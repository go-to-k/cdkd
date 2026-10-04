import { IntrinsicResolutionRefusalError } from '../../utils/error-handler.js';
import { type RetryLogger } from '../retry.js';
import {
  type StaleAttributeHealPhase,
  type StaleAttributeHealer,
} from '../stale-attribute-heal.js';
import {
  dynamicReferenceTokens,
  recordSecretExpression,
  forgetSecretExpression,
  isRecordedSecretExpression,
  clearRecordedSecretExpressions,
  errorCauseChain,
  type DynamicReferenceSubstitution,
  type RecordedSecretValues,
} from '../secret-redaction.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import {
  type ResourceState,
  type StateImportEntry,
  type StateOutputReadEntry,
} from '../../types/state.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import type { ExportIndexStore } from '../../state/export-index-store.js';

/**
 * The same context with the `producerRegions` EVIDENCE removed (issue #2134
 * review rounds 1 and 2).
 *
 * That field means "the CONSUMER stack reads from these regions", and it is
 * only meaningful where the origin of a reference is genuinely UNKNOWN. Hand it
 * to a resolution whose origin is already established and it re-judges a
 * reference cdkd has just proven, verdicting `ambiguous`.
 *
 * ROUND 1 stripped it by RESOLVER IDENTITY -- "is this a different instance?"
 * -- and round 2 measured that that is the wrong question. When the producer
 * lives in the CONSUMER's own region `resolverForProducerRegion` returns `this`,
 * so the identity test passed the evidence straight through and a name-form
 * reference read out of that producer was refused. The LOCAL producer failed
 * while the CROSS-REGION one succeeded, which is backwards, and after the
 * round-1 re-raise it aborted the whole stack's scrub rather than logging a
 * debug line.
 *
 * The right question is whether the ORIGIN IS KNOWN, so each caller answers it
 * for itself and this helper only performs the strip. Returned BY IDENTITY when
 * there is no evidence to remove, so the ordinary path allocates nothing.
 */
export function withoutProducerRegions(
  context: ResolverContext | undefined
): ResolverContext | undefined {
  if (context?.producerRegions === undefined) return context;
  const { producerRegions: _stripped, ...rest } = context;
  return rest;
}

/**
 * A resolved string beside its LOG TWIN (issue
 * [#3100](https://github.com/go-to-k/cdkd/issues/3100)): the same string with
 * every span a recorded secret was WRITTEN into replaced by
 * {@link SECRET_MASK}. `resolveJoin` / `resolveSub` build it alongside the
 * value and log the twin, never the value.
 *
 * It exists because the NEEDLE mask (`maskNeedlesForLog`) masks a 1-3
 * character secret only as the WHOLE text (`MIN_NEEDLE_LENGTH`), so
 * `port:` + a two-character secret printed in the clear. The floor is right for
 * a needle — a short needle would rewrite unrelated text in every line — and
 * what the needle lacks is POSITION, which only the writer holds. The twin is
 * therefore built at the writes, and the needle mask still runs over it for
 * everything a write did not see.
 */
export interface LogTwin {
  readonly result: string;
  readonly twin: string;
}

/**
 * A dynamic-reference pass over one string: its {@link LogTwin}, every token
 * it REPLACED with the verdict that replacement took, and whether it replaced
 * every token it met (issue [#3156](https://github.com/go-to-k/cdkd/issues/3156)).
 * `resolveJoin` / `resolveSub` assemble these into the object's
 * `IntrinsicLeafResolution`.
 */
export interface DynamicReferencePass extends LogTwin {
  readonly substitutions: readonly DynamicReferenceSubstitution[];
  readonly complete: boolean;
}

/**
 * Masked log twins registered this pass, per pass bag (issue #3100;
 * `rememberLogTwin` / `logTwinOfProduct`). Nothing that RESOLVES a value reads
 * it. One persistence decision does: `resolveBase64` registers its encoding
 * mask-only when the input's position mask fires (issue #3119), which a nested
 * child also reaches through the inherited-bag lookup (issue #3114).
 *
 * MODULE scope, not instance scope: a region-pinned sibling resolver
 * (`resolverForProducerRegion`) resolves on behalf of the consumer with the
 * consumer's bag, so an instance-local registry left the sibling's twin where
 * the consumer's `Fn::Join` / `Fn::Sub` never looked. The key is still the
 * pass's own bag object, so scope does not widen to unrelated passes: a pass
 * reaches only the entries under its own bag and under the bag it was handed
 * as `inheritedSecrets` (a nested-stack child reading its parent's, issue
 * #3114), and the entries die with the bag.
 */
