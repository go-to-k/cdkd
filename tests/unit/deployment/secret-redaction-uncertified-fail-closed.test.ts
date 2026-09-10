/**
 * THE READBACK POSITION WALK FAILS CLOSED — issues
 * [#2852](https://github.com/go-to-k/cdkd/issues/2852),
 * [#2846](https://github.com/go-to-k/cdkd/issues/2846) and
 * [#2869](https://github.com/go-to-k/cdkd/issues/2869).
 *
 * `refuseUncertifiedReadbackPositions` substitutes the source expression only at
 * positions it can CERTIFY. At every branch it could not certify it returned the
 * BAG — the DECRYPTED readback — so "this pairing is not evidence" and "this
 * plaintext is safe to write to `state.json`" were the same answer, and the
 * GHSA-p5qg-v9gv-hc7w disclosure survived through the two empty-map readback
 * writers (`cdkd state refresh-observed` and `cdkd import`'s observed capture)
 * plus a plain `cdkd deploy`'s `drainObservedCaptures` baseline.
 *
 * WHAT THE THREE ISSUES SHARE is one decision — what the walk does at a
 * position it cannot certify — which is why they are fixed together: three
 * separate answers to that question would contradict each other.
 *
 * THE ANSWER, and the two halves are asserted apart throughout this file:
 *
 *  - the source is still NOT substituted. Writing it would fabricate a baseline
 *    AWS never reported, which `cdkd drift --revert` pushes to the live
 *    resource — the issue #1915 / #1917 / #1498 bar the first attempt at these
 *    rows failed. Every case here asserts the expression is absent.
 *  - the readback is not persisted either. Every STRING leaf the SOURCE SUBTREE
 *    does not itself spell becomes `SECRET_MASK`, a value the persisted-state
 *    consumers already model (`drift.ts`'s `collectSecretMaskPaths` /
 *    `preserveLiveValuesAtMaskedLeaves`, `runAccept`'s refusal,
 *    `rollback-executor.ts`'s `refuseMaskedReplayBaseline`).
 *
 * The tests are written against `redactSecretsForState` in the configuration
 * the writers reach it in — an EMPTY map plus `STATE_SOURCED_BASELINE_RULES` —
 * and through `scrubResourceRecord`, which is the call `cdkd state
 * refresh-observed` and the deploy persist choke point actually make.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import {
  redactSecretsForState,
  scrubResourceRecord,
  clearRecordedSecretExpressions,
  STATE_SOURCED_READBACK_RULES,
  STATE_SOURCED_BASELINE_RULES,
  STATE_SOURCED_CROSS_GENERATION_RULES,
  TEMPLATE_SOURCED_RULES,
  SECRET_MASK,
} from '../../../src/deployment/secret-redaction.js';

const EXPR = '{{resolve:secretsmanager:app/db:SecretString:password}}';
const EXPR_2 = '{{resolve:secretsmanager:app/other:SecretString:password}}';
const PLAINTEXT = 'the-real-resolved-secret-value';
const PLAINTEXT_2 = 'the-other-resolved-secret-value';

/** The configuration every empty-map readback writer reaches this module in. */
const readback = (bag: unknown, source: unknown): Record<string, unknown> =>
  redactSecretsForState(
    bag,
    new Map<string, string>(),
    source,
    STATE_SOURCED_BASELINE_RULES
  ) as Record<string, unknown>;

