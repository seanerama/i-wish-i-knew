// @iwik/runner — the programmatic API behind the `iwik` CLI. Stage 5's MCP
// adapter and the service's end-to-end test drive the runner through these
// functions; the CLI is a thin layer over them.
export { run, deriveAccounting } from './run.js';
export type { RunOptions, RunResult } from './run.js';
export { preview, submit, receipt, wireRun } from './submit.js';
export type { ClientOptions, PreviewOptions, PreviewResult, SubmitResult } from './submit.js';
export { init, resolveHome, homePaths, loadConfig, saveConfig, loadToken } from './home.js';
export type { InitOptions, InitResult, RunnerConfig, HomePaths } from './home.js';
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
} from './vault.js';
export type { VaultPaths, RunDraft, VaultMeta, PreviewRecord } from './vault.js';
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
export { ulid, ULID_PATTERN } from './ulid.js';
