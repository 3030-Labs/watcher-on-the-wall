/**
 * Public surface of the ingestion module.
 */
export { IngestionQueue, type IngestionOutcome, type IngestionQueueOptions } from "./queue.js";
export { CostTracker } from "./cost-tracker.js";
export { ModelRouter, PRICING, type ModelPricing } from "./model-router.js";
export {
  buildIngestionPrompt,
  type IngestionPrompt,
  type BuildIngestionPromptOptions,
} from "./prompt-builder.js";
export { invokeIngestionAgent, type InvokeOptions, type InvokeResult } from "./llm-invoker.js";
export { reconcileWrittenPages, loadAllPages, type ReconcileResult } from "./wiki-writer.js";
export { commitWikiChanges, type CommitRequest, type CommitResult } from "./git-committer.js";
