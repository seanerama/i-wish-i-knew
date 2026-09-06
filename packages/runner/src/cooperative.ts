// `iwik report --cooperative` and the rendering behind `query_evidence`
// (stage 9; contracts/member-api.md `POST /v1/evidence/query`,
// contracts/evidence-envelope.md `AnswerReceipt`). The node asks the
// cooperative for a compatible cohort's released aggregates and renders the
// receipt section by section: applicability, ranges, uncertainty, freshness,
// contradictions, missing-data accounting, limitations, the caller's own
// evidence, and the suppression explanation when nothing cooperative was
// released. Every number shown is the receipt's own (bands and spreads);
// nothing is pooled, recomputed, or explained away here.
import type { AnswerReceipt, ContextValue, Spread, SuppressionReason } from '@iwik/contracts';
import { validate } from '@iwik/contracts';
import { ApiClient } from './client.js';
import { RunnerError } from './errors.js';
import { loadConfig, loadToken, resolveHome } from './home.js';
import type { ClientOptions } from './submit.js';

export const COOPERATIVE_HEADER = 'Cooperative evidence';

export interface CooperativeQueryOptions extends ClientOptions {
  protocol: string;
  context?: Record<string, ContextValue>;
  asOfRevision?: number;
  investigationId?: string;
}

/** POST /v1/evidence/query; the receipt as the service answered it (any status). */
export async function queryCooperative(options: CooperativeQueryOptions): Promise<AnswerReceipt> {
  const home = resolveHome(options.home, options.env);
  const config = loadConfig(home);
  const client = new ApiClient(config.service_url, loadToken(home), options.fetch);
  const body: Record<string, unknown> = {
    protocol_ref: options.protocol,
    context_filters: options.context ?? {},
  };
  if (options.asOfRevision !== undefined) body['as_of_revision'] = options.asOfRevision;
  if (options.investigationId !== undefined) body['investigation_id'] = options.investigationId;
  const res = await client.post<unknown>('/v1/evidence/query', body);
  const check = validate('AnswerReceipt', res.body);
  if (!check.ok) {
    throw new RunnerError(
      'api_error',
      'the service answered with something that is not an AnswerReceipt',
      check.errors,
    );
  }
  return res.body as AnswerReceipt;
}

/** What each suppression reason means for the member, in fixed words. */
export const SUPPRESSION_EXPLANATIONS: Record<SuppressionReason, string> = {
  no_cooperative_evidence: 'No member has shared a comparable measurement yet.',
  min_orgs: 'Fewer than three organizations contributed compatible runs.',
  min_runs: 'Fewer than five compatible runs exist.',
  concentration: 'One organization supplied more than half of the compatible runs.',
  differencing:
    'The cohort differs from an earlier release by fewer than three organizations; releasing it could expose a contributor.',
  cohort_too_large:
    'More compatible runs exist than the service computes over in one answer; narrow the filters.',
};

/** The operator-facing next step for a non-released answer. */
export function nextStepFor(receipt: AnswerReceipt, protocolRef: string): string {
  const reasons = receipt.suppression_reasons ?? [];
  const own = receipt.result?.own_evidence;
  const ownNote =
    own !== undefined && own.runs.length > 0
      ? ` Your own ${own.runs.length} run(s) for this protocol are listed under result.own_evidence (${own.compatible} compatible with this query).`
      : '';
  const local = `To resolve it locally: call plan_test with protocol_ref ${protocolRef}, the target, and the question; the operator runs the returned iwik run --plan command, and iwik report <run_id> shows the local result.`;
  const reread = `Re-read this receipt later with get_receipt ${receipt.receipt_id}.`;
  if (receipt.status === 'insufficient_evidence' || reasons.includes('no_cooperative_evidence')) {
    return `Tell the user honestly that the commons has no shareable evidence for this question yet.${ownNote} ${local} ${reread}`;
  }
  if (reasons.includes('cohort_too_large')) {
    return `Narrow the context filters (add another required_context key) so the cohort fits in one answer, then query again.${ownNote} ${reread}`;
  }
  if (reasons.includes('differencing')) {
    return `Do not narrow further: repeat the earlier, broader query instead, or wait until at least three more organizations contribute.${ownNote} ${reread}`;
  }
  const waiting = reasons.includes('concentration')
    ? 'Wait until more organizations contribute so no single one dominates'
    : 'Wait until more organizations contribute compatible runs';
  return `Evidence exists but releasing it could expose a contributor (${reasons.join(', ')}). ${waiting}, or broaden the context filters.${ownNote} ${local} ${reread}`;
}

