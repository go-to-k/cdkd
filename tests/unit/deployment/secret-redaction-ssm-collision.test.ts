import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import {
  redactSecretsForState,
  scrubResourceRecord,
  recordSecretExpression,
  forgetSecretExpression,
  isRecordedSecretExpression,
  clearRecordedSecretExpressions,
  STATE_SOURCED_READBACK_RULES,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

// Two DISTINCT SecureString ssm parameters that happen to hold the SAME value —
// a shared password rotated into two paths, which is ordinary rather than
// exotic. Unlike the #1904 secretsmanager pair, neither spelling reveals
// secret-ness: `{{resolve:ssm:...}}` is public config UNLESS the parameter's
// Type is SecureString, which only the GetParameter response settles.
const EXPR_A = '{{resolve:ssm:/app/db/password}}';
const EXPR_B = '{{resolve:ssm:/legacy/db/password}}';
const SHARED = 'one-and-the-same-secret';

describe('secret-redaction - SecureString ssm pair sharing one value (issue #1910)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  // The residue #1904 knowingly left open, pinned here so the fix below is
  // measured against a real starting point rather than an assumed one. The map
  // is keyed by the resolved plaintext, so the second `set` overwrites the
  // first and the surviving VALUE set — which is all `redactByPath` had —
  // contains only EXPR_B.
  it('collapses onto one expression when the pass has no expression SET', () => {
    const map: RecordedSecretValues = new Map();
    map.set(SHARED, EXPR_A);
    map.set(SHARED, EXPR_B);
    expect(map.size).toBe(1);

    const redacted = redactSecretsForState(
      { Variables: { A: SHARED, B: SHARED } },
      map,
      { Variables: { A: EXPR_A, B: EXPR_B } }
    ) as { Variables: Record<string, string> };

    // Nothing LEAKS either way — both leaves are redacted...
    expect(JSON.stringify(redacted)).not.toContain(SHARED);
    // ...but A is persisted holding B's expression. On the next deploy the
    // template's A resolves to EXPR_A and state says EXPR_B: a permanent
    // spurious UPDATE.
    expect(redacted.Variables['A']).toBe(EXPR_B);
    expect(redacted.Variables['B']).toBe(EXPR_B);
  });

  it('keeps each leaf on ITS OWN expression once the resolver records both', () => {
    // What the resolver now does on each SecureString verdict.
    recordSecretExpression(EXPR_A);
    recordSecretExpression(EXPR_B);

    const map: RecordedSecretValues = new Map();
    map.set(SHARED, EXPR_A);
    map.set(SHARED, EXPR_B);

    const redacted = redactSecretsForState(
      { Variables: { A: SHARED, B: SHARED } },
      map,
      { Variables: { A: EXPR_A, B: EXPR_B } }
    ) as { Variables: Record<string, string> };

    expect(redacted.Variables['A']).toBe(EXPR_A);
    expect(redacted.Variables['B']).toBe(EXPR_B);
    expect(JSON.stringify(redacted)).not.toContain(SHARED);
  });

  // The direction that would be a SECURITY regression if the set were treated
  // as "any ssm expression is fine to persist": a plain String / StringList
  // parameter is public config that #1901 requires stay RESOLVED in state, and
  // it is never recorded, so it must still fall through.
  it('does NOT persist an ssm expression that was never recorded (#1901)', () => {
    recordSecretExpression(EXPR_A);
    const PUBLIC_EXPR = '{{resolve:ssm:/app/public-host}}';

    const redacted = redactSecretsForState(
      { Host: 'db.example.com', Password: SHARED },
      new Map([[SHARED, EXPR_A]]),
      { Host: PUBLIC_EXPR, Password: EXPR_A }
    ) as Record<string, string>;

    expect(redacted['Host']).toBe('db.example.com');
    expect(redacted['Password']).toBe(EXPR_A);
  });

  // The resolver's verdict can go the other way: a parameter first seen as
  // unknown and then proven to be a plain String must be FORGOTTEN, or the
  // stale verdict would keep persisting public config as an expression.
  it('forgets a verdict, restoring the #1901 behavior for that expression', () => {
    // Asserted in BOTH directions on purpose: the post-forget half alone also
    // passes when the recorded arm never fires at all, so it would be satisfied
    // by the very regression this file exists to catch.
    const redactOnce = () =>
      (redactSecretsForState({ A: 'plain-config' }, new Map(), { A: EXPR_A }) as Record<
        string,
        string
      >)['A'];

    recordSecretExpression(EXPR_A);
    expect(isRecordedSecretExpression(EXPR_A)).toBe(true);
    expect(redactOnce()).toBe(EXPR_A);

    forgetSecretExpression(EXPR_A);
    expect(isRecordedSecretExpression(EXPR_A)).toBe(false);
    expect(redactOnce()).toBe('plain-config');
  });

  // The set must NOT widen the STATE-sourced arm, which already trusts any
  // expression it finds (#1900) — this pins that the two mechanisms compose
  // rather than one masking the other.
  it('still redacts an observed readback from the record itself with no map', () => {
    recordSecretExpression(EXPR_A);
    const redacted = scrubResourceRecord(
      {
        properties: { Password: EXPR_A },
        observedProperties: { Password: SHARED },
      },
      new Map()
    );
    expect(redacted.observedProperties?.['Password']).toBe(EXPR_A);
  });

  it('positions an observed readback against a STATE source unchanged', () => {
    const redacted = redactSecretsForState(
      { Password: SHARED },
      new Map(),
      { Password: EXPR_B },
      STATE_SOURCED_READBACK_RULES
    ) as Record<string, string>;
    expect(redacted['Password']).toBe(EXPR_B);
  });
});
