import { referenceProvenanceOf } from '../../reference-provenance-record.js';
import { passProvenanceFor } from '../../secret-redaction/reference-provenance.js';
import { dynamicReferenceTokens, type RecordedSecretValues } from '../../secret-redaction.js';

/**
 * The `{{resolve:...}}` tokens anywhere in `value` (go-to-k/cdkd#7037), for
 * remembering what a legacy-spelling repair rewrote.
 */
export function tokensIn(value: unknown): string[] {
  if (value === undefined) return [];
  return dynamicReferenceTokens(JSON.stringify(value) ?? '');
}

/**
 * Did any of `tokens` move to another secret VERSION since `record` was
 * written (go-to-k/cdkd#7037, the rotation edge)? Only where both sides say:
 * the record's `referenceProvenance` lists the versions it was written at, and
 * this pass's `secrets` recorded the one it was served now, outside that list.
 *
 * A repair renders the record's token with TODAY's plaintext. After a
 * rotation that equality says nothing about what AWS holds, so a caller that
 * would drop a change on it keeps the change instead. A record with no
 * provenance (written before schema v12) cannot say, and is repaired as
 * before.
 */
export function tokenVersionMoved(
  record: unknown,
  tokens: Iterable<string>,
  secrets: RecordedSecretValues
): boolean {
  const recorded = referenceProvenanceOf(record);
  if (recorded === undefined) return false;
  for (const token of tokens) {
    const was = recorded[token]?.versions;
    const now = passProvenanceFor(secrets, token)?.versions;
    if (was === undefined || was.length === 0 || now === undefined || now.length === 0) continue;
    if (!now.some((version) => was.includes(version))) return true;
  }
  return false;
}
