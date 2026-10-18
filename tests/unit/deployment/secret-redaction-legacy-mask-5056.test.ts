import { describe, it, expect } from 'vite-plus/test';
import {
  legacyLeavesWithoutMask,
  recordResolvedPair,
  mixedLiteralAnswered,
  redactForState,
  repairPhysicalNameCopyLeaves,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { recordProvenPublicExpression } from '../../../src/deployment/secret-redaction/mask-only.js';

// go-to-k/cdkd#5056 review: the legacy-spelling repair must never take a
// spelling that holds a mask as proof the value is unchanged, since a mask
// hides a rotation. Two halves: the state the review named (a 4+ character
// secret whose map survivor is the mask, beside a sub-floor pin and a public
// token) never reaches the repair at all, and the filter drops any legacy
// leaf holding a mask wherever one does reach it (the engine-level case, a
// public value spelling `***`, is in
// `deploy-engine-mixed-literal-legacy-repair-5056.test.ts`).

const HOST = '{{resolve:ssm:/db/host}}';
const PIN = '{{resolve:secretsmanager:pin:SecretString:pin}}';
const KEY = '{{resolve:secretsmanager:key:SecretString:key}}';
const source = { Url: `${HOST}/pin=${PIN}/key=${KEY}` };

function pass(key: string): RecordedSecretValues {
  const secrets: RecordedSecretValues = new Map();
  secrets.set('x9', PIN);
  recordResolvedPair(secrets, PIN, 'x9');
  recordResolvedPair(secrets, KEY, key);
  secrets.set(key, SECRET_MASK);
  recordProvenPublicExpression(secrets, HOST, 'db.example.com');
  return secrets;
}

describe('the legacy repair never trusts a masked spelling', () => {
  it('the named state: today\'s walk refuses the mixed arm, so no repair runs', () => {
    // The scan leaves an EMBEDDED mask-only value alone (the substring arm
    // excludes the mask class), while the bound expects its survivor `***`:
    // the two differ, the arm refuses, and `mixedLiteralAnswered` stays off.
    const secrets = pass('NEWKEYVALUE2');
    redactForState(
      { Url: 'db.example.com/pin=x9/key=NEWKEYVALUE2' },
      { provenance: 'template-derived', secrets, source, generation: 'same-generation' }
    );
    expect(mixedLiteralAnswered(secrets)).toBe(false);
  });

  it('a legacy leaf holding a mask is dropped, so the stored leaf is not repaired', () => {
    const stored = `db-${SECRET_MASK}.example.com/pin=x9`;
    const current = `db-${SECRET_MASK}.example.com/pin=${PIN}`;
    expect(repairPhysicalNameCopyLeaves(stored, stored, current)).toBe(current);
    const filtered = legacyLeavesWithoutMask({ Url: stored }) as Record<string, unknown>;
    expect(repairPhysicalNameCopyLeaves(stored, filtered['Url'], current)).toBe(stored);
  });

  it('keeps every leaf without a mask, at every depth', () => {
    expect(
      legacyLeavesWithoutMask({ A: 'a/pin=x9', B: ['ok', `x${SECRET_MASK}`], C: { D: SECRET_MASK }, E: 1 })
    ).toEqual({ A: 'a/pin=x9', B: ['ok', undefined], C: { D: undefined }, E: 1 });
  });
});
