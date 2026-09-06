// Signing payload and content digest (contracts/member-api.md, "Wire details"):
// the JCS canonical form of the Run with `submission.signature` removed and
// with no `org_ref` member. This mirrors the service's intake so the digest
// the node signs is the digest the preview binds.
import { createHash } from 'node:crypto';
import type { Run } from '@iwik/contracts';
import { canonicalize } from '@iwik/contracts';

export function signingPayload(run: Run): string {
  const body: Record<string, unknown> = { ...run };
  delete body['org_ref'];
  const unsigned: Record<string, unknown> = { ...run.submission };
  delete unsigned['signature'];
  body['submission'] = unsigned;
  return canonicalize(body);
}

export function contentDigest(run: Run): string {
  return 'sha256:' + createHash('sha256').update(signingPayload(run), 'utf8').digest('hex');
}