describe('secret-redaction - the readback walk fails closed (issue #2852)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  // Each row is one line of the measurement pasted on issue #2852, whose verdict
  // column read LEAK. The needle assertion is the security property; the shape
  // assertion is the no-fabricated-baseline property, and neither implies the
  // other — an implementation returning `{}` satisfies the first alone.

  it('an ANCESTOR container reshaped object -> array no longer persists the plaintext', () => {
    const out = readback({ A: [PLAINTEXT] }, { A: { B: EXPR } });

    expect(out).toEqual({ A: [SECRET_MASK] });
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
    expect(JSON.stringify(out)).not.toContain(EXPR);
  });

  it('an ANCESTOR that gained a WRAPPER level no longer persists the plaintext', () => {
    const out = readback({ A: { B: { C: PLAINTEXT } } }, { A: { B: EXPR } });

    expect(out).toEqual({ A: { B: { C: SECRET_MASK } } });
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
  });

  it('a scalar source leaf promoted to a CONTAINER no longer persists the plaintext', () => {
    const out = readback({ A: { Nested: PLAINTEXT } }, { A: EXPR });

    expect(out).toEqual({ A: { Nested: SECRET_MASK } });
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
  });

  it('an identity key AWS CASE-normalised no longer persists its element in the clear', () => {
    // The keyed-array arm. `DB` finds no partner, and the source element that
    // carries the reference is left over with nothing pointing at it — which is
    // the evidence that its resolved plaintext is in this remainder.
    const out = readback(
      { Env: [{ Name: 'DB', Value: PLAINTEXT }] },
      { Env: [{ Name: 'db', Value: EXPR }] }
    );

    expect(out).toEqual({ Env: [{ Name: SECRET_MASK, Value: SECRET_MASK }] });
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
    expect(JSON.stringify(out)).not.toContain(EXPR);
  });

  it('an identity key AWS expanded to an ARN no longer persists its element in the clear', () => {
    // Second spelling of the same axis, because the axis is "does the identity
    // round-trip BYTE-identically", not "did AWS change the case".
    const out = readback(
      { I: [{ Name: 'arn:aws:x:::A', Value: PLAINTEXT }] },
      { I: [{ Name: 'A', Value: EXPR }] }
    );

    expect(out).toEqual({ I: [{ Name: SECRET_MASK, Value: SECRET_MASK }] });
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
  });

  it('an unkeyed array whose sibling literal AWS normalised no longer persists the plaintext', () => {
    const out = readback({ I: [PLAINTEXT, 'US-EAST-1'] }, { I: [EXPR, 'us-east-1'] });

    // The normalised literal is masked WITH the secret: once the anchors stop
    // corroborating, nothing tells them apart. Over-masking, on purpose.
    expect(out).toEqual({ I: [SECRET_MASK, SECRET_MASK] });
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
  });

  it('two LOOKALIKE reference elements no longer persist either plaintext', () => {
    const out = readback(
      { I: [{ V: PLAINTEXT }, { V: PLAINTEXT_2 }] },
      { I: [{ V: EXPR }, { V: EXPR_2 }] }
    );

    expect(out).toEqual({ I: [{ V: SECRET_MASK }, { V: SECRET_MASK }] });
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT_2);
  });

  it('a single bare-token element with no literal FRAME no longer persists the plaintext', () => {
    const out = readback({ I: [PLAINTEXT] }, { I: [EXPR] });

    expect(out).toEqual({ I: [SECRET_MASK] });
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
  });

  it('a RAW intrinsic source object against a STRING readback masks it (issue #2846)', () => {
    // `cdkd import`'s warn path deliberately persists the RAW intrinsic shape
    // when a reference names a resource outside the importable set, and says so
    // in its warning. `cdkd state refresh-observed` then walks a readback whose
    // leaf is a STRING against an `Fn::Join` OBJECT — the shape-divergence arm,
    // which persisted the decrypted value.
    const source = { Url: { 'Fn::Join': ['', ['postgres://u:', EXPR, '@h']] } };
    const out = readback({ Url: `postgres://u:${PLAINTEXT}@h` }, source);

    expect(out).toEqual({ Url: SECRET_MASK });
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
    // Not the intrinsic either: an `Fn::Join` object in a drift BASELINE is a
    // value AWS never reported, which is the fabrication half of the bar.
    expect(out['Url']).not.toEqual(source['Url']);
  });

  it('is IDEMPOTENT — a second pass over its own output moves nothing', () => {
    // The property `outputs-redaction-idempotence.test.ts` measures for the
    // outputs bag, restated for a refused position: a mask is a fixed point, so
    // a record re-walked by a later command cannot drift further.
    const source = { A: { B: EXPR } };
    const once = readback({ A: [PLAINTEXT] }, source);
    const twice = readback(once, source);

    expect(twice).toEqual(once);
  });
});

