// `iwik report`: a local-only report from the vault whose header states its
// limits, whose JSON validates against schema/local-report.schema.json, and
// whose claims follow the pack's claims.json (spread across runs, never a
// pooled number; excluded runs count in accounting only).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, test } from 'node:test';
import {
  renderMarkdown,
  report,
  REPORT_HEADER,
  run,
  RunnerError,
  validateReport,
} from '../src/index.js';
import type { LocalReport } from '../src/index.js';
import { allow, cleanupTemp, cliPath, makeHome, OPERATOR_CONTEXT, startStub } from './helpers.js';

const PROTOCOL = 'inference-api/latency@1';
const closers: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const close of closers.splice(0)) await close();
  cleanupTemp();
});

function iwik(home: string, args: string[]) {
  const res = spawnSync(process.execPath, [cliPath, '--home', home, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '' },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, all: res.stdout + res.stderr };
}

test('report: header states local-only, JSON validates, claims derive from claims.json, exclusions are accounting only', async () => {
  const stub = await startStub({ delayMs: 2, errorRate: 0.2, seed: 21 });
  closers.push(() => stub.close());
  const { home } = makeHome();
  allow(home, `127.0.0.1:${stub.port}`);
  const good = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 12,
    offline: true,
    targetKind: 'fixture',
    context: OPERATOR_CONTEXT,
  });
  assert.equal(good.execution_status, 'succeeded');
  const small = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 3,
    offline: true,
    targetKind: 'fixture',
    context: OPERATOR_CONTEXT,
  });
  assert.equal(small.execution_status, 'succeeded');
  const excluded = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 2,
    offline: true,
    targetKind: 'fixture',
    context: { ...OPERATOR_CONTEXT, concurrency: 2 },
  });
  assert.equal(excluded.execution_status, 'excluded');
  const partial = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 2,
    offline: true,
    targetKind: 'fixture',
    context: { 'model.requested': 'stub-model', concurrency: 1 },
  });
  assert.equal(partial.exclusion_reason, 'required_context_unknown');

  const one = report({ home, runId: good.run_id });
  assert.equal(one.header, REPORT_HEADER);
  assert.equal(one.header, 'Local evidence only — not corroborated by the cooperative');
  assert.equal(one.scope, 'local');
  assert.equal(one.corroboration, 'unreplicated');
  assert.deepEqual(validateReport(one), []);
  assert.equal(one.runs.length, 1);
  assert.equal(one.protocol_ref, PROTOCOL);

  const all = report({ home, protocol: PROTOCOL });
  assert.deepEqual(validateReport(all), []);
  assert.equal(all.runs.length, 4);
  assert.deepEqual(all.accounting.runs, {
    total: 4,
    succeeded: 2,
    failed: 0,
    excluded: 2,
    unobserved: 0,
  });
  assert.equal(all.accounting.attempts.planned, 12 + 3 + 2 + 2);
  // the exit-2 run made no attempts (2 excluded); the unknown-context run made its 2
  assert.equal(all.accounting.attempts.attempted, 17);
  assert.equal(all.accounting.attempts.excluded, 2);

  assert.deepEqual(
    all.claims.map((c) => c.name),
    ['latency_distribution', 'error_rate'],
  );
  const latency = all.claims[0] as LocalReport['claims'][number];
  assert.equal(latency.minimum_per_run, '10 succeeded attempts');
  assert.deepEqual(latency.eligible_runs, [good.run_id]);
  assert.deepEqual(latency.below_minimum_runs, [small.run_id]);
  assert.deepEqual(
    latency.metrics.map((m) => [m.name, m.kind, m.unit]),
    [
      ['ttft_ms', 'distribution', 'ms'],
      ['total_ms', 'distribution', 'ms'],
    ],
  );
  const ttft = latency.metrics[0] as LocalReport['claims'][number]['metrics'][number];
  assert.equal(ttft.per_run.length, 1);
  const dist = ttft.per_run[0]?.value as { samples: number; p50: number; p99: number };
  assert.equal(dist.samples, good.accounting.succeeded);
  assert.ok(dist.p50 > 0 && dist.p99 >= dist.p50);
  const across = ttft.across_runs as {
    runs: number;
    p50: { runs: number; min: number; max: number };
  };
  assert.equal(across.runs, 1);
  assert.equal(across.p50.min, dist.p50);
  assert.equal(across.p50.max, dist.p50);
  const errorRate = all.claims[1] as LocalReport['claims'][number];
  assert.equal(errorRate.minimum_per_run, '10 attempts');
  assert.deepEqual(errorRate.eligible_runs, [good.run_id]);
  const rate = errorRate.metrics[0] as LocalReport['claims'][number]['metrics'][number];
  assert.equal(rate.kind, 'rate');
  assert.equal(rate.per_run[0]?.value, good.accounting.failed / good.accounting.attempted);
  const breakdown = errorRate.metrics[1] as LocalReport['claims'][number]['metrics'][number];
  assert.equal(breakdown.kind, 'breakdown');
  assert.equal(
    (breakdown.across_runs['totals'] as Record<string, number>)['http_5xx'] ?? 0,
    good.accounting.failed,
  );

  // the exit-2 run never wrote context.json, so its harness-measured keys are unknown too
  assert.deepEqual(all.missing_context, [
    { key: 'cache_disabled', runs: [partial.run_id] },
    { key: 'client_region', runs: [partial.run_id] },
    { key: 'model.reported', runs: [excluded.run_id] },
    { key: 'retry_policy', runs: [excluded.run_id] },
  ]);
  assert.ok(all.limitations.some((l) => /fixture target/.test(l)));
  assert.ok(all.limitations.some((l) => /Excluded, failed, and unobserved runs/.test(l)));
  const excludedRow = all.runs.find((r) => r.run_id === excluded.run_id);
  assert.equal(excludedRow?.exclusion_reason, 'harness_protocol_violation');
  assert.match(excludedRow?.exclusion_detail ?? '', /concurrency = 1/);
  assert.equal(excludedRow?.submitted, false);

  const md = renderMarkdown(all);
  assert.ok(md.startsWith(`# ${REPORT_HEADER}\n`));
  assert.match(md, /## Claims \(permitted by the protocol\)/);
  assert.match(md, /### latency_distribution/);
  assert.match(md, /across 1 runs \(min\.\.max\)/);
  assert.match(md, /## Missing context/);
  assert.match(md, /`cache_disabled` unknown in 1 run/);
  assert.match(md, /## Limitations/);

  // CLI: markdown by default, JSON with --json; an empty vault is an error
  const cli = iwik(home, ['report', good.run_id]);
  assert.equal(cli.code, 0, cli.all);
  assert.ok(cli.stdout.startsWith(`# ${REPORT_HEADER}`));
  const json = iwik(home, ['report', '--protocol', PROTOCOL, '--json']);
  assert.equal(json.code, 0, json.all);
  const parsed = JSON.parse(json.stdout) as LocalReport;
  assert.equal(parsed.header, REPORT_HEADER);
  assert.deepEqual(validateReport(parsed), []);
  assert.equal(parsed.runs.length, 4);
  const none = iwik(home, ['report', '--protocol', 'other-pack/none@1']);
  assert.equal(none.code, 6);
  assert.match(none.stderr, /^iwik: report_empty: /);
  const both = iwik(home, ['report', good.run_id, '--protocol', PROTOCOL]);
  assert.equal(both.code, 2);
  assert.throws(
    () => report({ home, runId: '01ARZ3NDEKTSV4RRFFQ69G5ZZZ' }),
    (e: unknown) => e instanceof RunnerError && e.code === 'run_not_found',
  );
  // nothing in the report names the target
  assert.ok(!json.stdout.includes(stub.url));
});
