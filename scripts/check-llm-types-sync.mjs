#!/usr/bin/env node
/**
 * LLMProvider types byte-identical sync check (review item 8).
 *
 * The wotw-cloud monorepo's packages/shared/src/llm/types.ts is the
 * single source of truth for the LLMProvider interface. This daemon's
 * src/llm/types-vendored.ts must remain byte-identical with it; drift
 * silently breaks the cross-repo type contract.
 *
 * The original src/llm/index.ts header claimed this CI gate existed but
 * the script was never written. This file closes that gap so the daemon
 * CI can enforce drift independently of wotw-cloud's parallel check
 * (web/scripts/check-llm-types-sync.mjs).
 *
 * Pattern mirrors wotw-cloud's sibling script. When the wotw-cloud repo
 * is not present at the expected sibling location, the script WARNS and
 * exits 0 — lets daemon CI runs that don't clone wotw-cloud skip
 * without a false-positive failure. The wotw-cloud half of the gate
 * still fires on its own CI.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const vendoredPath = join(repoRoot, "src/llm/types-vendored.ts");
// wotw-cloud is assumed at ../wotw-cloud (sibling checkout layout).
const cloudCanonicalPath = join(
  repoRoot,
  "..",
  "wotw-cloud",
  "packages/shared/src/llm/types.ts",
);

if (!existsSync(vendoredPath)) {
  console.error(
    `[check-llm-types-sync] missing vendored copy at ${vendoredPath} — daemon repo layout broke`,
  );
  process.exit(1);
}

if (!existsSync(cloudCanonicalPath)) {
  console.warn(
    `[check-llm-types-sync] WARN: canonical not found at ${cloudCanonicalPath} ` +
      `(wotw-cloud sibling checkout missing — skipping daemon-side sync gate). ` +
      `wotw-cloud CI runs its own parallel check.`,
  );
  process.exit(0);
}

const vendoredBytes = readFileSync(vendoredPath);
const canonicalBytes = readFileSync(cloudCanonicalPath);

if (vendoredBytes.equals(canonicalBytes)) {
  console.log(
    `ok: ${vendoredPath} byte-identical with ${cloudCanonicalPath} (${vendoredBytes.length} bytes)`,
  );
  process.exit(0);
}

console.error(
  `DRIFT: ${vendoredPath} differs from ${cloudCanonicalPath}. ` +
    `Vendored=${vendoredBytes.length} bytes, canonical=${canonicalBytes.length} bytes. ` +
    `Re-copy the canonical file into the vendored path before merging.`,
);
process.exit(1);
