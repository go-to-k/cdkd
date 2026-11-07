import { IntrinsicResolutionRefusalError } from '../../../utils/error-handler.js';
import { dynamicReferenceTokens, errorCauseChain } from '../../secret-redaction.js';

/** The nested-stack resource type, whose `Outputs.<Name>` attributes are re-resolved (issue #2055). */
export const NESTED_STACK_RESOURCE_TYPE = 'AWS::CloudFormation::Stack';
/** Prefix `NestedStackProvider` records a child stack output under. */
export const NESTED_STACK_OUTPUT_ATTRIBUTE_PREFIX = 'Outputs.';
/**
 * `arn:cdkd-local:<childRegion>:<accountId>:nested-stack/<parent>/<logicalId>` —
 * the synthesized physicalId `NestedStackProvider.synthesizeArn` records on the
 * parent's `AWS::CloudFormation::Stack` row.
 */
export const NESTED_STACK_LOCAL_ARN = /^arn:cdkd-local:([a-z0-9-]+):[^:]*:nested-stack\//i;

/**
 * The CHILD stack's region, read off the parent row's synthesized physicalId
 * (issue [#2055](https://github.com/go-to-k/cdkd/issues/2055)).
 *
 * WHY THE ARN AND NOT A STATE READ. The child's own record carries `region`,
 * but its state KEY is `cdkd/<parent>~<logicalId>/<region>/state.json` — the
 * region is part of the key, so reading the record to learn the region is
 * circular. The synthesized physicalId is the SAME provider's durable record of
 * the region it deployed the child into, it sits on the resource row the
 * resolver already holds, and reading it costs no I/O on a path that is
 * otherwise hot.
 *
 * Returns `undefined` for anything that is not that shape (a hand-edited state
 * file, a record written before this provider existed), which the caller reads
 * as "use this resolver's own region".
 */
export function nestedStackChildRegionFromLocalArn(
  physicalId: string | undefined
): string | undefined {
  if (typeof physicalId !== 'string') return undefined;
  return NESTED_STACK_LOCAL_ARN.exec(physicalId)?.[1];
}

/**
 * The array position a RESOLVED `Fn::Select` index names, or `undefined` when
 * it names none (issue #3574): a non-negative safe integer, or its canonical
 * decimal string (CloudFormation accepts `"1"`, and a `Ref` to a parameter the
 * resolver did not coerce is still a string). No `Number()` on anything else:
 * it trims whitespace and maps `""` / `null` / `[]` to `0`. No leading zero
 * either, so `String(position)` IS the resolved text and masks like it — the
 * same shape `import.ts`'s `isStaticSelectIndex` vouches for.
 */
export function selectIndexPosition(value: unknown): number | undefined {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)
        ? Number(value)
        : undefined;
  return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

/**
 * One entry in {@link ResolverContext.abandonedResolutions} — one UNIT of a
 * resolution this pass could not complete, recorded instead of abandoning every
 * later unit beside it (issues
 * [#3181](https://github.com/go-to-k/cdkd/issues/3181) /
 * [#3218](https://github.com/go-to-k/cdkd/issues/3218)).
 *
 * Two units, because the defect had two spellings and closing one leaves the
 * other live. A `token` is one `{{resolve:...}}` reference inside a string leaf
 * (#3181); a `key` is one entry of an object property bag or of an `Fn::Sub`
 * variable map (#3218), whose failure needs no dynamic reference at all — the
 * issue's own repro fails on a `Ref` — and therefore never reaches the token
 * loop. A third, `placeholder` (#2166), records a reference nothing threw for:
 * see {@link AbandonedResolution.unit}.
 *
 * STRUCTURED, for the reason its sibling below records at length: a consumer
 * forced to recover structure out of a human string couples to a spelling, and
 * both prior attempts at that coupling shipped a defect.
 */