export const LOG_TWINS_BY_PASS = new WeakMap<RecordedSecretValues, Map<string, string>>();

/**
 * Does `value` carry a CloudFormation dynamic reference anywhere inside it?
 *
 * Used as the identity fast path of {@link
 * IntrinsicFunctionResolver.reresolveCrossStackValue}: a cross-stack value that
 * carries none is returned untouched, so every ordinary import keeps its
 * pre-#1934 behaviour with no walk, no AWS call and no allocation.
 *
 * The walk descends arrays and objects because `state.outputs` is typed
 * `Record<string, unknown>` and deliberately NOT coerced to string — a
 * list-valued `Fn::GetAtt` persists a JSON array — so a secret-bearing output
 * is not always a bare string.
 *
 * EXPORTED for `cdkd scrub` (issue
 * [#2133](https://github.com/go-to-k/cdkd/issues/2133)), which asks the inverse
 * question of the same value: a cross-stack read that comes back carrying NO
 * dynamic reference is one scrub could not turn into a needle, because a needle
 * is only ever recorded by resolving a `{{resolve:...}}` expression.
 */
export function carriesDynamicReference(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('{{resolve:');
  if (Array.isArray(value)) return value.some(carriesDynamicReference);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(carriesDynamicReference);
  }
  return false;
}

/**
 * The dynamic-reference services the resolver RESOLVES on the deploy path. A
 * token of any other service is left as written on BOTH paths (the resolver
 * warns and substitutes nothing), so it is never a sign of a secret.
 */
const DEPLOY_RESOLVED_REFERENCE_SERVICES: ReadonlySet<string> = new Set([
  'secretsmanager',
  'ssm',
  'ssm-secure',
]);

/**
 * True when text RESOLVED by a `skipDynamicReferences` pass
 * still carries a token of a service the deploy resolves (issue
 * [#4056](https://github.com/go-to-k/cdkd/issues/4056)).
 *
 * Only a SECRET keeps its token through that pass: `secretsmanager` and
 * `ssm-secure` by spelling, and a plain `ssm` one whose parameter the lookup
 * finds to be a `SecureString`; a `String` / `StringList` parameter resolves
 * to its value and leaves no token. So on RESOLVED text the token scan, not
 * the `isSecretBearingReferenceString` spelling test, is what says "the deploy
 * substitutes a secret here". The spelling test stays right for its other
 * readers, which read RAW template or STORED text, where a plain `ssm` token
 * says nothing about the parameter's type. Read by `outputs-diff.ts` (an
 * export name) and `resolveBase64` (go-to-k/cdkd#2909), which must agree.
 */
export function keepsSecretReferenceToken(resolvedName: string): boolean {
  // `inner.split(':')[0]`, the resolver's own reading of the service, with the
  // closing braces sliced off so a colon-less `{{resolve:ssm-secure}}` reads
  // `ssm-secure` there and here alike.
  return dynamicReferenceTokens(resolvedName).some((token) =>
    DEPLOY_RESOLVED_REFERENCE_SERVICES.has(
      token.slice('{{resolve:'.length, -'}}'.length).split(':')[0] ?? ''
    )
  );
}

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
 * loop.
 *
 * STRUCTURED, for the reason its sibling below records at length: a consumer
 * forced to recover structure out of a human string couples to a spelling, and
 * both prior attempts at that coupling shipped a defect.
 */
export interface AbandonedResolution {
  /** Which walk abandoned this unit. */
  readonly unit: 'token' | 'key';
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
 * {@link IntrinsicFunctionResolver.pushRedactedAttributeRead} keys its fourth
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
  /** The user-facing rendering, built where the structure is still known. */
  readonly display: string;
}

/**
 * Resolver context for intrinsic functions
 */
