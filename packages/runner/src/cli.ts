// `iwik` command line: init, policy, plan, run, report, preview, submit,
// receipt, withdraw, vault, mcp. Every failure exits nonzero with a one-line reason on
// stderr; token and key material are never printed. Only `run`, `plan`, and
// `report` write something to stdout that scripts capture: an id, or the
// report itself.
import { Command, InvalidArgumentError } from 'commander';
import { isRunnerError, RunnerError } from './errors.js';
import { discoverNode, init, loadToken, resolveHome } from './home.js';
import { serveMcp } from './mcp.js';
import { loadPlan, plan, planSummary } from './plan.js';
import { loadPolicy, normalizeTargetEntry, savePolicy } from './policy.js';
import { renderMarkdown, report } from './report.js';
import { run, runPlan } from './run.js';
import type { RunOptions, RunResult } from './run.js';
import type { WithdrawalReasonCode } from './withdraw.js';
import { preview, receipt, submit } from './submit.js';
import { listRuns, readMeta, readPreview, readReceipt } from './vault.js';
import { WITHDRAWAL_REASON_CODES, isWithdrawalReasonCode, withdraw } from './withdraw.js';

function out(text: string): void {
  process.stdout.write(text + '\n');
}

function err(text: string): void {
  process.stderr.write(text + '\n');
}