describe('secret-redaction - what the refusal must NOT take (issue #2852)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  it('leaves an ordinary readback untouched, extra AWS keys included', () => {
    // The cost bound. The walk descends only reference-bearing SOURCE subtrees,
    // so a resource with no dynamic reference cannot be masked at all — which is
    // what keeps the fail-closed change off the overwhelming majority of drift
    // baselines.
    const bag = { Runtime: 'nodejs22.x', LastModified: '2020-01-01', Tags: [{ Key: 'a' }] };
    const out = readback(bag, { Runtime: 'nodejs22.x' });

    expect(out).toEqual(bag);
  });

  it('does NOT mask an extra readback KEY beside a paired source key', () => {
    // The row #2852 lists that is DELIBERATELY still open, pinned so a later
    // widening has to face the cost rather than discover it. An extra key is the
    // NORM in an AWS readback (`Runtime`, `FunctionArn`, `LastModified`) and a
    // write-only credential AWS never echoes back (RDS `MasterUserPassword`)
    // leaves a reference-bearing SOURCE key unpaired on every single readback —
    // so keying a refusal on that would mask ordinary fields for every
    // secret-bearing resource in the account.
    // The extra key holds a SECRET-shaped value on purpose. An earlier revision
    // used `FunctionArn: 'arn:aws:lambda:::f'`, which made the open row READ as
    // safe — the case passed while saying nothing about the hazard. What is
    // actually open is this: a second plaintext, at a key the source does not
    // carry, is persisted.
    const out = readback({ pw: PLAINTEXT, Copy: PLAINTEXT_2 }, { pw: EXPR });

    expect(out).toEqual({ pw: EXPR, Copy: PLAINTEXT_2 });
    expect(JSON.stringify(out)).toContain(PLAINTEXT_2);
  });

  it('does NOT mask an AWS-ADDED array element when every source reference paired', () => {
    // The keyed arm's other direction. `db` pairs and is substituted, so the
    // source has no reference left over to account for — the extra element is a
    // peer AWS added and keeps its value.
    const out = readback(
      {
        Env: [
          { Name: 'db', Value: PLAINTEXT },
          { Name: 'aws-added', Value: 'ordinary' },
        ],
      },
      { Env: [{ Name: 'db', Value: EXPR }] }
    );

    expect(out).toEqual({
      Env: [
        { Name: 'db', Value: EXPR },
        { Name: 'aws-added', Value: 'ordinary' },
      ],
    });
  });

  it('keeps a WHOLE-TOKEN leaf the source does not spell, rather than masking over it', () => {
    // A persisted expression is not plaintext, and a mask is not a value `cdkd
    // drift` can re-resolve — replacing one with the other would DESTROY
    // information in the name of protecting it.
    //
    // THE BAG TOKEN DIFFERS FROM THE SOURCE'S, and that is the whole case. An
    // earlier revision passed the SAME token on both sides, which made it a
    // confluence point: `sourceLiterals` spared the leaf and the token arm was
    // never consulted, so disabling that arm left the entire suite green
    // (measured). The shape here is the issue #1917 generation skew — state
    // holds the DEPLOYED `:AWSPREVIOUS` stage while the source names the
    // unqualified one — which is exactly the value this arm exists to protect.
    const deployed = '{{resolve:secretsmanager:app/db:SecretString:password::AWSPREVIOUS}}';
    const out = readback({ A: { B: deployed } }, { A: EXPR });

    expect(out).toEqual({ A: { B: deployed } });
  });

  it('MASKS a leaf that merely CONTAINS a token, which is not an expression', () => {
    // The other half of the arm above, and the reason it tests a WHOLE token
    // rather than "contains one". A substring test spared this leaf on the
    // strength of the reference embedded at the END of it, while everything
    // before the `@` was the decrypted secret — a leak wearing an expression's
    // clothes. `sourceLiterals` cannot rescue it either: the source spells the
    // reference, not this assembled string.
    const embedded = `postgres://admin:${PLAINTEXT}@{{resolve:ssm-secure:/db/host}}`;
    const out = readback({ A: { B: embedded } }, { A: EXPR });

    expect(out).toEqual({ A: { B: SECRET_MASK } });
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
  });

  it('does not mask an EMPTY string, which no resolved secret can be', () => {
    // The same bar the value scan applies to a needle and `isUniquelyKeyedBy`
    // to an identity: `''` is not a distinguishing value, and the resolver
    // records no empty secret. Masking it only costs drift a comparison.
    const out = readback({ A: { Name: '', Pw: PLAINTEXT } }, { A: EXPR });

    expect(out).toEqual({ A: { Name: '', Pw: SECRET_MASK } });
  });

  it('MASKS a Uint8Array rather than descending or keeping it', () => {
    // A binary blob is NOT a safe leaf, and an earlier revision of this case
    // asserted it was kept by identity. Its own enumerable keys are `'0'`,
    // `'1'`, …, so an unguarded rebuild produces a plain object of numbers —
    // but the reason it is masked rather than merely not-descended is that its
    // BYTES are the secret: `JSON.stringify` writes them out in full. The
    // `Date` cases below pin the other non-plain path, where the value is a
    // timestamp and carries nothing.
    const blob = new Uint8Array([1, 2, 3]);
    const out = readback({ A: blob }, { A: EXPR });

    expect(out['A']).toBe(SECRET_MASK);
  });

  it('returns a CYCLIC readback instead of throwing', () => {
    // A state bag is JSON and cannot cycle, but a live AWS SDK readback is an
    // object graph. Before the visited set this walk recursed until
    // `RangeError`, turning a redaction pass into a crash on a bag the
    // pre-#2852 code returned unchanged. The sibling walks in this module
    // (`wholeStringLeavesOf`, `recordMaskOnlyValuesIn`) carry the same set.
    const cyclic: Record<string, unknown> = { Pw: PLAINTEXT };
    cyclic['self'] = cyclic;
    const out = readback({ A: cyclic }, { A: EXPR });

    const a = out['A'] as Record<string, unknown>;
    expect(a['Pw']).toBe(SECRET_MASK);
    // THE BACK-EDGE CARRIES THE REFUSED COPY. Asserting only `toBeDefined()`
    // passed while `self` was still the ORIGINAL object, so the plaintext was
    // one dereference away — a vacuous assertion on the exact leak the memo
    // exists to close.
    expect(a['self']).toBe(a);
    expect((a['self'] as Record<string, unknown>)['Pw']).toBe(SECRET_MASK);
  });

  it('does not mask a NON-STRING leaf, which cannot be a resolved secret', () => {
    // `RecordedSecretValues` is keyed and valued by `string`, so a number, a
    // boolean or `null` is not a shape a resolved secret can take.
    const out = readback({ A: { Port: 5432, On: true, None: null } }, { A: EXPR });

    expect(out).toEqual({ A: { Port: 5432, On: true, None: null } });
  });

  it('is INERT unless the CALLER declared its bag is a drift baseline', () => {
    // THE DESTINATION BOUND, and it is what keeps the mask out of `properties`.
    // `cdkd drift --accept` walks with the same three shape flags and then
    // writes its result into `observedProperties` OR, for a record that has
    // none, into `properties` — where `cdkd export` blocks the record and the
    // rollback replay refuses the operation, over a value that was never
    // unknown. Destination is not derivable from the two bags, so it is
    // DECLARED: `STATE_SOURCED_BASELINE_RULES` fails closed,
    // `STATE_SOURCED_READBACK_RULES` keeps the pre-#2852 answer.
    //
    // Two earlier discriminators were tried and each was measured wrong — the
    // rules' three shape flags alone (they select `drift.ts` too) and
    // `secrets.size === 0` (`runAccept` reaches an empty map through its
    // cross-region refusal, and through a resource whose only `{{resolve:`
    // leaf names a service cdkd resolves for nobody).
    const bag = { I: [PLAINTEXT, 'US-EAST-1'] };
    const source = { I: [EXPR, 'us-east-1'] };

    expect(
      redactSecretsForState(bag, new Map(), source, STATE_SOURCED_READBACK_RULES)
    ).toEqual(bag);
    expect(redactSecretsForState(bag, new Map(), source, STATE_SOURCED_BASELINE_RULES)).toEqual({
      I: [SECRET_MASK, SECRET_MASK],
    });
  });

  it('masks a SHARED node at every position it occupies, not just the first', () => {
    // A DAG is not a cycle. A plain visited-set answers both by returning the
    // node by identity, which is right for a walk that ACCUMULATES and wrong for
    // one that REBUILDS: measured on this tree before the fix,
    // `{A: [shared, shared]}` came back `[{Pw:'***'}, {Pw:'<plaintext>'}]` — a
    // guard added to stop a crash persisted the secret one position over. The
    // walk memoises the REFUSED copy instead, so every position gets it.
    const shared = { Pw: PLAINTEXT };
    const out = readback({ A: [shared, shared] }, { A: EXPR });

    expect(out).toEqual({ A: [{ Pw: SECRET_MASK }, { Pw: SECRET_MASK }] });
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
  });

  it('masks a SHARED node reached through two different KEYS', () => {
    // The object-arm spelling of the same defect, because the array arm and the
    // object arm seed the memo separately.
    const shared = { Pw: PLAINTEXT };
    const out = readback({ A: { P: shared, Q: shared } }, { A: EXPR });

    expect(out).toEqual({ A: { P: { Pw: SECRET_MASK }, Q: { Pw: SECRET_MASK } } });
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
  });

  it('honours the DESTINATION bound in the KEYED-array arm as well', () => {
    // The bound is spelled TWICE — once in `refuseAgainstSource`, and again in
    // the keyed arm, which hoists its literal set and so calls
    // `refuseUncertifiedSubtree` directly. Only the first spelling was pinned:
    // deleting `&& failClosed === true` from the keyed arm left the whole suite
    // green, and a mask reaching `properties` through `drift.ts`'s
    // `!hasObserved` arm is exactly the regression this PR argues against. The
    // sibling case above uses an UNKEYED array and cannot reach this arm.
    const bag = { Env: [{ Name: 'DB', Value: PLAINTEXT }] };
    const source = { Env: [{ Name: 'db', Value: EXPR }] };

    expect(redactSecretsForState(bag, new Map(), source, STATE_SOURCED_READBACK_RULES)).toEqual(
      bag
    );
    expect(redactSecretsForState(bag, new Map(), source, STATE_SOURCED_BASELINE_RULES)).toEqual({
      Env: [{ Name: SECRET_MASK, Value: SECRET_MASK }],
    });
  });

  it('threads failClosed through a PAIRED keyed element into a refused position', () => {
    // The keyed arm recurses per element, so the flag has to survive the
    // partner walk. Passing `false` there left the suite green: no other case
    // has a refused position NESTED under a paired element. `db` pairs, and the
    // refusal happens one level down where a whole-token source meets a
    // CONTAINER readback.
    const out = readback(
      { Env: [{ Name: 'db', Value: { Nested: PLAINTEXT } }] },
      { Env: [{ Name: 'db', Value: EXPR }] }
    );

    expect(out).toEqual({ Env: [{ Name: 'db', Value: { Nested: SECRET_MASK } }] });
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
  });

  it('is INERT on the rules the readback gate excludes', () => {
    // `cdkd scrub`'s observed walk is CROSS-generation and the outputs writers
    // are TEMPLATE-sourced, so `isReadbackProjectedFromState` excludes both and
    // the refusal pass never runs for them. Asserted rather than reasoned:
    // widening the gate is exactly the edit this case exists to catch.
    const bag = { A: [PLAINTEXT] };
    const source = { A: { B: EXPR } };

    expect(
      redactSecretsForState(bag, new Map(), source, STATE_SOURCED_CROSS_GENERATION_RULES)
    ).toEqual(bag);
    expect(redactSecretsForState(bag, new Map(), source, TEMPLATE_SOURCED_RULES)).toEqual(bag);
  });
});