export interface AbandonedResolution {
  /**
   * Which walk abandoned this unit. A `placeholder` is the one unit nothing
   * THREW for (issue [#2166](https://github.com/go-to-k/cdkd/issues/2166)):
   * `resolveSub` KEPT an undeclared `${...}` inside a `{{resolve:...}}`
   * reference, so that reference cannot be evaluated and was never looked up.
   * Its `subject` is the placeholder as the template spells it.
   */
  readonly unit: 'token' | 'key' | 'placeholder';
  /**
   * For `'token'`, the reference as the log twin would PRINT it — never the raw
   * one: `resolveSub` / `resolveJoin` re-enter with an ASSEMBLED string, so
   * `fullMatch` can carry a plaintext the caller holds no needle for (issue
   * #2827). For `'key'`, the property / variable name, which is template
   * structure rather than a value.
   */
  readonly subject: string;
  /**
   * The thrown message, MASKED at push. An SSM `ValidationException` echoes the
   * `Name` it was given — which for an assembled reference IS a plaintext.
   * `sendWithThrottleRetry` already rethrows it masked by position
   * (go-to-k/cdkd#3171); the push-time mask stays as the layer for every other
   * throw. Render THIS, never {@link error}.
   *
   * The two units are masked to different DEPTHS, and the difference is stated
   * rather than smoothed over. A `'token'` entry additionally maps each raw
   * reference segment through the twin-derived `nameLogText` first, which has
   * no length floor, so a SUB-FLOOR plaintext is cleaned. A `'key'` entry has
   * no such source — the key is template structure, and the failure under it
   * is a `Ref`/`Fn::GetAtt` rather than a fetch that echoes a secret name — so
   * it gets the `MIN_NEEDLE_LENGTH`-floored needle mask alone. No reachable
   * path was found where that matters (a nested token failure RECOVERS rather
   * than throwing up to the key), but the asymmetry is real.
   */
  readonly message: string;
  /**
   * Whatever was thrown, for CLASSIFICATION only. Never render it: unlike
   * {@link message} it is not guaranteed masked (an SDK rejection from a lookup
   * arrives as a masked clone since go-to-k/cdkd#3171, other throws do not),
   * and it is kept so a consumer can test its class rather than its wording.
   */
  readonly error: unknown;
  /**
   * Did THIS unit's own input carry a `{{resolve:...}}` reference at all?
   *
   * Recorded as a BOOLEAN, computed at push time from the raw input, so the
   * entry can be judged per unit without carrying a value that could be a
   * plaintext. A consumer that judged the enclosing property instead gets the
   * wrong answer in both directions: go-to-k/cdkd#3218's abandoned key is a
   * bare `{"Ref": ...}` carrying no reference — nothing about it is
   * unverifiable — while a sibling entry in the same bag may be a genuinely
   * unfetched reference that must still gate the exit code.
   */
  readonly carriedDynamicReference: boolean;
  /**
   * Did this unit's own input carry a reference that could be FETCHED — i.e.
   * one that is not still awaiting an `Fn::Sub` placeholder? Separates "nobody
   * could have resolved this" from "this one was resolvable and was not
   * resolved", which is the line between reporting and gating.
   */
  readonly carriedFetchableReference: boolean;
}

/**
 * The prefix every dynamic-reference diagnostic this resolver spells carries.
 *
 * Exported because `cdkd scrub` applies the SAME partition on its side and must
 * not keep a second spelling of it (issue #1936's rule, one layer up): a bare
 * marker tail is reachable from text this resolver did not write — `Parameter X
 * is required but no value was provided` comes out of `resolveParameters` — so
 * the prefix is what makes the match an assertion about OWNERSHIP.
 */
export const DYNAMIC_REFERENCE_PREFIX = 'Dynamic reference: ';

/**
 * Does `source` carry a `{{resolve:...}}` reference that could actually be
 * FETCHED — one not still awaiting an `Fn::Sub` placeholder?
 *
 * Moved here from `cdkd scrub` (issue go-to-k/cdkd#3181), which still imports
 * it, because the resolver needs the same question answered per abandoned UNIT
 * and issue #1936 forbids a second spelling of the token pattern.
 *
 * The distinction it draws is between "nobody could have resolved this" and
 * "this one was resolvable and was not resolved" — the line between merely
 * REPORTING an abandonment and letting it gate an exit code.
 */
