// Public API — everything importable for programmatic use.
// The CLI (`dist/cli.js`, bin `dsh-super-agent`) covers the operational surface.

export * from "./domain.js";
export { evaluateGate, resolveCandidate, type GateResult, type Resolution, type Assessment } from "./gate.js";
export { Engine, type IngestItem, type TicketView, type DecisionView, type IngestReport } from "./engine.js";
export { GitHubClient, type TokenProvider } from "./github/client.js";
export { AppTokenProvider, appAuthFromEnv, signAppJwt, type AppAuthEnv, type AppAuthOptions } from "./github/app-auth.js";
export { GitHubSource, isBotActor } from "./github/source.js";
export { FileSourceState, type StateStore, type SourceState } from "./github/state.js";
export { Executor, renderPrompt, type ExecutorConfig, type ExecutorResult } from "./executor.js";
export { runWork, deliverPullRequest, type WorkReport } from "./work.js";
export { runWatch, type WatchOptions } from "./watch.js";
export { evaluateMerge, runMergeSweep, type MergeCheck, type MergeSweepLine } from "./merge.js";
export { runWatchdogSweep, healthReport, watchdogPolicyOf, type WatchdogLine, type WatchdogPolicy, type HealthReport, type ProgressCheck } from "./watchdog.js";
export { runPromoteSweep } from "./work.js";
export { classify, formatOutcome, type PollOutcome } from "./runner.js";
export { llmAssessor, stubAssessor, type Assessor } from "./assess.js";
export { clipReply, wordCount } from "./clip.js";
export { startPanel } from "./panel.js";