function fmt(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3);
  return String(value);
}

function spreadRow(label: string, s: Spread): string {
  return `| ${label} | ${s.n} | ${fmt(s.min)} | ${fmt(s.p50)} | ${fmt(s.p90)} | ${fmt(s.p95)} | ${fmt(s.p99)} | ${fmt(s.max)} |`;
}

/** Markdown rendering of an AnswerReceipt, every section the receipt carries. */
export function renderReceipt(receipt: AnswerReceipt): string {
  const lines: string[] = [];
  const r = receipt.result;
  const reasons = receipt.suppression_reasons ?? [];
  lines.push(`# ${COOPERATIVE_HEADER}: ${receipt.status}`);
  lines.push('');
  lines.push(
    `Protocol: \`${receipt.cohort.protocol_ref}\` · receipt \`${receipt.receipt_id}\` · evidence revision ${receipt.evidence_revision} · issued ${receipt.issued_at}`,
  );
  lines.push(
    `Calculation: \`${receipt.calculation_version}\` · policy: \`${receipt.policy_version}\` · query digest \`${receipt.query_digest}\``,
  );
  lines.push('');
  lines.push('## Cohort');
  lines.push('');
  const filters = Object.entries(receipt.cohort.filters);
  lines.push(
    `Filters: ${filters.length === 0 ? '(none)' : filters.map(([k, v]) => `\`${k}\` = ${JSON.stringify(v)}`).join(', ')}`,
  );
  lines.push(
    `Cohort: ${receipt.cohort.orgs} organizations, ${receipt.cohort.runs} runs (bands, never exact counts).`,
  );
  lines.push('');
  if (receipt.status === 'stale') {
    lines.push(
      '**Stale**: a later evidence revision touched this protocol; query again before quoting any number below. Nothing here says what changed.',
    );
    lines.push('');
  }
  if (reasons.length > 0) {
    lines.push('## Why nothing cooperative was released');
    lines.push('');
    for (const reason of reasons) {
      lines.push(`- \`${reason}\`: ${SUPPRESSION_EXPLANATIONS[reason] ?? reason}`);
    }
    lines.push('');
  }
  if (r?.findings !== undefined && r.findings.length > 0) {
    lines.push('## Findings');
    lines.push('');
    for (const f of r.findings) {
      lines.push(`- **${f.claim}** (${f.status ?? 'released'}): ${f.statement ?? ''}`.trimEnd());
    }
    lines.push('');
  }
  if (r?.applicability !== undefined) {
    const a = r.applicability;
    lines.push('## Applicability');
    lines.push('');
    lines.push(
      `- Filters applied exactly: ${(a.filters_applied ?? []).map((k) => `\`${k}\``).join(', ') || '(none)'}`,
    );
    lines.push(
      `- Required context not filtered (the cohort varies across these): ${(a.unfiltered_required_context ?? []).map((k) => `\`${k}\``).join(', ') || '(none)'}`,
    );
    for (const [key, band] of Object.entries(a.context_known ?? {})) {
      lines.push(`- Runs knowing \`${key}\`: ${band}`);
    }
    if (a.ranking !== undefined) lines.push(`- Ranking: ${a.ranking}`);
    lines.push('');
  }
  if (r?.distributions !== undefined) {
    const d = r.distributions;
    lines.push('## Distributions');
    lines.push('');
    lines.push(
      'Spreads of per-run statistics across the contributing runs (nearest-rank percentiles); never a pooled number.',
    );
    if (d.contributors !== undefined) {
      lines.push(
        `Contributors: ${d.contributors.orgs} organizations; largest share of runs ${d.contributors.max_org_share}.`,
      );
    }
    lines.push('');
    for (const [claim, metrics] of Object.entries(d.claims ?? {})) {
      lines.push(`### ${claim}`);
      lines.push('');
      for (const [name, m] of Object.entries(metrics)) {
        lines.push(
          `**${name}**${m.unit !== undefined ? ` (${m.unit})` : ''}, ${m.kind}, ${m.runs} runs`,
        );
        lines.push('');
        lines.push('| per-run statistic | n | min | p50 | p90 | p95 | p99 | max |');
        lines.push('|---|---|---|---|---|---|---|---|');
        for (const [stat, s] of Object.entries(m.statistics ?? {})) lines.push(spreadRow(stat, s));
        if (m.values !== undefined) lines.push(spreadRow('value', m.values));
        lines.push('');
      }
    }
  }
  if (r?.uncertainty !== undefined) {
    const u = r.uncertainty;
    lines.push('## Uncertainty');
    lines.push('');
    if (u.detail !== undefined) lines.push(u.detail);
    if (u.tail_claims !== undefined) {
      lines.push(
        `Tail claims (minimum ${u.tail_claims.minimum_runs} runs): ${u.tail_claims.supported ? 'supported' : 'not supported'}. ${u.tail_claims.statement}`,
      );
    }
    lines.push('');
  }
  if (r?.freshness !== undefined) {
    const f = r.freshness;
    lines.push('## Freshness');
    lines.push('');
    if (f.oldest_received_on !== undefined)
      lines.push(`- Oldest run received: ${f.oldest_received_on}`);
    if (f.newest_received_on !== undefined)
      lines.push(`- Newest run received: ${f.newest_received_on}`);
    if (f.newest_run_at !== undefined) lines.push(`- Newest run: ${f.newest_run_at}`);
    lines.push(`- Evidence revision: ${receipt.evidence_revision}`);
    lines.push('');
  }
  if (r?.contradictions !== undefined) {
    lines.push('## Contradictions');
    lines.push('');
    if (r.contradictions.length === 0) {
      lines.push('_No contributing organizations disagree on a released statistic._');
    }
    for (const c of r.contradictions) {
      lines.push(`- **${c.claim} / ${c.metric} ${c.statistic}**: ${c.text}`);
    }
    lines.push('');
  }
  if (r?.missingness !== undefined) {
    const m = r.missingness;
    lines.push('## Missing-data accounting');
    lines.push('');
    if (m.attempts !== undefined) {
      const a = m.attempts;
      lines.push(
        `- Attempts across the cohort: ${a.planned} planned, ${a.attempted} attempted, ${a.succeeded} succeeded, ${a.failed} failed, ${a.excluded} excluded, ${a.unobserved} unobserved`,
      );
    }
    if (m.runs_with_unknown_context !== undefined) {
      lines.push(`- Runs with unknown required context: ${m.runs_with_unknown_context}`);
    }
    for (const [claim, band] of Object.entries(m.runs_below_claim_minimum ?? {})) {
      lines.push(`- Runs below the \`${claim}\` per-run minimum: ${band}`);
    }
    lines.push('');
  }
  if (r?.limitations !== undefined && r.limitations.length > 0) {
    lines.push('## Limitations');
    lines.push('');
    for (const l of r.limitations) lines.push(`- ${l}`);
    lines.push('');
  }
  lines.push('## Your own evidence');
  lines.push('');
  const own = r?.own_evidence;
  if (own === undefined || own.runs.length === 0) {
    lines.push('_Your organization has no runs for this protocol._');
  } else {
    lines.push(
      `${own.note} Compatible with this query: ${own.compatible}; in the cohort: ${own.in_cohort}.`,
    );
    lines.push('');
    lines.push('| run | received | status | sharing | compatible | in cohort | why not |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const run of own.runs) {
      lines.push(
        `| ${run.run_id} | ${run.received_at} | ${run.execution_status} | ${run.sharing_policy} | ${run.compatible ? 'yes' : 'no'} | ${run.in_cohort ? 'yes' : 'no'} | ${run.reasons.join(', ')} |`,
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}