describe('secret-redaction - a derived needle still outranks the mask (issue #2012 kept)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  it('writes the EXPRESSION, not the mask, where a certified sibling named the plaintext', () => {
    // The regression the merge ordering exists to prevent. `Primary` is a whole
    // token, so the walk certifies it and `deriveReadbackNeedles` learns
    // `PLAINTEXT -> EXPR` from it. `Copy` is the shape-divergence arm — refused,
    // and therefore masked — but the needle NAMES its value, and an expression
    // is strictly better than a mask: `cdkd drift` can re-resolve one.
    const out = readback({ Primary: PLAINTEXT, Copy: PLAINTEXT }, { Primary: EXPR, Copy: { I: EXPR } });

    expect(out).toEqual({ Primary: EXPR, Copy: EXPR });
    expect(JSON.stringify(out)).not.toContain(SECRET_MASK);
  });

  it('KEEPS the mask when the scan rewrote only PART of a refused leaf', () => {
    // `derived.certain` carries the SUBSTRING arm, so a needle can name ONE
    // embedded value inside a refused leaf. That makes `scanDecision !== bag`
    // while the rest of the leaf is still the decrypted secret — and taking it
    // discarded the mask and published the password. Measured on the (#2846)
    // raw-intrinsic shape before the fix:
    // `postgres://{{resolve:...username}}:hunter2-decrypted@h`.
    //
    // `User` is what makes it fire: it is a CERTIFIED whole-token position, so
    // the derived pass learns `appuser -> <userExpr>` and the substring scan
    // then reaches inside the refused `Url`.
    const userExpr = '{{resolve:secretsmanager:app/db:SecretString:username}}';
    const out = readback(
      { User: 'appuser', Url: `postgres://appuser:${PLAINTEXT}@h` },
      { User: userExpr, Url: { 'Fn::Join': ['', ['postgres://', userExpr, ':', EXPR, '@h']] } }
    );

    expect(out['User']).toBe(userExpr);
    expect(out['Url']).toBe(SECRET_MASK);
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
  });

  it('KEEPS the mask on a partial rewrite inside an unkeyed ARRAY too', () => {
    // The same defect through the other refusing arm, because the merge is
    // per-LEAF and the arm that produced the mask does not change it. Before
    // the fix the mask landed on the harmless sibling literal and was dropped
    // exactly at the element holding the password.
    const userExpr = '{{resolve:secretsmanager:app/db:SecretString:username}}';
    const out = readback(
      { User: 'appuser', Args: [`--dsn=postgres://appuser:${PLAINTEXT}@h`, 'US-EAST-1'] },
      { User: userExpr, Args: [{ 'Fn::Join': ['', ['--dsn=', EXPR]] }, 'us-east-1'] }
    );

    expect(JSON.stringify(out)).not.toContain(PLAINTEXT);
  });

  it('MASKS a BINARY leaf under a refused position, whose bytes are the secret', () => {
    // Secrets Manager's `SecretBinary` is the shape that matters: an SDK v3
    // readback hands back a `Uint8Array`, and `JSON.stringify` writes the bytes
    // out as `{"type":"Buffer","data":[...]}` — the secret in the clear, beside
    // a string the same refusal masked.
    //
    // The FIXTURE spells that shape, and an earlier revision did not: it used a
    // DynamoDB `AttributeValue` map (`{D:[{B,S}]}`) under this comment. The
    // guard is shape-agnostic — `ArrayBuffer.isView` at any leaf — so nothing
    // was untested, but a case whose comment and fixture describe different AWS
    // APIs teaches the next reader the wrong population. The refusal is
    // triggered the way every other case here triggers it: AWS returns a
    // CONTAINER where the source subtree spells one member, so the two cannot
    // be paired and the whole subtree is refused.
    const binary = Buffer.from('binary-secret-value');
    const out = readback(
      { Secret: [{ SecretBinary: binary, SecretString: PLAINTEXT }] },
      { Secret: { SecretBinary: EXPR, SecretString: EXPR } }
    );

    expect(out).toEqual({ Secret: [{ SecretBinary: SECRET_MASK, SecretString: SECRET_MASK }] });
    expect(JSON.stringify(out)).not.toContain('binary-secret-value');
    expect(JSON.stringify(out)).not.toContain('"data"');
  });

  it('falls back to the mask where the needles have nothing to say', () => {
    // The polarity that keeps the case above from being "the mask never
    // applies". A different plaintext at the refused position matches no needle,
    // so the refusal stands.
    const out = readback(
      { Primary: PLAINTEXT, Copy: PLAINTEXT_2 },
      { Primary: EXPR, Copy: { I: EXPR } }
    );

    expect(out).toEqual({ Primary: EXPR, Copy: SECRET_MASK });
    expect(JSON.stringify(out)).not.toContain(PLAINTEXT_2);
  });
});