export interface ResolverContext {
  /** Template being processed */
  template: CloudFormationTemplate;
  /** Current resource states (for Ref/GetAtt) */
  resources: Record<string, ResourceState>;
  /** Parameter values (for Ref to parameters) */
  parameters?: Record<string, unknown>;
  /** Evaluated condition values (for Fn::If) */
  conditions?: Record<string, boolean>;
  /** State backend for cross-stack references (Fn::ImportValue) */
  stateBackend?: S3StateBackend;
  /** Current stack name (for Fn::ImportValue to avoid self-reference) */
  stackName?: string;
  /**
   * Persistent exports index for fast `Fn::ImportValue` resolution. When
   * supplied, the resolver tries an O(1) index lookup before falling back
   * to the per-stack state.json scan. Optional for backwards compat; the
   * scan-only path is still correct.
   */
  exportIndex?: ExportIndexStore;
  /**
   * Bag for the resolver to push every successful `Fn::ImportValue`
   * resolution into. The deploy engine reads this after resource
   * provisioning and persists it to the consumer's `state.imports`
   * field (schema v4) so destroy-time strong-reference checks can
   * refuse to delete a producer with active consumers.
   *
   * `Fn::GetStackOutput` does NOT push entries here by design — it
   * is a weak reference and uses the sibling `recordedOutputReads`
   * bag instead (schema v8, issue #668).
   */
  recordedImports?: StateImportEntry[];
  /**
   * Bag for the resolver to push every successful `Fn::GetStackOutput`
   * resolution into (schema v8+, issue #668). The deploy engine reads
   * this after resource provisioning and persists it to the consumer's
   * `state.outputReads` field so `findDownstreamConsumers` can name
   * the downstream stacks affected by a producer's recreate.
   *
   * Sibling of `recordedImports` for the weak-reference
   * `Fn::GetStackOutput` intrinsic. Cross-account `RoleArn`-based
   * reads do NOT push entries here in v8 (deferred to a future
   * schema bump alongside a `sourceAccountId` field).
   */
  recordedOutputReads?: StateOutputReadEntry[];
  /**
   * Bag for the resolver to push every resolved SECRET dynamic reference into,
   * keyed by the resolved plaintext VALUE with the original `{{resolve:...}}`
   * expression as the payload (GHSA fix). The deploy engine reads this after
   * resolution to (a) redact the plaintext out of the bag it PERSISTS to state
   * — replacing each secret value with its unresolved expression, CloudFormation
   * semantics — and (b) mask the value out of log / error output. What counts
   * as a secret is decided by TYPE, not by the reference's SPELLING (issue
   * #1901): every `secretsmanager` reference, plus a plain `{{resolve:ssm:...}}`
   * one whose parameter turns out to be a `SecureString` — that form resolves
   * with `WithDecryption`, so for that type it yields a real secret. An `ssm`
   * reference to a `String` / `StringList` parameter IS public config and is
   * deliberately NOT recorded, so state keeps storing it resolved.
   * See `src/deployment/secret-redaction.ts`.
   */
  recordedSecretValues?: RecordedSecretValues;
  /**
   * Secret pairs a PARENT stack already resolved on a nested CHILD's behalf,
   * for the child resolver to RECORD from rather than to substitute with
   * (issues [#1903](https://github.com/go-to-k/cdkd/issues/1903) /
   * [#2087](https://github.com/go-to-k/cdkd/issues/2087)).
   *
   * Set only by a nested-stack child `DeployEngine`, from
   * `DeployEngineOptions.inheritedSecrets`. The parent resolves the child's
   * `Parameters` block, so the value reaching the child is already PLAINTEXT
   * and the child's own template spells the consumption as
   * `{Ref: <ParamName>}` — an intrinsic OBJECT, never a `{{resolve:` string.
   * Nothing in the child's own resolution can therefore record the
   * `plaintext -> expression` pair that the deploy engine's state-save choke
   * point redacts with, and the child's `state.json` persisted the decrypted
   * secret.
   *
   * READ-ONLY and NEVER substituted: `resolveRef` still returns the real
   * parameter value — that is what reaches AWS — and only copies the matching
   * pair into `recordedSecretValues`, i.e. into the map belonging to the
   * resource whose resolution actually consumed the parameter. Recording at
   * RESOLUTION time rather than pre-seeding every context is what keeps the
   * per-resource scoping every reader of `perResourceSecrets` assumes; the
   * earlier pre-seed handed the same bag to every child resource, so an
   * unrelated literal merely CONTAINING the plaintext (`my-production-bucket`
   * against a secret `production`) was spliced into the expression and the
   * stack acquired a perpetual UPDATE (issue #2087).
   *
   * A reader MUST NOT enumerate or log its KEYS — they are secret plaintext.
   */
  inheritedSecrets?: RecordedSecretValues;
  /**
   * A PRINT-ONLY corpus of LOG-ONLY needles (go-to-k/cdkd#4043): read by the
   * render mask of this resolver's own lines ({@link maskSecretsRaw}) and by
   * nothing that detects, records into {@link recordedSecretValues} or
   * decides. `cdkd diff`'s Outputs pass resolves into bags of its own, whose
   * log-only needles decide which export aliases are refused, so the
   * `NoEcho` values it holds up front reach its lines through here instead.
   * An `Fn::Base64` whose input this corpus masks records its encoding into
   * THIS bag, as a log-only needle, so the encoding prints masked too.
   */
  printingSecrets?: RecordedSecretValues;
  /**
   * Logical ids whose provider declared THIS RUN's `attributes` sensitive —
   * a Lambda-backed custom resource whose handler answered `NoEcho: true`
   * (issue [#2274](https://github.com/go-to-k/cdkd/issues/2274)).
   *
   * Set by the deploy engine from the create / update results it has already
   * collected this run, so by the time a DEPENDENT resolves, the producer's
   * entry is present (each resource is provisioned before anything that depends
   * on it, which is what the DAG guarantees).
   *
   * READ-ONLY and never substituted, exactly like {@link inheritedSecrets}:
   * `resolveGetAtt` still returns the REAL attribute value — that is what
   * reaches AWS, and CloudFormation delivers it to a dependent in the clear —
   * and only records the resolved string leaves as MASK-ONLY needles in
   * {@link recordedSecretValues}, i.e. in the bag belonging to the resource
   * whose resolution actually consumed the attribute. Recording at RESOLUTION
   * time rather than pre-seeding every context is what keeps the per-resource
   * scoping every reader of `perResourceSecrets` assumes — the same rule issue
   * #2087 forced on the inherited-secrets channel.
   *
   * `true` declares the WHOLE attributes bag sensitive (a custom resource's
   * `NoEcho` response); a SET names the sensitive members only (a nested
   * stack's `Outputs.<Key>` entries, where the rest of the child's outputs are
   * ordinary and masking them would degrade unrelated parent resources).
   */
  noEchoAttributeResources?: ReadonlyMap<string, true | ReadonlySet<string>>;
  /**
   * Bag the resolver pushes `<logicalId>.<attributeName>` into whenever it
   * serves a PERSISTED attribute that is nothing but {@link SECRET_MASK}
   * (issue #2274).
   *
   * This is the cross-DEPLOY half of the `NoEcho` story, and it exists because
   * the redaction is not free. Once a `NoEcho` custom resource's `Data` has
   * been masked into `state.json`, a LATER deploy that does NOT re-invoke the
   * handler (the resource is `NO_CHANGE`, so CloudFormation semantics say the
   * handler does not run) reads `***` back out of state — and a dependent
   * resolving `Fn::GetAtt` against it would otherwise PUSH that literal to AWS.
   * `state.ts` carries no durable per-attribute `NoEcho` flag to recover from
   * (issue [#2449](https://github.com/go-to-k/cdkd/issues/2449)), so the mask
   * itself is the signal.
   *
   * The resolver RECORDS; it never throws for this, and the difference decides
   * whether a stack stays deployable. A throw inside the diff would be caught
   * by `resolveBestEffort`, which keeps the raw intrinsic — so the desired side
   * would stop matching the `***` in state, the resource would look CHANGED on
   * every run, and the provisioning pass would then fail it. Recording instead
   * leaves the diff comparing `***` against `***`, i.e. a clean NO_CHANGE, so a
   * stack nobody has edited keeps deploying and only a dependent that ACTUALLY
   * has to be written is refused.
   *
   * **PRESENCE OF THE BAG IS THE OPT-IN, so it belongs ONLY on a context whose
   * reads something will READ** (issue #2847 round-4 review). An earlier
   * revision of this note said the deploy engine puts it on EVERY context, the
   * diff one included, on the argument that an unread array costs nothing. That
   * stopped being true the moment `resolveRefValue` began consulting the bag to
   * decide whether {@link refStateLookupFromResource} may SKIP a masked leaf:
   * on the diff context the skip fired with no reader behind it, so `{Ref: X}`
   * resolved to the raw physical id and was compared against the `'***'` in
   * state — a pre-existing #2274 stack that reported NO_CHANGE and deployed
   * clean now reported a spurious UPDATE and then hard-failed at the
   * provisioning refusal. Fail-closed, so never an exposure, but a regression
   * for existing users and a divergence from standalone `cdkd diff` (bagless,
   * still NO_CHANGE). `DeployEngine.buildResolverContext` therefore takes the
   * bag from its CALLER, and only the two provisioning sites pass one.
   */
  redactedAttributeReads?: RedactedAttributeRead[];

