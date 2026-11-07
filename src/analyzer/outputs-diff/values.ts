import type { CloudFormationTemplate } from '../../types/resource.js';
import { INTRINSIC_KEYS } from '../diff-calculator.js';
import {
  DYNAMIC_REFERENCE_TOKEN_SCAN,
  dynamicReferenceTokens,
  WHOLE_DYNAMIC_REFERENCE_PATTERN,
  type RecordedSecretValues,
} from '../../deployment/secret-redaction.js';
import { isSecretBearingReferenceString as isSecretDynamicReference } from '../../deployment/no-change-outputs-merge.js';
import { keepsSecretReferenceToken } from '../../deployment/intrinsic-resolver/context.js';

/**
 * The stretch of a stored alias KEY that an older binary filled in for the
 * `{{resolve:...}}` tokens of `exportName`, or `undefined` when the key does
 * not have the name's shape (issue
 * [#4015](https://github.com/go-to-k/cdkd/issues/4015)).
 *
 * This is the diff's only route to the plaintext itself: it resolves with
 * `skipDynamicReferences` and must not fetch a secret, while a binary from
 * before issue #1919 published `app-<plaintext>` as a state KEY for the
 * `Export.Name` today's resolver spells `app-{{resolve:secretsmanager:...}}`.
 * The literal text before the first token and after the last one must match
 * the key's ends; what lies between is the substituted span.
 *
 * ONE span from the first token to the last, not one per token: with two
 * tokens the split between them is ambiguous, and the span masks every
 * candidate at the cost of also masking the literal between them. A key with
 * nothing between the ends is no match, since a substituted secret is never
 * empty.
 */
export function secretSpanInStoredKey(key: string, exportName: string): string | undefined {
  // The shared token scan, never a local pattern: `secret-redaction.ts` owns
  // the grammar. `indexOf` / `lastIndexOf` place the first and last match,
  // since an earlier or later copy of either text would itself be a match.
  const tokens = dynamicReferenceTokens(exportName);
  const first = tokens[0];
  const last = tokens[tokens.length - 1];
  if (first === undefined || last === undefined) return undefined;
  const prefix = exportName.slice(0, exportName.indexOf(first));
  const suffix = exportName.slice(exportName.lastIndexOf(last) + last.length);
  if (key.length <= prefix.length + suffix.length) return undefined;
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return undefined;
  return key.slice(prefix.length, key.length - suffix.length);
}

/**
 * The expression half of a corpus entry built from a stored value. Never
 * printed: `secretSafeKeyDisplay` masks with the plaintext side only.
 */
const SUSPECTED_PLAINTEXT_EXPRESSION = '<stored output value withheld as possible plaintext>';

/** Every string leaf of a stored value, as corpus entries (issue #4015). */
export function addStringLeaves(value: unknown, into: RecordedSecretValues): void {
  if (typeof value === 'string') {
    if (value.length > 0) into.set(value, SUSPECTED_PLAINTEXT_EXPRESSION);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const member of Object.values(value as Record<string, unknown>)) {
    addStringLeaves(member, into);
  }
}

/**
 * A `${...}` placeholder `Fn::Sub` did NOT substitute.
 *
 * `resolveSub` catches a genuine `Ref` / `Fn::GetAtt` miss, WARNS, and keeps the
 * literal `${Foo}` in the output string — it neither throws nor leaves an
 * intrinsic object behind. So a half-substituted `Fn::Sub` reaches this module
 * looking like an ordinary resolved string, and comparing it against state
 * reports a phantom change whose printed value is `"arn:...${NewBucket}"`.
 *
 * Only consulted for a value whose TEMPLATE source actually contained an
 * `Fn::Sub` (see {@link templateUsesSub}). Applying it to every string
 * over-matches badly: an IAM policy body with `${aws:username}`, a UserData
 * snippet with a shell `${VAR}`, or any literal a user wrote would set
 * `resolutionFailed` and suppress the WHOLE Outputs section for that stack, on
 * every run, forever.
 *
 * Within `Fn::Sub`-sourced values one false positive remains and is accepted:
 * `${!Literal}` is `Fn::Sub`'s ESCAPE and resolves to the literal text
 * `${Literal}`, which post-resolution is indistinguishable from a placeholder
 * that failed to substitute. That case merely SUPPRESSES the section (the
 * pre-#1921 behavior) whereas the alternative is a phantom reported every run.
 */