export function carriesFetchableDynamicReference(source: unknown): boolean {
  if (typeof source === 'string') {
    // `dynamicReferenceTokens`, never a local regex: a scan that disagreed with
    // the resolver about where a token ENDS would disagree about which argument
    // the `${` test is applied to. (Fenced by
    // `secret-redaction-dynamic-reference-pattern.test.ts`.)
    return dynamicReferenceTokens(source).some((token) => !token.includes('${'));
  }
  if (Array.isArray(source)) return source.some(carriesFetchableDynamicReference);
  if (source !== null && typeof source === 'object') {
    return Object.values(source as Record<string, unknown>).some(carriesFetchableDynamicReference);
  }
  return false;
}

/**
 * The NAMELESS spellings, which REFUSE rather than fail to fetch.
 *
 * `{{resolve:secretsmanager:}}` with an empty argument is a structurally broken
 * template, and no substitution produces one — an unresolved `Fn::Sub` keeps its
 * literal `${...}`. `cdkd scrub` has refused on these since
 * [#2692](https://github.com/go-to-k/cdkd/issues/2692), so the per-unit
 * recovery must not quietly downgrade one to a skipped token.
 */
export const NAMELESS_DYNAMIC_REFERENCE_MARKERS = [
  'PARAMETER_NAME is required',
  'SECRET_ID is required',
] as const;

/**
 * `err` is a refusal this resolver took ON PURPOSE rather than a step that
 * failed, so the per-unit recovery must re-raise it and abort the walk.
 *
 * The partition is the one `cdkd scrub` already applies on its side
 * (go-to-k/cdkd#3178), drawn by OWNERSHIP rather than vocabulary: every refusal
 * here is one THIS repo decides and spells, which is what makes matching it
 * sound in a way that matching AWS's error text never is. Everything else — any
 * SDK rejection, any shape this cannot classify — is treated as a failed step
 * and RECORDED. That asymmetry is deliberate: the residual is a unit reported
 * as unresolved, never a refusal silently skipped.
 *
 * The two halves of the message test open the partition in DIFFERENT
 * directions, and their EVIDENCE differs — stated separately rather than
 * asserted together, because only one of them is demonstrated.
 *
 * {@link DYNAMIC_REFERENCE_PREFIX} is REACHABLE and tested: a secret id is
 * template-assembled, so AWS's rejection echoes the name it was handed, and a
 * parameter named after a marker puts the bare tail inside a message this repo
 * did not write. Matching the tail alone reads that as a refusal and disarms
 * recovery for the leaf — restoring exactly the loss #3181 removes.
 *
 * The CAUSE walk is defence in depth, and NO reachable wrapping of one of these
 * throws was found from inside either walk's `try` (the in-repo precedent for
 * the shape is `role-arn.ts`). It is kept because the two failure directions
 * are not symmetric: an unrecognised refusal is recorded and walked past, which
 * is the one residual this partition promises cannot happen, while the cost of
 * the walk is a bounded chain read. Do not cite it as fenced — it is not.
 */
export function isNamelessDynamicReferenceError(err: unknown): boolean {
  // The MESSAGE arm of the partition, exported because `cdkd scrub` asks the
  // same question on its side and issue #1936 forbids a second spelling of one
  // predicate. The constants moved here under go-to-k/cdkd#3181; the
  // conjunction over them was left behind, spelled byte-identically in both
  // files, which is the same drift one level up.
  //
  // Both halves are load-bearing. The prefix is what makes the match an
  // assertion about OWNERSHIP — a bare marker tail is reachable from text this
  // repo did not write (`resolveParameters` raises `Parameter <name> is
  // required but no value was provided`). The cause walk catches a refusal
  // wrapped on its way out.
  if (!(err instanceof Error)) return false;
  return errorCauseChain(err).some(
    (link) =>
      link.message.includes(DYNAMIC_REFERENCE_PREFIX) &&
      NAMELESS_DYNAMIC_REFERENCE_MARKERS.some((m) => link.message.includes(m))
  );
}