  /**
   * Units this pass could not resolve, recorded instead of abandoning every
   * later unit beside them (issues #3181 / #3218).
   *
   * OPT-IN, exactly like the bag above and for the same reason: the recovery
   * changes what a partially-resolved value looks like, so a caller asks for it
   * on the line where it builds its context rather than inheriting it
   * ambiently. Passing no bag keeps the pre-#3181 behaviour, where the first
   * failing token aborts every later token in the leaf and the first failing
   * key aborts every later key in the bag.
   *
   * **What a CONSUMER owes, and it is not optional: a non-empty bag MUST fail
   * the operation.** Recovery leaves each abandoned unit's input in place, so
   * `resolveValue`'s return can still carry a literal `{{resolve:...}}` token
   * or an unresolved `{"Ref": ...}` — and for a caller that SENDS its resolved
   * value to AWS that is the issue-#2482 shape, where the credential WAS the
   * template text and the deploy exited 0. The two consumers today are
   * `cdkd scrub`, which discards the resolved value and only wants the needles
   * recorded along the way, and this resolver's own tests.
   *
   * What a PUSHER owes: `subject` and `message` must already be LOG text —
   * an assembled reference can put a plaintext in the raw token, and an SDK
   * rejection echoes the name it was given.
   */
  abandonedResolutions?: AbandonedResolution[];
  /**
   * Internal hook used while evaluating the template `Conditions` section.
   * A CFn Condition can reference ANOTHER named condition via
   * `{Condition: OtherName}` inside `Fn::And` / `Fn::Or` / `Fn::Not`
   * (issue #840). When set, the `{Condition: X}` case in `resolveValue`
   * delegates to this resolver, which lazily evaluates condition `X`
   * (recursing into its own `{Condition: ...}` references) and memoizes
   * the result so declaration order in the `Conditions` block does not
   * matter and cycles are rejected. Not set when resolving normal
   * resource properties — a `{Condition: X}` reference outside the
   * `Conditions` section is invalid CFn and falls through to the
   * already-evaluated `conditions` map (or the not-found path).
   */
  conditionResolver?: (conditionName: string) => Promise<boolean>;
  /**
   * Set by BEST-EFFORT callers (the diff calculator's
   * `resolveBestEffort`, which catches resolution failures and keeps the
   * raw intrinsic) where a `Ref` to a resource that is not in state yet is
   * the EXPECTED case — the classic CDK logical-id-churn dance (an
   * `AWS::ApiGateway::Deployment` hash rotation, a `fn.currentVersion`
   * Lambda Version) makes the new template reference a resource this same
   * deploy will CREATE. When true, the resolver's "Ref not found" log is
   * demoted from warn to debug so a routine diff is not noisy (issue
   * #1017); the throw itself is unchanged. Deploy-time resolution leaves
   * this unset, keeping the warn as a genuine error signal.
   */
  bestEffort?: boolean;
  /**
   * When true, SECRET `{{resolve:...}}` dynamic references are left UNRESOLVED
   * (the expression string is returned verbatim). Set by the diff / no-op
   * comparison paths (GHSA fix): cdkd now persists the unresolved expression to
   * state (CloudFormation semantics — the substitution keeps the secret value
   * out of the persisted bag wherever the redaction can certify the position).
   * That is a redaction pass, not a guarantee about `state.json`: positions it
   * cannot certify keep what they were handed, ON THE DEPLOY PATH TOO — an
   * unchanged resource's `drainObservedCaptures` baseline reaches the persist
   * choke point with an empty secrets map (go-to-k/cdkd#2012,
   * go-to-k/cdkd#2852) — and other commands widen it further
   * (go-to-k/cdkd#2846, go-to-k/cdkd#2847). So a
   * comparison must keep the desired side as its
   * expression too, otherwise a resolved-plaintext-vs-stored-expression compare
   * reports a spurious change on every run and `cdkd diff` would also fetch and
   * print the value. A changed EXPRESSION still shows as a diff; a rotated
   * secret behind an unchanged expression is a no-op, exactly as under
   * CloudFormation.
   *
   * NO secret VALUE is fetched under this flag, but it is not the same as "no
   * AWS call" (issue #1901). A `secretsmanager` reference is secret by its
   * spelling, so it is skipped outright with no call. A plain `ssm` one is
   * secret only when its parameter is a `SecureString`, which is knowable only
   * from `GetParameter` — so a not-yet-classified `ssm` reference DOES cost one
   * call here, made with `WithDecryption: false` so a `SecureString` comes back
   * as ciphertext (never substituted, cached or persisted) and a `String` /
   * `StringList` resolves exactly as it must. The verdict is memoized per
   * expression, so each reference pays that call at most once per process.
   */
  skipDynamicReferences?: boolean;

