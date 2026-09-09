/**
 * `secretSafeKeyDisplay` — how a state-bag KEY may be printed once it has been
 * tested for secret content (issue
 * [#2667](https://github.com/go-to-k/cdkd/issues/2667) review).
 *
 * An export name is a key of `state.outputs` AND of the exports index, and a
 * key holding secret plaintext is the residue `cdkd scrub` reports and cannot
 * rewrite (issue #1919). The exports-index repair names entries in `info` /
 * `warn` lines and in its failure message, and `--dry-run --fail` prints them
 * on every run of the documented CI gate — into CI logs. `displaySafe` /
 * `stripControlChars` sanitise for a TERMINAL and mask nothing, so a name has
 * to come through here instead.
 *
 * The THIRD arm is the one a caller must not fold into the first: masking can
 * leave the text unchanged, and printing it then publishes the secret under a
 * label asserting it was masked — the invariant
 * `secretBearingExportNameWarning` states absolutely. No command-level case
 * reaches that arm, which is why it is exercised directly here.
 */

import { describe, it, expect } from 'vite-plus/test';
import { secretSafeKeyDisplay } from '../../../src/deployment/outputs-export-alias.js';
import { SECRET_MASK, type RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';

const SECRET = 'super-secret-plaintext-value';
const EXPR = '{{resolve:secretsmanager:my-secret:SecretString:password::}}';

function secrets(...pairs: Array<[string, string]>): RecordedSecretValues {
  return new Map(pairs.length > 0 ? pairs : [[SECRET, EXPR]]);
}

describe('secretSafeKeyDisplay', () => {
  it('SAFE: a key carrying no recorded secret is returned control-stripped', () => {
    expect(secretSafeKeyDisplay('MyStack:DbEndpoint', secrets())).toEqual({
      kind: 'safe',
      text: 'MyStack:DbEndpoint',
    });
  });

  it('SAFE: strips control bytes, which a template-controlled name can carry', () => {
    // An `Fn::Sub` export name is a RESOLVED, template-controlled value, so it
    // can carry ANSI / control bytes into a terminal.
    const shown = secretSafeKeyDisplay('alias\u001b[31m-red', secrets());
    expect(shown.kind).toBe('safe');
    expect(shown.kind === 'safe' && shown.text).not.toContain('\u001b');
  });

  it('MASKED: a key EMBEDDING a secret is masked, and the plaintext is gone', () => {
    const shown = secretSafeKeyDisplay(`alias-${SECRET}-suffix`, secrets());
    expect(shown.kind).toBe('masked');
    expect(shown.kind === 'masked' && shown.text).toBe(`alias-${SECRET_MASK}-suffix`);
    expect(JSON.stringify(shown)).not.toContain(SECRET);
  });

  it('MASKED: a key that IS the secret, whole', () => {
    const shown = secretSafeKeyDisplay(SECRET, secrets());
    expect(shown.kind).toBe('masked');
    expect(JSON.stringify(shown)).not.toContain(SECRET);
  });

  it('MASKED: a sub-floor secret still matches as the WHOLE key', () => {
    // `stateKeySecretExposure` bounds containment at `MIN_SECRET_NEEDLE`, so a
    // 3-character secret is matched only when it IS the whole key. Pinned
    // because that bound is what keeps the CI gate from flagging every key.
    const shown = secretSafeKeyDisplay('abc', secrets(['abc', EXPR]));
    expect(shown.kind).toBe('masked');
  });

  it('SAFE: a sub-floor secret EMBEDDED in a longer key is not matched', () => {
    // The other direction of the same bound — an over-eager scan here fails
    // the `--dry-run --fail` gate repo-wide, the availability failure the
    // export-name check was redesigned to avoid.
    expect(secretSafeKeyDisplay('abc-endpoint', secrets(['abc', EXPR])).kind).toBe('safe');
  });

  it('WITHHELD: a secret whose masking leaves the text unchanged yields no text', () => {
    // The degenerate case the third arm exists for: the recorded plaintext IS
    // the mask, so masking is a no-op and the "masked" label would be a lie.
    // The result carries NO text at all, so a caller cannot print it by
    // reaching for a field.
    const shown = secretSafeKeyDisplay(SECRET_MASK, secrets([SECRET_MASK, EXPR]));
    expect(shown).toEqual({ kind: 'withheld' });
    expect(Object.hasOwn(shown, 'text')).toBe(false);
  });

  it('longest-first, so a secret containing another is masked whole', () => {
    const outer = 'abcdef-secret';
    const inner = 'abcdef';
    const shown = secretSafeKeyDisplay(outer, secrets([inner, EXPR], [outer, EXPR]));
    expect(shown.kind).toBe('masked');
    // Not `***-secret`: the longer needle wins, so no fragment survives.
    expect(shown.kind === 'masked' && shown.text).toBe(SECRET_MASK);
  });
});
