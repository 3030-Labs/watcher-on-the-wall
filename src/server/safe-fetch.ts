/**
 * SSRF-hardened fetch for downloading user-uploaded content from signed
 * URLs (Supabase Storage, S3 presigned, etc.). Layered defenses per the
 * REVIEW-LAYER-1-DAEMON.md X4-C-1 recommendation: IP-level rejection
 * FIRST, content-length cap SECOND, streaming-to-disk with byte-count
 * enforcement THIRD.
 *
 * Closes review items 49 (SSRF) + 52 (no AbortSignal timeout) + 53 (raw
 * err.message echo) + 58 (no content-type validation).
 */
import { lookup } from "node:dns/promises";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { isIP } from "node:net";

export interface SafeFetchOptions {
  /** Absolute filesystem path to write the downloaded body to. */
  targetPath: string;
  /** Wall-clock cap in milliseconds. Default 30_000. */
  timeoutMs?: number;
  /** Byte cap. Default 32 MiB. */
  maxBytes?: number;
  /** Optional case-insensitive Content-Type prefix allowlist. */
  contentTypeAllowlist?: string[];
  /** Optional hostname substring allowlist. */
  hostnameAllowlist?: string[];
}

export interface SafeFetchResult {
  bytes: number;
  contentType: string | null;
}

export type SafeFetchErrorCode =
  | "INVALID_URL"
  | "INVALID_SCHEME"
  | "HOSTNAME_NOT_ALLOWED"
  | "PRIVATE_IP_BLOCKED"
  | "UPSTREAM_NON_2XX"
  | "CONTENT_LENGTH_TOO_LARGE"
  | "CONTENT_LENGTH_DURING_STREAM"
  | "CONTENT_TYPE_NOT_ALLOWED"
  | "FETCH_TIMEOUT"
  | "FETCH_FAILED"
  | "WRITE_FAILED";

export class SafeFetchError extends Error {
  readonly code: SafeFetchErrorCode;
  constructor(code: SafeFetchErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "SafeFetchError";
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Returns true when the IPv4 / IPv6 string belongs to a range that an
 * external public download should never reach. Exported for unit testing.
 */
export function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedIpv4(ip);
  if (family === 6) return isBlockedIpv6(ip);
  return true;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:") || lower.startsWith("fe80::")) return true;
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
  const v4MapMatch = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4MapMatch && v4MapMatch[1]) return isBlockedIpv4(v4MapMatch[1]);
  if (lower.startsWith("ff")) return true;
  return false;
}

/**
 * Download a remote URL to a local file with layered SSRF defenses.
 *
 * Order of checks (each must pass before the next runs):
 *   1. URL parse + scheme=https + optional hostname allowlist
 *   2. DNS lookup; reject if any resolved address is private/loopback/etc.
 *   3. HTTP GET with AbortSignal timeout and redirect:"error"
 *   4. Response must be 2xx
 *   5. Optional Content-Type allowlist check
 *   6. Content-Length header (if present) must be <= maxBytes
 *   7. Stream body to disk; abort if running total exceeds maxBytes
 *
 * On any failure the (partial) target file is removed.
 */
export async function safeFetchToFile(
  url: string,
  opts: SafeFetchOptions,
): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SafeFetchError("INVALID_URL", "URL parse failed");
  }
  if (parsed.protocol !== "https:") {
    throw new SafeFetchError("INVALID_SCHEME", "scheme must be https");
  }
  if (opts.hostnameAllowlist && opts.hostnameAllowlist.length > 0) {
    const hostLower = parsed.hostname.toLowerCase();
    const allowed = opts.hostnameAllowlist.some((suffix) =>
      hostLower.includes(suffix.toLowerCase()),
    );
    if (!allowed) {
      throw new SafeFetchError("HOSTNAME_NOT_ALLOWED", "hostname not in allowlist");
    }
  }

  let addrs: { address: string }[];
  try {
    addrs = await lookup(parsed.hostname, { all: true });
  } catch {
    throw new SafeFetchError("FETCH_FAILED", "dns lookup failed");
  }
  if (addrs.length === 0) {
    throw new SafeFetchError("FETCH_FAILED", "dns returned no addresses");
  }
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new SafeFetchError("PRIVATE_IP_BLOCKED", "host resolves to a blocked address");
    }
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, { signal: controller.signal, redirect: "error" });
  } catch {
    clearTimeout(timeoutHandle);
    if (controller.signal.aborted) {
      throw new SafeFetchError("FETCH_TIMEOUT", "fetch timed out");
    }
    throw new SafeFetchError("FETCH_FAILED", "fetch failed");
  }

  if (!res.ok) {
    clearTimeout(timeoutHandle);
    throw new SafeFetchError("UPSTREAM_NON_2XX", `upstream returned ${res.status}`);
  }

  const contentType = res.headers.get("content-type");
  if (opts.contentTypeAllowlist && opts.contentTypeAllowlist.length > 0) {
    const lower = (contentType ?? "").toLowerCase();
    const allowed = opts.contentTypeAllowlist.some((prefix) =>
      lower.startsWith(prefix.toLowerCase()),
    );
    if (!allowed) {
      clearTimeout(timeoutHandle);
      throw new SafeFetchError("CONTENT_TYPE_NOT_ALLOWED", "content-type not in allowlist");
    }
  }

  const declaredLength = res.headers.get("content-length");
  if (declaredLength !== null) {
    const n = Number(declaredLength);
    if (!Number.isFinite(n) || n > maxBytes) {
      clearTimeout(timeoutHandle);
      throw new SafeFetchError("CONTENT_LENGTH_TOO_LARGE", "content-length exceeds cap");
    }
  }

  if (!res.body) {
    clearTimeout(timeoutHandle);
    throw new SafeFetchError("FETCH_FAILED", "response had no body");
  }

  let bytesWritten = 0;
  const sink = createWriteStream(opts.targetPath);
  const sinkErrors: Error[] = [];
  sink.on("error", (e) => sinkErrors.push(e));

  try {
    const source = Readable.fromWeb(res.body as never);
    for await (const chunk of source) {
      const buf = chunk as Buffer;
      bytesWritten += buf.length;
      if (bytesWritten > maxBytes) {
        controller.abort();
        sink.destroy();
        throw new SafeFetchError(
          "CONTENT_LENGTH_DURING_STREAM",
          "body exceeded max bytes during stream",
        );
      }
      if (!sink.write(buf)) {
        await new Promise<void>((resolve) => sink.once("drain", () => resolve()));
      }
    }
    await new Promise<void>((resolve, reject) => {
      sink.end((err: unknown) => {
        if (err) {
          const e = err instanceof Error ? err : new Error("sink write failed");
          reject(e);
        } else if (sinkErrors.length > 0) {
          const first = sinkErrors[0];
          reject(first instanceof Error ? first : new Error("sink write failed"));
        } else {
          resolve();
        }
      });
    });
    clearTimeout(timeoutHandle);
    return { bytes: bytesWritten, contentType };
  } catch (err) {
    clearTimeout(timeoutHandle);
    sink.destroy();
    await unlink(opts.targetPath).catch(() => undefined);
    if (err instanceof SafeFetchError) throw err;
    if (controller.signal.aborted) {
      throw new SafeFetchError("FETCH_TIMEOUT", "fetch timed out during stream");
    }
    throw new SafeFetchError("WRITE_FAILED", "write failed during stream");
  }
}