  /**
   * The FOREIGN-region evidence for the secret-region classification issue
   * [#2134](https://github.com/go-to-k/cdkd/issues/2134) performs inside
   * {@link IntrinsicFunctionResolver.resolveDynamicReferences} -- the producer
   * regions this stack is on record as reading from, i.e.
   * `producerRegionsFromState(state)` over `state.imports[].sourceRegion` plus
   * `state.outputReads[].sourceRegion`.
   *
   * **Opt-in, and its ABSENCE is meaningful rather than a default.** Supplying
   * it arms the `ambiguous` REFUSAL: a name-form secret reference in a stack
   * that reads across a region boundary cannot be attributed to a region, so
   * the resolver declines rather than fetching a possibly-different secret.
   * Omitting it leaves every name-form reference `local`, which is the
   * pre-#2134 behaviour exactly.
   *
   * **`cdkd deploy` deliberately does NOT supply it, and that is a decision
   * rather than an omission.** The classifier's refusal is per-STACK, not
   * per-reference -- the evidence cannot say WHICH reference crossed the
   * boundary -- so arming it on deploy would refuse the ordinary CDK
   * `secretValueFromJson` shape (a plain name-form reference) in any stack
   * that also happens to hold one cross-region import, and templates that
   * deploy today would stop deploying.
   *
   * **`cdkd scrub` is the ONLY supplier**, and the precision matters because an
   * earlier draft of this paragraph named `cdkd drift` and the rollback replay
   * as well. They do NOT supply it: each classifies per token in its own
   * `*Resolvers` wrapper BEFORE calling the resolver, so a reference they route
   * arrives already attributed and never reaches the arm below. Scrub supplies
   * it because a wrong-region answer there is a silent MISS -- the stack
   * reported clean over surviving plaintext -- and failing closed is the point.
   *
   * A supplier must also make the refusal SURVIVE its own error handling.
   * Scrub wraps each resolution pass in a best-effort `catch`, so it re-raises
   * {@link DynamicReferenceRegionAmbiguousError} explicitly; swallowed, the
   * refusal produces exactly the silent success it exists to prevent (issue
   * #2134 review). Any future supplier owes the same.
   *
   * The other half of #2134 needs no evidence at all and is therefore always
   * armed, deploy included: a reference naming a full ARN says its own region,
   * so it is routed to a resolver pinned there rather than fetched against
   * this stack's endpoint.
   */
  producerRegions?: readonly string[];

