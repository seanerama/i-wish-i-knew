// `iwik report --cooperative` and the rendering behind query_evidence (stage
// 9): the released conformance fixture renders every section, the suppression
// explanations and next steps are fixed text with no causal language, and the
// CLI drives POST /v1/evidence/query against the fake service.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { AnswerReceipt } from '@iwik/contracts';
import {
  COOPERATIVE_HEADER,
  nextStepFor,
  queryCooperative,
  renderReceipt,
  RunnerError,
  SUPPRESSION_EXPLANATIONS,
} from '../src/index.js';
import { cleanupTemp, cliPath, fakeService, makeHome, repoRoot } from './helpers.js';

after(cleanupTemp);

const CAUSAL_WORDS = /\b(because|caused|causes|cause|due to)\b/i;

/** The CLI in its own process: the fake service lives in this one, so never spawnSync. */
function iwik(home: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [cliPath, '--home', home, ...args], {
      env: { PATH: process.env['PATH'] ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function fixture(): AnswerReceipt {
  return JSON.parse(
    readFileSync(
      join(repoRoot, 'contracts', 'fixtures', 'v1', 'receipt.released-latency-v1.valid.json'),
      'utf8',
    ),
  ) as AnswerReceipt;
}

/** The receipt with no `result` member at all (not `result: undefined`). */
function withoutResult(receipt: AnswerReceipt): AnswerReceipt {
  const copy = { ...receipt };
  delete copy.result;
  return copy;
}

test('renderReceipt: a released receipt renders every section with the receipt’s own bands and spreads', () => {
  const receipt = fixture();
  const text = renderReceipt(receipt);
  assert.ok(text.startsWith(`# ${COOPERATIVE_HEADER}: released`));
  for (const heading of [
    '## Cohort',
    '## Findings',
    '## Applicability',
    '## Distributions',
    '## Uncertainty',
    '## Freshness',
    '## Contradictions',
    '## Missing-data accounting',
    '## Limitations',
    '## Your own evidence',
  ]) {
    assert.ok(text.includes(heading), heading);
  }
  assert.ok(text.includes('3-5 organizations, 5-10 runs'));
  assert.ok(text.includes('| p50 | 5-10 | 20 | 24 | 30 | 30 | 30 | 30 |'));
  assert.ok(text.includes('| value | 5-10 | 0.050 | 0.150 | 0.300 | 0.300 | 0.300 | 0.300 |'));
  assert.ok(text.includes('largest share of runs <=50%'));
  assert.ok(text.includes('Tail claims (minimum 20 runs): not supported'));
  assert.ok(text.includes('- Oldest run received: 2026-09-01'));
  assert.ok(text.includes('non-overlapping interquartile ranges'));
  assert.ok(
    text.includes(
      '120 planned, 120 attempted, 99 succeeded, 21 failed, <11 excluded, <11 unobserved',
    ),
  );
  assert.ok(text.includes('| 01ARZ3NDEKTSV4RRFFQ69G5FAV |'));
  assert.ok(text.includes('| private, fixture |'));
  assert.doesNotMatch(text, CAUSAL_WORDS);
  assert.ok(!text.includes('## Why nothing cooperative was released'));

  // stale: the warning is rendered before any number
  const stale = renderReceipt({ ...receipt, status: 'stale' });
  assert.ok(stale.includes('**Stale**'));
  assert.ok(stale.indexOf('**Stale**') < stale.indexOf('## Findings'));
});

test('renderReceipt and nextStepFor: suppressed and insufficient receipts explain each reason without a cause', () => {
  const base = fixture();
  const own = base.result?.own_evidence;
  assert.ok(own);
  const suppressed: AnswerReceipt = {
    ...base,
    status: 'suppressed',
    cohort: { ...base.cohort, orgs: '<3', runs: '5-10' },
    suppression_reasons: ['min_orgs'],
    result: { own_evidence: own },
  };
  const text = renderReceipt(suppressed);
  assert.ok(text.startsWith(`# ${COOPERATIVE_HEADER}: suppressed`));
  assert.ok(text.includes('## Why nothing cooperative was released'));
  assert.ok(text.includes('`min_orgs`: Fewer than three organizations'));
  assert.ok(!text.includes('## Distributions'));
  assert.ok(text.includes('## Your own evidence'));
  assert.doesNotMatch(text, CAUSAL_WORDS);
  const step = nextStepFor(suppressed, 'inference-api/latency@1');
  assert.match(step, /Wait until more organizations contribute/);
  assert.match(step, /plan_test/);
  assert.match(step, /Your own 2 run\(s\)/);
  assert.match(step, new RegExp(`get_receipt ${base.receipt_id}`));

  for (const reason of Object.keys(SUPPRESSION_EXPLANATIONS)) {
    assert.doesNotMatch(
      SUPPRESSION_EXPLANATIONS[reason as keyof typeof SUPPRESSION_EXPLANATIONS],
      CAUSAL_WORDS,
    );
  }
  const each = (reasons: NonNullable<AnswerReceipt['suppression_reasons']>) =>
    nextStepFor({ ...withoutResult(suppressed), suppression_reasons: reasons }, 'p/q@1');
  assert.match(each(['differencing']), /Do not narrow further/);
  assert.match(each(['cohort_too_large']), /Narrow the context filters/);
  assert.match(each(['concentration']), /no single one dominates/);
  assert.match(each(['min_runs']), /more organizations contribute compatible runs/);
  const insufficient = nextStepFor(
    {
      ...withoutResult(suppressed),
      status: 'insufficient_evidence',
      suppression_reasons: ['no_cooperative_evidence'],
    },
    'p/q@1',
  );
  assert.match(insufficient, /no shareable evidence/);
  assert.ok(!insufficient.includes('Your own'));
  const empty = renderReceipt(withoutResult(suppressed));
  assert.ok(empty.includes('_Your organization has no runs for this protocol._'));
});

test('queryCooperative and iwik report --cooperative against the fake service: the query body, the receipt, the exit status', async () => {
  const service = await fakeService();
  try {
    const { home } = makeHome(service.url);
    const receipt = await queryCooperative({
      home,
      protocol: 'inference-api/latency@1',
      context: { client_region: 'eu-west', concurrency: 1 },
      asOfRevision: 3,
    });
    assert.equal(receipt.status, 'insufficient_evidence');
    assert.deepEqual(service.queries[0], {
      protocol_ref: 'inference-api/latency@1',
      context_filters: { client_region: 'eu-west', concurrency: 1 },
      as_of_revision: 3,
    });
    await assert.rejects(
      queryCooperative({ home, protocol: 'nope', context: {} }),
      (e: unknown) => e instanceof RunnerError && e.code === 'api_error',
    );

    const cli = await iwik(home, [
      'report',
      '--cooperative',
      '--protocol',
      'inference-api/latency@1',
      '--context',
      'client_region=eu-west',
      '--context',
      'concurrency=1',
    ]);
    assert.equal(cli.code, 0, cli.stdout + cli.stderr);
    assert.ok(cli.stdout.startsWith(`# ${COOPERATIVE_HEADER}: insufficient_evidence`));
    assert.match(cli.stdout, /`no_cooperative_evidence`: No member has shared/);
    assert.match(cli.stderr, /insufficient_evidence: no_cooperative_evidence \(receipt /);
    assert.deepEqual(service.queries[2], {
      protocol_ref: 'inference-api/latency@1',
      context_filters: { client_region: 'eu-west', concurrency: 1 },
    });

    const json = await iwik(home, [
      'report',
      '--cooperative',
      '--protocol',
      'inference-api/latency@1',
      '--json',
    ]);
    assert.equal(json.code, 0, json.stderr);
    assert.equal((JSON.parse(json.stdout) as AnswerReceipt).status, 'insufficient_evidence');

    const usage = await iwik(home, ['report', '--cooperative']);
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /needs --protocol/);
  } finally {
    await service.close();
  }
});
