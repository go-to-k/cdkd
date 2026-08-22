/**
 * Issue #2176 — the shared pre-stringify secret walk.
 *
 * `maskDeep` was three hand-rolled copies (`elbv2-provider.ts`,
 * `cognito-provider.ts`, `sns-topic-provider.ts`) before this issue converged
 * them. The copies encode a security contract, and the third had already
 * DIVERGED — it carried no depth cap — so this suite pins the behaviour the
 * shared one now owes all three.
 *
 * Each case asserts the POSITIVE marker (the mask token is present) as well as
 * the negative (the plaintext is gone). "The plaintext is absent" alone is a
 * confluence point: it is equally true of a walk that dropped the value, threw,
 * or returned an empty structure.
 */
import { describe, expect, it } from 'vite-plus/test';

import {
  MASK_WALK_DEPTH_CAP_MARKER,
  MASK_WALK_MAX_DEPTH,
  maskDeep,
} from '../../../src/provisioning/masked-retry-logger.js';
import { createSecretMasker, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';

/**
 * The REAL shape: `Map<plaintext, the {{resolve:...}} expression it came from>`
 * (`RecordedSecretValues` in `secret-redaction.ts`). Built without a cast on
 * purpose — an earlier draft wrapped the value in `{ reference }` and cast the
 * map, which type-checked only because `maskSecretsInText` reads `size` / `has`
 * / `keys` and never the values, so the fixture could drift from the producer
 * without any test noticing.
 */
function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(values.map((v) => [v, `{{resolve:secretsmanager:${v}}}`]));
}