  /**
   * Re-reads a state record's attributes from AWS when `Fn::GetAtt` is about to
   * take the physical-id fallback for it (issue
   * [#1852](https://github.com/go-to-k/cdkd/issues/1852)) — a record written
   * before its provider recorded the attribute is never re-recorded by a
   * no-change deploy, so without this the fallback's refusal is permanent.
   *
   * OPT-IN by presence, like the bags above. Only a caller that can ROUTE a
   * record to its provider supplies it: `DeployEngine` does, on every context
   * it builds, and persists what the read returns; `cdkd diff` supplies a
   * `readOnly` one (`read-only-attribute-healer.ts`) that persists nothing. A
   * context without one keeps the pre-#1852 behaviour exactly — no AWS call is
   * ever issued on its behalf. The supplier owns single-flight, memoization and
   * any persistence; the resolver only asks, and only on a MISS.
   */
  attributeHealer?: StaleAttributeHealer;

  /**
   * INTERNAL to `resolveGetAtt`'s heal wrapper, which sets it on a DERIVED
   * context for one resolution. Never set by a caller.
   */
  staleAttributeHeal?: StaleAttributeHealPhase;
}

/**
 * AWS Account information cache
 */
export interface AwsAccountInfo {
  accountId: string;
  region: string;
  partition: string;
}

/**
 * The genuinely region-independent half of {@link AwsAccountInfo} — the ONLY
 * part that may be cached across callers (issue #1746).
 *
 * `region` is the CALLER's, and `partition` is a function of it, so caching a
 * whole `AwsAccountInfo` pinned the FIRST caller's region on every later
 * no-override call. That was benign-ish while `partition` was hardcoded to
 * `'aws'`; issue #1730 made the partition DERIVE from the region, so the stale
 * region started dragging a stale partition with it — a first call from a
 * `cn-north-1`-scoped resolver cached `{region: 'cn-north-1', partition:
 * 'aws-cn'}` and a later no-override call from a us-east-1 context read
 * `aws-cn`. Caching the ACCOUNT alone and deriving region + partition per call
 * removes the failure mode rather than papering over it.
 */
