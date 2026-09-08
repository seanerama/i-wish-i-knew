const { test } = require('node:test');
const assert = require('node:assert/strict');

test('worker probe only enqueues maintenance and observes identifier-only completion', async () => {
  const { probe } = await import('../staging/worker-probe.mjs');
  const lines = [];
  const pool = {
    query: async (sql, values) => {
      assert.equal(sql, 'SELECT state, attempts FROM jobs WHERE job_id = $1');
      assert.deepEqual(values, ['probe-id']);
      return { rows: [{ state: 'done', attempts: 1 }] };
    },
  };
  const id = await probe(
    pool,
    async (db, input) => {
      assert.equal(db, pool);
      assert.equal(input.kind, 'reap_previews');
      assert.match(input.idempotency_key, /^staging-probe:/);
      assert.equal(input.payload, undefined);
      return { job_id: 'probe-id' };
    },
    { emit: (line) => lines.push(JSON.parse(line)) },
  );
  assert.equal(id, 'probe-id');
  assert.deepEqual(lines, [
    { job_id: id, kind: 'reap_previews', state: 'enqueued' },
    { job_id: id, kind: 'reap_previews', state: 'done', attempts: 1 },
  ]);
});

test('failed jobs and bounded timeout cannot report successful worker proof', async () => {
  const { probe } = await import('../staging/worker-probe.mjs');
  for (const state of ['failed', 'queued']) {
    const lines = [];
    await assert.rejects(
      probe(
        { query: async () => ({ rows: [{ state, attempts: 5 }] }) },
        async () => ({ job_id: 'probe-id' }),
        { timeoutMs: 15, emit: (line) => lines.push(JSON.parse(line)) },
      ),
      new RegExp(state === 'failed' ? 'probe failed' : 'probe timed out'),
    );
    assert.equal(
      lines.some((line) => line.state === 'done'),
      false,
    );
  }
});