describe('maskDeep (issue #2176)', () => {
  it('masks a JSON-DOCUMENT secret that message-level masking cannot reach', () => {
    // The whole reason the walk runs BEFORE `JSON.stringify`: stringify escapes
    // `"` and `\`, so the plaintext no longer OCCURS in the finished line and a
    // mask applied afterwards is inert. This is every Secrets Manager JSON
    // document, i.e. the commonest real secret shape.
    const secret = '{"user":"admin","pw":"hunter2"}';
    const mask = createSecretMasker(bagOf(secret));

    const messageLevel = mask(`got ${JSON.stringify(secret)}`);
    expect(messageLevel, 'the pre-fix shape must still leak, or this suite proves nothing').toContain(
      'hunter2'
    );

    const walked = `got ${JSON.stringify(maskDeep(secret, mask))}`;
    expect(walked).not.toContain('hunter2');
    expect(walked).toBe(`got ${JSON.stringify(SECRET_MASK)}`);
  });

  it('masks a sub-MIN_NEEDLE_LENGTH secret by reaching the whole-value arm', () => {
    // A finished message is longer than the value inside it, so it can only
    // reach the SUBSTRING arm, which ignores needles under 4 characters. The
    // walk hands the masker each RAW leaf, which has no floor.
    const secret = 'abc';
    const mask = createSecretMasker(bagOf(secret));

    expect(mask(`Value '${secret}' at 'pin' failed`)).toContain("'abc'");
    expect(maskDeep(secret, mask)).toBe(SECRET_MASK);
  });

  it('masks string leaves nested in arrays and objects, and masks KEYS too', () => {
    const leaf = 'leaf-secret-value';
    const key = 'key-secret-value';
    const mask = createSecretMasker(bagOf(leaf, key));

    const walked = maskDeep({ [key]: ['plain', { deeper: leaf }] }, mask) as Record<
      string,
      unknown
    >;

    expect(Object.keys(walked)).toEqual([SECRET_MASK]);
    const [first, second] = walked[SECRET_MASK] as [unknown, Record<string, unknown>];
    // Negative control: a non-secret leaf is untouched, so the walk is masking
    // the recorded values rather than blanking everything it sees.
    expect(first).toBe('plain');
    expect(second['deeper']).toBe(SECRET_MASK);
  });

  it('leaves non-string scalars alone', () => {
    const mask = createSecretMasker(bagOf('s3cret'));
    expect(maskDeep(42, mask)).toBe(42);
    expect(maskDeep(true, mask)).toBe(true);
    expect(maskDeep(null, mask)).toBe(null);
    expect(maskDeep(undefined, mask)).toBe(undefined);
  });

  it('terminates on a SELF-REFERENTIAL bag instead of overflowing the stack', () => {
    // The divergence the convergence fixed: `sns-topic-provider.ts`'s private
    // copy had no depth cap, so this input recursed until the stack blew.
    // `name` is deliberately NOT a secret. An earlier revision made it one and
    // then asserted the marker appears somewhere in the output — which the
    // MASKED SECRET also satisfies, since both render as `***`. That case
    // passed even when the cap returned `undefined`, i.e. it missed the exact
    // mutation its own comment claimed it caught (round-2 reviewer, measured).
    const mask = createSecretMasker(bagOf('an-unrelated-secret'));
    const cyclic: Record<string, unknown> = { name: 'plain-name' };
    cyclic['self'] = cyclic;

    const walked = maskDeep(cyclic, mask) as Record<string, unknown>;
    // Terminated rather than overflowing, and the shallow leaf is untouched.
    expect(walked['name']).toBe('plain-name');
    // The cycle was cut by SUBSTITUTION, not by dropping the branch: the only
    // `***` that can appear here comes from the cap.
    expect(JSON.stringify(walked)).toContain(MASK_WALK_DEPTH_CAP_MARKER);
  });

  it('SUBSTITUTES at the depth cap rather than returning the subtree raw', () => {
    // The cap must fail CLOSED. Returning the container raw would stringify
    // every leaf and key below it in plaintext — silent disclosure — whereas
    // substituting is silent truncation (issue #2176 security review).
    //
    // The leaf is deliberately NOT a secret, and that is what makes this pin
    // the BOUNDARY. An earlier revision nested the secret itself and asserted
    // "no plaintext, marker present" on both sides of the cap — which is
    // vacuous, because a masked secret and the cap marker are the SAME token
    // (`***`), so the case passed with the cap set to 7 or 9 just as happily.
    // Measured, not reasoned: a round-2 reviewer re-ran the walk under three
    // cap values and all four assertions held. A non-secret leaf separates
    // them — it must survive VERBATIM at the cap and become the marker one
    // level deeper.
    //
    // What this does NOT fence, stated so nobody reads more into it: the cap's
    // VALUE. The nesting is built from `MASK_WALK_MAX_DEPTH`, so it moves with
    // the constant and the case stays green if the cap is retuned to 7 or 9 —
    // measured. That is deliberate (the value is a tuning knob, not a
    // contract); what IS fenced is the boundary's SHAPE. Probed: flipping `>=`
    // to `>` reds this case, and returning `undefined` at the cap reds it and
    // the cyclic case below.
    //
    // The `atCap` arm below also fences the walk's ORDERING (the string check
    // runs BEFORE the depth test). A separate case asserting "a secret leaf is
    // masked at any depth" was written for that and DELETED: a masked secret
    // and the cap marker are both `***`, so it passed with the order flipped —
    // the same confluence this case was rewritten to escape.
    const plain = 'sentinel-not-a-secret';
    const mask = createSecretMasker(bagOf('an-unrelated-secret'));

    const nest = (levels: number): unknown => {
      let v: unknown = plain;
      for (let i = 0; i < levels; i++) v = { nested: v };
      return v;
    };

    // AT the cap the walk still reaches the string, which is not a secret, so
    // it comes through untouched.
    const atCap = JSON.stringify(maskDeep(nest(MASK_WALK_MAX_DEPTH), mask));
    expect(atCap).toContain(plain);
    expect(atCap).not.toContain(MASK_WALK_DEPTH_CAP_MARKER);

    // One deeper the walk meets an OBJECT at the cap and substitutes.
    const past = JSON.stringify(maskDeep(nest(MASK_WALK_MAX_DEPTH + 1), mask));
    expect(past).not.toContain(plain);
    expect(past).toContain(MASK_WALK_DEPTH_CAP_MARKER);
  });

  it('keeps its depth-cap marker equal to SECRET_MASK', () => {
    // `masked-retry-logger.ts` is a LEAF module and deliberately does not import
    // `secret-redaction.ts`, so the marker is spelled twice. This is the fence
    // that keeps the two spellings from drifting apart.
    expect(MASK_WALK_DEPTH_CAP_MARKER).toBe(SECRET_MASK);
  });

  it('is idempotent, which is what lets a provider mask the value AND the message', () => {
    const secret = 'idempotence-probe-secret';
    const mask = createSecretMasker(bagOf(secret));
    const once = maskDeep({ a: secret }, mask);
    // Assert what the FIRST pass produced before asserting the second changes
    // nothing. Without this line the case passes under `maskDeep = (v) => v`,
    // under a constant-returning masker, and under a drop-everything walk —
    // it constrained nothing at all.
    expect(once).toEqual({ a: SECRET_MASK });
    expect(maskDeep(once, mask)).toEqual(once);
  });
});