export interface CachedAccountIdentity {
  accountId: string;
}

/**
 * The real account identity, per CREDENTIAL IDENTITY: keyed by
 * {@link credentialFingerprint} of the active `AwsClients`' credential
 * configuration (issue [#3660](https://github.com/go-to-k/cdkd/issues/3660)).
 *
 * Process-wide, and a CLI run has one identity, so for the CLI this holds one
 * entry. A LIBRARY caller can install `AwsClients` for account A, deploy, then
 * install account B's in the same process (or run both in per-stack scopes);
 * keyed by nothing, B's `AWS::AccountId` and every ARN built from it resolved
 * as A's. The in-flight slot in `account-drain.ts` shares the key.
 */
export const cachedAccountIdentities = new Map<string, CachedAccountIdentity>();

/**
 * Availability-zone names per (credential identity, region): keyed by
 * `injectiveKey(credentialFingerprint, region)` (issue
 * [#3660](https://github.com/go-to-k/cdkd/issues/3660)). The zone list is an
 * ACCOUNT's answer — an opt-in or restricted zone is visible to one account and
 * not another — so a region-only key served one identity's list to the next.
 */
export const cachedAvailabilityZones = new Map<string, string[]>();

/**
 * One resolved dynamic reference, as remembered by
 * {@link IntrinsicFunctionResolver.cachedDynamicReferences}.
 *
 * `secret` is the verdict the resolution that PRODUCED this value reached —
 * `true` for every `secretsmanager` spelling and for an `ssm` parameter whose
 * `GetParameter` response classified it as a `SecureString`. It is carried HERE
 * rather than re-derived from the process-global verdict store on every hit
 * because the two now have different lifetimes (issue #1933): another stack's
 * resolver — plausibly in another region, where the same parameter NAME is a
 * plain `String` — RETRACTS the store's memo when its own lookup comes back
 * public, and this instance's later resources would then stop redacting a value
 * that is genuinely secret for THEM. The entry answers for the region and the
 * stack that resolved it, which is the whole point of the instance scope.
 */
export interface CachedDynamicReference {
  value: string;
  secret: boolean;
}

/** What {@link IntrinsicFunctionResolver.namedRequestMasks} returns (go-to-k/cdkd#3171). */
export interface NamedRequestMasks {
  /** A masked clone of `error` and its whole cause chain; classification survives. */
  error: (error: unknown) => unknown;
  /** A caught SDK message, masked for interpolation into a line or a throw. */
  text: (message: string) => string;
  /** The `withRetry` logger for the same request. */
  retryLogger: RetryLogger;
}

/**
 * The `{{resolve:...}}` expressions this process has PROVEN resolve to a
 * SECRET, reached through `secret-redaction.ts`'s `recordedSecretExpressions`
 * store. Process-global, and cleared by `resetAccountInfoCache` so a test (or a
 * later phase) cannot inherit a verdict it just asked to forget.
 *
 * NOTE this store is deliberately WIDER-lived than the resolved VALUES it was
 * once paired with: those moved onto the resolver instance (issue #1933), while
 * a verdict is a statement about a reference's TYPE, which the redaction path
 * must be able to read with no resolver in hand. The asymmetry is safe in the
 * one direction that matters — a verdict inherited across regions can only make
 * a reference be treated AS a secret (persisted as its expression, never as
 * plaintext), and the reverse case re-asks AWS because the fresh response is
 * authoritative and the value cache no longer answers for another region.
 *
 * `ssm` is the kind that NEEDS the memory (issue #1901). A plain `ssm`
 * reference is not a secret by SPELLING the way `secretsmanager` is — whether
 * it resolves to public config or to a decrypted secret depends on the
 * parameter's `Type`, which is only knowable from the `GetParameter` response.
 * So secret-ness is discovered on the first resolution and remembered, keyed by
 * the full `{{resolve:...}}` expression. Two consumers need it AFTER the lookup
 * that populated it: the cache-hit arm (which must re-record the value as a
 * secret for the current resolution pass) and the diff / no-op path (which must
 * leave a SecureString reference unresolved without paying a lookup at all once
 * the type is known). A reference NOT in the set is only "not known to be
 * secure" — never "proven public" — so every arm that would leak still asks AWS
 * for the type first. Only the TYPE is remembered, never the decrypted value:
 * on the diff path the lookup is made with `WithDecryption: false`, so the
 * plaintext is never fetched at all there.
 *
 * A `secretsmanager` reference is recorded TOO, and that is issue
 * [#1916](https://github.com/go-to-k/cdkd/issues/1916). It needed no memory
 * while the only question asked of the set was "is this expression secret?",
 * which its spelling settles — but the set is ALSO the candidate list the
 * redaction path matches an INTRINSIC source leaf against
 * ({@link secret-redaction.redactSecretsForState}), and a list holding only the
 * ssm half cannot name the losing member of a collapsed
 * secretsmanager/secretsmanager pair. Recording every kind is what makes the
 * set mean what its name says. It changes no verdict here: every arm that reads
 * it for secret-ness already answers `true` on a `secretsmanager` spelling
 * before consulting it.
 *
 * The store lives in `secret-redaction.ts` rather than here (issue
 * [#1910](https://github.com/go-to-k/cdkd/issues/1910)) because the redaction
 * path is the other consumer: one set in the LEAF module means the redactor can
 * answer with no caller threading it, and the resolver reaches it along an
 * import edge it already has — the reverse would close a cycle.
 *
 * The resolver no longer reads or writes it through this facade (issue
 * [#4105](https://github.com/go-to-k/cdkd/issues/4105)): `pinSecretVerdict`
 * files each verdict under the resolver's SCOPE (region + credential
 * identity) and `isKnownSecret` reads only that scope, since another region's
 * `SecureString` under the same parameter name says nothing about this one.
 * `has` here still answers the bare, last-writer set the redaction path reads.
 */
