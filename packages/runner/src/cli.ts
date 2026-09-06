// `iwik` command line (stage 3): init, policy, run, preview, submit, receipt.
// Every failure exits nonzero with a one-line reason on stderr; token and key
// material are never printed. Only `run` writes something to stdout that
// scripts capture: the run id.
import { Command, InvalidArgumentError } from 'commander';
import { isRunnerError, RunnerError } from './errors.js';
import { init, resolveHome } from './home.js';
import { loadPolicy, normalizeTargetEntry, savePolicy } from './policy.js';
import { run } from './run.js';
import type { RunOptions } from './run.js';
import { preview, receipt, submit } from './submit.js';
import { listRuns, readMeta, readPreview, readReceipt } from './vault.js';

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

function sharing(value: string): 'private' | 'cooperative' {
  if (value === 'private' || value === 'cooperative') return value;
  throw new InvalidArgumentError('sharing policy must be private or cooperative');
}

const program = new Command();
program
  .name('iwik')
  .description(
    'I Wish I Knew runner: run a protocol locally, preview, then submit sanitized evidence',
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

program
  .command('init')
  .description('create the runner home, generate the Ed25519 signing key, store the node token')
  .requiredOption('--service <url>', 'service base URL')
  .option('--token-file <path>', 'file containing the node token (copied to <home>/token, 0600)')
  .option('--node-id <ulid>', 'node id issued with the token')
  .option('--packs-dir <dir>', 'directory holding domain packs')
  .action((opts: { service: string; tokenFile?: string; nodeId?: string; packsDir?: string }) => {
    try {
      const result = init({
        home: homeOf(),
        serviceUrl: opts.service,
        ...(opts.tokenFile !== undefined ? { tokenFile: opts.tokenFile } : {}),
        ...(opts.nodeId !== undefined ? { nodeId: opts.nodeId } : {}),
        ...(opts.packsDir !== undefined ? { packsDir: opts.packsDir } : {}),
      });
      err(`home: ${result.home}`);
      err(`service: ${result.service_url}`);
      err(`node id: ${result.node_id ?? '(not set; pass --node-id before running)'}`);
      err(`token: ${result.token_stored ? 'stored' : 'unchanged'}`);
      err(`signing key: ${result.key_created ? 'generated' : 'kept'} (key_id ${result.key_id})`);
      err('public key for enrollment (base64, raw Ed25519):');
      out(result.pubkey);
    } catch (e) {
      fail(e);
    }
  });

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
  .command('run')
  .description('execute one protocol against a target under local policy; prints the run id')
  .requiredOption('--protocol <ref>', 'protocol ref, e.g. inference-api/latency@1')
  .requiredOption('--target <url>', 'target base URL')
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
  .option('--investigation <ulid>', 'investigation id to attach')
  .option('--offline', "verify against the pack's own protocol.json instead of the registry")
  .option('--manifest <file>', 'verify against a saved GET /v1/protocols/{ref} body')
  .option('--packs-dir <dir>', 'directory holding domain packs')
  .action(
    async (opts: {
      protocol: string;
      target: string;
      planned: number;
      context: string[];
      targetKind: 'service' | 'fixture' | 'device';
      share: 'private' | 'cooperative';
      model?: string;
      apiKeyEnv?: string;
      timeoutMs: number;
      maxTokens: number;
      investigation?: string;
      offline?: boolean;
      manifest?: string;
      packsDir?: string;
    }) => {
      try {
        const options: RunOptions = {
          home: homeOf(),
          protocol: opts.protocol,
          target: opts.target,
          planned: opts.planned,
          context: opts.context,
          targetKind: opts.targetKind,
          sharingPolicy: opts.share,
          timeoutMs: opts.timeoutMs,
          maxTokens: opts.maxTokens,
          ...(opts.model !== undefined ? { model: opts.model } : {}),
          ...(opts.apiKeyEnv !== undefined ? { apiKeyEnv: opts.apiKeyEnv } : {}),
          ...(opts.investigation !== undefined ? { investigationId: opts.investigation } : {}),
          ...(opts.offline === true ? { offline: true } : {}),
          ...(opts.manifest !== undefined ? { manifest: opts.manifest } : {}),
          ...(opts.packsDir !== undefined ? { packsDir: opts.packsDir } : {}),
        };
        const result = await run(options);
        const a = result.accounting;
        err(
          `run ${result.run_id}: ${result.execution_status}` +
            (result.exclusion_reason !== undefined ? ` (${result.exclusion_reason})` : '') +
            ` planned=${a.planned} attempted=${a.attempted} succeeded=${a.succeeded} failed=${a.failed}` +
            ` excluded=${a.excluded} unobserved=${a.unobserved}`,
        );
        for (const o of result.context_overrides) {
          err(
            `context override: ${o.key} operator value replaced by harness ${o.harness_origin} value`,
          );
        }
        for (const issue of result.issues) err(`note: ${issue}`);
        err(`vault: ${result.vault_dir}`);
        out(result.run_id);
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

program.parseAsync(process.argv).catch(fail);