const UNSUBSTITUTED_SUB_PLACEHOLDER = /\$\{[^}]*\}/;

/**
 * True when `value` is, or anywhere CONTAINS, something the diff could not
 * fully resolve against current state.
 *
 * The deploy engine's twin check is `Object.values(bag).some(v => v ===
 * undefined)` — its resolver THROWS on failure and the catch stores `undefined`.
 * The diff's resolver is best-effort and fails in three further ways that all
 * have to count as "unresolved" here, because anything that slips through is
 * compared against state and reported as a change the apply will never make:
 *
 * 1. `undefined` — the SAME signal the deploy side keys on. `resolve` returns it
 *    WITHOUT throwing for a constructible-but-unknown attribute
 *    (`AWS::DynamoDB::Table.StreamArn`, `AWS::IAM::Policy.PolicyId`, ...;
 *    `AWS::EC2::SecurityGroup.VpcId` left this list in #3097 — it now reads
 *    the group live and REFUSES, which the catch below records). `JSON.stringify` drops an
 *    `undefined`-valued key, so state can never hold one and such an output
 *    would otherwise report a PERMANENT phantom `ADD` printing `new: undefined`.
 * 2. A symbol — `Ref: AWS::NoValue` resolves to a sentinel symbol, which
 *    `resolveValue` strips only INSIDE arrays / objects; a top-level
 *    `Fn::If` selecting `AWS::NoValue` returns it bare. Not persistable, so
 *    again a permanent phantom.
 * 3. A surviving intrinsic OBJECT, or — only when the template source used
 *    `Fn::Sub` — an unsubstituted placeholder STRING (see
 *    {@link UNSUBSTITUTED_SUB_PLACEHOLDER}).
 *
 * DEEP rather than shallow: an unresolved leaf can sit anywhere inside an array
 * or object an outer intrinsic already built.
 */
// Exported for `cdkd scrub` (issue #1919): it resolves an intrinsic
// `Export.Name` for a collision test and must apply the SAME "did this actually
// resolve?" rule, or it trusts a name it provably could not reproduce.
export function isUnresolvedValue(value: unknown, sourceUsedSub: boolean): boolean {
  if (value === undefined) return true;
  if (typeof value === 'symbol') return true;
  if (typeof value === 'string') {
    return sourceUsedSub && UNSUBSTITUTED_SUB_PLACEHOLDER.test(value);
  }
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => isUnresolvedValue(v, sourceUsedSub));
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 1 && INTRINSIC_KEYS.has(keys[0]!)) return true;
  return Object.values(value as Record<string, unknown>).some((v) =>
    isUnresolvedValue(v, sourceUsedSub)
  );
}

/**
 * True when this output's RAW template value contains an `Fn::Sub` anywhere —
 * including nested inside an `Fn::Join` / `Fn::If`, since those resolve their
 * arguments and a laundered placeholder from an inner `Fn::Sub` surfaces in the
 * outer result.
 */
export function templateUsesSub(templateValue: unknown): boolean {
  if (templateValue === null || typeof templateValue !== 'object') return false;
  if (Array.isArray(templateValue)) return templateValue.some(templateUsesSub);
  const record = templateValue as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, 'Fn::Sub')) return true;
  return Object.values(record).some(templateUsesSub);
}