function fail(error: unknown): never {
  if (isRunnerError(error)) {
    const details =
      error.details !== undefined && error.details.length > 0
        ? ' [' + error.details.map((d) => `${d.path || '/'} ${d.rule}`).join(', ') + ']'
        : '';
    err(`iwik: ${error.code}: ${error.message}${details}`);
    process.exit(error.exitCode);
  }
  err(`iwik: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

function positiveInt(name: string): (value: string) => number {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1)
      throw new InvalidArgumentError(`${name} must be a positive integer`);
    return n;
  };
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function kind(value: string): 'service' | 'fixture' | 'device' {
  if (value === 'service' || value === 'fixture' || value === 'device') return value;
  throw new InvalidArgumentError('target kind must be service, fixture, or device');
}

function reasonCode(value: string): WithdrawalReasonCode {
  if (isWithdrawalReasonCode(value)) return value;
  throw new InvalidArgumentError(`reason must be one of: ${WITHDRAWAL_REASON_CODES.join(', ')}`);
}

function sharing(value: string): 'private' | 'cooperative' {
  if (value === 'private' || value === 'cooperative') return value;
  throw new InvalidArgumentError('sharing policy must be private or cooperative');
}

/** `--price name=usd` pairs into the cost-model price map. */
function parsePrices(args: readonly string[]): Record<string, number> | undefined {
  if (args.length === 0) return undefined;
  const prices: Record<string, number> = {};
  for (const arg of args) {
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : '';
    const value = Number(arg.slice(eq + 1));
    if (name === '' || !Number.isFinite(value) || value < 0) {
      throw new RunnerError('usage', 'price must be <name>=<non-negative number>');
    }
    prices[name] = value;
  }
  return prices;
}

const program = new Command();
program
  .name('iwik')
  .description(
    'I Wish I Knew runner: plan and run a protocol locally, read the local report, preview, then submit sanitized evidence',
  )
  .option('--home <dir>', 'runner home (default: $IWIK_HOME or ~/.iwik)')
  .showHelpAfterError()
  .exitOverride((e) => {
    // commander already printed its message; keep its exit status
    process.exit(e.exitCode);
  });

function homeOf(): string {
  const opts = program.opts<{ home?: string }>();
  return resolveHome(opts.home);
}

/**
 * Enrollment instructions, worded like the console's /org page ("Enroll a
 * node", packages/service/views/org.eta) so the two stay consistent. Only the
 * public key is ever shown; the token and private key are never printed.
 * `iwik init` prints the base64 raw key; a PEM SPKI block is accepted at
 * registration but is never what `iwik init` prints.
 */
export function enrollmentInstructions(serviceUrl: string, home: string): string[] {
  return [
    '',
    `Enroll this node: sign in to the console at ${serviceUrl}/org, then`,
    '  1. Paste the public key above under "Register a node" and register the node. iwik init',
    '     prints the base64 raw key; a PEM block is accepted there too but is never what iwik init',
    '     prints. Accepted formats: base64 raw key: one line of 44 characters, the 32 raw bytes of',
    '     the Ed25519 public key (no PEM header lines), or PEM SPKI block:',
    '     -----BEGIN PUBLIC KEY----- ... -----END PUBLIC KEY-----. Either form is stored',
    '     canonically as the base64 raw key.',
    '  2. Issue the node a token with only the scopes it needs (query reads, submit previews and',
    '     submits runs, publish challenges, outcomes, withdrawals). Save the token to',
    `     ${home}/token (0600): iwik init --service ${serviceUrl} --token-file <path>; the node id`,
    '     is learned from GET /v1/whoami (pass --node-id only when working offline).',
    '  3. Lost or leaked? Revoke the token, or revoke the whole node: every request with a revoked',
    '     token answers 401, and intake rejects signatures from a revoked node.',
  ];
}

program
  .command('init')
  .description(
    'create the runner home, generate the Ed25519 signing key, store the node token, learn the node id',
  )
  .requiredOption('--service <url>', 'service base URL')
  .option('--token-file <path>', 'file containing the node token (copied to <home>/token, 0600)')
  .option('--node-id <ulid>', 'node id (offline; otherwise learned from GET /v1/whoami)')
  .option('--packs-dir <dir>', 'directory holding domain packs')
  .option('--offline', 'do not call GET /v1/whoami')
  .action(
    async (opts: {
      service: string;
      tokenFile?: string;
      nodeId?: string;
      packsDir?: string;
      offline?: boolean;
    }) => {
      try {
        const home = homeOf();
        const result = init({
          home,
          serviceUrl: opts.service,
          ...(opts.tokenFile !== undefined ? { tokenFile: opts.tokenFile } : {}),
          ...(opts.nodeId !== undefined ? { nodeId: opts.nodeId } : {}),
          ...(opts.packsDir !== undefined ? { packsDir: opts.packsDir } : {}),
        });
        let nodeId = result.node_id;
        let nodeNote = '';
        if (opts.nodeId === undefined && opts.offline !== true) {
          let hasToken = false;
          try {
            loadToken(home);
            hasToken = true;
          } catch {
            hasToken = false;
          }
          if (hasToken) {
            try {
              const me = await discoverNode(home);
              nodeId = me.node_id;
              nodeNote = ` (from GET /v1/whoami; organization "${me.org_display_name}", scopes ${me.scopes.join(', ') || 'none'})`;
            } catch (e) {
              nodeNote = ` (GET /v1/whoami failed: ${e instanceof Error ? e.message : String(e)}; pass --node-id to set it offline)`;
            }
          }
        }
        err(`home: ${result.home}`);
        err(`service: ${result.service_url}`);
        err(
          `node id: ${nodeId ?? '(not set; store a token so GET /v1/whoami can fill it in, or pass --node-id)'}${nodeNote}`,
        );
        err(`token: ${result.token_stored ? 'stored' : 'unchanged'}`);
        err(`signing key: ${result.key_created ? 'generated' : 'kept'} (key_id ${result.key_id})`);
        err('public key for enrollment (base64, raw Ed25519):');
        out(result.pubkey);
        for (const line of enrollmentInstructions(result.service_url, result.home)) err(line);
      } catch (e) {
        fail(e);
      }
    },
  );

const policy = program.command('policy').description('show or change the local execution policy');
policy
  .command('show')
  .description('print the effective policy')
  .action(() => {
    try {
      out(JSON.stringify(loadPolicy(homeOf()), null, 2));
    } catch (e) {
      fail(e);
    }
  });
policy
  .command('set <key> <value>')
  .description('set allow_execution, allow_disruptive (true|false) or budget_per_plan_usd (number)')
  .action((key: string, value: string) => {
    try {
      const home = homeOf();
      const current = loadPolicy(home);
      if (key === 'allow_execution' || key === 'allow_disruptive') {
        if (value !== 'true' && value !== 'false')
          throw new RunnerError('usage', `${key} must be true or false`);
        current[key] = value === 'true';
      } else if (key === 'budget_per_plan_usd') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0)
          throw new RunnerError('usage', `${key} must be a non-negative number`);
        current[key] = n;
      } else {
        throw new RunnerError(
          'usage',
          'key must be allow_execution, allow_disruptive, or budget_per_plan_usd',
        );
      }
      savePolicy(home, current);
      out(JSON.stringify(current, null, 2));
    } catch (e) {
      fail(e);
    }
  });
policy
  .command('allow-target <host>')
  .description('add a host (host or host:port) to allowed_targets')
  .action((host: string) => {
    try {
      const home = homeOf();
      const current = loadPolicy(home);
      const entry = normalizeTargetEntry(host);
      if (entry === '') throw new RunnerError('usage', 'host must not be empty');
      if (!current.allowed_targets.includes(entry)) current.allowed_targets.push(entry);
      savePolicy(home, current);
      out(JSON.stringify(current, null, 2));
    } catch (e) {
      fail(e);
    }
  });
policy
  .command('deny-target <host>')
  .description('remove a host from allowed_targets')
  .action((host: string) => {
    try {
      const home = homeOf();
      const current = loadPolicy(home);
      const entry = normalizeTargetEntry(host);
      current.allowed_targets = current.allowed_targets.filter(
        (t) => normalizeTargetEntry(t) !== entry,
      );
      savePolicy(home, current);
      out(JSON.stringify(current, null, 2));
    } catch (e) {
      fail(e);
    }
  });

program
  .command('plan')
  .description(
    'save a plan under plans/: protocol, target, context (unknowns listed), estimated cost, what it resolves; never executes',
  )
  .requiredOption('--protocol <ref>', 'protocol ref, e.g. inference-api/latency@1')
  .requiredOption('--target <url>', 'target base URL')
  .requiredOption('--question <text>', 'the question this test is meant to resolve')
  .option('--context <k=v>', 'operator-supplied context field (repeatable)', collect, [])
  .option('--target-kind <kind>', 'service | fixture | device', kind, 'service')
  .option('--planned <n>', 'planned attempts', positiveInt('planned'), 10)
  .option('--max-tokens <n>', 'max_tokens per request', positiveInt('max-tokens'), 64)
  .option('--timeout-ms <n>', 'per-attempt timeout', positiveInt('timeout-ms'), 30000)
  .option(
    '--price <name=usd>',
    'price the pack cost model needs for a non-fixture target (repeatable)',
    collect,
    [],
  )
  .option('--api-key-env <name>', 'environment variable holding the target API key')
  .option('--investigation <ulid>', 'investigation id to attach')
  .option('--share <policy>', 'sharing policy at submit: private | cooperative', sharing, 'private')
  .option('--packs-dir <dir>', 'directory holding domain packs')
  .option('--json', 'print the plan summary as JSON on stdout instead of the plan id')
  .action(
    (opts: {
      protocol: string;
      target: string;
      question: string;
      context: string[];
      targetKind: 'service' | 'fixture' | 'device';
      planned: number;
      maxTokens: number;
      timeoutMs: number;
      price: string[];
      apiKeyEnv?: string;
      investigation?: string;
      share: 'private' | 'cooperative';
      packsDir?: string;
      json?: boolean;
    }) => {
      try {
        const prices = parsePrices(opts.price);
        const record = plan({
          home: homeOf(),
          protocol: opts.protocol,
          target: opts.target,
          targetKind: opts.targetKind,
          question: opts.question,
          context: opts.context,
          planned: opts.planned,
          maxTokens: opts.maxTokens,
          timeoutMs: opts.timeoutMs,
          sharingPolicy: opts.share,
          ...(prices !== undefined ? { prices } : {}),
          ...(opts.apiKeyEnv !== undefined ? { apiKeyEnv: opts.apiKeyEnv } : {}),
          ...(opts.investigation !== undefined ? { investigationId: opts.investigation } : {}),
          ...(opts.packsDir !== undefined ? { packsDir: opts.packsDir } : {}),
        });
        const cost = record.estimated_cost;
        err(
          `plan ${record.plan_id}: ${record.protocol_ref} against ${record.target.kind} target, ${record.planned} attempts`,
        );
        err(
          `estimated cost: ${cost.amount === null ? 'unknown' : cost.amount + ' USD'} (${cost.basis}); budget_per_plan_usd ${cost.budget_per_plan_usd}`,
        );
        if (record.required_context.unknown.length > 0)
          err(`required context unknown: ${record.required_context.unknown.join(', ')}`);
        err(`resolves: ${record.resolves.statement}`);
        err(
          `execution: ${record.execution.allowed ? 'allowed by policy' : 'denied: ' + record.execution.reasons.join('; ')}`,
        );
        err(`next: ${record.execution.next_step}`);
        out(opts.json === true ? JSON.stringify(planSummary(record), null, 2) : record.plan_id);
      } catch (e) {
        fail(e);
      }
    },
  );

function printRun(result: RunResult): void {
  const a = result.accounting;
  err(
    `run ${result.run_id}: ${result.execution_status}` +
      (result.exclusion_reason !== undefined ? ` (${result.exclusion_reason})` : '') +
      ` planned=${a.planned} attempted=${a.attempted} succeeded=${a.succeeded} failed=${a.failed}` +
      ` excluded=${a.excluded} unobserved=${a.unobserved}`,
  );
  if (result.exclusion_detail !== undefined) err(`detail (vault only): ${result.exclusion_detail}`);
  err(`estimated cost: ${result.estimated_cost.amount ?? 0} USD (${result.estimated_cost.basis})`);
  for (const o of result.context_overrides) {
    err(`context override: ${o.key} operator value replaced by harness ${o.harness_origin} value`);
  }
  for (const issue of result.issues) err(`note: ${issue}`);
  err(`vault: ${result.vault_dir}`);
  err(`report: iwik report ${result.run_id}`);
  out(result.run_id);
}

program
  .command('run')
  .description(
    'execute a saved plan (--plan) or one protocol against a target, under local policy and budget; prints the run id',
  )
  .option('--plan <plan_id>', 'execute a plan saved by "iwik plan"')
  .option('--protocol <ref>', 'protocol ref, e.g. inference-api/latency@1')
  .option('--target <url>', 'target base URL')
  .option('--planned <n>', 'planned attempts', positiveInt('planned'), 10)
  .option('--context <k=v>', 'operator-supplied context field (repeatable)', collect, [])
  .option('--target-kind <kind>', 'service | fixture | device', kind, 'service')
  .option(
    '--share <policy>',
    'sharing policy requested at submit: private | cooperative',
    sharing,
    'private',
  )
  .option(
    '--model <name>',
    'model to request from the target (defaults to context model.requested)',
  )
  .option('--api-key-env <name>', 'environment variable holding the target API key')
  .option('--timeout-ms <n>', 'per-attempt timeout', positiveInt('timeout-ms'), 30000)
  .option('--max-tokens <n>', 'max_tokens per request', positiveInt('max-tokens'), 64)
  .option('--price <name=usd>', 'price for the pack cost model (repeatable)', collect, [])
  .option('--investigation <ulid>', 'investigation id to attach')
  .option('--offline', "verify against the pack's own protocol.json instead of the registry")
  .option('--manifest <file>', 'verify against a saved GET /v1/protocols/{ref} body')
  .option('--packs-dir <dir>', 'directory holding domain packs')
  .action(
    async (opts: {
      plan?: string;
      protocol?: string;
      target?: string;
      planned: number;
      context: string[];
      targetKind: 'service' | 'fixture' | 'device';
      share: 'private' | 'cooperative';
      model?: string;
      apiKeyEnv?: string;
      timeoutMs: number;
      maxTokens: number;
      price: string[];
      investigation?: string;
      offline?: boolean;
      manifest?: string;
      packsDir?: string;
    }) => {
      try {
        const home = homeOf();
        if (opts.plan !== undefined) {
          if (opts.protocol !== undefined || opts.target !== undefined) {
            throw new RunnerError('usage', '--plan takes its protocol and target from the plan');
          }
          const result = await runPlan(opts.plan, {
            home,
            ...(opts.offline === true ? { offline: true } : {}),
            ...(opts.manifest !== undefined ? { manifest: opts.manifest } : {}),
            ...(opts.packsDir !== undefined ? { packsDir: opts.packsDir } : {}),
          });
          printRun(result);
          return;
        }
        if (opts.protocol === undefined || opts.target === undefined) {
          throw new RunnerError(
            'usage',
            'required option --protocol <ref> and --target <url> (or --plan <plan_id>) not specified',
          );
        }
        const prices = parsePrices(opts.price);
        const options: RunOptions = {
          home,
          protocol: opts.protocol,
          target: opts.target,
          planned: opts.planned,
          context: opts.context,
          targetKind: opts.targetKind,
          sharingPolicy: opts.share,
          timeoutMs: opts.timeoutMs,
          maxTokens: opts.maxTokens,
          ...(prices !== undefined ? { prices } : {}),
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          ...(opts.apiKeyEnv !== undefined ? { apiKeyEnv: opts.apiKeyEnv } : {}),
          ...(opts.investigation !== undefined ? { investigationId: opts.investigation } : {}),
          ...(opts.offline === true ? { offline: true } : {}),
          ...(opts.manifest !== undefined ? { manifest: opts.manifest } : {}),
          ...(opts.packsDir !== undefined ? { packsDir: opts.packsDir } : {}),
        };
        printRun(await run(options));
      } catch (e) {
        fail(e);
      }
    },
  );

program
  .command('report [run_id]')
  .description(
    'local-only report from the vault for one run or (--protocol) every run of a protocol; Markdown, or JSON with --json',
  )
  .option('--protocol <ref>', 'report every vault run of this protocol')
  .option('--json', 'print the report as JSON')
  .option('--packs-dir <dir>', 'directory holding domain packs (for claims.json)')
  .action(
    (runId: string | undefined, opts: { protocol?: string; json?: boolean; packsDir?: string }) => {
      try {
        const result = report({
          home: homeOf(),
          ...(runId !== undefined ? { runId } : {}),
          ...(opts.protocol !== undefined ? { protocol: opts.protocol } : {}),
          ...(opts.packsDir !== undefined ? { packsDir: opts.packsDir } : {}),
        });
        out(opts.json === true ? JSON.stringify(result, null, 2) : renderMarkdown(result));
      } catch (e) {
        fail(e);
      }
    },
  );

program
  .command('preview <run_id>')
  .description(
    'sign the sanitized run, dry-run intake, store the preview id; prints what will be sent',
  )
  .option('--share <policy>', 'override the sharing policy: private | cooperative', sharing)
  .action(async (runId: string, opts: { share?: 'private' | 'cooperative' }) => {
    try {
      const result = await preview(runId, {
        home: homeOf(),
        ...(opts.share !== undefined ? { sharingPolicy: opts.share } : {}),
      });
      err(`preview ${result.preview_id} (expires ${result.expires_at})`);
      err(`content digest: ${result.content_digest}`);
      err(`sanitization: ${JSON.stringify(result.sanitization)}`);
      err(`would store: ${JSON.stringify(result.would_store)}`);
      err('body to be sent by "iwik submit":');
      out(JSON.stringify(result.body, null, 2));
    } catch (e) {
      fail(e);
    }
  });

program
  .command('submit <run_id>')
  .description('submit the previewed run; refuses without a stored preview; safe to rerun')
  .action(async (runId: string) => {
    try {
      const result = await submit(runId, { home: homeOf() });
      err(result.status === 201 ? 'accepted (201)' : `already accepted (${result.status})`);
      out(JSON.stringify(result.receipt, null, 2));
    } catch (e) {
      fail(e);
    }
  });

program
  .command('receipt <id>')
  .description('fetch and print a receipt')
  .action(async (id: string) => {
    try {
      out(JSON.stringify(await receipt(id, { home: homeOf() }), null, 2));
    } catch (e) {
      fail(e);
    }
  });

program
  .command('withdraw <run_id...>')
  .description(
    'withdraw your own runs from the cooperative (effective at the next evidence revision; cannot be undone); prints the withdrawal id',
  )
  .requiredOption(
    '--reason <code>',
    `reason code: ${WITHDRAWAL_REASON_CODES.join(' | ')}`,
    reasonCode,
  )
  .action(async (runIds: string[], opts: { reason: WithdrawalReasonCode }) => {
    try {
      const result = await withdraw(runIds, { home: homeOf(), reasonCode: opts.reason });
      err(
        `${result.status === 201 ? 'withdrawal recorded' : 'already withdrawn'}: ${result.run_ids.length} run(s), ` +
          `reason ${result.reason_code}, effective at evidence revision ${result.effective_revision}`,
      );
      err(
        'receipts issued for these protocols before that revision now read stale; delivered answers cannot be recalled',
      );
      out(result.withdrawal_id);
    } catch (e) {
      fail(e);
    }
  });

program
  .command('vault')
  .description('list runs in the vault with their preview and receipt state')
  .action(() => {
    try {
      const home = homeOf();
      for (const id of listRuns(home)) {
        let line = id;
        try {
          const meta = readMeta(home, id);
          line += ` ${meta.protocol_ref} ${meta.target.kind}`;
        } catch {
          line += ' (no metadata)';
        }
        const p = readPreview(home, id);
        const r = readReceipt(home, id);
        line += p === undefined ? ' unpreviewed' : ` preview:${p.preview_id}`;
        line += r === undefined ? ' unsubmitted' : ` receipt:${String(r['receipt_id'])}`;
        out(line);
      }
    } catch (e) {
      fail(e);
    }
  });

program
  .command('plans')
  .description('show a saved plan by id')
  .argument('<plan_id>')
  .action((planId: string) => {
    try {
      out(JSON.stringify(loadPlan(homeOf(), planId), null, 2));
    } catch (e) {
      fail(e);
    }
  });

program
  .command('mcp')
  .description('serve the agent tools over stdio (MCP); refuses unless IWIK_MCP_ENABLED is set')
  .option('--packs-dir <dir>', 'directory holding domain packs')
  .action(async (opts: { packsDir?: string }) => {
    try {
      await serveMcp({
        home: homeOf(),
        ...(opts.packsDir !== undefined ? { packsDir: opts.packsDir } : {}),
      });
    } catch (e) {
      fail(e);
    }
  });

program.parseAsync(process.argv).catch(fail);
