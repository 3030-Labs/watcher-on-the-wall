/**
 * Single source of truth for the package version.
 *
 * Uses `createRequire` to read `package.json` at runtime so the version
 * can never drift from the declared value. This is safe in ESM because
 * `createRequire` resolves relative to the compiled output directory and
 * `package.json` sits at the repo root (two levels up from `dist/utils/`).
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

export const VERSION: string = pkg.version;