export const recordedSecretExpressions = {
  has: (expression: string): boolean => isRecordedSecretExpression(expression),
  add: (expression: string): void => recordSecretExpression(expression),
  delete: (expression: string): void => forgetSecretExpression(expression),
  clear: (): void => clearRecordedSecretExpressions(),
};

/**
 * Cache for EC2 instance attributes that require a live DescribeInstances
 * lookup (PrivateIp / PublicIp / PrivateDnsName / PublicDnsName /
 * AvailabilityZone). Keyed by `${physicalId}#${attributeName}`. The IP /
 * DNS attributes are not derivable from the instance id, so they are read
 * back from AWS once per (instance, attribute) and memoized for the PROCESS
 * lifetime — one `cdkd deploy` per CLI process, so "the deploy" in practice;
 * nothing in `src/` calls `resetAccountInfoCache`, tests do. Only a VALUE is cached — a settled instance's address, or the
 * known-empty `''` a settled instance reports for a public member it has
 * none of — never a refusal: a `pending` instance is re-described on the
 * next resolution, when it may have settled (issue #3096).
 */
export const cachedEc2InstanceAttributes: Record<string, string> = Object.create(null) as Record<
  string,
  string
>;

/**
 * The three sibling caches of {@link cachedEc2InstanceAttributes} (issues
 * #3096 / #3097), each holding a value the resolver read LIVE because the
 * state record omitted it — `definedAttributes` drops a member the provider
 * could not read back (issue #3077), so the `Fn::GetAtt` falls out of the
 * flat lookup and into `constructAttribute`'s per-type arm. Keyed by physical
 * id: the read is region-pinned (`clientsForRegion(this.explicitRegion)`),
 * so the key names one resource in that region, and the value — a default
 * security group id, a distribution hostname, a security group's VPC —
 * never changes; like the instance cache, a refusal caches nothing. Same
 * process lifetime, cleared together with it by {@link resetAccountInfoCache}.
 * The RDS `DBProxy` / `DBProxyEndpoint` `VpcId` arms have no cache because
 * they have no live read: `AwsClients` exposes no RDS client and this file
 * imports none, so those two arms refuse outright (see
 * `refuseUnservedAttribute`'s callers).
 *
 * All four are NULL-PROTOTYPE objects (#3096 delta review, measured): the
 * key is a state-record physical id, and on a plain `{}` a record holding
 * `constructor` / `__proto__` / `hasOwnProperty` read a FUNCTION out of
 * `Object.prototype` as the cached value — served with zero AWS calls, ahead
 * of every shape guard below. `Object.create(null)` has nothing to read; the
 * `delete`-based clears in `resetAccountInfoCache` keep the prototype.
 */
export const cachedVpcDefaultSecurityGroups: Record<string, string> = Object.create(null) as Record<
  string,
  string
>;
export const cachedCloudFrontDomainNames: Record<string, string> = Object.create(null) as Record<
  string,
  string
>;
export const cachedSecurityGroupVpcIds: Record<string, string> = Object.create(null) as Record<
  string,
  string
>;
