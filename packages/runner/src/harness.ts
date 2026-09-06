// Harness execution (contracts/runner-pack.md "Invocation"): `node
// harness/index.js` as a child process with IWIK_INPUT, IWIK_OUTPUT and
// IWIK_ALLOWED_HOSTS, under the egress guard preloaded via NODE_OPTIONS. The
// child gets a minimal environment (never the runner's), its stdout and
// stderr go to vault files, and it is killed after the overall timeout.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { FILE_MODE } from './home.js';
import { runnerRoot } from './pack.js';

export const GUARD_PATH = resolve(runnerRoot, 'guard', 'egress-guard.cjs');

export interface SpawnOptions {
  harnessEntry: string;
  inputFile: string;
  outputDir: string;
  allowedHosts: string;
  egressLog: string;
  stdoutFile: string;
  stderrFile: string;
  /** Overall wall-clock limit for the harness process. */
  timeoutMs: number;
  /** Working directory for the child (the output directory by default). */
  cwd?: string;
}

export interface SpawnResult {
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  duration_ms: number;
  stderr_first_line: string | null;
}

/** The exact environment the harness sees; PATH is passed through for `node` resolution only. */
export function harnessEnv(options: SpawnOptions, env: NodeJS.ProcessEnv = process.env) {
  const guard = GUARD_PATH.includes(' ') ? `"${GUARD_PATH}"` : GUARD_PATH;
  const child: Record<string, string> = {
    PATH: env['PATH'] ?? '/usr/local/bin:/usr/bin:/bin',
    IWIK_INPUT: options.inputFile,
    IWIK_OUTPUT: options.outputDir,
    IWIK_ALLOWED_HOSTS: options.allowedHosts,
    IWIK_EGRESS_LOG: options.egressLog,
    NODE_OPTIONS: `--require ${guard}`,
  };
  for (const name of ['TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'SystemRoot']) {
    const value = env[name];
    if (value !== undefined) child[name] = value;
  }
  return child;
}

export function spawnHarness(options: SpawnOptions): Promise<SpawnResult> {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const stdout = createWriteStream(options.stdoutFile, { mode: FILE_MODE });
    const stderr = createWriteStream(options.stderrFile, { mode: FILE_MODE });
    let firstLine: string | null = null;
    let pending = '';
    let timedOut = false;

    const child = spawn(process.execPath, [options.harnessEntry], {
      cwd: options.cwd ?? options.outputDir,
      env: harnessEnv(options),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs);

    child.stdout.pipe(stdout);
    child.stderr.on('data', (chunk: Buffer) => {
      if (firstLine === null) {
        pending += chunk.toString('utf8');
        const nl = pending.indexOf('\n');
        if (nl !== -1) firstLine = pending.slice(0, nl);
      }
    });
    child.stderr.pipe(stderr);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (firstLine === null && pending.trim() !== '') firstLine = pending.trim();
      let open = 2;
      const done = (): void => {
        open -= 1;
        if (open === 0) {
          resolvePromise({
            exit_code: code,
            signal,
            timed_out: timedOut,
            duration_ms: Date.now() - started,
            stderr_first_line: firstLine,
          });
        }
      };
      stdout.end(done);
      stderr.end(done);
    });
  });
}
