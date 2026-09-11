/**
 * The INPUT-SPACE fence for `cdkd import`'s observed-baseline refusal
 * (issue [#2828](https://github.com/go-to-k/cdkd/issues/2828)).
 *
 * WHY THIS EXISTS RATHER THAN A THIRD CASE. `resolveImportedProperties`'
 * refusal verdict is a CLASSIFIER: it decides, per resource, whether the
 * persisted `properties` can position the observed-capture redaction. Two
 * review rounds each found a new INPUT CLASS it got wrong — not a new place the
 * logic was wrong:
 *
 *  - round 1: the resolve THREW, leaving a raw `Fn::Join` OBJECT where the
 *    readback has a STRING;
 *  - round 2: the resolve SUCCEEDED and an `Fn::If` under a condition
 *    `cdkd import` cannot bind selected the branch AWS did not take, so the
 *    reference was gone with nothing thrown.
 *
 * Hand-picked cases cannot fence a classifier whose defects live in shapes
 * nobody wrote down, and a third hand-picked case would have been the third
 * round of the same. So this file enumerates SHAPES along the axes that have
 * produced defects, and asserts the SAFETY PROPERTY end to end rather than the
 * verdict alone.
 *
 * It does NOT enumerate "the input space", and an earlier revision of this
 * paragraph claimed it did. Round 4 falsified that by finding a whole AXIS the
 * table had no row for — a reference sourced from OUTSIDE the property bag (a
 * parameter `Default`, a `Mappings` entry) — which is now rows of its own. Say
 * which axes are covered, not that coverage is complete.
 *
 * THE INVARIANT, per row, and it is deliberately independent of HOW the
 * classifier decides: either the resource is REFUSED, or replaying exactly what
 * `captureObservedForImportedResources` does — `redactSecretsForState(readback,
 * EMPTY, properties, STATE_SOURCED_BASELINE_RULES)` — produces a bag with no
 * plaintext in it. A shape nobody imagined therefore reds here even though no
 * one wrote its expected verdict down, which is the whole point.
 *
 * The per-row EXPECTED verdict is asserted too, and that pairing is load-bearing
 * in the other direction: the invariant alone is satisfied by refusing
 * everything, so without the expected column an over-refusal — which silently
 * costs every imported resource its drift baseline — would pass. Cap and floor.
 *
 * THE REAL RESOLVER, not a fake, for the reason
 * `import-resolver-error-masking.test.ts` gives at length: what is under test is
 * what the resolver DOES to these shapes, so a fake that produced the expected
 * shapes would be asserting the fixture.
 *
 * THE #2852 SHAPES NOW HAVE ROWS. Issue
 * [#2852](https://github.com/go-to-k/cdkd/issues/2852) made the position walk
 * FAIL CLOSED where it cannot certify, but only for a caller that DECLARES its
 * bag is a drift baseline (`STATE_SOURCED_BASELINE_RULES`); this capture passed
 * the plain readback constant until issue
 * [#2885](https://github.com/go-to-k/cdkd/issues/2885) swapped it, so every one
 * of those shapes persisted the decrypted value and a row for any of them would
 * have red the SAFETY invariant. The rows that arrived with the swap are
 * TRANSCRIBED from the fail-closed block of
 * `tests/unit/deployment/secret-redaction-uncertified-fail-closed.test.ts` --
 * the enumerated source #2885 names, rather than a fresh hand-pick -- ALL NINE
 * of its shape cases, in its order, plus two more. Each is driven through the
 * real capture here, which is the part transcription cannot assume: that suite
 * calls the module directly.
 *
 * THE TWO EXTRA ROWS are an array AWS REORDERED and an array whose LENGTH AWS
 * changed, and their provenance is `unkeyedArrayPairsByAnchors`' four
 * conditions rather than any issue body -- condition 1 is the index counts, and
 * a reorder is what the anchors stop corroborating. An earlier revision of this
 * line credited them to #2885's body, which names a reorder and does NOT name a
 * length change; the shapes are right and the attribution was not.
 *
 * The NINTH transcribed case (a RAW intrinsic source OBJECT against a STRING
 * readback, #2846) needs its own note, because it nearly went unrowed on the
 * reasoning that the four `closedByMask` rows below already cover it. They do
 * not: those are REFUSED by the classifier, and the shape is reachable on the
 * ADMITTED path too -- measured, an `Fn::Transform` wrapper resolves WITHOUT
 * throwing, so nothing refuses and the raw object survives into the persisted
 * bag. That is the row, and the near-miss is why the count above is stated as
 * "all nine" rather than left to a reader to check.
 *
 * THE #2850 SHAPES NOW HAVE ROWS TOO. Issue
 * [#2850](https://github.com/go-to-k/cdkd/issues/2850) measured two ways past
 * the opener-count arm on the success path — a downgraded `Fn::If` dropping
 * one reference while a parameter-sourced one is ADDED elsewhere (the totals
 * balance), and a reference sourced ENTIRELY outside the bag then dropped
 * (both counts zero, no warn) — plus a sibling discarder found while fixing
 * it: `resolveValue`'s dispatch order drops the sibling keys of a multi-key
 * intrinsic object. Every one of those rows red the SAFETY invariant against
 * the pre-fix tree (measured: 4 failed / 32 passed, each failure quoting the
 * persisted plaintext); they are refused by the DISCARD-EVENT walk
 * (`resolveDiscardsNonInertSubtree`), whose negative controls — an `Fn::If`
 * discarding pure literals, a multi-key intrinsic whose dropped sibling is a
 * literal — are rows here as well, because the walk's risk direction is
 * over-refusal.
 *
 * THE REVIEW ROUND THEN RE-ENUMERATED THE DISCARDERS and found the first cut
 * had missed two, each now a refusing row with its own negative control:
 * `resolveFindInMap`'s 4-argument `DefaultValue` is resolved LAZILY (a lookup
 * HIT discards it unresolved — the `resolveIf` pattern on a second
 * intrinsic), and a non-literal lookup KEY makes the un-taken mapping entries
 * discarded template content; `resolveSelect` consumes its INDEX raw, so an
 * intrinsic index discards the eagerly-decrypted list wholesale. The same
 * round bought the `{Ref: 'AWS::NoValue'}` carve-out row: the one intrinsic
 * whose discard cannot correspond to a value AWS holds, and without the
 * carve-out the walk refused the optional-property idiom — the over-refusal
 * direction's live case, not a hypothetical.
 *
 * WHAT IS STILL ABSENT, and it is recorded rather than left to read as
 * coverage. `plaintext can still be persisted by this capture` — by a
 * parameter bound to a placeholder `Default` while the DEPLOYED value was the
 * reference ([#2854](https://github.com/go-to-k/cdkd/issues/2854) — no
 * discard occurs, the divergence is in the VALUE, so the discard walk cannot
 * see it), and by a secret with no counterpart in the source at all
 * ([#2868](https://github.com/go-to-k/cdkd/issues/2868)). A row for either
 * would red the SAFETY invariant, exactly as the #2852 and #2850 rows did
 * before their fixes.
 *
 * #2868 IS WORTH STATING PRECISELY, because the note this paragraph replaced
 * listed "a readback key the source lacks" among the shapes #2852 closed and it
 * does NOT — measured through this file's own harness on 2026-09-11 under the
 * BASELINE constant, a readback of `{Detail: {pw: <plaintext>, Extra:
 * <a DIFFERENT plaintext>}}` against a source of `{Detail: {pw: <token>}}`
 * persists `Extra` in the clear, because the source has no leaf at that
 * position to refuse from and `refuseUncertifiedReadbackPositions`' own table
 * marks that row deliberately open. With the SAME plaintext at both keys the
 * derived needles of issue #2012 rewrite the extra key for free and the shape
 * reads as closed, which is why the measurement used two different secrets —
 * the same trap `SECRET_ID_2` below was introduced for.
 *
 * WHAT THIS TABLE DELIBERATELY DOES NOT ROW, because the MODULE suite already
 * fences it and an import-path duplicate would only re-test the module: the
 * remaining rows of `refuseUncertifiedReadbackPositions`' own doc table — a
 * MIXED leaf inside a PAIRED element, an unpaired element with every source
 * reference paired (needle-only), a `Date` kept by identity (#2869), and a
 * PUBLIC ssm MIXED leaf under an EMPTY map (over-redacts, #2036) — plus the
 * non-string arms of `refuseUncertifiedSubtree` this capture can now reach
 * (`Uint8Array` masked, `''` kept, the DAG / cycle memoisation). All are
 * covered in `tests/unit/deployment/`; none is a leak this capture is the only
 * route to.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const SECRET_ID = 'cdkd-2828-matrix';
const PLAINTEXT = 'matrix-decrypted-value';
/**
 * A SECOND secret with a DIFFERENT value. Load-bearing for the two-reference
 * row: with both leaves holding the same plaintext, the derived-needle pass
 * learns `plaintext -> token` from the surviving leaf and rewrites the dropped
 * one for free, so that row's refusal was measurably UNEARNED — its own premise
 * assertion caught it. Distinct values are what make the dropped leaf actually
 * leak, which is the shape the row exists to describe.
 */