export function isDeliberateResolutionRefusal(err: unknown): boolean {
  // Covers `CrossAccountSecretRefusalError` and
  // `DynamicReferenceRegionAmbiguousError`, which extend it — all three re-set
  // their prototype, so `instanceof` survives the subclassing. Tested over the
  // CAUSE chain for the same reason the message arm is.
  if (!(err instanceof Error)) return false;
  if (errorCauseChain(err).some((link) => link instanceof IntrinsicResolutionRefusalError)) {
    return true;
  }
  return isNamelessDynamicReferenceError(err);
}

/**
 * One entry in {@link ResolverContext.redactedAttributeReads} — a read the
 * resolver served out of a REDACTED persisted record.
 *
 * STRUCTURED RATHER THAN A JOINED STRING, and that is the fix for a defect
 * CLASS rather than for one consumer (issue
 * [#2847](https://github.com/go-to-k/cdkd/issues/2847) review rounds 3 and 4).
 * The bag used to hold only `display`, and `DeployEngine` recovered the
 * structure back out of it with two regexes — one deciding the remedy text,
 * one deciding whether an Outputs read is refused. Re-parsing a
 * human-readable string produced a blocker twice, by two different mechanisms:
 * first a SPELLING coupling (a producer rename silently disarms the consumer),
 * then a CHARSET one (`/^Ref ([A-Za-z0-9]+) .../` cannot match a hyphenated
 * logical id, which cdkd accepts because it validates no logical-id charset
 * and never hands the template to CloudFormation — so the Outputs guard
 * silently published a raw physical id for `{"Ref": "My-Table"}`).
 *
 * With the structure carried in the data, a consumer asks a FIELD. Neither a
 * rename nor a character outside some regex's class can disarm one, and the
 * rendering is free to change without a consumer noticing.
 *
 * `display` is the only member a user ever sees; the other two are for
 * routing. `display` may be MASKED — AND SANITIZED, since go-to-k/cdkd#3426:
 * both the attribute name and the cross-stack origin go through
 * `displayMasked` on the way in, which strips control characters and runs
 * `displaySafe` as well as masking, since the deploy engine joins these into a
 * throw at DEFAULT verbosity. That is why dedup keys on `display`: it is what
 * the message would repeat.
 *
 * ONE CONSEQUENCE, stated because the dedup test at
 * `pushRedactedAttributeRead` (`getatt.ts`) keys its fourth
 * conjunct on this field: two reads whose names differ ONLY by control
 * characters or padding now produce the same `display` and COLLAPSE, so
 * `refuseRedactedAttributeReads` shows one row where it used to show two. Same
 * accepted trade as the masked-key collapse in `maskValueLeaves` — the loss is
 * a row COUNT in a diagnostic and never a disclosure, and the direction is
 * safe: the surviving row carries the sanitized spelling either way.
 */
export interface RedactedAttributeRead {
  /**
   * WHICH resolution branch served the mask. `ref-state-key` is the only kind
   * whose fall-through emits a value NO downstream reader recognises (the raw
   * physical id), which is why `resolveOutputs` refuses on it alone — see the
   * scoping argument at `DeployEngine`'s `refuseMaskedOutputReads`.
   */
  readonly kind: 'ref-state-key' | 'attribute' | 'cross-stack';
  /**
   * The logical id whose STATE RECORD holds the mask — the target a
   * `cdkd import --resource <id>=... --force` would repair. NOT the resource
   * being provisioned. Absent for `cross-stack`, whose record lives in another
   * stack's state and which no re-import here can reach.
   */
  readonly logicalId?: string;
  /**
   * The state key (`ref-state-key`) or attribute name (`attribute`) the read
   * named. Informational — no consumer routes on it today; it is here so the
   * `display` rendering stays derivable from the entry.
   */
  readonly key?: string;
  /**
   * `true` when the record's `noEchoAttributeNames` (schema v11,
   * go-to-k/cdkd#2449) names the attribute: its producer DECLARED it
   * `NoEcho`, so the refusal names that one cause instead of listing every
   * way a record can come to hold the mask. Absent on a pre-v11 record.
   */
  readonly declaredNoEcho?: true;
  /** The user-facing rendering, built where the structure is still known. */
  readonly display: string;
}
