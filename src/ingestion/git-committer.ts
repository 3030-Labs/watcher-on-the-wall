/**
 * Git committer for the wiki directory. Wraps simple-git with a narrow
 * surface area: stage specific paths, commit with a generated message,
 * retry on lock contention. The committer does NOT push — remote sync is
 * a user decision.
 */
import { relative } from "node:path";
import { commitAll, ensureGitRepo } from "../utils/git.js";
import { getLogger } from "../utils/logger.js";
import { retry } from "../utils/retry.js";

export interface CommitRequest {
  /** Absolute path to the wiki root (the git repo). */
  wikiRoot: string;
  /** Absolute paths that should be included in the commit. */
  paths: string[];
  /** Short identifier for the operation (batch id, query id, etc.). */
  operationId: string;
  /** Human-readable operation label (e.g. "ingest", "compound"). */
  operation: string;
  /** Extra metadata lines appended to the commit body. */
  metadata?: Record<string, string | number>;
}

export interface CommitResult {
  committed: boolean;
  sha: string | null;
  message: string;
  fileCount: number;
  reason?: string;
}

/**
 * Stage the given files and commit them. Returns { committed: false } when
 * there's nothing to commit (idempotent). Retries on transient lock errors.
 */
export async function commitWikiChanges(req: CommitRequest): Promise<CommitResult> {
  const log = getLogger("git-committer");
  await ensureGitRepo(req.wikiRoot, "chore: wotw init — scaffold wiki store");

  const relativePaths = req.paths
    .map((p) => relative(req.wikiRoot, p).replace(/\\/g, "/"))
    .filter((p) => p.length > 0 && !p.startsWith(".."));

  if (relativePaths.length === 0) {
    return { committed: false, sha: null, message: "", fileCount: 0, reason: "no eligible paths" };
  }

  const message = buildCommitMessage(req);

  return retry(
    async () => {
      const sha = await commitAll(req.wikiRoot, message, relativePaths);
      if (!sha) {
        return {
          committed: false,
          sha: null,
          message,
          fileCount: relativePaths.length,
          reason: "nothing to commit",
        };
      }
      log.info({ sha, fileCount: relativePaths.length, operationId: req.operationId }, "committed");
      return { committed: true, sha, message, fileCount: relativePaths.length };
    },
    {
      retries: 3,
      initialDelayMs: 200,
      maxDelayMs: 2_000,
      factor: 2,
      shouldRetry: (err) => /index\.lock/i.test((err as Error).message ?? ""),
      onRetry: (err, attempt, delay) =>
        log.warn({ err, attempt, delay }, "retrying git commit after lock contention"),
    },
  );
}

function buildCommitMessage(req: CommitRequest): string {
  const header = `wotw: ${req.operation} ${req.operationId}`;
  const body: string[] = [];
  if (req.metadata) {
    for (const [k, v] of Object.entries(req.metadata)) {
      body.push(`${k}: ${v}`);
    }
  }
  body.push(`files: ${req.paths.length}`);
  return `${header}\n\n${body.join("\n")}`;
}
