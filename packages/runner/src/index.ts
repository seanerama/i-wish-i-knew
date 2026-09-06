// @iwik/runner — the programmatic API behind the `iwik` CLI. The MCP adapter
// (`iwik mcp`) and the service's end-to-end test drive the runner through
// these functions; the CLI is a thin layer over them.
export { run, runPlan, deriveAccounting, checkBudget } from './run.js';
export type { RunOptions, RunResult } from './run.js';
export {
  plan,
  loadPlan,
  savePlan,
  listPlans,
  planSummary,
  planPath,
  runPlanCommand,
} from './plan.js';
export type { PlanOptions, PlanRecord } from './plan.js';
export { estimateCost, parseCostModel } from './cost.js';
export type { CostModel, CostInputs, CostEstimate } from './cost.js';
export {
  report,
  renderMarkdown,
  validateReport,
  REPORT_HEADER,
  REPORT_SCHEMA_PATH,
} from './report.js';
export type { ReportOptions, LocalReport, ReportRun, ReportClaim, ReportMetric } from './report.js';
export { preview, submit, receipt, wireRun } from './submit.js';
export type { ClientOptions, PreviewOptions, PreviewResult, SubmitResult } from './submit.js';
export {
  init,
  discoverNode,
  resolveHome,
  homePaths,
  loadConfig,
  saveConfig,
  loadToken,
} from './home.js';
export type { InitOptions, InitResult, RunnerConfig, HomePaths, WhoAmI } from './home.js';
export {
  loadPolicy,
  savePolicy,
  checkExecution,
  targetAllowed,
  parseTarget,
  targetHost,
  DEFAULT_POLICY,
} from './policy.js';
export type { Policy } from './policy.js';
export { loadKey, signPayload, generateKey, nodeKeyFrom } from './keys.js';
export type { NodeKey } from './keys.js';
export { signingPayload, contentDigest } from './signing.js';
export { ApiClient } from './client.js';
export type { FetchLike, ApiResponse } from './client.js';
export { RunnerError, ApiError, isRunnerError, EXIT_CODES } from './errors.js';
export type { RunnerErrorCode, ErrorDetail } from './errors.js';
export {
  vaultPaths,
  readDraft,
  readMeta,
  readPreview,
  readSignedRun,
  readReceipt,
  listRuns,
  tightenPermissions,
  EXCLUSION_REASONS,
} from './vault.js';
export type { VaultPaths, RunDraft, VaultMeta, PreviewRecord, ExclusionReason } from './vault.js';
export {
  loadLocalPack,
  verifyPack,
  parseManifest,
  parseProtocolRef,
  defaultPacksDir,
} from './pack.js';
export type { LocalPack, Manifest } from './pack.js';
export { mergeContext, parseContextArg, parseContextArgs, projection } from './context.js';
export type { MergedContext, ContextOverride } from './context.js';
export { GUARD_PATH, harnessEnv, spawnHarness } from './harness.js';
export type { SpawnOptions, SpawnResult } from './harness.js';
export { callTool, errorEnvelope, isToolName, NOT_YET_AVAILABLE } from './tools.js';
export type { ToolContext, Envelope } from './tools.js';
export {
  buildServer,
  serveMcp,
  mcpEnabled,
  mcpDisabledMessage,
  toolList,
  skillText,
  MCP_FLAG,
  SKILL_PATH,
} from './mcp.js';
export { ulid, ULID_PATTERN } from './ulid.js';