/*
 * `isSecretDynamicReference` (imported above) is true for a string carrying a
 * SECRET-BEARING dynamic reference — `{{resolve:secretsmanager:` or
 * `{{resolve:ssm-secure:`. Its definition, and why a plain `{{resolve:ssm:` is
 * excluded, live with the deploy side's no-change merge, so the merge's refusal
 * and this module's exoneration read ONE predicate (issue #2771).
 *
 * The diff resolves with `skipDynamicReferences`, so a secret-bearing output
 * arrives here as its unresolved `{{resolve:...}}` expression — which is also
 * what post-GHSA state stores. A state record written by an OLDER binary can
 * still hold the resolved PLAINTEXT instead (that mismatch is exactly what
 * `cdkd scrub` exists to repair), and printing it is this module's problem
 * because it is the first code path that DISPLAYS a stored output value.
 */

/**
 * True when `value` carries a plain `{{resolve:ssm:<name>...}}` token (issue
 * #4108). A colon-less `{{resolve:ssm}}` names no parameter, so no deploy
 * writes it and it proves nothing.
 */
export function holdsPlainSsmToken(value: string): boolean {
  return dynamicReferenceTokens(value).some((token) => {
    const parts = token.slice('{{resolve:'.length, -'}}'.length).split(':');
    return parts[0] === 'ssm' && parts.length >= 2;
  });
}

/**
 * True when a STORED value is exactly one secret-bearing token and nothing
 * else, so it holds no plaintext whatever produced it (issue #4056). Exported
 * for the no-change merge preview in `diff-recursive.ts`, which asks the same
 * question of a carried value with no resolved side to compare it against.
 */
export function isWholeSecretReferenceToken(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    WHOLE_DYNAMIC_REFERENCE_PATTERN.test(value) &&
    keepsSecretReferenceToken(value)
  );
}

/**
 * The literal text around each `{{resolve:...}}` token. `split` builds its own
 * splitter from the shared global pattern and leaves the constant's
 * `lastIndex` untouched, which is what its doc forbids `.exec` / `.test` for.
 */
function literalPartsAroundTokens(text: string): string[] {
  return text.split(DYNAMIC_REFERENCE_TOKEN_SCAN);
}

/**
 * May a STORED string carrying a secret's token be read as the key's redacted
 * expression (issues #4056, #4101)? A substring hit is not enough: a value
 * holding one token beside a plaintext is exactly what a binary before #1901
 * wrote for `Fn::Join ['-', ['{{resolve:secretsmanager:A}}',
 * '{{resolve:ssm:/SecureB}}']]` (it redacted A and stored B's plaintext), and
 * what `cdkd scrub` leaves when it can name one secret in a value and not the
 * other. So the stored string must carry exactly the LITERAL parts the
 * resolved desired side carries, so every stretch that differs sits where a
 * token is; or be one whole token where the desired side is one too, or has
 * no string to compare (a removed output). A whole token against a desired
 * side with literal text fails closed, since a plaintext spelled like a token
 * would pass as one.
 *
 * Residuals, both fail-closed or contrived: editing the literal around a
 * token marks the record pre-GHSA until the next deploy; and a secret whose
 * plaintext is itself a complete `{{resolve:...}}` token, stored in a token
 * position with matching literals, still passes.
 */
export function storedSecretTokenIsExpression(stored: string, desired: unknown): boolean {
  if (!keepsSecretReferenceToken(stored)) return false;
  if (isWholeSecretReferenceToken(stored)) {
    return typeof desired !== 'string' || isWholeSecretReferenceToken(desired);
  }
  if (typeof desired !== 'string') return false;
  const storedParts = literalPartsAroundTokens(stored);
  const desiredParts = literalPartsAroundTokens(desired);
  return (
    storedParts.length === desiredParts.length &&
    storedParts.every((part, index) => part === desiredParts[index])
  );
}

/**
 * A secret's expression in RESOLVED text (or in what a post-#1901 deploy
 * stores for it): the spelling test, or a surviving token of a service the
 * deploy resolves. See {@link keepsSecretReferenceToken} for why the token
 * reading is sound only there, never on RAW template text.
 */
function isSecretReferenceText(value: string): boolean {
  return isSecretDynamicReference(value) || keepsSecretReferenceToken(value);
}

