/**
 * `wotw audit [page]` — walk the provenance chain for a given wiki page, or
 * verify the entire chain with `--verify`.
 *
 * The chain is read directly from disk — no daemon required. This is by
 * design: audit should work even if the daemon is down or compromised, and
 * the chain itself is the source of truth.
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { loadConfig, resolveConfigPaths } from "../../daemon/config.js";
import { ProvenanceChain } from "../../provenance/chain.js";
import type { ProvenanceRecord } from "../../utils/types.js";
import { chalk, fail, info, keyValueTable, line, success, warn } from "../output.js";

interface AuditOptions {
  verify?: boolean;
  format?: "tree" | "json";
  limit?: string;
}

/**
 * Attach the `audit` subcommand.
 */
export function registerAuditCommand(program: Command): void {
  program
    .command("audit [page]")
    .description("Walk the cryptographic provenance chain for a wiki page")
    .option("--verify", "Verify the entire chain instead of walking a single page")
    .option("--format <fmt>", "Output format: tree | json", "tree")
    .option("--limit <n>", "Max records to show when no page is given", "20")
    .action(async (page: string | undefined, opts: AuditOptions) => {
      await runAudit(page, opts);
    });
}

/**
 * Implementation used by the CLI action.
 */
export async function runAudit(page: string | undefined, opts: AuditOptions): Promise<void> {
  const loaded = await loadConfig();
  const config = resolveConfigPaths(loaded.config);

  if (!config.provenance.enabled) {
    warn("Provenance is disabled in config (provenance.enabled = false).");
    return;
  }

  const chainFile = config.provenance.chain_file;
  if (!existsSync(chainFile)) {
    fail(`No provenance chain found at ${chainFile}.`);
    info("The chain is created when the daemon processes its first ingestion or query.");
    process.exitCode = 1;
    return;
  }

  const chain = new ProvenanceChain({ path: chainFile });
  await chain.init();

  if (opts.verify) {
    await verifyChain(chain, opts);
    return;
  }

  if (!page) {
    await listRecent(chain, opts);
    return;
  }

  await walkPage(chain, config.wiki_root, page, opts);
}

/** Verify the full chain and print a report. */
async function verifyChain(chain: ProvenanceChain, opts: AuditOptions): Promise<void> {
  info("Walking provenance chain...");
  const result = await chain.verify();
  if (opts.format === "json") {
    line(
      JSON.stringify(
        {
          ok: result.ok,
          total: result.totalRecords,
          verified: result.verifiedRecords,
          errors: result.errors,
          head: chain.head(),
          signature: await chain.signature(),
        },
        null,
        2,
      ),
    );
    if (!result.ok) process.exitCode = 1;
    return;
  }
  line("");
  line(
    keyValueTable([
      ["total records", String(result.totalRecords)],
      ["verified", String(result.verifiedRecords)],
      ["errors", String(result.errors.length)],
      ["head", chain.head().slice(0, 16) + "…"],
      ["signature", (await chain.signature()).slice(0, 16) + "…"],
    ]),
  );
  line("");
  if (result.ok) {
    success(`Chain intact: ${result.totalRecords} record(s) verified.`);
  } else {
    fail(`Chain corrupt: ${result.errors.length} error(s) found.`);
    for (const err of result.errors.slice(0, 10)) {
      line(`  ${chalk.red("×")} seq=${err.seq} id=${err.id.slice(0, 12)} — ${err.reason}`);
    }
    process.exitCode = 1;
  }
}

/** List recent records when no specific page is given. */
async function listRecent(chain: ProvenanceChain, opts: AuditOptions): Promise<void> {
  const limit = Math.max(1, Math.min(500, Number(opts.limit) || 20));
  const records = await chain.readRecent(limit);
  if (records.length === 0) {
    info("Provenance chain is empty.");
    return;
  }
  if (opts.format === "json") {
    line(JSON.stringify({ total: chain.count(), records }, null, 2));
    return;
  }
  line("");
  line(chalk.dim(`Showing ${records.length} of ${chain.count()} records:`));
  line("");
  for (const r of records) {
    printRecord(r);
  }
  line("");
  info(`Run 'wotw audit <wiki/path.md>' to see history for a specific page.`);
  info(`Run 'wotw audit --verify' to check chain integrity.`);
}

/** Walk the provenance trail for a specific page. */
async function walkPage(
  chain: ProvenanceChain,
  wikiRoot: string,
  page: string,
  opts: AuditOptions,
): Promise<void> {
  const normalized = normalizePagePath(wikiRoot, page);
  const records = await chain.recordsFor(normalized);
  if (records.length === 0) {
    warn(`No provenance records found for ${normalized}.`);
    return;
  }
  if (opts.format === "json") {
    line(JSON.stringify({ page: normalized, records }, null, 2));
    return;
  }
  line("");
  line(chalk.bold(`History for ${normalized}:`));
  line(chalk.dim(`  ${records.length} record(s) in chain`));
  line("");
  for (const r of records) printRecord(r);
}

/** Pretty-print a single provenance record. */
function printRecord(r: ProvenanceRecord): void {
  const icon =
    r.type === "ingest" ? "⇥" : r.type === "query" ? "?" : r.type === "compound" ? "⊕" : "•";
  const cost =
    typeof r.metadata?.cost_usd === "number" ? `$${r.metadata.cost_usd.toFixed(4)}` : "—";
  line(
    `  ${chalk.cyan(icon)} ${chalk.dim(`#${r.seq}`)} ${chalk.bold(r.type.padEnd(8))} ${chalk.dim(r.timestamp)}`,
  );
  line(`      id=${chalk.yellow(r.id.slice(0, 12))}  model=${r.model_id}  cost=${cost}`);
  if (r.wiki_files_written.length > 0) {
    line(
      `      wrote: ${r.wiki_files_written.slice(0, 3).join(", ")}${r.wiki_files_written.length > 3 ? `, +${r.wiki_files_written.length - 3} more` : ""}`,
    );
  }
  if (r.source_files.length > 0) {
    line(
      `      from:  ${r.source_files.slice(0, 3).join(", ")}${r.source_files.length > 3 ? `, +${r.source_files.length - 3} more` : ""}`,
    );
  }
}

/**
 * Normalize a user-provided page argument into the form stored in the
 * provenance chain (wiki-relative path as-is in `wiki_files_written`).
 */
function normalizePagePath(wikiRoot: string, page: string): string {
  // If user gave an absolute path, convert to wiki-relative.
  if (page.startsWith("/")) {
    const rel = relative(wikiRoot, resolve(page));
    return rel || page;
  }
  // Strip leading "./"
  return page.replace(/^\.\//, "");
}
