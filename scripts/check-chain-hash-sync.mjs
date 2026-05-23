#!/usr/bin/env node
/**
 * chain-hash-vendored byte-identity sync check (review item 39).
 *
 * src/provenance/chain-hash-vendored.ts is the daemon's vendored copy
 * of wotw-cloud's `packages/shared/src/provenance/chain-hash.ts` (or the
 * equivalent canonical module). Drift between the two means daemon
 * provenance records and wotw-cloud's verify-chain endpoint can
 * silently disagree on the hash. Pre-fix the daemon had this file as
 * dead code with no CI gate; this script + CI step closes the gap.
 *
 * WARN-and-skip when the wotw-cloud sibling checkout is missing.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const vendoredPath = join(repoRoot, "src/provenance/chain-hash-vendored.ts");
const cloudCanonicalPath = join(
  repoRoot,
  "..",
  "wotw-cloud",
  "packages/shared/src/chain-hash.ts",
);

if (!existsSync(vendoredPath)) {
  console.error(`[check-chain-hash-sync] missing vendored copy at ${vendoredPath}`);
  process.exit(1);
}
if (!existsSync(cloudCanonicalPath)) {
  console.warn(
    `[check-chain-hash-sync] WARN: canonical not found at ${cloudCanonicalPath} ` +
      `(wotw-cloud sibling checkout missing — skipping daemon-side sync gate). ` +
      `wotw-cloud CI runs its own parallel check.`,
  );
  process.exit(0);
}

const a = readFileSync(vendoredPath);
const b = readFileSync(cloudCanonicalPath);
if (a.equals(b)) {
  console.log(`ok: ${vendoredPath} byte-identical with ${cloudCanonicalPath} (${a.length} bytes)`);
  process.exit(0);
}
console.error(
  `DRIFT: ${vendoredPath} differs from ${cloudCanonicalPath}. ` +
    `Vendored=${a.length} bytes, canonical=${b.length} bytes. ` +
    `Re-copy the canonical file into the vendored path before merging.`,
);
process.exit(1);