describe('secret-redaction - the readback walk keeps a Date intact (issue #2869)', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  it('returns a Date BY IDENTITY instead of rebuilding it as {}', () => {
    // `isPlainObject` admits any non-null non-array object and
    // `Object.entries(new Date())` is `[]`, so the object arm REBUILT a readback
    // `Date` as `{}` — a baseline value AWS never reported, which `cdkd drift
    // --revert` can push. It fires where the SOURCE subtree at that position
    // carries a reference, because that is the only subtree this walk descends;
    // an AWS SDK v3 readback reaching `drainObservedCaptures` is pre-JSON and
    // really does carry `Date`s beside reference-bearing properties.
    const when = new Date('2020-01-01T00:00:00Z');
    const out = readback({ Schedule: when }, { Schedule: { Cron: EXPR } });

    expect(out['Schedule']).toBe(when);
    expect(out['Schedule']).not.toEqual({});
  });

  it('keeps a Date nested INSIDE a refused subtree', () => {
    // The second reach: a subtree the walk refuses is rebuilt by
    // `refuseUncertifiedSubtree`, so that walk needs the same guard or the fix
    // would move the flattening rather than remove it.
    const when = new Date('2021-06-01T00:00:00Z');
    const out = readback({ A: { At: when, Pw: PLAINTEXT } }, { A: EXPR });

    expect((out['A'] as Record<string, unknown>)['At']).toBe(when);
    expect((out['A'] as Record<string, unknown>)['Pw']).toBe(SECRET_MASK);
  });

  it('keeps a Date when the DERIVED-needle merge is live, not just when it is skipped', () => {
    // The third reach, and the only one that exercises `preferPositionDecisions`
    // at all: `deriveReadbackNeedles` returns nothing unless some position was
    // certified, so the two cases above take the short path that returns the
    // refusal pass's output directly. `Primary` certifies one, which turns the
    // merge on — and the merge scans the RAW bag with a plain value walk that
    // rebuilds objects. Its own prototype guard is what keeps the `Date` out of
    // that walk's result.
    const when = new Date('2022-03-04T00:00:00Z');
    const out = readback(
      { Primary: PLAINTEXT, Schedule: when },
      { Primary: EXPR, Schedule: { Cron: EXPR } }
    );

    expect(out['Primary']).toBe(EXPR);
    expect(out['Schedule']).toBe(when);
  });
});