/** {@link isSecretReferenceText} over every string leaf of a resolved value. */
export function containsSecretReferenceText(value: unknown): boolean {
  if (typeof value === 'string') return isSecretReferenceText(value);
  if (Array.isArray(value)) return value.some(containsSecretReferenceText);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsSecretReferenceText);
  }
  return false;
}

/**
 * The same question asked of a whole template VALUE, walking every string leaf.
 *
 * The leaf predicate answers `false` for a non-string, and an output's `Value`
 * is very often an OBJECT: `secret.secretValueFromJson(...)` renders the
 * secret's ARN as a `Ref`, so the value is an `Fn::Join` / `Fn::Sub` — which
 * issue #1916 calls the DOMINANT CDK shape, not an edge case.
 * Feeding the raw value to the leaf predicate therefore reported "no secret
 * here" for exactly the templates most likely to have one, which silently
 * disarmed BOTH signals built on it: the export-alias decision below (issue
 * #1919) and the legacy-record withholding that keeps a pre-GHSA plaintext out
 * of the rendered diff (issue #1921).
 */
export function containsSecretDynamicReference(value: unknown): boolean {
  if (typeof value === 'string') return isSecretDynamicReference(value);
  if (Array.isArray(value)) return value.some(containsSecretDynamicReference);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(containsSecretDynamicReference);
  }
  return false;
}

/**
 * Does this template carry a secret-bearing dynamic reference ANYWHERE?
 *
 * Exported for the DELETED nested-child path (issue #1948 review): that node
 * diffs its state against an EMPTY template, so it can compute nothing about
 * secrets from its own input and would render a pre-GHSA child's whole stored
 * bag in full. The caller passes the PARENT's answer instead — see
 * `diff-recursive.ts`'s `buildDeletedSubtree`.
 */
export function templateHasSecretDynamicReference(template: CloudFormationTemplate): boolean {
  return containsSecretDynamicReference(template);
}

/**
 * Can a condition verdict reach an output's VALUE in this template?
 *
 * The no-change merge preview (issue #3101) must not carry a failed output a
 * condition verdict could change, because `cdkd diff` evaluates `Conditions`
 * best-effort and its verdict can differ from the deploy's. An output never
 * reads a resource's template properties (a `Ref` or `Fn::GetAtt` reads the
 * stored record), so a verdict reaches its value only through the output's own
 * `Condition`, or an `Fn::If` / `{ Condition: ... }` outside `Resources`: in an
 * output, or in a mapping `Fn::FindInMap` returns. `Conditions` is skipped as
 * well, since a reference there composes a verdict and reaches an output only
 * through one of those. A verdict that prunes or keeps a resource differently
 * changes the resource set instead; where that leaves the diff seeing no change
 * the deploy sees, the warning naming every carried output already says the
 * next deploy may write a different value for it.
 *
 * Not "the template declares `Conditions`": CDK attaches `CDKMetadataAvailable`
 * to its `AWS::CDK::Metadata` resource in every env-agnostic stack, and that
 * test refused the preview for the default app shape.
 */
export function templateLetsConditionsReachOutputs(template: CloudFormationTemplate): boolean {
  for (const output of Object.values(template.Outputs ?? {})) {
    if (output.Condition !== undefined) return true;
  }
  return Object.entries(template).some(
    ([section, value]) =>
      section !== 'Resources' && section !== 'Conditions' && readsConditionVerdict(value)
  );
}

/** An `Fn::If`, or a `{ Condition: ... }` reference, anywhere under `value`. */
function readsConditionVerdict(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(readsConditionVerdict);
  const record = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, 'Fn::If')) return true;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === 'Condition') return true;
  return Object.values(record).some(readsConditionVerdict);
}

/** Structural equality, mirroring the deploy engine's `outputMapsEqual` leaf rule. */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => valuesEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!valuesEqual(ao[k], bo[k])) return false;
  }
  return true;
}