const SECRET_ID_2 = 'cdkd-2828-matrix-two';
const PLAINTEXT_2 = 'matrix-second-decrypted-value';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(command: {
      input?: { SecretId?: string };
      constructor: { name: string };
    }): Promise<unknown> {
      if (command.input?.SecretId === SECRET_ID_2) {
        return { SecretString: JSON.stringify({ pw: PLAINTEXT_2 }) };
      }
      if (command.input?.SecretId !== SECRET_ID) {
        const notFound = new Error("Secrets Manager can't find the specified secret.");
        notFound.name = 'ResourceNotFoundException';
        throw notFound;
      }
      return { SecretString: JSON.stringify({ pw: PLAINTEXT }) };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});

const { resolveImportedProperties, captureObservedForImportedResources } = await import(
  '../../../src/cli/commands/import.js'
);
const { SECRET_MASK } = await import('../../../src/deployment/secret-redaction.js');
const { getLogger } = await import('../../../src/utils/logger.js');

const TOKEN = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:pw::}}`;
const TOKEN_2 = `{{resolve:secretsmanager:${SECRET_ID_2}:SecretString:pw::}}`;
/** A token whose secret does NOT exist, so resolving it throws. */
const MISSING_TOKEN = '{{resolve:secretsmanager:cdkd-2828-absent:SecretString:pw::}}';

interface Row {
  readonly name: string;
  /** Template `Properties` for the single resource under test. */
  readonly properties: Record<string, unknown>;
  /** What AWS reports back for it — the DECRYPTED value, at the same path. */
  readonly readback: Record<string, unknown>;
  /** Whether the classifier must REFUSE to capture a baseline for it. */
  readonly refused: boolean;
  /** Why, in one line — this column is the reason the table reads as a spec. */
  readonly why: string;
  readonly template?: Partial<CloudFormationTemplate>;
  /**
   * The exact bag the capture must persist for a NON-refused row. `not.toContain`
   * alone is satisfied by a redactor that returns `{}`, and three shapes exist
   * ONLY in this table, so the safety claim for them rested on an assertion that
   * cannot tell a correct redaction from an empty one.
   */
  readonly expected?: Record<string, unknown>;
  /**
   * A refusal that is DELIBERATELY conservative: the row would not have leaked,
   * and is refused anyway because the predicate is coarse. Exempt from the
   * premise loop, and counted separately so the over-refusals stay visible and
   * bounded rather than hiding among the earned ones.
   */
  readonly overRefusal?: boolean;
  /**
   * A refusal whose LEAK closes ONE LAYER DOWN. The classifier still refuses,
   * and replaying the capture anyway now writes {@link SECRET_MASK} at the
   * refused position instead of the plaintext, because issue #2885 put this
   * capture on `STATE_SOURCED_BASELINE_RULES`.
   *
   * The premise loop proves the MASK for these rows rather than the plaintext,
   * and that is not a weaker claim: the mask IS the evidence that the position
   * walk could not certify the position, which is the hazard the refusal is
   * about. Asserting the plaintext here would red for the fail-closed layer
   * doing its job. Distinct from {@link overRefusal}, where the walk COULD have
   * paired the position and nothing was ever at risk — measured apart, and the
   * counts below keep them apart.
   */
  readonly closedByMask?: boolean;
  /**
   * The exact bag a {@link closedByMask} row's capture persists when it is
   * replayed with the refusal NOT applied — the `expected` column for the
   * premise loop, and required on every such row.
   *
   * Without it that loop asserted only `toContain(SECRET_MASK)` over a
   * STRINGIFIED bag, which is position- and shape-blind: a walk that masked the
   * WRONG leaf, masked every leaf, or reshaped the container would satisfy it.
   * That is the same absence-vacuity these rows' `expected` column exists to
   * close, one branch over, and it was found by review rather than by a probe —
   * the mutation that motivated the assertion changed the mask LITERAL, which
   * `toContain` does catch, so nothing pointed at the gap.
   */
  readonly expectedOnReplay?: Record<string, unknown>;
  /**
   * The plaintext this row is about, when it is not the default one. A row
   * carrying two different secrets has to name the one whose disclosure it
   * describes, or the assertions test the wrong value and pass.
   */
  readonly needle?: string;
}

const ROWS: readonly Row[] = [
  {
    name: 'whole-token leaf, resolves',
    properties: { Detail: { pw: TOKEN } },
    readback: { Detail: { pw: PLAINTEXT } },
    expected: { Detail: { pw: TOKEN } },
    refused: false,
    why: 'the persisted bag holds the token as a string leaf — the walk substitutes it',
  },
  {
    name: 'MIXED leaf embedding the token, resolves',
    properties: { Detail: { url: `postgres://u:${TOKEN}@h/db` } },
    readback: { Detail: { url: `postgres://u:${PLAINTEXT}@h/db` } },
    expected: { Detail: { url: `postgres://u:${TOKEN}@h/db` } },
    refused: false,
    why: "the mixed-leaf refusal inside redactSecretsForState covers it",
  },
  {
    name: 'Fn::Join-assembled token, resolves',
    properties: {
      Detail: {
        pw: {
          'Fn::Join': ['', [`{{resolve:secretsmanager:${SECRET_ID}`, ':SecretString:pw::}}']],
        },
      },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    expected: { Detail: { pw: TOKEN } },
    refused: false,
    why: 'the resolve collapses the join to one string leaf carrying the token',
  },
  {
    name: 'no dynamic reference at all, resolves',
    properties: { Detail: { name: 'plain-literal' } },
    readback: { Detail: { name: 'plain-literal', AwsOnly: 'added' } },
    expected: { Detail: { name: 'plain-literal', AwsOnly: 'added' } },
    refused: false,
    why: 'nothing to disclose — refusing would cost a baseline for no gain',
  },
  {
    name: 'Fn::Join-assembled token, resolve THROWS',
    properties: {
      Detail: {
        pw: { 'Fn::Join': ['', ['{{resolve:secretsmanager:', { Ref: 'NoSuchResource' }, '}}']] },
      },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    closedByMask: true,
    expectedOnReplay: { Detail: { pw: SECRET_MASK } },
    why:
      'raw OBJECT leaf vs STRING readback — the walk cannot pair them (round 1). ' +
      'Since #2885 that same un-pairability makes the capture write a MASK, so ' +
      'the refusal is now the outer of two layers rather than the only one',
  },
  {
    name: 'whole-token STRING leaf, resolve THROWS on a SIBLING property',
    properties: { Detail: { pw: TOKEN }, Other: { Ref: 'NoSuchResource' } },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    overRefusal: true,
    why:
      'the walk COULD pair this one, but the throw-arm test is coarse on purpose ' +
      '— see the three rows below for what precision here cost',
  },
  {
    name: 'complete token wrapped in a single-element Fn::Join, resolve THROWS',
    properties: {
      Detail: { pw: { 'Fn::Join': ['', [TOKEN]] } },
      Other: { Ref: 'NoSuchResource' },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    closedByMask: true,
    expectedOnReplay: { Detail: { pw: SECRET_MASK } },
    why:
      'THE REGRESSION ROW. A precise throw-arm test counted this token as complete ' +
      'on both sides and admitted it; the walk sees an OBJECT where the readback ' +
      'has a STRING and cannot pair them. It USED TO return the plaintext ' +
      'untouched, which is what made admitting it a leak; since #2885 the ' +
      'un-paired position is masked, so the regression this row records is now ' +
      'a masked baseline rather than a disclosure',
  },
  {
    name: 'complete token wrapped in Fn::Sub, resolve THROWS',
    properties: {
      Detail: { pw: { 'Fn::Sub': TOKEN } },
      Other: { Ref: 'NoSuchResource' },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    closedByMask: true,
    expectedOnReplay: { Detail: { pw: SECRET_MASK } },
    why: 'second spelling of the row above — the wrapper is what matters, not Fn::Join',
  },
  {
    name: 'complete token wrapped in Fn::If, resolve THROWS',
    properties: {
      Detail: { pw: { 'Fn::If': ['IsProd', TOKEN, 'other'] } },
      Other: { Ref: 'NoSuchResource' },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    closedByMask: true,
    expectedOnReplay: { Detail: { pw: SECRET_MASK } },
    why: 'third spelling — an unresolved Fn::If is an object leaf like any other',
    template: {
      Parameters: { Stage: { Type: 'String' } },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
    },
  },
  {
    name: 'no dynamic reference, resolve THROWS',
    properties: { Detail: { name: 'plain-literal' }, Other: { Ref: 'NoSuchResource' } },
    readback: { Detail: { name: 'plain-literal' } },
    refused: true,
    overRefusal: true,
    why:
      'nothing to disclose, refused anyway — the price of refusing on the THROW ' +
      'itself rather than on any predicate over a bag the resolver could not finish',
  },
  {
    name: 'Fn::If under a DOWNGRADED condition, secret in the UNTAKEN branch',
    properties: { Detail: { 'Fn::If': ['IsProd', { pw: TOKEN }, { pw: 'dev-placeholder' }] } },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why: 'resolves cleanly to the false branch, so the marker is LOST (round 2)',
    template: {
      Parameters: { Stage: { Type: 'String' } },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
    },
  },
  {
    name: 'Fn::If under a DOWNGRADED condition, secret in the TAKEN branch',
    properties: { Detail: { 'Fn::If': ['IsProd', { pw: 'prod-placeholder' }, { pw: TOKEN }] } },
    readback: { Detail: { pw: PLAINTEXT } },
    expected: { Detail: { pw: TOKEN } },
    refused: false,
    why: 'the selected branch keeps the marker — the mirror of the row above',
    template: {
      Parameters: { Stage: { Type: 'String' } },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
    },
  },
  {
    name: 'TWO references to DIFFERENT secrets, one resolved and one dropped by a downgraded Fn::If',
    properties: {
      Detail: { kept: TOKEN, dropped: { 'Fn::If': ['IsProd', TOKEN_2, 'dev-placeholder'] } },
    },
    readback: { Detail: { kept: PLAINTEXT, dropped: PLAINTEXT_2 } },
    refused: true,
    needle: PLAINTEXT_2,
    why:
      'a surviving sibling reference must not vouch for the dropped one — and ' +
      'the secrets differ, so the derived-needle pass cannot rescue it either',
    template: {
      Parameters: { Stage: { Type: 'String' } },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
    },
  },
  {
    name: 'reference from a PARAMETER DEFAULT, resolve THROWS on a sibling',
    properties: { Detail: { pw: { Ref: 'SecretRef' } }, Other: { Ref: 'NoSuchResource' } },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why:
      'ROUND-4 CLASS. The reference is sourced OUTSIDE the property bag, so an ' +
      'opener count over the raw bag reads ZERO — a predicate gated on that ' +
      'count admitted this and leaked',
    template: { Parameters: { SecretRef: { Type: 'String', Default: TOKEN } } },
  },
  {
    name: 'reference from a MAPPINGS entry, resolve THROWS on a sibling',
    properties: {
      Detail: { pw: { 'Fn::FindInMap': ['M', 's', 'pw'] } },
      Other: { Ref: 'NoSuchResource' },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why: 'second source outside the bag — same zero opener count, same leak',
    template: { Mappings: { M: { s: { pw: TOKEN } } } },
  },
  {
    name: 'reference from a PARAMETER DEFAULT that RESOLVES cleanly',
    properties: { Detail: { pw: { Ref: 'SecretRef' } } },
    readback: { Detail: { pw: PLAINTEXT } },
    expected: { Detail: { pw: TOKEN } },
    refused: false,
    why:
      'the NEGATIVE control for the two rows above: with no throw AND no ' +
      'condition dropping it, the resolve puts the token into the persisted ' +
      'bag and the walk positions on it. It does NOT establish that the ' +
      'outside-the-bag class is throw-arm-only — an earlier revision of this ' +
      'line claimed that and a reviewer refuted it: drop the same reference ' +
      'with a downgraded Fn::If and BOTH counts read zero. That shape is issue ' +
      '2850, whose rows follow below',
    template: { Parameters: { SecretRef: { Type: 'String', Default: TOKEN } } },
  },
  {
    name: 'BALANCED trade: one reference dropped by a downgraded Fn::If, another ADDED from a parameter Default',
    properties: {
      Prod: { 'Fn::If': ['IsProd', TOKEN, 'dev-placeholder'] },
      Fallback: { Ref: 'SecretRef' },
    },
    readback: { Prod: PLAINTEXT, Fallback: PLAINTEXT_2 },
    refused: true,
    needle: PLAINTEXT,
    why:
      'ISSUE #2850 SHAPE A. The downgrade drops secret A (raw opener 1 -> persisted 0) ' +
      'while the parameter-sourced reference ADDS one (raw 0 -> persisted 1), so the ' +
      'TOTALS balance and a count comparison admits it. The secrets differ, so the ' +
      'derived-needle pass cannot rescue the dropped leaf either',
    template: {
      Parameters: {
        Stage: { Type: 'String' },
        SecretRef: { Type: 'String', Default: TOKEN_2 },
      },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
    },
  },
  {
    name: 'reference sourced from a PARAMETER DEFAULT, dropped by a downgraded Fn::If — both counts ZERO',
    properties: {
      Detail: { pw: { 'Fn::If': ['IsProd', { Ref: 'SecretRef' }, 'dev-placeholder'] } },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why:
      'ISSUE #2850 SHAPE B. The reference lives ENTIRELY outside the bag (a parameter ' +
      'Default), so the raw count reads zero; the downgrade then drops it, so the ' +
      'persisted count is zero too. 0 < 0 is false, nothing throws, and no warn fires',
    template: {
      Parameters: {
        Stage: { Type: 'String' },
        SecretRef: { Type: 'String', Default: TOKEN },
      },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
    },
  },
  {
    name: 'reference sourced from a MAPPINGS entry, dropped by a downgraded Fn::If — both counts ZERO',
    properties: {
      Detail: {
        pw: { 'Fn::If': ['IsProd', { 'Fn::FindInMap': ['M', 's', 'pw'] }, 'dev-placeholder'] },
      },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why: 'ISSUE #2850 SHAPE B, second source outside the bag — same zero counts, same silence',
    template: {
      Parameters: { Stage: { Type: 'String' } },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
      Mappings: { M: { s: { pw: TOKEN } } },
    },
  },
  {
    name: 'sibling subtree DROPPED by dispatch order: an intrinsic key beside other keys',
    properties: { Detail: { pw: { Ref: 'PlainParam', nested: { Ref: 'SecretRef' } } } },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why:
      'the SAME CLASS as Shape B, one discarder over: `resolveValue` dispatches on ' +
      'the first matching intrinsic key, so `nested` — and the reference it sources ' +
      'from the parameter Default — is silently dropped, with both counts zero',
    template: {
      Parameters: {
        PlainParam: { Type: 'String', Default: 'public-value' },
        SecretRef: { Type: 'String', Default: TOKEN },
      },
    },
  },
  {
    name: 'Fn::FindInMap 4-arg DefaultValue DISCARDED by a lookup HIT, reference in the default',
    properties: {
      Detail: {
        pw: {
          'Fn::FindInMap': ['M', { Ref: 'Stage' }, 'pw', { DefaultValue: { Ref: 'SecretRef' } }],
        },
      },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why:
      "THE REVIEW ROUND'S BLOCKER. resolveFindInMap resolves DefaultValue lazily, " +
      'only on a lookup MISS — a HIT discards it UNRESOLVED, the resolveIf pattern ' +
      'on a second intrinsic. Deployed with a parameter value that MISSED, AWS ' +
      'holds the default reference decrypted; import binds the Default, hits, and ' +
      'both counts read zero',
    template: {
      Parameters: {
        Stage: { Type: 'String', Default: 'dev' },
        SecretRef: { Type: 'String', Default: TOKEN },
      },
      Mappings: { M: { dev: { pw: 'dev-placeholder' } } },
    },
  },
  {
    name: 'Fn::FindInMap 4-arg with a pure-LITERAL DefaultValue, lookup hits',
    properties: {
      Detail: { pw: { 'Fn::FindInMap': ['M', 'dev', 'pw', { DefaultValue: 'fallback-literal' }] } },
    },
    readback: { Detail: { pw: 'from-map' } },
    expected: { Detail: { pw: 'from-map' } },
    refused: false,
    why:
      'the NEGATIVE control for the DefaultValue arm: a literal default is inert ' +
      'whichever way the deployed lookup went, and literal keys make the selection ' +
      'template-constant',
    template: { Mappings: { M: { dev: { pw: 'from-map' } } } },
  },
  {
    name: 'Fn::FindInMap keyed by a PARAMETER, token in the un-taken mapping entry',
    properties: { Detail: { pw: { 'Fn::FindInMap': ['M', { Ref: 'Stage' }, 'pw'] } } },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why:
      'a non-literal key selects a mapping entry this import cannot prove is the ' +
      'deployed one, so the un-taken entries are discarded template content — and ' +
      'this map holds a reference in one of them, with both bag counts zero',
    template: {
      Parameters: { Stage: { Type: 'String', Default: 'dev' } },
      Mappings: { M: { dev: { pw: 'dev-placeholder' }, prod: { pw: TOKEN } } },
    },
  },
  {
    name: 'Fn::FindInMap keyed by a PARAMETER over a pure-LITERAL map',
    properties: { Detail: { pw: { 'Fn::FindInMap': ['M', { Ref: 'Stage' }, 'pw'] } } },
    readback: { Detail: { pw: 'prod-v' } },
    expected: { Detail: { pw: 'prod-v' } },
    refused: false,
    why:
      'the NEGATIVE control for the keyed arm: whichever entry the deployed lookup ' +
      'took, every value this map can supply is public template text — refusing ' +
      'would cost the region-map idiom its baseline',
    template: {
      Parameters: { Stage: { Type: 'String', Default: 'dev' } },
      Mappings: { M: { dev: { pw: 'dev-v' }, prod: { pw: 'prod-v' } } },
    },
  },
  {
    name: 'Fn::Select with an INTRINSIC index over a list holding a reference',
    properties: {
      Detail: { pw: { 'Fn::Select': [{ Ref: 'Idx' }, [{ Ref: 'SecretRef' }, 'pub-element']] } },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why:
      "THE REVIEW ROUND'S MAJOR. resolveSelect consumes the index RAW — an " +
      'intrinsic index selects undefined here while CloudFormation resolved it at ' +
      'deploy, so the eagerly-decrypted elements are all discarded and AWS holds ' +
      'one of them',
    template: {
      Parameters: {
        Idx: { Type: 'String', Default: '1' },
        SecretRef: { Type: 'String', Default: TOKEN },
      },
    },
  },
  {
    name: 'Fn::Select with a NON-CANONICAL digit-string index over a list holding a reference',
    properties: {
      Detail: { pw: { 'Fn::Select': ['01', [{ Ref: 'SecretRef' }, 'x-element']] } },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why:
      "THE DELTA ROUND'S MAJOR. resolvedList['01'] is a property read, not an " +
      'index — it yields undefined — while CloudFormation integer-parses the ' +
      "index to 1, so '01' diverges exactly like an intrinsic index and a " +
      'digits-only static test admitted it',
    template: { Parameters: { SecretRef: { Type: 'String', Default: TOKEN } } },
  },
  {
    name: 'Fn::Select with a CANONICAL digit-string index over a list holding a reference',
    properties: {
      Detail: { pw: { 'Fn::Select': ['1', [{ Ref: 'SecretRef' }, 'x-element']] } },
    },
    readback: { Detail: { pw: 'x-element' } },
    expected: { Detail: { pw: 'x-element' } },
    refused: false,
    why:
      "the NEGATIVE control for the canonical-form tightening: '1' selects " +
      'element 1 here AND at deploy, so the discarded element 0 was discarded ' +
      'identically on both sides and AWS holds the public literal',
    template: { Parameters: { SecretRef: { Type: 'String', Default: TOKEN } } },
  },
  {
    name: 'Fn::FindInMap keyed by a DYNAMIC-REFERENCE string, balanced by a parameter-sourced sibling',
    properties: {
      A: { 'Fn::FindInMap': ['M', TOKEN, 'pw'] },
      B: { Ref: 'SecretRef2' },
    },
    readback: { A: PLAINTEXT, B: PLAINTEXT_2 },
    refused: true,
    why:
      "THE DELTA ROUND'S MINOR, measured leaking: the key string is DECRYPTED " +
      'before the lookup, so the selected entry depends on the secret deploy-time ' +
      "value; the sibling's added token BALANCES the key's consumed opener " +
      '(raw 1 / persisted 1) and the un-taken entry holds a different secret',
    template: {
      Parameters: { SecretRef2: { Type: 'String', Default: TOKEN_2 } },
      Mappings: {
        M: { [PLAINTEXT]: { pw: 'dev-placeholder' }, prod: { pw: TOKEN } },
      },
    },
  },
  {
    name: 'Fn::Select with an INTRINSIC index over a pure-LITERAL list',
    properties: {
      Detail: { pw: { 'Fn::Select': [{ Ref: 'Idx' }, ['alpha', 'beta']] } },
    },
    readback: { Detail: { pw: 'beta' } },
    expected: { Detail: { pw: 'beta' } },
    refused: false,
    why:
      'the NEGATIVE control for the Select arm: every element AWS could hold is ' +
      'public template text, so the unknown selection discloses nothing',
    template: { Parameters: { Idx: { Type: 'String', Default: '1' } } },
  },
  {
    name: 'Fn::If inside an ARRAY element, reference in the untaken branch',
    properties: {
      Detail: {
        Items: [{ 'Fn::If': ['IsProd', { Ref: 'SecretRef' }, 'dev-placeholder'] }, 'anchor-lit'],
      },
    },
    readback: { Detail: { Items: [PLAINTEXT, 'anchor-lit'] } },
    refused: true,
    why:
      'the ARRAY recursion arm, fenced (parent review measured it unpinned): a ' +
      'discarder inside a list property is the everyday cdk-synth shape ' +
      '(SecurityGroupIds and friends). The sibling literal anchors the ' +
      'positional pairing, so the replay leaks rather than masks',
    template: {
      Parameters: {
        Stage: { Type: 'String' },
        SecretRef: { Type: 'String', Default: TOKEN },
      },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
    },
  },
  {
    name: 'Fn::Select with a NUMERIC index selecting the reference itself',
    properties: {
      Detail: { pw: { 'Fn::Select': [0, [{ Ref: 'SecretRef' }, 'x-element']] } },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    expected: { Detail: { pw: TOKEN } },
    refused: false,
    why:
      "the NUMBER arm of the static-index test, fenced (parent review: every " +
      'earlier Select row spelled its index as a string or an intrinsic, while ' +
      'the dominant cdk-synth spelling is the bare number). Index 0 selects the ' +
      'same element at deploy, the secret resolves, and the token persists',
    template: { Parameters: { SecretRef: { Type: 'String', Default: TOKEN } } },
  },
  {
    name: 'nested Fn::If inside the TAKEN branch of an outer Fn::If',
    properties: {
      Detail: {
        pw: {
          'Fn::If': [
            'IsTrue',
            { 'Fn::If': ['IsProd', { Ref: 'SecretRef' }, 'dev-ph'] },
            'other-literal',
          ],
        },
      },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why:
      'the SELECTED-branch recursion, fenced: the outer condition holds (its ' +
      'parameter has a Default), so the walk must descend into the taken branch ' +
      'to see the inner downgraded drop — both counts read zero',
    template: {
      Parameters: {
        Stage: { Type: 'String', Default: 'prod' },
        Unbound: { Type: 'String' },
        SecretRef: { Type: 'String', Default: TOKEN },
      },
      Conditions: {
        IsTrue: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] },
        IsProd: { 'Fn::Equals': [{ Ref: 'Unbound' }, 'prod'] },
      },
    },
  },
  {
    name: 'MALFORMED two-argument Fn::If, reference in the true branch',
    properties: {
      Detail: { pw: { 'Fn::If': ['IsProd', { Ref: 'SecretRef' }] } },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why:
      'the malformed-args arm, fenced: resolveIf destructures the missing false ' +
      'branch as undefined and resolves it without throwing, so the downgraded ' +
      'condition persists an ABSENT leaf while the true branch — and whatever ' +
      'AWS holds from it — was discarded unresolved',
    template: {
      Parameters: {
        Stage: { Type: 'String' },
        SecretRef: { Type: 'String', Default: TOKEN },
      },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
    },
  },
  {
    name: 'Fn::FindInMap keyed by a NUMERIC literal over a map with a token elsewhere',
    properties: { Detail: { pw: { 'Fn::FindInMap': ['M', 1, 'pw'] } } },
    readback: { Detail: { pw: 'one-v' } },
    expected: { Detail: { pw: 'one-v' } },
    refused: false,
    why:
      "the NUMBER/boolean arm of the static-key test, fenced: resolveFindInMap " +
      "String()s the key, so a numeric literal selects the same entry at deploy " +
      'and the un-taken token-bearing entry was discarded identically on both sides',
    template: { Mappings: { M: { '1': { pw: 'one-v' }, prod: { pw: TOKEN } } } },
  },
  {
    name: 'Fn::FindInMap whose MAP NAME is an intrinsic, token in a SIBLING map',
    properties: { Detail: { pw: { 'Fn::FindInMap': [{ Ref: 'MapName' }, 'dev', 'pw'] } } },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why:
      'the whole-Mappings scope fallback, fenced: a dynamic map name means the ' +
      'named-map narrowing cannot apply, and the sibling map holds a reference ' +
      'the deployed lookup could have selected',
    template: {
      Parameters: { MapName: { Type: 'String', Default: 'M' } },
      Mappings: {
        M: { dev: { pw: 'm-dev-v' } },
        S: { x: { y: TOKEN } },
      },
    },
  },
  {
    name: 'downgraded Fn::If nested inside an Fn::Join argument',
    properties: {
      Detail: {
        pw: { 'Fn::Join': ['-', ['pre', { 'Fn::If': ['IsProd', { Ref: 'SecretRef' }, 'dev'] }]] },
      },
    },
    readback: { Detail: { pw: `pre-${PLAINTEXT}` } },
    refused: true,
    why:
      "the generic-recursion tail, fenced: the walk doc claims a nested Fn::If " +
      'inside an Fn::Join argument is still found, and no row exercised the ' +
      'claim — the joined readback embeds the decrypted value mid-string',
    template: {
      Parameters: {
        Stage: { Type: 'String' },
        SecretRef: { Type: 'String', Default: TOKEN },
      },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
    },
  },
  {
    name: 'TWO intrinsic-shaped keys in one object, both values inert text',
    properties: {
      Detail: { pw: { Ref: 'PlainParam', 'Fn::Sub': '${SecretRef}' } },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why:
      "the parent review's multi-key refinement: dispatch runs the Ref and drops " +
      "the Fn::Sub as a WHOLE INTRINSIC, whose string VALUE is opener-free while " +
      'its semantics pull the secret-bearing parameter — judging the dropped ' +
      "values' text admits it",
    template: {
      Parameters: {
        PlainParam: { Type: 'String', Default: 'plain-endpoint' },
        SecretRef: { Type: 'String', Default: TOKEN },
      },
    },
  },
  {
    name: 'Fn::Select with a NEGATIVE numeric index over a list holding a reference',
    properties: {
      Detail: { pw: { 'Fn::Select': [-1, [{ Ref: 'SecretRef' }, 'x-element']] } },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why:
      'the number arm must vouch only for a real index: resolveSelect answers a ' +
      'negative with its OutOfBounds placeholder, discarding the whole ' +
      'eagerly-decrypted list, so the persisted leaf is a placeholder literal ' +
      'the readback pairs against',
    template: { Parameters: { SecretRef: { Type: 'String', Default: TOKEN } } },
  },
  {
    name: 'ONE-argument Fn::FindInMap resolved through the stringified-undefined keys',
    properties: { Detail: { pw: { 'Fn::FindInMap': ['M'] } } },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why:
      "the malformed-FindInMap arm, fenced on its one SUCCESS-arm route: " +
      "resolveFindInMap String()s the missing keys to 'undefined', so a map " +
      'carrying that literal key resolves cleanly and both counts read zero',
    template: {
      Mappings: { M: { undefined: { undefined: 'undef-v' } } },
    },
  },
  {
    name: 'THREE-argument-plus Fn::Select, numeric index, reference in the list',
    properties: {
      Detail: { pw: { 'Fn::Select': [0, [{ Ref: 'SecretRef' }, 'x-element'], 'extra'] } },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    overRefusal: true,
    why:
      'the malformed-Select arm, fenced: resolveSelect destructures the first ' +
      'two args and ignores the extra, so the reference resolves and the token ' +
      'persists — nothing would have leaked, and the arm refuses the unmodelled ' +
      'shape anyway, which is the fail-closed trade the label records',
    template: { Parameters: { SecretRef: { Type: 'String', Default: TOKEN } } },
  },
  {
    name: 'Fn::FindInMap options object with a NON-DefaultValue sibling carrying a Ref',
    properties: {
      Detail: {
        pw: {
          'Fn::FindInMap': ['M', 'dev', 'pw', { DefaultValue: 'fallback-lit', Other: { Ref: 'SecretRef' } }],
        },
      },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why:
      "the whole-options inertness check, fenced (parent review): resolveFindInMap " +
      'reads ONLY DefaultValue, so the sibling subtree is discarded ' +
      'unconditionally — extracting the one key and judging it alone admitted this',
    template: {
      Mappings: { M: { dev: { pw: 'm-dev-v' } } },
      Parameters: { SecretRef: { Type: 'String', Default: TOKEN } },
    },
  },
  {
    name: 'Fn::If discarding {Ref: AWS::NoValue} — the optional-property idiom',
    properties: {
      Detail: { opt: { 'Fn::If': ['HasOpt', 'real-value', { Ref: 'AWS::NoValue' }] } },
    },
    readback: { Detail: { opt: 'real-value' } },
    expected: { Detail: { opt: 'real-value' } },
    refused: false,
    why:
      'the NEGATIVE control a review round bought: AWS::NoValue is the one ' +
      'intrinsic that cannot have produced a value at deploy either (it means ' +
      'property REMOVAL), so discarding it discards nothing AWS could hold — ' +
      'without the carve-out the most common Fn::If idiom lost its baseline',
    template: {
      Parameters: { Stage: { Type: 'String', Default: 'prod' } },
      Conditions: { HasOpt: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
    },
  },
  {
    name: 'Fn::If whose condition is ABSENT from the evaluated map, reference in the true branch',
    properties: {
      Detail: { pw: { 'Fn::If': ['NoSuchCondition', { Ref: 'SecretRef' }, 'fallback-literal'] } },
    },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    why:
      'the resolver WARNS and takes the false branch when the condition is not in ' +
      'its context, so nothing throws and both counts read zero — the same silence ' +
      'as Shape B, reached without any Conditions section at all',
    template: { Parameters: { SecretRef: { Type: 'String', Default: TOKEN } } },
  },
  {
    name: 'Fn::If under a DOWNGRADED condition discarding a BENIGN intrinsic',
    properties: {
      Detail: { endpoint: { 'Fn::If': ['IsProd', { Ref: 'PlainParam' }, 'dev-endpoint'] } },
    },
    readback: { Detail: { endpoint: 'prod-public-endpoint' } },
    refused: true,
    overRefusal: true,
    why:
      'the discarded branch is an intrinsic, so the walk cannot vouch for what the ' +
      'deployed condition produced there — refused although this particular ' +
      'parameter is public. The price of not enumerating reference sources',
    template: {
      Parameters: {
        Stage: { Type: 'String' },
        PlainParam: { Type: 'String', Default: 'public-endpoint-value' },
      },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
    },
  },
  {
    name: 'Fn::If under a DOWNGRADED condition discarding a pure-LITERAL object',
    properties: {
      Detail: { cfg: { 'Fn::If': ['IsProd', { mode: 'prod', size: 3 }, { mode: 'dev' }] } },
    },
    readback: { Detail: { cfg: { mode: 'dev' } } },
    expected: { Detail: { cfg: { mode: 'dev' } } },
    refused: false,
    why:
      'the NEGATIVE control for the discard walk: the discarded branch is pure ' +
      'literals, whose deployed value is the same public template text the walk can ' +
      'read — refusing it would cost the common placeholder pattern its baseline',
    template: {
      Parameters: { Stage: { Type: 'String' } },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Stage' }, 'prod'] } },
    },
  },
  {
    name: 'intrinsic key beside a LITERAL sibling key — dispatch drops only inert text',
    properties: { Detail: { pw: { Ref: 'SecretRef', Extra: 'literal-note' } } },
    readback: { Detail: { pw: PLAINTEXT } },
    expected: { Detail: { pw: TOKEN } },
    refused: false,
    why:
      "the NEGATIVE control for the dispatch-order rule: the dropped sibling is an " +
      'inert literal, and the dispatched Ref resolves the reference into the ' +
      'persisted bag as a token the walk can position on',
    template: { Parameters: { SecretRef: { Type: 'String', Default: TOKEN } } },
  },
  {
    name: 'token inside a KEYED array element, readback REORDERED',
    properties: { Detail: { Items: [{ Name: 'a', Value: TOKEN }, { Name: 'b', Value: 'plain' }] } },
    readback: { Detail: { Items: [{ Name: 'b', Value: 'plain' }, { Name: 'a', Value: PLAINTEXT }] } },
    expected: { Detail: { Items: [{ Name: 'b', Value: 'plain' }, { Name: 'a', Value: TOKEN }] } },
    refused: false,
    why: 'identity-keyed descent pairs by Name, so a reorder is still substituted',
  },
  {
    name: 'token inside an UNKEYED array, readback same length',
    properties: { Detail: { Items: [TOKEN, 'plain'] } },
    readback: { Detail: { Items: [PLAINTEXT, 'plain'] } },
    expected: { Detail: { Items: [TOKEN, 'plain'] } },
    refused: false,
    why: 'the corroborated positional walk pairs index-for-index',
  },
  {
    name: 'token whose SECRET does not exist, so the lookup throws',
    properties: { Detail: { pw: MISSING_TOKEN } },
    readback: { Detail: { pw: PLAINTEXT } },
    refused: true,
    overRefusal: true,
    why: 'a throw carrying any opener refuses, whether or not this one could have paired',
  },

  // ---------------------------------------------------------------------------
  // THE #2852 SHAPES (issue #2885). Every row below is ADMITTED by the
  // classifier — the resolve neither throws nor loses its marker, so the
  // refusal above never fires — and is closed one layer down, by the
  // fail-closed position walk this capture reaches since it moved to
  // `STATE_SOURCED_BASELINE_RULES`. Each `expected` bag spells the mask at the
  // exact positions the walk could not certify, which is the CONTENT half the
  // header argues for: a `not.toContain` alone cannot tell a masked baseline
  // from an empty one, and cannot tell either from a walk that quietly went
  // back to writing the source.
  //
  // Transcribed from `secret-redaction-uncertified-fail-closed.test.ts`'s
  // fail-closed block, in its order, and driven through the REAL capture rather
  // than through `redactSecretsForState` directly — which is what these rows
  // add over that suite, and the only thing that would notice the constant at
  // the call site moving back.
  // ---------------------------------------------------------------------------
  {
    name: 'ANCESTOR container RESHAPED object -> array',
    properties: { Detail: { pw: TOKEN } },
    readback: { Detail: [PLAINTEXT] },
    expected: { Detail: [SECRET_MASK] },
    refused: false,
    why: 'no position pairs a record key against an array index, so the leaf is masked',
  },
  {
    name: 'ANCESTOR gained a WRAPPER level',
    properties: { Detail: { pw: TOKEN } },
    readback: { Detail: { pw: { Inner: PLAINTEXT } } },
    expected: { Detail: { pw: { Inner: SECRET_MASK } } },
    refused: false,
    why: 'the source leaf is a scalar where the readback has a container — masked, not taken',
  },
  {
    name: 'scalar source leaf PROMOTED to a container',
    properties: { Detail: TOKEN },
    readback: { Detail: { Nested: PLAINTEXT } },
    expected: { Detail: { Nested: SECRET_MASK } },
    refused: false,
    why: 'same divergence one level up, at the top of the bag rather than inside it',
  },
  {
    name: 'identity key AWS CASE-normalised',
    properties: { Detail: { Env: [{ Name: 'db', Value: TOKEN }] } },
    readback: { Detail: { Env: [{ Name: 'DB', Value: PLAINTEXT }] } },
    expected: { Detail: { Env: [{ Name: SECRET_MASK, Value: SECRET_MASK }] } },
    refused: false,
    why:
      'the keyed descent finds no partner for `DB`, so the whole element is refused ' +
      '— the identity field with it, because once the pairing is gone nothing ' +
      'distinguishes a normalised literal from a resolved secret',
  },
  {
    name: 'identity key AWS expanded to an ARN',
    properties: { Detail: { Env: [{ Name: 'A', Value: TOKEN }] } },
    readback: { Detail: { Env: [{ Name: 'arn:aws:x:::A', Value: PLAINTEXT }] } },
    expected: { Detail: { Env: [{ Name: SECRET_MASK, Value: SECRET_MASK }] } },
    refused: false,
    why: 'second spelling of the axis — does the identity round-trip BYTE-identically',
  },
  {
    name: 'UNKEYED array whose sibling literal AWS normalised',
    properties: { Detail: { Items: [TOKEN, 'us-east-1'] } },
    readback: { Detail: { Items: [PLAINTEXT, 'US-EAST-1'] } },
    expected: { Detail: { Items: [SECRET_MASK, SECRET_MASK] } },
    refused: false,
    why: 'the anchors stop corroborating, so the positional walk is not licensed',
  },
  {
    name: 'UNKEYED array AWS REORDERED',
    properties: { Detail: { Items: [TOKEN, 'plain'] } },
    readback: { Detail: { Items: ['plain', PLAINTEXT] } },
    expected: { Detail: { Items: ['plain', SECRET_MASK] } },
    refused: false,
    why:
      'the mirror of the corroborated row above: same two values, order swapped, and ' +
      'the anchor `plain` is SPARED because the source array spells it SOMEWHERE in ' +
      'the refused subtree — the spare set is position-INDEPENDENT, which is why it ' +
      'survives at index 0 where the source spells the token',
  },
  {
    name: 'UNKEYED array whose LENGTH AWS changed',
    properties: { Detail: { Items: [TOKEN, 'plain'] } },
    readback: { Detail: { Items: [PLAINTEXT, 'plain', 'aws-added'] } },
    expected: { Detail: { Items: [SECRET_MASK, 'plain', SECRET_MASK] } },
    refused: false,
    why:
      'index counts differ, the first of the four anchor conditions — the AWS-added ' +
      'element is masked alongside the secret, which is the over-masking the ' +
      'fail-closed direction accepts by design',
  },
  {
    name: 'two LOOKALIKE reference elements in an unkeyed array',
    properties: { Detail: { Items: [{ V: TOKEN }, { V: TOKEN_2 }] } },
    readback: { Detail: { Items: [{ V: PLAINTEXT }, { V: PLAINTEXT_2 }] } },
    expected: { Detail: { Items: [{ V: SECRET_MASK }, { V: SECRET_MASK }] } },
    refused: false,
    why:
      'nothing tells the two elements apart, so pairing them by index would ' +
      "misattribute each secret to the other's expression",
  },
  {
    name: 'a single bare-token element with no literal FRAME',
    properties: { Detail: { Items: [TOKEN] } },
    readback: { Detail: { Items: [PLAINTEXT] } },
    expected: { Detail: { Items: [SECRET_MASK] } },
    refused: false,
    why:
      'the NEGATIVE of the corroborated one-frame row above: a one-element list ' +
      'whose only member is the reference has no literal position left to anchor on',
  },
  {
    name: 'RAW intrinsic source OBJECT vs STRING readback, resolve does NOT throw',
    properties: { Detail: { pw: { 'Fn::Transform': { Name: 'X', Parameters: { v: TOKEN } } } } },
    readback: { Detail: { pw: PLAINTEXT } },
    expected: { Detail: { pw: SECRET_MASK } },
    refused: false,
    why:
      'the #2846 shape on the ADMITTED path. The four closedByMask rows reach it by ' +
      'THROWING, which is what nearly cost this row: an `Fn::Transform` is left ' +
      'unresolved with nothing thrown, so the classifier admits the resource and the ' +
      'raw object reaches the walk as an unpairable source leaf',
  },
];

function stateFor(row: Row): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName: 'matrix-stack',
    region: 'us-east-1',
    resources: {
      Res: {
        physicalId: 'res-phys',
        resourceType: 'AWS::SQS::Queue',
        properties: structuredClone(row.properties),
      },
    },
    outputs: {},
    lastModified: 0,
  } satisfies StackState;
}

function templateFor(row: Row): CloudFormationTemplate {
  return {
    ...row.template,
    Resources: { Res: { Type: 'AWS::SQS::Queue', Properties: {} } },
  } as CloudFormationTemplate;
}

async function classify(row: Row): Promise<{ refused: boolean; persisted: Record<string, unknown> }> {
  const state = stateFor(row);
  // `stateBackend` is only consulted for a cross-stack read, and no row holds
  // one — the same cast, for the same reason, as the sibling masking suite.
  const refusedIds = await resolveImportedProperties(
    state,
    templateFor(row),
    'us-east-1',
    undefined as never,
    getLogger()
  );
  return { refused: refusedIds.has('Res'), persisted: state.resources['Res']!.properties };
}

/**
 * Drives the REAL `captureObservedForImportedResources` rather than replaying
 * its `redactSecretsForState` call by hand: a hand-rolled replay keeps this
 * fence green when production's arguments change, which is the one regression
 * an input-space matrix must not miss.
 *
 * The provider double takes the FIVE arguments production passes
 * (`physicalId`, `logicalId`, `resourceType`, `properties`, `context`) and
 * records them. FOUR are asserted by the caller — `physicalId`,
 * `resourceType`, `logicalId` and `properties`. `context` is recorded and
 * deliberately NOT asserted: it is `buildReadCurrentStateContext`'s output,
 * whose own shape is fenced by that function's suite, and pinning it here
 * would couple this table to a sibling-map layout no row varies.
 *
 * An earlier revision of this paragraph said the call shape "is pinned too"
 * while only TWO of the five were read — the recorded-but-unread arguments
 * looked like coverage and were not. Say which are asserted.
 */
async function captureVia(
  row: Row,
  persisted: Record<string, unknown>,
  refusedIds: ReadonlySet<string>
): Promise<{ observed: unknown; seen: readonly unknown[] }> {
  const seen: unknown[] = [];
  const state = stateFor(row);
  state.resources['Res']!.properties = persisted;
  const provider = {
    readCurrentState: async (
      physicalId: string,
      logicalId: string,
      resourceType: string,
      properties: Record<string, unknown>,
      context?: unknown
    ) => {
      seen.push({ physicalId, logicalId, resourceType, properties, context });
      return structuredClone(row.readback);
    },
  };
  const registry = {
    getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
  } as unknown as Parameters<typeof captureObservedForImportedResources>[1];
  await captureObservedForImportedResources(state, registry, getLogger(), refusedIds);
  return { observed: state.resources['Res']!.observedProperties, seen };
}

describe('cdkd import: which resources may take an observedProperties baseline (issue #2828)', () => {
  it('the table covers every enumerated shape, and both verdicts occur in it', () => {
    // A floor on the POOL, written as literals from this file rather than
    // derived from the array: a table that quietly lost its refusing rows would
    // otherwise satisfy every assertion below by having nothing to check.
    expect(ROWS).toHaveLength(60);
    expect(ROWS.filter((r) => r.refused)).toHaveLength(32);
    expect(ROWS.filter((r) => !r.refused)).toHaveLength(28);
    // The deliberate over-refusals. This counts the rows' own LABEL, so it
    // cannot catch production refusing more than it should — the widening
    // fence is the ADMITTED rows above, which red when a refusal reaches
    // them. What the label buys is premise-loop EXEMPTION: an overRefusal row
    // skips the proves-it-really-leaked replay, so quietly silencing an
    // unearned refusal has to flip this literal and show up in the diff.
    expect(ROWS.filter((r) => r.overRefusal)).toHaveLength(5);
    expect(
      ROWS.filter((r) => r.overRefusal && !r.refused),
      'an over-refusal that is not a refusal is a contradiction'
    ).toHaveLength(0);
    // A floor PER CLASS, not just on the total: the premise loop proves a
    // different property for each, so a row silently changing class would move
    // which assertion guards it while every aggregate stayed put.
    expect(ROWS.filter((r) => r.closedByMask)).toHaveLength(4);
    expect(
      ROWS.filter((r) => r.closedByMask && !r.refused),
      'a row closed by the mask below is still a REFUSAL at this layer'
    ).toHaveLength(0);
    expect(
      ROWS.filter((r) => r.closedByMask && r.overRefusal),
      'the two exemptions are disjoint: one says the walk COULD pair, the other that it could not'
    ).toHaveLength(0);
    // `expectedOnReplay` belongs to the mask class and to nothing else — a row
    // carrying one without the marker is asserted by no branch at all.
    expect(
      ROWS.filter((r) => r.expectedOnReplay !== undefined && !r.closedByMask),
      'expectedOnReplay is the closedByMask branch\'s expected column; on any other row nothing reads it'
    ).toHaveLength(0);
    expect(new Set(ROWS.map((r) => r.name)).size, 'row names are unique').toBe(ROWS.length);
  });

  it('a bag too deep for the discard walk is REFUSED fail-closed, and the import survives (parent-review blocker)', async () => {
    // The discard walk recurses SYNCHRONOUSLY. Its frames are the heaviest of
    // the per-resource passes — measured through this very harness, it
    // overflows at roughly a THIRD of the depth `JSON.stringify` handles and
    // well below the resolver's own descent limit — so a window exists where
    // the resolve completes, both opener counts compute normally, and the
    // walk ALONE raises `RangeError`. Unwrapped, that error escaped
    // `resolveImportedProperties` and aborted the import AFTER the AWS-side
    // import had succeeded — the loss the function's own parameter-fallback
    // comment forbids. The ARM-3 call site now catches it and REFUSES.
    //
    // No depth is hard-coded, because every limit here moves with the
    // engine's stack size AND with the ambient call depth of the test worker
    // (a fixed fraction of the stringify limit was measured landing on
    // DIFFERENT arms in different workers). Instead this case BISECTS, through
    // the real entry point, to the smallest depth the classifier refuses, and
    // then asserts the refusal it measured there was NOT the resolver's (no
    // ARM-1 warn): the walk has the lowest limit of the passes, so the first
    // refusing depth is the fail-closed catch — and if an engine ever inverts
    // the frame-weight ordering, the ARM-1 warn shows up at the boundary and
    // this case fails LOUDLY rather than leaving the window silently
    // untested.
    const nest = (depth: number): unknown => {
      let value: unknown = 'leaf';
      for (let i = 0; i < depth; i++) value = { a: value };
      return value;
    };
    const warnMock = (getLogger() as unknown as { warn: ReturnType<typeof vi.fn> }).warn;
    const probe = async (depth: number): Promise<{ refused: boolean; resolveThrew: boolean }> => {
      warnMock.mockClear();
      const state: StackState = {
        version: STATE_SCHEMA_VERSION_CURRENT,
        stackName: 'matrix-stack',
        region: 'us-east-1',
        resources: {
          Res: {
            physicalId: 'res-phys',
            resourceType: 'AWS::SQS::Queue',
            properties: { Deep: nest(depth) } as Record<string, unknown>,
          },
        },
        outputs: {},
        lastModified: 0,
      };
      const refusedIds = await resolveImportedProperties(
        state,
        {
          Resources: { Res: { Type: 'AWS::SQS::Queue', Properties: {} } },
        } as CloudFormationTemplate,
        'us-east-1',
        undefined as never,
        getLogger()
      );
      return {
        refused: refusedIds.has('Res'),
        resolveThrew: warnMock.mock.calls.some((call) =>
          String(call[0]).includes('Failed to resolve intrinsics')
        ),
      };
    };
    // A shallow plain bag is ADMITTED — the anchor that makes the search's
    // "first refusing depth" a real boundary rather than refusal-everywhere.
    expect((await probe(64)).refused, 'a shallow plain bag must be admitted').toBe(false);
    let lo = 64;
    let hi = 128;
    let refusingProbe = await probe(hi);
    while (!refusingProbe.refused) {
      lo = hi;
      hi *= 2;
      expect(hi, 'no refusing depth found below 2^21 — the walk stopped overflowing?').toBeLessThan(
        1 << 21
      );
      refusingProbe = await probe(hi);
    }
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      const result = await probe(mid);
      if (result.refused) {
        hi = mid;
        refusingProbe = result;
      } else {
        lo = mid;
      }
    }
    // The import SURVIVED every probe (each await resolved instead of
    // rejecting), and the minimal refusing depth was refused with the resolve
    // COMPLETED — i.e. by ARM 3's fail-closed catch, not by ARM 1.
    expect(refusingProbe.refused).toBe(true);
    expect(
      refusingProbe.resolveThrew,
      'at the minimal refusing depth the resolve completed, so the refusal must be the ' +
        'walk-overflow catch — an ARM-1 warn here means the frame-weight ordering inverted'
    ).toBe(false);
  }, 60_000);

  for (const row of ROWS) {
    it(`SAFE: ${row.name}`, async () => {
      const { refused, persisted } = await classify(row);

      // THE INVARIANT. Independent of how the verdict was reached, so a shape
      // nobody enumerated still has to satisfy it.
      if (!refused) {
        const { observed: redacted, seen } = await captureVia(row, persisted, new Set());
        expect(seen, `${row.name}: the provider was not consulted`).toHaveLength(1);
        expect(
          (seen[0] as { physicalId: string; resourceType: string }).physicalId,
          `${row.name}: production must pass the recorded physicalId`
        ).toBe('res-phys');
        expect((seen[0] as { resourceType: string }).resourceType).toBe('AWS::SQS::Queue');
        expect(
          (seen[0] as { logicalId: string }).logicalId,
          `${row.name}: production must pass the record's own logical id`
        ).toBe('Res');
        // The bag the provider is READ WITH is the record's PERSISTED
        // properties, not the row's template input — the same object the
        // redaction below positions against. Pinning it is what stops a future
        // edit reading AWS with one bag and positioning against another, which
        // would make every certified position a coincidence.
        expect(
          (seen[0] as { properties: unknown }).properties,
          `${row.name}: production must read with the record's persisted properties`
        ).toEqual(persisted);
        expect(
          JSON.stringify(redacted),
          `${row.name}: captured a baseline that still holds the plaintext (${row.why})`
        ).not.toContain(row.needle ?? PLAINTEXT);
        // CONTENT, not just absence: `not.toContain` alone is satisfied by a
        // redactor that returns `{}`, and several shapes exist only here.
        expect(
          row.expected,
          `${row.name}: a non-refused row must declare its expected bag. ` +
            '`not.toContain` alone is satisfied by a redactor returning `{}`, so a ' +
            'row without `expected` silently degrades to an absence check.'
        ).toBeDefined();
        expect(redacted, `${row.name}: wrong bag persisted`).toEqual(row.expected);
      }

      // THE EXPECTED VERDICT. Paired with the invariant so that refusing
      // everything — which satisfies the invariant perfectly — cannot pass.
      expect(refused, `${row.name}: ${row.why}`).toBe(row.refused);
    });
  }

  it('the premise holds: every refused row was refused over something REAL', async () => {
    // Without this the refusing half of the table is unfalsifiable — a row
    // could be refused for a shape that was never dangerous, and the fence
    // would read as protective while protecting nothing. So replay the capture
    // for each refused row ANYWAY and require the hazard to show: that is what
    // the refusal is buying, measured rather than assumed.
    //
    // TWO SHAPES OF PROOF since issue #2885, one per class, and a floor on
    // each. Before the swap every earned refusal proved itself with a surviving
    // PLAINTEXT. Four of them now prove it with a MASK instead: the classifier
    // still refuses, and replaying anyway reaches the fail-closed position walk
    // — so the plaintext assertion would red for the layer below doing its job,
    // while the MASK is the same evidence (the position could not be certified)
    // read off the layer that now records it. Losing that distinction is how
    // this loop would go quietly vacuous, which is why each class carries its
    // own count rather than one total.
    let provenByPlaintext = 0;
    let provenByMask = 0;
    for (const row of ROWS.filter((r) => r.refused && !r.overRefusal)) {
      const { persisted } = await classify(row);
      const { observed: redacted } = await captureVia(row, persisted, new Set());
      const json = JSON.stringify(redacted);
      const needle = row.needle ?? PLAINTEXT;
      if (row.closedByMask) {
        expect(
          json,
          `${row.name}: marked closedByMask, but the plaintext survived the capture — ` +
            'the row belongs in the plaintext class, and the fail-closed walk did not fire'
        ).not.toContain(needle);
        expect(
          json,
          `${row.name}: refused, and capturing leaves NEITHER the plaintext nor a mask — ` +
            'nothing was at risk here, so the refusal is unearned and the row is an overRefusal'
        ).toContain(SECRET_MASK);
        // CONTENT, exactly as the admitted rows get. `toContain` over a
        // STRINGIFIED bag is position- and shape-blind: a walk that masked the
        // wrong leaf, masked every leaf, or reshaped the container satisfies it.
        expect(
          row.expectedOnReplay,
          `${row.name}: a closedByMask row must declare the bag its replay persists. ` +
            'Without one this branch degrades to a presence check on `***`.'
        ).toBeDefined();
        expect(redacted, `${row.name}: wrong bag on replay`).toEqual(row.expectedOnReplay);
        provenByMask++;
      } else {
        expect(
          json,
          `${row.name}: refused, but capturing would NOT have leaked — the refusal is unearned`
        ).toContain(needle);
        provenByPlaintext++;
      }
    }
    expect(provenByPlaintext, 'the loop ran over every refusal earned by a PLAINTEXT').toBe(23);
    expect(provenByMask, 'the loop ran over every refusal earned by a MASK').toBe(4);
  });
});