describe('secret-redaction - fail-closed through scrubResourceRecord', () => {
  beforeEach(() => clearRecordedSecretExpressions());
  afterEach(() => clearRecordedSecretExpressions());

  it('reaches the refusal through the call the commands actually make', () => {
    // `cdkd state refresh-observed` and the deploy persist choke point both
    // DERIVE the rules here rather than passing them, so the direct calls above
    // do not prove this path. This is issue #2846's exact shape: `properties`
    // hold the raw `Fn::Join` object `cdkd import`'s warn path writes.
    const scrubbed = scrubResourceRecord(
      {
        properties: { Url: { 'Fn::Join': ['', ['postgres://u:', EXPR, '@h']] } },
        observedProperties: { Url: `postgres://u:${PLAINTEXT}@h` },
      },
      new Map<string, string>()
    );

    expect(scrubbed.observedProperties).toEqual({ Url: SECRET_MASK });
    expect(JSON.stringify(scrubbed)).not.toContain(PLAINTEXT);
  });

  it('does NOT fail closed for a scrubResourceRecord caller that HAS a secrets map', () => {
    // `scrubResourceRecord` derives the rules for the observed bag, which is
    // how the deploy's unchanged-resource auto-refresh (the issue #1900 walk)
    // gets the refusal with no call-site change. The rollback replay's trailing
    // scrub always reaches that derivation with a POPULATED map, and the deploy
    // JOURNAL's `previousState` no longer reaches it at all —
    // `redactOperationsForJournal` passes the readback constant explicitly
    // (issue #2886; its journal-side pair lives in
    // `deploy-engine-secret-redaction.test.ts`). Both are REPLAYED baselines,
    // so a mask there is a fresh permanent hole in a record a rollback persists
    // and `cdkd drift --accept` then refuses for its lifetime — for a leaf the
    // scan had every chance to name.
    //
    // NOT "the map proves nothing is left to protect": evidence is per-VALUE,
    // and a rotated or pre-GHSA leaf is not a key of this pass's map. The claim
    // is only that such a value already sits in `state.json`, where `cdkd
    // scrub` is its repairer.
    //
    // Keying on the map is safe HERE and was measured wrong INSIDE the walk,
    // and the difference is what this pair pins: here the destination is
    // already settled (this branch redacts `observedProperties`), so the only
    // question left is evidence.
    const record = {
      properties: { I: [EXPR, 'us-east-1'] },
      observedProperties: { I: [PLAINTEXT, 'US-EAST-1'] },
    };

    const withMap = scrubResourceRecord(record, new Map([[PLAINTEXT_2, EXPR_2]]));
    expect(withMap.observedProperties).toEqual({ I: [PLAINTEXT, 'US-EAST-1'] });

    const withoutMap = scrubResourceRecord(record, new Map<string, string>());
    expect(withoutMap.observedProperties).toEqual({ I: [SECRET_MASK, SECRET_MASK] });
  });

  it('a KEY-RENAMING readback inside a refused subtree is masked too', () => {
    // THE REJECTED ALTERNATIVE, applied as a control. Masking only the leaves
    // whose KEY the source spells as reference-bearing is the obvious way to cut
    // the over-masking cost, and it LEAKS: AWS renames `Password` to `Secret`
    // inside a subtree the walk already refused, and a key-name rule would keep
    // it because no source key called `Secret` carries a reference. The rule
    // shipped is over the VALUE (is it a string the source subtree spells), so
    // the rename is masked. Written as a case rather than a paragraph, because a
    // rejection with no control reads as an omission.
    const scrubbed = scrubResourceRecord(
      {
        properties: { Config: { Password: EXPR } },
        observedProperties: { Config: [{ Secret: PLAINTEXT }] },
      },
      new Map<string, string>()
    );

    expect(scrubbed.observedProperties).toEqual({ Config: [{ Secret: SECRET_MASK }] });
    expect(JSON.stringify(scrubbed)).not.toContain(PLAINTEXT);
  });
});
