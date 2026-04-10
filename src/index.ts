/**
 * Public library entrypoint. Re-exports the stable API surface that third-party
 * consumers can depend on. CLI and daemon logic are intentionally not exported
 * here.
 */
export { defaultConfig, loadConfig, mergeConfig, resolveConfigPaths } from "./daemon/config.js";
export { Daemon } from "./daemon/index.js";
export type { DaemonSubsystem, DaemonOptions } from "./daemon/index.js";
export type {
  ConfidenceLevel,
  CostLogEntry,
  DaemonEvent,
  DaemonStatus,
  IngestionBatch,
  ModelId,
  OperationType,
  ProvenanceRecord,
  WikiCategory,
  WikiFrontmatter,
  WikiPage,
  WotwConfig,
} from "./utils/types.js";
export {
  sha256,
  sha256Hex,
  sha256Canonical,
  sha256File,
  sha256FileSync,
  sha256Files,
  sha256Json,
  canonicalJson,
  stableStringify,
  GENESIS_HASH,
} from "./provenance/hash.js";
export { sanitize, sanitizeWithReport, DEFAULT_REDACTIONS } from "./utils/sanitize.js";
export { getLogger, initLogger } from "./utils/logger.js";
