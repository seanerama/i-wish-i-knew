#!/usr/bin/env node
// Stage 14 local operations tooling. No product API, database access, or paid CI calls.
const fs = require('node:fs');
const path = require('node:path');
const hashing = require('node:crypto');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const root = path.resolve(__dirname, '..');
const protocol = 'inference-api/latency@1';
const members = ['A', 'B', 'C'];
const manualNames = [
  'enrollment',
  'console-released',
  'console-stale',
  'worker',
  'restored',
  'inventory',
];
const fixedNames = [
  'preflight',
  'initial',
  'two-orgs',
  'release',
  'replay',
  'surfaces',
  'prediction',
  'outcome',
  'second-outcome',
  'withdraw',
  'stale',
  'pinned',
  'flag-off',
  'cleanup',
];
const reasons = [
  'no_cooperative_evidence',
  'min_orgs',
  'min_runs',
  'concentration',
  'differencing',
  'cohort_too_large',
];
const frictionNames = [
  'none',
  'enrollment',
  'approval',
  'context',
  'dedupe',
  'receipt-navigation',
  'prediction',
  'withdrawal',
  'restart-pacing',
  'budget',
  'other',
];
const now = () => new Date().toISOString();
const digest = (value) => hashing.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function read(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function write(file, value) {
  const temp = `${file}.tmp`;
  const fd = fs.openSync(temp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
  const dir = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(dir);
  } finally {
    fs.closeSync(dir);
  }
}
function need(condition, code = 'prerequisite_missing') {
  if (!condition) {
    const error = new Error(code);
    error.scenarioCode = code;
    throw error;
  }
}
function safeCode(error) {
  const code = error.scenarioCode ?? error.apiCode ?? error.code;
  return [
    'prerequisite_missing',
    'ambiguous_write',
    'budget_exhausted',
    'config_changed',
    'approval_required',
    'outcome_exists',
    'prediction_immutable',
    'preview_expired',
    'preview_mismatch',
    'run_conflict',
    'policy_denied',
    'scope_required',
    'validation_failed',
    'feature_disabled',
  ].includes(code)
    ? code
    : 'step_failed';
}
function init(directory, configFile) {
  const dir = path.resolve(directory);
  need(!fs.existsSync(dir), 'config_changed');
  const config = read(configFile);
  fs.mkdirSync(dir, { mode: 0o700, recursive: true });
  fs.chmodSync(dir, 0o700);
  write(path.join(dir, 'scenario.json'), config);
  write(path.join(dir, 'journal.json'), {
    schema: 1,
    started_at: now(),
    config_digest: digest(config),
    steps: {},
    reservations: {},
    friction: [],
    errors: [],
  });
  return dir;
}
function open(directory) {
  const dir = path.resolve(directory);
  const config = read(path.join(dir, 'scenario.json'));
  const journal = read(path.join(dir, 'journal.json'));
  need(journal.config_digest === digest(config), 'config_changed');
  return { dir, config, journal };
}
const validStep = (name) =>
  fixedNames.includes(name) ||
  manualNames.includes(name) ||
  /^(plan|run|local|preview|approve)-[ABC][1-9][0-9]*$/.test(name) ||
  /^(plan|run|local)-followup$/.test(name);
function requiredSteps(journal) {
  const contributions = members.flatMap((m) =>
    Object.keys(journal.steps).filter(
      (k) =>
        k.startsWith(`approve-${m}`) &&
        journal.steps[k].status === 'pass' &&
        journal.steps[k].data?.receipt?.status === 'accepted',
    ),
  );
  return [
    ...fixedNames,
    ...manualNames,
    'plan-followup',
    'run-followup',
    'local-followup',
    ...contributions,
  ];
}
function renderReport({ config, journal }) {
  // Deliberately never interpolate operator text, paths, URLs, IDs, response text or raw errors.
  const complete =
    config.mode === 'live' &&
    journal.friction.length > 0 &&
    requiredSteps(journal).every((k) => journal.steps[k]?.status === 'pass');
  const safeHex = (s, pattern) => (typeof s === 'string' && pattern.test(s) ? s : 'unrecorded');
  const rows = Object.entries(journal.steps)
    .filter(([k]) => validStep(k))
    .map(([k, s]) => {
      const status = ['pass', 'fail', 'incomplete', 'pending'].includes(s.status)
        ? s.status
        : 'incomplete';
      const code = s.error ? safeCode({ scenarioCode: s.error.code }) : '-';
      const suppression =
        (s.data?.suppression_reasons ?? []).filter((v) => reasons.includes(v)).join(', ') || '-';
      return `| ${k} | ${status} | ${Number.isFinite(s.elapsed_ms) ? s.elapsed_ms : 0} | ${code} | ${suppression} | [restricted artifact](./private/${k}.json) |`;
    });
  for (const k of requiredSteps(journal))
    if (!journal.steps[k])
      rows.push(`| ${k} | incomplete | 0 | prerequisite_missing | - | pending |`);
  const reserved = Object.values(journal.reservations);
  const sum = (key) => reserved.reduce((n, v) => n + (Number.isFinite(v[key]) ? v[key] : 0), 0);
  const versions = journal.steps.preflight?.data;
  const friction = journal.friction.map(
    (f) =>
      `- ${frictionNames.includes(f.category) ? f.category : 'other'}: ${['minor', 'delay', 'blocked'].includes(f.impact) ? f.impact : 'blocked'}; restricted detail retained.`,
  );
  return [
    '# Cooperative investigation execution report',
    '',
    `Result: ${complete ? 'single live cycle complete; second cycle requires its own report' : 'INCOMPLETE live acceptance'}.`,
    `Provenance: ${config.mode === 'live' ? 'operator-controlled service measurements; simulated demo membership' : 'CI fixture execution / isolated synthetic regression only; never live measurements'}.`,
    'Two completed live reports are required for stage acceptance. No independent real-member replication, predictive usefulness, held-out decision-quality study, or service-level target is established.',
    '',
    `Commit: ${safeHex(config.commit, /^[a-f0-9]{40}$/)}.`,
    `Image digest: ${safeHex(config.image?.split('@')[1], /^sha256:[a-f0-9]{64}$/)}.`,
    `Protocol: ${protocol}; digest: ${safeHex(versions?.protocol_digest, /^sha256:[a-f0-9]{64}$/)}; harness: ${safeHex(versions?.harness_digest, /^sha256:[a-f0-9]{64}$/)}.`,
    'Calculation: latency-v1; policy: 2026-09-p1 (released receipts checked against these versions).',
    `Started: ${safeHex(journal.started_at, /^\d{4}-\d\d-\d\dT[\d:.]+Z$/)}; report generated: ${now()}.`,
    `Elapsed investigation time (ms, including human pauses): ${Math.max(0, Date.now() - Date.parse(journal.started_at))}.`,
    `Reserved executions: ${reserved.length}; requests: ${sum('requests')}; estimated upper-bound USD: ${sum('usd')}.`,
    'Cost basis: planned × (64 × prompt USD/1M tokens + max_tokens × completion USD/1M tokens) / 1,000,000. Operator prices and individual estimates are restricted. Fixture estimates are zero. Reservations survive interruption; estimates are not measured invoices. Measured billed cost: unrecorded.',
    'Per-step milliseconds below distinguish run execution, local reporting, and query answer latency. Failed execution reservations remain charged against the local budget.',
    '',
    '| Step | Status | Elapsed ms | Submission/error code | Suppression reasons | Evidence |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
    'Restricted artifacts are logical links into the private bundle; share only this report. Keep journal.json, scenario.json, runner homes, recordings, and raw responses access-controlled. Identifying question, workload, thresholds, context, prices, and remaining-data inventory are in that bundle.',
    '',
    'Six qualifying runs retain the unsupported-tail-claim limitation. Actual agreement/contradiction is retained in the restricted receipt; deterministic synthetic contradiction regression is reported separately.',
    '',
    'Error history (retained after a successful retry):',
    ...(journal.errors ?? []).map((e, i) =>
      validStep(e.step)
        ? `- ${e.step}: ${safeCode({ scenarioCode: e.error?.code })}; [restricted failure](./private/failure-${i + 1}.json).`
        : '- Unrecognized private checkpoint.',
    ),
    '',
    'Observed friction:',
    ...(friction.length ? friction : ['- Not yet recorded; this is not evidence of no friction.']),
    '',
  ].join('\n');
}
async function execute(directory, name, argument) {
  need(validStep(name));
  const dir = path.resolve(directory);
  const lock = path.join(dir, '.lock');
  // Exclusive writer; after an interrupted process the Operator verifies it is dead before removing this lock.
  const fd = fs.openSync(lock, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, started_at: now() }));
  fs.closeSync(fd);
  let state;
  try {
    state = open(dir);
    const { journal } = state;
    const old = journal.steps[name];
    if (
      old?.status === 'pass' &&
      name !== 'cleanup' &&
      !(name.startsWith('preview-') && argument === '--refresh')
    )
      return old.data;
    const retrySafe =
      /^(approve-|preview-)/.test(name) ||
      [
        'replay',
        'withdraw',
        'cleanup',
        'initial',
        'two-orgs',
        'release',
        'stale',
        'pinned',
        'flag-off',
        'preflight',
        'surfaces',
        'second-outcome',
      ].includes(name) ||
      manualNames.includes(name);
    need(!old || old.status !== 'pending' || retrySafe, 'ambiguous_write');
    need(!old?.ambiguous || retrySafe, 'ambiguous_write');
    journal.steps[name] = {
      status: 'pending',
      started_at: now(),
      ...(old?.intent ? { intent: true } : {}),
    };
    const save = () => write(path.join(dir, 'journal.json'), journal);
    save();
    const started = Date.now();
    try {
      const data = await action(state, name, argument, save);
      journal.steps[name] = {
        ...journal.steps[name],
        status: 'pass',
        elapsed_ms: Date.now() - started,
        data,
      };
      fs.mkdirSync(path.join(dir, 'private'), { recursive: true, mode: 0o700 });
      write(path.join(dir, 'private', `${name}.json`), journal.steps[name]);
      save();
      return data;
    } catch (error) {
      journal.steps[name] = {
        ...journal.steps[name],
        status: error.scenarioCode ? 'incomplete' : 'fail',
        elapsed_ms: Date.now() - started,
        ambiguous: !retrySafe && journal.steps[name].intent === true,
        error: { code: safeCode(error), detail: String(error.stack ?? error) },
      };
      fs.mkdirSync(path.join(dir, 'private'), { recursive: true, mode: 0o700 });
      journal.errors ??= [];
      journal.errors.push({ step: name, ...journal.steps[name] });
      write(
        path.join(dir, 'private', `failure-${journal.errors.length}.json`),
        journal.steps[name],
      );
      write(path.join(dir, 'private', `${name}.json`), journal.steps[name]);
      save();
      throw error;
    } finally {
      write(path.join(dir, 'report.md'), renderReport(state));
    }
  } finally {
    fs.unlinkSync(lock);
  }
}
async function action(state, name, argument, save) {
  const { config: c, journal: j } = state;
  const runner = await import('i-wish-i-knew');
  const passed = (key) => {
    need(j.steps[key]?.status === 'pass');
    return j.steps[key].data;
  };
  const home = (member = 'A') => {
    need(members.includes(member));
    return c.homes[member];
  };
  const timedFetch = (input, init) =>
    globalThis.fetch(input, { ...init, signal: AbortSignal.timeout(30000) });
  const options = (member = 'A') => ({ home: home(member), fetch: timedFetch });
  const query = (member = 'A', revision) =>
    runner.queryCooperative({
      ...options(member),
      protocol,
      context: c.filters,
      ...(revision === undefined ? {} : { asOfRevision: revision }),
    });
  const intent = () => {
    j.steps[name].intent = true;
    save();
  };
  const submits = (member) =>
    Object.entries(j.steps)
      .filter(([k, s]) => k.startsWith(`approve-${member}`) && s.status === 'pass')
      .map(([, s]) => s.data.receipt);
  const eligible = (member) =>
    Object.entries(j.steps)
      .filter(
        ([k, s]) =>
          k.startsWith(`approve-${member}`) && s.status === 'pass' && s.data.qualifying === true,
      )
      .map(([, s]) => s.data.receipt);
  const privateScan = (value, foreign) => {
    const text = JSON.stringify(value);
    for (const id of foreign) need(!text.includes(id));
    need(!/"(?:org_ref|node_id)"/.test(text));
  };
  if (name === 'preflight') {
    need(['live', 'fixture-ci'].includes(c.mode));
    need(typeof c.question === 'string' && c.question.trim().length > 10);
    need(c.commit?.match(/^[a-f0-9]{40}$/));
    need(c.target && ['fixture', 'service'].includes(c.target.kind));
    need(typeof c.target.url === 'string' && c.target.url.length > 0);
    const target = new URL(c.target.url);
    need(['http:', 'https:'].includes(target.protocol) && !target.username && !target.password);
    need(
      Number.isInteger(c.planned) &&
        c.planned >= 10 &&
        Number.isInteger(c.max_tokens) &&
        c.max_tokens > 0,
    );
    need(Number.isInteger(c.timeout_ms) && c.timeout_ms > 0);
    need(
      Number.isInteger(c.budget?.max_runs) &&
        c.budget.max_runs >= 7 &&
        c.budget.max_runs <= 100 &&
        Number.isInteger(c.budget.max_requests) &&
        c.budget.max_requests >= c.planned * 7,
    );
    need(
      Number.isFinite(c.budget.max_usd) &&
        c.budget.max_usd >= 0 &&
        Number.isFinite(c.budget.max_elapsed_ms) &&
        c.budget.max_elapsed_ms > 0,
    );
    need(
      c.prediction?.metric === 'ttft_ms' ||
        c.prediction?.metric === 'total_ms' ||
        c.prediction?.metric === 'error_rate',
    );
    need(
      c.prediction.metric === 'error_rate'
        ? c.prediction.statistic === undefined
        : ['p50', 'p90', 'p95', 'p99'].includes(c.prediction.statistic),
    );
    need(
      ['below', 'above'].includes(c.prediction.comparator) && Number.isFinite(c.prediction.value),
    );
    need(
      /^\d{4}-\d\d-\d\d$/.test(c.prediction.horizon) &&
        Date.parse(c.prediction.horizon + 'T23:59:59Z') > Date.now(),
    );
    if (c.mode === 'live') {
      const stage13 = read(path.join(root, '.verity/evidence/stage-13-staging-2026-09-08.json'));
      need(
        c.target.kind === 'service' &&
          c.attestations?.non_fixture_service === true &&
          c.attestations?.operator_controlled === true &&
          c.attestations?.non_sensitive_inputs === true &&
          c.attestations?.accurate_context === true &&
          c.attestations?.isolated_demo_data === true &&
          c.attestations?.stage13_image_verified === true,
      );
      const restored = stage13.phases.find((p) => p.phase === 'restored-demo');
      need(
        stage13.status === 'passed' &&
          stage13.pending.length === 0 &&
          restored?.health_verified === true,
      );
      need(
        restored.containers.length === 2 &&
          restored.containers.every((v) => v.reference === c.image && v.running),
      );
      need(
        c.deployed_commit === stage13.intended_commit &&
          c.service_url === stage13.configuration.public_url,
      );
      need(c.runtime_evidence_file && fs.statSync(c.runtime_evidence_file).isFile());
      const runtime = read(c.runtime_evidence_file);
      need(
        runtime.image === c.image &&
          runtime.deployed_commit === c.deployed_commit &&
          runtime.service_url === c.service_url &&
          runtime.checked === true &&
          Number.isFinite(Date.parse(runtime.observed_at)) &&
          typeof runtime.notes === 'string',
      );
      for (const key of ['usd_per_1m_prompt_tokens', 'usd_per_1m_completion_tokens'])
        need(Number.isFinite(c.prices?.[key]) && c.prices[key] >= 0);
    } else {
      need(
        c.target.kind === 'fixture' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname),
      );
    }
    const identities = [];
    const keys = [];
    const tokens = [];
    const homes = members.map((m) => fs.realpathSync(home(m)));
    need(new Set(homes).size === 3);
    const manifests = [];
    for (const m of members) {
      const h = home(m);
      const cfg = runner.loadConfig(h);
      if (c.mode === 'live') need(cfg.service_url === c.service_url);
      if (c.mode === 'fixture-ci')
        need(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(cfg.service_url).hostname));
      identities.push(await runner.discoverNode(h, timedFetch));
      keys.push(runner.loadKey(runner.homePaths(h).key).pubkey);
      tokens.push(digest(runner.loadToken(h)));
      need(
        identities.at(-1).scopes.includes('query') &&
          identities.at(-1).scopes.includes('submit') &&
          identities.at(-1).scopes.includes('publish'),
      );
      runner.checkExecution(runner.loadPolicy(h), c.target.url);
      const client = new runner.ApiClient(cfg.service_url, runner.loadToken(h), timedFetch);
      manifests.push((await client.get(`/v1/protocols/${encodeURIComponent(protocol)}`)).body);
      const response = await fetch(cfg.service_url + '/', { signal: AbortSignal.timeout(10000) });
      const html = await response.text();
      for (const flag of [
        'intake',
        'enrollment',
        'dedupe',
        'cooperative-query',
        'challenge',
        'withdrawal',
      ])
        need(html.includes(`id="${flag}-state">enabled</dd>`));
    }
    need(
      new Set(identities.map((i) => i.org_display_name)).size === 3 &&
        new Set(identities.map((i) => i.node_id)).size === 3 &&
        new Set(keys).size === 3 &&
        new Set(tokens).size === 3,
    );
    const manifest = manifests[0];
    need(
      manifests.every(
        (m) =>
          m.protocol_digest === manifest.protocol_digest &&
          m.harness_digest === manifest.harness_digest,
      ),
    );
    const local = runner.loadLocalPack(
      runner.loadConfig(home()).packs_dir ?? runner.defaultPacksDir,
      protocol,
    );
    need(
      local.protocol_digest === manifest.protocol_digest &&
        local.harness_digest === manifest.harness_digest,
    );
    need(
      c.context?.['model.requested'] &&
        c.context?.client_region &&
        c.context?.concurrency === 1 &&
        c.context?.cache_disabled === true,
    );
    need(
      Object.keys(c.filters ?? {}).length > 0 &&
        Object.entries(c.filters).every(
          ([k, v]) =>
            manifest.required_context.includes(k) &&
            (c.context[k] === v || k === 'model.reported' || k === 'retry_policy'),
        ),
    );
    return {
      protocol_digest: manifest.protocol_digest,
      harness_digest: manifest.harness_digest,
      identities,
      image: c.image,
    };
  }
  passed('preflight');
  if (manualNames.includes(name)) {
    if (name === 'console-released') passed('surfaces');
    if (name === 'console-stale' || name === 'worker') passed('stale');
    if (name === 'restored') passed('flag-off');
    if (name === 'inventory') passed('cleanup');
    need(argument && fs.statSync(argument).isFile());
    const evidence = read(argument);
    need(
      evidence.checked === true &&
        typeof evidence.observed_at === 'string' &&
        Number.isFinite(Date.parse(evidence.observed_at)) &&
        typeof evidence.notes === 'string' &&
        evidence.notes.trim().length > 0 &&
        Array.isArray(evidence.artifacts) &&
        evidence.artifacts.length > 0,
    );
    const artifacts = evidence.artifacts.map((p) => {
      const bytes = fs.readFileSync(p);
      need(bytes.length > 0);
      return {
        location: path.resolve(p),
        sha256: hashing.createHash('sha256').update(bytes).digest('hex'),
      };
    });
    if (name === 'worker')
      need(
        evidence.job_kind === 'withdrawal_apply' &&
          evidence.withdrawal_id === passed('withdraw').withdrawal_id &&
          evidence.state === 'done' &&
          evidence.effective_revision === passed('withdraw').effective_revision &&
          typeof evidence.job_id === 'string',
      );
    if (name === 'restored') {
      const r = await query();
      need(r.calculation_version === 'latency-v1');
    }
    return { ...evidence, artifacts };
  }
  if (name === 'initial') {
    passed('enrollment');
    let local;
    try {
      local = runner.report({ ...options(), protocol });
    } catch (error) {
      if (error.code !== 'report_empty') throw error;
      local = { status: 'report_empty', runs: [] };
    }
    need(local.runs.length === 0);
    const receipt = await query();
    need(
      receipt.status === 'insufficient_evidence' &&
        (receipt.result?.own_evidence?.runs?.length ?? 0) === 0,
    );
    return { ...receipt, local };
  }
  const match = /^(plan|run|local|preview|approve)-([ABC][1-9][0-9]*|followup)$/.exec(name);
  if (match) {
    const [, verb, slot] = match;
    const member = slot === 'followup' ? 'A' : slot[0];
    if (slot === 'followup') passed('prediction');
    else passed('initial');
    if (verb === 'plan') {
      delete j.steps.inventory;
      save();
      if (slot.startsWith('C')) passed('two-orgs');
      if (slot !== 'followup') need(eligible(member).length < 2);
      need(!submits(member).some((s) => s.run_id === j.steps[`run-${slot}`]?.data?.run_id));
      return runner.plan({
        ...options(member),
        protocol,
        question: c.question,
        target: c.target.url,
        targetKind: c.target.kind,
        context: c.context,
        planned: c.planned,
        maxTokens: c.max_tokens,
        timeoutMs: c.timeout_ms,
        prices: c.prices,
        apiKeyEnv: c.api_key_env,
        sharingPolicy: slot === 'followup' ? 'private' : 'cooperative',
      });
    }
    const plan = passed(`plan-${slot}`);
    if (verb === 'run') {
      const currentPlan = { ...runner.loadPlan(home(member), plan.plan_id) };
      const recordedPlan = { ...plan };
      delete currentPlan.runs;
      delete recordedPlan.runs;
      assert.deepEqual(currentPlan, recordedPlan);
      const reservations = Object.values(j.reservations);
      const usd = plan.estimated_cost.amount;
      need(Number.isFinite(usd) && plan.execution.allowed, 'prerequisite_missing');
      const worstMs = (c.planned + 1) * c.timeout_ms + 10000;
      need(
        reservations.length < c.budget.max_runs &&
          reservations.reduce((n, r) => n + r.requests, 0) + c.planned <= c.budget.max_requests &&
          reservations.reduce((n, r) => n + r.usd, 0) + usd <= c.budget.max_usd &&
          Date.now() - Date.parse(j.started_at) + worstMs <= c.budget.max_elapsed_ms,
        'budget_exhausted',
      );
      delete j.steps.inventory;
      j.reservations[name] = { requests: c.planned, usd, worst_ms: worstMs, reserved_at: now() };
      intent();
      const result = await runner.runPlan(plan.plan_id, options(member));
      // Preserve failed/unobserved runs for honest local reporting; they never qualify automatically.
      return {
        run_id: result.run_id,
        execution_status: result.execution_status,
        accounting: result.accounting,
        vault_dir: result.vault_dir,
      };
    }
    const run = passed(`run-${slot}`);
    if (verb === 'local') return runner.report({ ...options(member), runId: run.run_id });
    passed(`local-${slot}`);
    if (verb === 'preview')
      return runner.preview(run.run_id, { ...options(member), sharingPolicy: 'cooperative' });
    passed(`preview-${slot}`);
    need(argument === '--approve', 'approval_required');
    delete j.steps.inventory;
    delete j.steps.cleanup;
    intent();
    const submitted = await runner.submit(run.run_id, options(member));
    const checked = await query(member);
    const own = checked.result?.own_evidence?.runs.find((v) => v.run_id === run.run_id);
    const local = passed(`local-${slot}`);
    const minima = local.claims
      .filter((v) => ['latency_distribution', 'error_rate'].includes(v.name))
      .every((v) => v.eligible_runs.includes(run.run_id));
    return {
      ...submitted,
      qualifying:
        submitted.receipt.status === 'accepted' &&
        submitted.receipt.sharing_policy === 'cooperative' &&
        own?.in_cohort === true &&
        minima,
      own_evidence: own ?? null,
    };
  }
  if (name === 'two-orgs') {
    need(eligible('A').length === 2 && eligible('B').length === 2 && submits('C').length === 0);
    const receipt = await query();
    need(receipt.status === 'suppressed' && receipt.suppression_reasons.includes('min_orgs'));
    return receipt;
  }
  if (name === 'release') {
    passed('two-orgs');
    need(members.every((m) => eligible(m).length === 2));
    need(new Set(members.flatMap((m) => eligible(m).map((r) => r.run_id))).size === 6);
    const receipts = [];
    for (const m of members) {
      const r = await query(m);
      need(r.status === 'released' && r.cohort.orgs === '3-5' && r.cohort.runs === '5-10');
      need(r.policy_version === '2026-09-p1' && r.calculation_version === 'latency-v1');
      need(r.result.uncertainty.tail_claims.supported === false);
      const own = r.result.own_evidence.runs.filter((v) => v.in_cohort);
      need(own.length === 2 && eligible(m).every((e) => own.some((v) => v.run_id === e.run_id)));
      const released = { ...r.result };
      delete released.own_evidence;
      privateScan(
        released,
        members.flatMap((v) => submits(v).map((e) => e.run_id)),
      );
      privateScan(
        r,
        members
          .filter((v) => v !== m)
          .flatMap((v) => [
            ...submits(v).map((e) => e.run_id),
            passed('preflight').identities[members.indexOf(v)].node_id,
            passed('preflight').identities[members.indexOf(v)].org_display_name,
          ]),
      );
      receipts.push(r);
    }
    return { ...receipts[0], member_receipts: receipts };
  }
  if (name === 'replay') {
    const original = eligible('A')[0] ?? submits('A')[0];
    need(original);
    const replay = await runner.submit(original.run_id, options());
    need(replay.status === 200);
    assert.deepEqual(replay.receipt, original);
    return replay;
  }
  if (name === 'surfaces') {
    const receipt = passed('release');
    const cli = path.join(root, 'packages/runner/dist/cli.js');
    const cliRead = await promisify(execFile)(
      process.execPath,
      [cli, '--home', home(), 'receipt', receipt.receipt_id],
      { timeout: 30000 },
    );
    const original = JSON.parse(cliRead.stdout);
    need(original.receipt_id === receipt.receipt_id && original.status === 'released');
    const contextArgs = Object.entries(c.filters).flatMap(([k, v]) => ['--context', `${k}=${v}`]);
    const report = await promisify(execFile)(
      process.execPath,
      [cli, '--home', home(), 'report', '--cooperative', '--protocol', protocol, ...contextArgs],
      { timeout: 30000 },
    );
    for (const title of [
      'Applicability',
      'Missing-data accounting',
      'Uncertainty',
      'Freshness',
      'Your own evidence',
    ])
      need(report.stdout.includes(title));
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const client = new Client({ name: 'iwik-stage14', version: '1' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, '--home', home(), 'mcp'],
      env: { PATH: process.env.PATH ?? '', IWIK_MCP_ENABLED: 'on' },
      stderr: 'pipe',
    });
    const envelope = (v) => JSON.parse(v.content.find((x) => x.type === 'text').text);
    let mcpRead, mcpQuery;
    try {
      await client.connect(transport);
      mcpRead = envelope(
        await client.callTool({
          name: 'get_receipt',
          arguments: { receipt_id: receipt.receipt_id },
        }),
      );
      mcpQuery = envelope(
        await client.callTool({
          name: 'query_evidence',
          arguments: { protocol_ref: protocol, context_filters: c.filters },
        }),
      );
    } finally {
      await client.close();
    }
    need(mcpRead.ok && mcpQuery.ok);
    assert.deepEqual(mcpRead.data.receipt, original);
    const comparable = (v) =>
      JSON.parse(JSON.stringify(v, (k, value) => (k === 'claim_id' ? undefined : value)));
    assert.deepEqual(comparable(mcpQuery.data.receipt.result), comparable(original.result));
    let foreign;
    try {
      await runner.receipt(receipt.receipt_id, options('B'));
    } catch (error) {
      foreign = error;
    }
    need(foreign?.status === 404);
    privateScan(foreign.body, [receipt.receipt_id, ...submits('A').map((r) => r.run_id)]);
    return {
      original,
      original_markdown: runner.renderReceipt(original),
      cli_report: report.stdout,
      mcpRead,
      mcpQuery,
      foreign_status: 404,
    };
  }
  if (name === 'prediction') {
    passed('console-released');
    const r = passed('release');
    const p = c.prediction;
    intent();
    return runner.predict({
      ...options(),
      receiptId: r.receipt_id,
      target: {
        claim: p.metric === 'error_rate' ? 'error_rate' : 'latency_distribution',
        metric: p.metric,
        ...(p.statistic ? { statistic: p.statistic, unit: 'ms' } : {}),
        comparator: p.comparator,
        value: p.value,
      },
      horizon: p.horizon,
      evaluationRule: 'own_measurement',
    });
  }
  if (name === 'outcome') {
    const prediction = passed('prediction');
    const run = passed('run-followup');
    const local = passed('local-followup');
    need(argument === 'changed' || argument === 'unchanged');
    const draft = runner.readDraft(home(), run.run_id);
    need(Date.parse(draft.started_at) > Date.parse(prediction.registered_at));
    const target = prediction.target;
    const metric = local.claims
      .find((v) => v.name === target.claim)
      ?.metrics.find((v) => v.name === target.metric);
    const entry = metric?.per_run.find((v) => v.run_id === run.run_id)?.value;
    const value = target.statistic ? entry?.[target.statistic] : entry;
    const eligibleRun = local.claims
      .find((v) => v.name === target.claim)
      ?.eligible_runs.includes(run.run_id);
    const conclusive =
      eligibleRun &&
      typeof value === 'number' &&
      Number.isFinite(value) &&
      Date.parse(draft.ended_at) <= Date.parse(prediction.horizon + 'T23:59:59Z');
    const result = !conclusive
      ? 'indeterminate'
      : (target.comparator === 'below' ? value < target.value : value > target.value)
        ? 'met'
        : 'not_met';
    intent();
    const outcome = await runner.outcome(prediction.prediction_id, {
      ...options(),
      result,
      environmentChanged: argument === 'changed',
      observedAt: draft.ended_at,
    });
    assert.deepEqual(outcome.prediction, prediction);
    return { ...outcome, local_evaluation_run_id: run.run_id, measured_value: value ?? null };
  }
  if (name === 'second-outcome') {
    const original = passed('outcome');
    let failure;
    try {
      await runner.outcome(original.prediction.prediction_id, {
        ...options(),
        result: original.observed.result,
        environmentChanged: original.observed.environment_changed,
      });
    } catch (error) {
      failure = error;
    }
    need(failure?.apiCode === 'outcome_exists' && failure.status === 409);
    return { code: 'outcome_exists', original_prediction: original.prediction };
  }
  if (name === 'withdraw') {
    passed('second-outcome');
    return runner.withdraw(
      submits('A').map((r) => r.run_id),
      options(),
    );
  }
  if (name === 'stale' || name === 'pinned') {
    passed('withdraw');
    const released = passed('release');
    const r = await query('A', name === 'pinned' ? released.evidence_revision : undefined);
    need(r.status === 'suppressed' && r.suppression_reasons.includes('min_orgs'));
    need(
      submits('A').every((s) =>
        r.result.own_evidence.runs.some(
          (v) => v.run_id === s.run_id && !v.in_cohort && v.reasons.includes('withdrawn'),
        ),
      ),
    );
    if (name === 'stale')
      need((await runner.receipt(released.receipt_id, options())).status === 'stale');
    return r;
  }
  if (name === 'flag-off') {
    passed('pinned');
    passed('console-stale');
    passed('worker');
    const r = await query();
    need(
      r.status === 'insufficient_evidence' &&
        r.suppression_reasons.includes('no_cooperative_evidence') &&
        r.calculation_version !== 'latency-v1',
    );
    return r;
  }
  if (name === 'cleanup') {
    // Available during failed/incomplete runs too: withdrawal is safe/idempotent on each recorded set.
    const remaining = [];
    for (const m of members) {
      const ids = new Set(submits(m).map((r) => r.run_id));
      // Lost submission responses still leave known local run IDs. Reconcile
      // their existence through the own-run route before idempotent cleanup.
      const cfg = runner.loadConfig(home(m));
      const client = new runner.ApiClient(cfg.service_url, runner.loadToken(home(m)), timedFetch);
      for (const [key, step] of Object.entries(j.steps)) {
        if (!key.startsWith(`approve-${m}`) || !step.intent) continue;
        const id = j.steps[key.replace('approve-', 'run-')]?.data?.run_id;
        if (!id || ids.has(id)) continue;
        try {
          await client.get(`/v1/runs/${id}`);
          ids.add(id);
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
      if (ids.size) remaining.push(await runner.withdraw([...ids], options(m)));
    }
    return {
      withdrawals: remaining,
      homes: c.homes,
      retained:
        'organizations, keys, tokens, private followup vault, receipts, predictions, outcomes, release history, withdrawal audit',
    };
  }
  throw new Error('unknown action');
}
function withLock(directory, fn) {
  const lock = path.join(path.resolve(directory), '.lock');
  const fd = fs.openSync(lock, 'wx', 0o600);
  fs.closeSync(fd);
  try {
    return fn();
  } finally {
    fs.unlinkSync(lock);
  }
}
async function main(argv) {
  const [command, directory, name, argument, evidenceFile] = argv;
  if (command === 'init') {
    init(directory, name);
    console.log('Prepared private scenario; preflight and live execution incomplete.');
    return;
  }
  if (command === 'report') {
    withLock(directory, () => {
      const state = open(directory);
      write(path.join(state.dir, 'report.md'), renderReport(state));
    });
    console.log('Sanitized report written; inspect it before sharing.');
    return;
  }
  if (command === 'step') {
    await execute(directory, name, argument);
    console.log(`PASS ${name}; restricted result saved in journal.json.`);
    return;
  }
  if (command === 'friction') {
    need(
      frictionNames.includes(name) &&
        ['minor', 'delay', 'blocked'].includes(argument) &&
        evidenceFile,
    );
    const evidence = read(evidenceFile);
    need(typeof evidence.notes === 'string' && evidence.notes.trim().length > 0);
    withLock(directory, () => {
      const state = open(directory);
      state.journal.friction.push({
        category: name,
        impact: argument,
        observed_at: now(),
        evidence_location: path.resolve(evidenceFile),
        notes: evidence.notes,
      });
      write(path.join(state.dir, 'journal.json'), state.journal);
      write(path.join(state.dir, 'report.md'), renderReport(state));
    });
    return;
  }
  throw new Error(
    'Usage: investigation.cjs init DIR CONFIG | step DIR NAME [ARG] | report DIR | friction DIR CATEGORY IMPACT EVIDENCE_JSON',
  );
}
module.exports = { init, open, execute, renderReport, main };
if (require.main === module)
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      `INCOMPLETE/FAIL: ${safeCode(error)}. See restricted journal and smoke/investigation.md recovery; do not repeat ambiguous writes.`,
    );
    process.exitCode = 1;
  });
