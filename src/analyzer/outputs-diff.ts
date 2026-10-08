import type { CloudFormationTemplate, TemplateOutput } from '../types/resource.js';
import { getLogger } from '../utils/logger.js';
import { INTRINSIC_KEYS, type IntrinsicResolveFn } from './diff-calculator.js';
import {
  collectPublishedOutputNames,
  displayTextOrWithheld,
  exportNameNoEchoParameters,
  exportNameSecretExposure,
  isExportAliasCollision,
  secretSafeKeyDisplay,
  type SecretSafeKeyDisplay,
} from '../deployment/outputs-export-alias.js';
import {
  DYNAMIC_REFERENCE_TOKEN_SCAN,
  dynamicReferenceTokens,
  WHOLE_DYNAMIC_REFERENCE_PATTERN,
  hasMaskableValues,
  printingCorpusOf,
  readsNoEchoSource,
  shareLogOnlyValues,
  type NoEchoPositionSources,
  type RecordedSecretValues,
} from '../deployment/secret-redaction.js';
import { stripControlChars } from '../utils/regexp.js';
import { safeMsg } from '../utils/display-safe.js';
import { isReadableBag } from '../state/malformed-resources-bag.js';
import { isSecretBearingReferenceString as isSecretDynamicReference } from '../deployment/no-change-outputs-merge.js';
import { keepsSecretReferenceToken } from '../deployment/intrinsic-resolver/context.js';

/**
 * Kind of change for one key of the persisted Outputs bag.
 *
 * Deliberately NOT reusing `ChangeType` (CREATE / UPDATE / DELETE / NO_CHANGE):
 * that vocabulary belongs to resources, where a change implies an AWS API call
 * on a physical resource. An Outputs delta is a pure state / exports-index
 * write, so it gets its own words and never lands in the resource counts.
 */
export type OutputChangeType = 'ADD' | 'MODIFY' | 'REMOVE';

/** One key of the resolved Outputs bag that differs between state and template. */
export interface OutputChange {
  /**
   * The bag KEY, which is either a template `Outputs` logical name or an
   * `Export.Name` alias — see {@link resolveTemplateOutputs} for why both live
   * in one flat map.
   */
  name: string;
  changeType: OutputChangeType;
  /** Value in cdkd state. Absent for `ADD`. */
  oldValue?: unknown;
  /** Value the next deploy would persist. Absent for `REMOVE`. */
  newValue?: unknown;
  /**
   * True when `name` is an `Export.Name` the template publishes — the keys with
   * cross-stack blast radius, since a consumer's `Fn::ImportValue` resolves
   * against exactly these. Always false for a `REMOVE`: the removed key is gone
   * from the template, so there is no `Export.Name` left to match it against
   * (state records the flat bag only, not which key was an alias of which).
   */
  isExport: boolean;
  /**
   * True when {@link oldValue} was WITHHELD because it MAY be legacy secret
   * plaintext (see {@link computeOutputsDiff}). Renderers and the `--json`
   * projection must not emit the value when this is set.
   *
   * Deliberately ONE boolean covering both reasons the value can be withheld —
   * a record judged pre-GHSA (which includes one the no-change merge preview
   * cannot clear, because a value carried from state for a failed output, an
   * export alias included, is not a secret expression, issue #3101), and a
   * stored key today's template cannot account for (issue #1948). Every
   * consumer does the same thing with it (do not print the value), so a reason
   * code would add a `--json` field nothing branches on.
   * "MAY be": both are SUSPICIONS by construction, which is why the rendered
   * stand-in is worded as a possibility.
   */
  oldValueRedacted?: boolean;
  /**
   * How {@link name} may be SHOWN (issue
   * [#4015](https://github.com/go-to-k/cdkd/issues/4015)): the verdict
   * `secretSafeKeyDisplay` returned for this key against the corpus
   * {@link computeOutputsDiff} derived, so a renderer prints the verdict's own
   * text and never a separately sanitised copy of the key.
   *
   * Present only when the verdict is NOT `safe`. Absence loses nothing: the
   * corpus and the force-mask set only ever ADD exposures, and a `safe` text
   * depends on the key alone, so the no-corpus verdict a renderer computes for
   * a change without this field is the same `safe` display.
   */
  nameDisplay?: SecretSafeKeyDisplay;
}

/** Result of resolving a template's `Outputs` section for the diff. */
export interface ResolvedTemplateOutputs {
  /** The bag the next deploy would persist, in `StackState.outputs` shape. */
  outputs: Record<string, unknown>;
  /** Every `Export.Name` key present in {@link outputs}. */
  exportNames: Set<string>;
  /**
   * True when at least one output could not be fully resolved against current
   * state. The caller then reports NO outputs delta, EXCEPT on a stack whose
   * resource diff is empty, whose parameters bind and conditions evaluate, in
   * which no condition verdict can reach an output
   * ({@link templateLetsConditionsReachOutputs}; a condition gating only
   * resources does not count), and where every failure is one
   * {@link failuresMirrorDeploy} certifies: there the deploy
   * takes its NO-CHANGE branch and persists a merge (issue #2771), and
   * `computeStackDiff` previews that same merge (issue #3101). With a resource
   * change pending the failure usually means an output waiting on a resource
   * this deploy creates, which the preview cannot tell from one that will fail
   * again, so the section stays suppressed.
   * (Deploy's changed-resources branch has no gate at all, because by then
   * every resource exists.)
   */
  resolutionFailed: boolean;
  /**
   * The template output NAMES whose VALUE failed in a way the deploy engine's
   * `resolveOutputs` also records as a failure — the resolver threw, or it
   * returned `undefined` — so the deploy, without `--strict-getatt` (which
   * fails for either), keeps them in its bag as `undefined` and its no-change
   * merge treats them as failed keys (issue #3101).
   *
   * Output names only, unlike {@link failedKeys}, which also holds a failed
   * output's literal `Export.Name` alias: the merge derives the alias from the
   * template itself, and an alias key fed in as a failed OUTPUT would be
   * carried under the wrong rule.
   */
  failedOutputKeys: Set<string>;
  /**
   * True when every failure that set {@link resolutionFailed} is named in
   * {@link failedOutputKeys}, so previewing the deploy's no-change merge is
   * sound (issue #3101).
   *
   * False for the failures only this preview reports, and for the ones it
   * cannot name:
   * - a value that came back as a symbol, a surviving intrinsic, an
   *   unsubstituted `Fn::Sub` placeholder, or a container holding any of
   *   those — {@link isUnresolvedValue}'s arms wider than deploy's
   *   `v === undefined`. Such a value is not the deploy's failure signal, so
   *   it says nothing about what the deploy does with the key: it may write
   *   the value, lose it when the bag is serialized (a symbol), or throw where
   *   this best-effort pass kept a placeholder (a structural `Fn::Sub`
   *   failure). The merge would treat as carried a key whose outcome it
   *   cannot see;
   * - an `Export.Name` that did not resolve, or a literal one this preview
   *   cannot decide — the alias key is unknown, so no merge input can name it.
   *
   * Why the wider arms suppress rather than merge: a carried key renders no
   * row, so carrying a key the deploy actually rewrites or drops hides that
   * key's change, and the merged path's warning would not name it either (it
   * lists {@link failedOutputKeys} only), while the suppression omits the
   * section and warns whenever a difference remains beyond the failed outputs.
   */
  failuresMirrorDeploy: boolean;
  /**
   * The bag keys that FAILED to resolve, so they are absent from {@link outputs}
   * rather than present-with-a-bad-value.
   *
   * The deploy side, without `--strict-getatt`, keeps such a key with the
   * value `undefined`; dropping it instead means a naive diff reads it as a
   * REMOVE. Callers deciding whether a
   * suppressed delta is worth WARNING about must exclude these, or the common
   * "references a resource this deploy will create" case warns on every run.
   */
  failedKeys: Set<string>;
  /**
   * Bag keys whose RAW TEMPLATE value is a `{{resolve:...}}` dynamic reference —
   * i.e. keys the template PROVES are secret-bearing, independently of what
   * either side of the comparison currently holds.
   *
   * Collected for EVERY declared output including condition-skipped ones,
   * because a skipped output still appears on the stored side and would
   * otherwise print its value as a REMOVE row. See {@link computeOutputsDiff}.
   *
   * What it CANNOT cover — stated because an earlier revision of this comment
   * claimed the opposite, and a false coverage claim is what lets a reader
   * conclude the case is handled: an output DELETED from today's template
   * contributes nothing to this set, since the set is built from declarations
   * only. That case is answered by {@link declaredKeys} +
   * {@link templateHasSecretReference} instead (issue #1948).
   */
  secretSourceKeys: Set<string>;
  /**
   * Every bag key today's template can ACCOUNT FOR: each declared output name
   * plus each LITERAL `Export.Name`, over all declared outputs including
   * condition-skipped and unresolvable ones.
   *
   * A stored key that is in neither this set nor the resolved bag is one the
   * template no longer explains — a DELETED output. Whether its stored value is
   * pre-GHSA secret plaintext is undecidable from the stored bag alone (a
   * plaintext is just a string), so {@link computeOutputsDiff} withholds it
   * when the template proves the stack handles secrets at all. See issue #1948.
   *
   * An INTRINSIC `Export.Name` is deliberately absent: the alias it resolves to
   * is knowable only when resolution succeeded, and in that case the key is in
   * {@link outputs}, which the consumer checks first.
   *
   * When it does NOT resolve the key is simply unknown, and the arms that give
   * up on it do NOT all record it in {@link failedKeys} — the resolve-failure,
   * secret-spelling and collision arms each skip the alias without adding one.
   * (An earlier revision of this note claimed they did.) The consequence is
   * benign and worth stating rather than fixing: such a key is absent from
   * BOTH sets, so a stored copy of it is treated as unaccountable and has its
   * value withheld — the conservative side, and unreachable in the ordinary
   * case anyway because those arms also set `resolutionFailed`, which
   * suppresses the whole section.
   */
  declaredKeys: Set<string>;
  /**
   * True when ANY string ANYWHERE in the template is a secret-bearing dynamic
   * reference — `Resources` included, not just `Outputs`.
   *
   * This is the "does this stack handle secrets at all?" gate on the
   * deleted-output withholding (issue #1948). Without it, every stack that ever
   * deletes an output loses its REMOVE values; with it, only stacks whose
   * template still proves a secret reference do. The residual is the stack
   * whose ONLY secret reference WAS the deleted output — nothing in the stored
   * bag or in today's template can then tell its plaintext from an ordinary
   * string, and blanket withholding is worse than that gap.
   */
  templateHasSecretReference: boolean;
  /**
   * Each RESOLVED `Export.Name` that still carries a `{{resolve:...}}` token
   * after this resolver's `skipDynamicReferences` pass — a name the deploy
   * substitutes a secret into and refuses (issue #1919), spelled with the
   * `{{resolve:...}}` token where an older binary substituted the plaintext.
   * {@link secretSpanInStoredKey} reads them to find that plaintext in a stored
   * alias key (issue #4015).
   */
  secretBearingExportNames: string[];
  /**
   * Each RESOLVED `Export.Name` this pass refused for a `NoEcho` reason (the
   * positional twin or the `NoEcho` containment verdict, go-to-k/cdkd#4657).
   * The name holds the value, possibly under the containment floor, so a
   * stored alias row under it is shown withheld, never by name.
   */
  refusedNoEchoExportNames: string[];
  /**
   * True when ANY declared output, a condition-skipped one included, has an
   * intrinsic `Export.Name` that can read a `NoEcho` parameter (in a nested
   * child, one the parent fills from a `NoEcho` source) or a `NoEcho`
   * attribute, under ANY `Fn::If` verdict (go-to-k/cdkd#4723). An older binary
   * published that name
   * with the value and the verdicts of THEN, so a stored alias may spell a
   * value since rotated, or come from a branch today's verdict drops, which
   * neither {@link refusedNoEchoExportNames} nor the printing corpus (today's
   * value only) can match: {@link computeOutputsDiff} withholds the name of
   * every stored alias today's template cannot account for.
   */
  exportNameReadsNoEcho: boolean;
}

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
function addStringLeaves(value: unknown, into: RecordedSecretValues): void {
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
function holdsPlainSsmToken(value: string): boolean {
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
function storedSecretTokenIsExpression(stored: string, desired: unknown): boolean {
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
function containsSecretReferenceText(value: unknown): boolean {
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
function containsSecretDynamicReference(value: unknown): boolean {
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
function valuesEqual(a: unknown, b: unknown): boolean {
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

/**
 * Resolve a template's `Outputs` section into the exact bag shape the deploy
 * engine persists to `StackState.outputs` (issue #1921).
 *
 * This is the preview twin of `DeployEngine.resolveOutputs`, and the three
 * semantics below are load-bearing for parity — a preview that builds a
 * DIFFERENT bag than the apply persists reports a phantom change on every run,
 * which is this issue's own bug class inverted. `tests/unit/analyzer/
 * outputs-diff.test.ts` fences each one against drift on the deploy side.
 *
 * 1. An output whose `Condition` evaluates false is SKIPPED, not resolved —
 *    CloudFormation simply does not create it (mirrors the resource side's
 *    `filterResourcesByCondition`; an unknown condition name is kept).
 * 2. An `Export.Name` is stored as a SECOND key holding the same value, so
 *    `Fn::ImportValue` can find it by export name. Both keys land in state, so
 *    both must land here.
 * 3. Resolution is best-effort and never throws — a diff must never harden into
 *    an error where the deploy would have succeeded.
 *
 * The parity claim is scoped to the deploy engine's NO-CHANGE branch, which is
 * the one this preview stands in for. Its changed-resources branch resolves
 * outputs with no `resolutionFailed` gate at all — correctly, because by then
 * every resource exists and resolution is expected to succeed, whereas a diff
 * runs BEFORE any of them are created.
 *
 * Deliberately does NOT redact secrets the way the deploy side does: this
 * resolver runs with `skipDynamicReferences`, so a `{{resolve:...}}` reference
 * is never resolved to plaintext in the first place and the bag already holds
 * the expression that state stores post-redaction.
 *
 * `storedOutputs` is the bag currently in state. It is consulted for exactly
 * two decisions — the LITERAL `Export.Name` of a secret-bearing stack, see issue
 * #1942 at that branch, and whether a skipped-output record still applies, see
 * issue #2740 below — and never merged into the result: everything else here
 * previews what the template says, and reading state anywhere else would make
 * the preview agree with the past instead of with the next deploy.
 *
 * `skippedOutputKeys` (issue #2740) are the keys the LAST DEPLOY could not
 * resolve and skipped, already narrowed by the caller on BOTH halves of the
 * binding rule: the recorded digest still matches today's template, AND no
 * resource the output references is changing on this run
 * (`bindingSkippedOutputs`, over a pre-resolution snapshot and this run's
 * resource diff — see `skipped-outputs.ts` for why the snapshot is the
 * caller's and why the change map cannot come from the digest). Such a key,
 * while still absent from `storedOutputs`, is previewed as ABSENT — skipped
 * without resolving, no bag entry, no row — because that is what the next
 * deploy will leave in state: this resolver runs
 * with `skipDynamicReferences`, so a failure that happened inside a secret
 * lookup would otherwise assemble cleanly and preview an `ADD` the deploy will
 * never perform. NOT a resolution failure: the sibling outputs are previewed
 * normally, so a genuine change beside the broken output still renders and
 * `--fail` still exits 1 for it. The key appearing in state (a later deploy
 * resolved it) ends the suppression.
 *
 * `outputsPass` (go-to-k/cdkd#4043) is the twin of the deploy's outputs-pass
 * bag: `resolveInto(bag)` is a resolver recording into `bag`. Every value
 * resolves into `secrets`, and each `Export.Name` into a bag of its own, so the
 * `NoEcho` values the deploy's pass reads as LOG-ONLY needles are known per
 * source, and an alias whose name holds one is refused as the deploy refuses
 * it. Without it no alias is refused for that reason.
 */
export async function resolveTemplateOutputs(
  template: CloudFormationTemplate,
  resolveFn: IntrinsicResolveFn,
  conditions?: Record<string, boolean>,
  storedOutputs?: Record<string, unknown>,
  skippedOutputKeys?: ReadonlySet<string>,
  outputsPass?: {
    resolveInto: (bag: RecordedSecretValues) => IntrinsicResolveFn;
    secrets: RecordedSecretValues;
    /** The deploy's `noEchoParameterValueSeed`, built from this diff's inputs. */
    noEchoParameterValues?: RecordedSecretValues;
    /**
     * The `NoEcho` parameters an intrinsic name may read, under the verdicts
     * this diff KNOWS (go-to-k/cdkd#4657): the deploy's positional refusal.
     */
    noEchoNameSources?: NoEchoPositionSources;
    /**
     * A nested child's parameters the parent fills from a `NoEcho` source
     * under ANY condition verdict (go-to-k/cdkd#4723): read only by the
     * `exportNameReadsNoEcho` gate, whose stored alias was published under a
     * past verdict. Pass 3 keeps `noEchoNameSources`, today's.
     */
    noEchoNameParametersAnyVerdict?: ReadonlySet<string>;
    /**
     * Whether `Fn::GetAtt` of `attribute` on `logicalId` serves a value its
     * producer declared `NoEcho`, per the stored record. Read only by the
     * `exportNameReadsNoEcho` gate (go-to-k/cdkd#4723), never by pass 3.
     */
    noEchoAttributeIsNoEcho?: (logicalId: string, attribute: string) => boolean;
  }
): Promise<ResolvedTemplateOutputs> {
  const resolveValue = outputsPass?.resolveInto(outputsPass.secrets) ?? resolveFn;
  // The outputs whose `Export.Name` pass 2 decides, in declaration order.
  const exporting: Array<{
    outputKey: string;
    output: TemplateOutput & { Export: { Name: unknown } };
    value: unknown;
  }> = [];
  // The deploy's verdict (go-to-k/cdkd#4043) over this name's bag, whose
  // log-only set is the pass's, and the stack's `NoEcho` seed. Skipped while
  // neither holds a needle.
  const refusesNoEchoName = (exportName: string, nameBag: RecordedSecretValues): boolean =>
    outputsPass !== undefined &&
    (hasMaskableValues(outputsPass.secrets) ||
      nameBag.size > 0 ||
      hasMaskableValues(outputsPass.noEchoParameterValues)) &&
    exportNameSecretExposure(
      exportName,
      nameBag,
      outputsPass.secrets,
      outputsPass.noEchoParameterValues
    ) !== undefined;
  // The owner key as a debug line may show it: masked against the pass's
  // printing corpus, as the deploy's refusal warning masks it.
  const ownerDisplay = (outputKey: string): string =>
    outputsPass === undefined
      ? outputKey
      : displayTextOrWithheld(
          secretSafeKeyDisplay(outputKey, printingCorpusOf(outputsPass.secrets))
        );
  const logger = getLogger().child('OutputsDiff');
  // `Object.create(null)`, not `{}` (issue #1943's class). Two writes below
  // key this bag by a template-controlled RESOLVED `Export.Name`, so a stack
  // exporting the name `__proto__` would either mutate the prototype or have
  // its write silently dropped on a normal object — and a dropped write then
  // reads downstream as a phantom REMOVE of a key state actually holds. A
  // null-prototype bag has no `__proto__` setter, so the key lands as data.
  // `JSON.stringify` and `Object.entries` treat it identically, and the value
  // is only ever consumed through those.
  const outputs: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const exportNames = new Set<string>();
  const failedKeys = new Set<string>();
  const failedOutputKeys = new Set<string>();
  // Starts true and only ever turns false: an arm that cannot hand the merge a
  // key clears it. See `ResolvedTemplateOutputs.failuresMirrorDeploy`.
  let failuresMirrorDeploy = true;
  const secretSourceKeys = new Set<string>();
  const declaredKeys = new Set<string>();
  // Walked over the WHOLE template, `Resources` included (issue #1948). The
  // question this answers is "does this stack handle secrets at all?", and the
  // deleted-output case it gates is precisely one where `Outputs` no longer
  // mentions the secret — so an Outputs-only walk would answer `false` for
  // every case the gate exists to catch.
  const templateHasSecretReference = containsSecretDynamicReference(template);
  const secretBearingExportNames: string[] = [];
  const refusedNoEchoExportNames: string[] = [];
  let exportNameReadsNoEcho = false;
  let resolutionFailed = false;
  // Does the deploy's outputs pass RECORD a secret at all (issue #4143)? A
  // spelled output value (`secretSourceKeys`) is one source; a resolved value
  // or intrinsic `Export.Name` that keeps a deploy-resolved token after the
  // skip pass (a plain `ssm` SecureString, or a `secretsmanager` reference
  // spelled only in a name) is the other, invisible to that raw spelling
  // test. Decided after the loop, so LITERAL aliases wait for it. Every alias
  // is written after the loop, in declaration order, as the deploy's alias
  // pass does (values first, then aliases).
  //
  // Only a token the template SPELLS in that output counts: one that arrives
  // through a `Ref` to a parameter (a nested child's secret parameter, which
  // the diff passes on as its token) is not recorded in the deploy's pass map,
  // so counting it suppressed a section main published (#4145 review).
  // This gate reads the whole pass, as the deploy's alias decisions do: they
  // run after every name has resolved (go-to-k/cdkd#4043).
  let passResolvesSecret = false;
  // A leaf walk rather than `JSON.stringify`, which throws on a BigInt or a
  // cycle, and would count a key NAME spelling a token.
  const spellsToken = (raw: unknown): boolean => {
    if (typeof raw === 'string') return raw.includes('{{resolve:');
    if (Array.isArray(raw)) return raw.some(spellsToken);
    if (raw !== null && typeof raw === 'object') {
      return Object.values(raw as Record<string, unknown>).some(spellsToken);
    }
    return false;
  };
  const pendingAliases: Array<{
    outputKey: string;
    exportName: string;
    value: unknown;
    literal: boolean;
  }> = [];
  const keepsTokenInLeaves = (value: unknown): boolean => {
    if (typeof value === 'string') return keepsSecretReferenceToken(value);
    if (Array.isArray(value)) return value.some(keepsTokenInLeaves);
    if (value !== null && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).some(keepsTokenInLeaves);
    }
    return false;
  };
  // The deploy engine REFUSES an export alias whose name is another published
  // output's name, and refuses one carrying a secret (issue #1919). This module
  // previews the bag that engine persists, so it has to refuse the same two —
  // it is the THIRD writer of that key space. Without this the preview publishes
  // an alias the deploy will not, and `computeOutputsDiff` reports a phantom
  // ADD/MODIFY on EVERY run: `cdkd diff --fail` never goes green again, and the
  // user is told an export exists that deploy declines to publish.
  const publishedOutputNames = collectPublishedOutputNames(template.Outputs ?? {}, conditions);

  if (!template.Outputs) {
    return {
      outputs,
      exportNames,
      failedKeys,
      failedOutputKeys,
      failuresMirrorDeploy,
      secretSourceKeys,
      declaredKeys,
      templateHasSecretReference,
      resolutionFailed,
      secretBearingExportNames,
      refusedNoEchoExportNames,
      exportNameReadsNoEcho,
    };
  }

  /**
   * Record a key the resolver DROPPED — plus the literal `Export.Name` alias the
   * deploy would have written alongside it. Both are absent from the bag, so
   * both would otherwise read as phantom REMOVEs and make the suppression
   * warning fire on the ordinary pending-resource case.
   */
  const recordFailure = (outputKey: string, output: TemplateOutput): void => {
    failedKeys.add(outputKey);
    // Only a LITERAL alias can be named. An INTRINSIC `Export.Name` on a failed
    // output has no resolved string to record, so if state holds that alias it
    // still reads as a phantom REMOVE. Accepted rather than worked around: the
    // name is genuinely unknowable here, and `failedKeys` feeds ONLY the
    // suppression-warning filter — never a rendered row — so the worst outcome
    // is one spurious warning line, not a wrong diff.
    if (typeof output.Export?.Name === 'string') failedKeys.add(output.Export.Name);
  };

  // Pass 1: which keys does the TEMPLATE prove are secret-bearing? Walked over
  // EVERY declared output — including condition-skipped ones, which never reach
  // the resolve loop below yet can still sit on the stored side and print as a
  // REMOVE row. A literal `Export.Name` alias is recorded too, since the deploy
  // writes the same value under both keys.
  // The `NoEcho` sources for the `exportNameReadsNoEcho` gate in the loop
  // below: no condition verdicts; in a nested child, each parameter the parent
  // fills from a `NoEcho` source under ANY verdict; and a `NoEcho` attribute.
  const everyBranch: NoEchoPositionSources = {
    parameters: new Set([
      ...(outputsPass?.noEchoNameSources?.parameters ?? []),
      ...(outputsPass?.noEchoNameParametersAnyVerdict ?? []),
    ]),
    ...(outputsPass?.noEchoAttributeIsNoEcho !== undefined && {
      attributeIsNoEcho: outputsPass.noEchoAttributeIsNoEcho,
    }),
  };
  for (const [outputKey, output] of Object.entries(template.Outputs)) {
    // Every declared key, secret-bearing or not (issue #1948): a stored key
    // this set does NOT hold is one today's template cannot account for, which
    // is the deleted-output signal `secretSourceKeys` structurally cannot give.
    declaredKeys.add(outputKey);
    if (typeof output.Export?.Name === 'string') declaredKeys.add(output.Export.Name);
    // Every declared output, not only those pass 3 decides: a condition-false
    // exporter's stored alias is a REMOVE row too. And NO condition verdicts,
    // unlike pass 3's refusal of today's name: the stored alias was published
    // under a past verdict, so an `Fn::If` branch today drops still counts.
    // A LITERAL name reads nothing, as for pass 3.
    const name: unknown = output.Export?.Name;
    if (
      !exportNameReadsNoEcho &&
      outputsPass?.noEchoNameSources !== undefined &&
      name !== null &&
      typeof name === 'object' &&
      readsNoEchoSource(name, everyBranch)
    ) {
      exportNameReadsNoEcho = true;
    }
    if (!containsSecretDynamicReference(output.Value)) continue;
    secretSourceKeys.add(outputKey);
    if (typeof output.Export?.Name === 'string') secretSourceKeys.add(output.Export.Name);
  }

  /**
   * Record the secret-bearing `Export.Name` of an output the loop below leaves
   * BEFORE its alias block -- condition-false, previewed absent by a #2740
   * record, or FAILED -- for the stored-key span only (issue #4015). A failed
   * one counts too: a RENAMED exporter whose value fails leaves the section
   * rendered (its old output key and alias are REMOVE rows), and its stale
   * alias printed raw without this. The
   * output's alias is not in this bag, so a stored copy of it is a REMOVE or
   * carried row whose NAME a binary from before #1919 filled with the
   * plaintext; without this, a condition-gated exporter printed it. Nothing
   * is published from here, and a name that throws or does not keep its token
   * gives no span.
   */
  /**
   * ANY `{{resolve:...}}` token left after this resolver's
   * `skipDynamicReferences` pass marks a name the deploy substitutes a SECRET
   * into, not only the `secretsmanager` / `ssm-secure` spellings
   * `isSecretDynamicReference` knows: a plain `{{resolve:ssm:...}}` to a
   * `SecureString` parameter stays a token too (measured), while a public
   * `String` one resolves to its value and carries none. So the token scan,
   * not the spelling, decides (issue #4015). Corpus only: which alias this
   * preview publishes is decided below by `keepsSecretReferenceToken`, which
   * reads the same scan narrowed to the services the deploy resolves (#4056).
   */
  const recordTokenBearingExportName = (name: string): void => {
    if (dynamicReferenceTokens(name).length > 0) secretBearingExportNames.push(name);
  };

  const recordSkippedSecretExportName = async (output: TemplateOutput): Promise<void> => {
    const declared: unknown = output.Export?.Name;
    if (declared === undefined || typeof declared === 'string') return;
    try {
      const resolvedName = await resolveFn(structuredClone(declared));
      if (typeof resolvedName === 'string') recordTokenBearingExportName(resolvedName);
    } catch {
      // No span from a name this preview cannot resolve.
    }
  };

  for (const [outputKey, output] of Object.entries(template.Outputs)) {
    if (output.Condition !== undefined && conditions?.[output.Condition] === false) {
      logger.debug(
        `Skipping output ${stripControlChars(outputKey)} — condition ${stripControlChars(String(output.Condition))} is false`
      );
      // NOT a resolution failure — CFn genuinely does not create it, so the
      // deploy drops it from the bag too and a REMOVE here is CORRECT.
      await recordSkippedSecretExportName(output);
      continue;
    }
    // Issue #2740: the last deploy could not resolve this output and the
    // template has not changed in any way its resolution reads — so the next
    // deploy will skip it again, and previewing it would be a phantom ADD.
    // Previewed as ABSENT instead, the way the deploy leaves it: no bag entry,
    // and — deliberately — neither `resolutionFailed` nor `failedKeys`, which
    // would suppress the whole section and hide a sibling's genuine change.
    // Only while the key is ABSENT from state: present means a later deploy did
    // resolve it, and the record is stale rather than binding. Checked BEFORE
    // resolving the preview's value. The deploy's value pass still resolves
    // it, recording its `NoEcho` needles for the alias verdict
    // (go-to-k/cdkd#4043), so with an `outputsPass` it is resolved into that
    // bag too, and the result discarded. Bound, stated: this issues the
    // lookups its resolution makes (an attribute heal, a CFn fallback), and
    // it can OVER-refuse, since the deploy's value pass may fail before
    // reaching what this preview's resolution records. Only a DERIVED needle
    // (an `Fn::Base64` encoding, an `Fn::Split` piece) can differ: the
    // `NoEcho` value itself is in both sides' seed either way.
    if (
      skippedOutputKeys?.has(outputKey) &&
      !(
        storedOutputs !== undefined &&
        Object.prototype.hasOwnProperty.call(storedOutputs, outputKey)
      )
    ) {
      logger.debug(
        `Diff previewing output ${stripControlChars(outputKey)} as absent — the last deploy could not resolve it and its template inputs are unchanged`
      );
      if (outputsPass !== undefined) {
        try {
          await resolveValue(structuredClone(output.Value));
        } catch {
          // Its needles only; a failure records nothing more.
        }
      }
      await recordSkippedSecretExportName(output);
      continue;
    }
    const sourceUsedSub = templateUsesSub(output.Value);

    let value: unknown;
    try {
      // Resolve a CLONE. The reason is the INVARIANT, not a call site: this
      // template is shared with the resource diff that already ran and with
      // the skipped-output digests computed above, so nothing here may leave
      // a resolved value — a decrypted secret among them — reachable by
      // either. Resolving a copy makes that true whatever the resolver does.
      // (It is not true that the resolver mutates its input today: `resolveSub`
      // wrote back until go-to-k/cdkd#2764 retired it, and this comment named
      // that write-back in three places. Kept as history so the clone is not
      // deleted as dead weight, which is exactly what the invariant forbids.)
      value = await resolveValue(structuredClone(output.Value));
    } catch (error) {
      logger.debug(
        `Diff could not resolve output ${stripControlChars(outputKey)}: ${stripControlChars(String(error))}`
      );
      resolutionFailed = true;
      recordFailure(outputKey, output);
      // The deploy records a throw the same way (its catch stores `undefined`):
      // a matching failure signal, not a promise that its resolution throws too.
      failedOutputKeys.add(outputKey);
      await recordSkippedSecretExportName(output);
      continue;
    }
    if (isUnresolvedValue(value, sourceUsedSub)) {
      // The common, EXPECTED case: the output references a resource this deploy
      // has not created yet. Not a warning — the resource section already shows
      // that CREATE.
      logger.debug(
        `Diff left output ${stripControlChars(outputKey)} unresolved (references a pending resource)`
      );
      resolutionFailed = true;
      recordFailure(outputKey, output);
      // Only a TOP-LEVEL `undefined` is deploy's own signal. Every other arm of
      // `isUnresolvedValue` (a nested `undefined` included) says nothing about
      // what the deploy does with the key, so it cannot be previewed as carried.
      if (value === undefined) failedOutputKeys.add(outputKey);
      else failuresMirrorDeploy = false;
      await recordSkippedSecretExportName(output);
      continue;
    }
    outputs[outputKey] = value;
    if (spellsToken(output.Value) && keepsTokenInLeaves(value)) passResolvesSecret = true;

    if (output.Export?.Name) {
      exporting.push({
        outputKey,
        output: output as TemplateOutput & { Export: { Name: unknown } },
        value,
      });
    }
  }

  // Pass 2, the deploy's name pass: every `Export.Name`, AFTER every value,
  // resolved before any alias is decided (go-to-k/cdkd#4043, Phase B). Each
  // name resolves into a bag of its OWN sharing the pass's log-only set, with
  // its entries forwarded into the pass bag once it resolves -- the deploy's
  // `nameSecrets` (a `ForwardingSecrets` sharing the pass map's set) -- so an
  // `Fn::Base64` in a name records its encoding exactly as the deploy's does.
  const resolvedNames: Array<{
    outputKey: string;
    exportName: string;
    value: unknown;
    declaredExportIsIntrinsic: boolean;
    nameSource: unknown;
    nameBag: RecordedSecretValues;
  }> = [];
  for (const { outputKey, output, value } of exporting) {
    const nameBag: RecordedSecretValues = new Map();
    if (outputsPass !== undefined) shareLogOnlyValues(nameBag, outputsPass.secrets);
    try {
      let exportName: unknown = output.Export.Name;
      // The `Fn::Sub` scoping is derived from `Export.Name`'s OWN source, not
      // from `output.Value`: an export name can be an `Fn::Sub` while the value
      // is a plain `Fn::GetAtt` (or the reverse), and reusing the value's flag
      // would either miss a laundered placeholder in the NAME — publishing a
      // wrong alias key, which is worse than a phantom because a consumer reads
      // it — or suppress on a name that never used `Fn::Sub` at all.
      const exportSourceUsedSub = templateUsesSub(output.Export.Name);
      const declaredExportIsIntrinsic = typeof output.Export.Name !== 'string';
      if (typeof exportName !== 'string') {
        try {
          exportName = await (outputsPass?.resolveInto(nameBag) ?? resolveFn)(
            structuredClone(exportName)
          );
        } catch (error) {
          logger.debug(
            `Diff could not resolve Export.Name of ${stripControlChars(outputKey)}: ${stripControlChars(String(error))}`
          );
          resolutionFailed = true;
          // The value resolved, so deploy records no failure for this output,
          // and the alias it will write has no name here to merge under.
          failuresMirrorDeploy = false;
          continue;
        }
      }
      if (typeof exportName === 'string') recordTokenBearingExportName(exportName);
      if (
        declaredExportIsIntrinsic &&
        spellsToken(output.Export.Name) &&
        typeof exportName === 'string' &&
        keepsSecretReferenceToken(exportName)
      ) {
        passResolvesSecret = true;
      }
      if (typeof exportName === 'string' && !isUnresolvedValue(exportName, exportSourceUsedSub)) {
        resolvedNames.push({
          outputKey,
          exportName,
          value,
          declaredExportIsIntrinsic,
          nameSource: output.Export.Name,
          nameBag,
        });
      } else {
        // An Export.Name that stayed intrinsic means the alias key the deploy
        // WILL write is unknown, so the bag is incomplete — same suppression as
        // an unresolvable value rather than a diff missing a key.
        resolutionFailed = true;
        failuresMirrorDeploy = false;
      }
    } finally {
      if (outputsPass !== undefined) {
        for (const [plaintext, expression] of nameBag)
          outputsPass.secrets.set(plaintext, expression);
      }
    }
  }

  // Pass 3, the deploy's alias decisions: in declaration order, each against
  // every value's and every name's needles.
  for (const {
    outputKey,
    exportName,
    value,
    declaredExportIsIntrinsic,
    nameSource,
    nameBag,
  } of resolvedNames) {
    // The refusal order MIRRORS the deploy engine's — secret first, then
    // collision — so a name matching both is attributed the same way on
    // both sides. See `outputs-export-alias.ts`'s parity table for the full
    // row-by-row correspondence this block is written against.
    if (exportNameNoEchoParameters(nameSource, outputsPass?.noEchoNameSources).length > 0) {
      // An intrinsic name reading a `NoEcho` parameter (go-to-k/cdkd#4657),
      // refused from the template at any value length, as the deploy does.
      refusedNoEchoExportNames.push(exportName);
      logger.debug(
        safeMsg`Diff skipping export alias of ${ownerDisplay(outputKey)} — the name reads a NoEcho parameter`
      );
    } else if (refusesNoEchoName(exportName, nameBag)) {
      refusedNoEchoExportNames.push(exportName);
      // A `NoEcho` value in the name (go-to-k/cdkd#4043), decided HERE, as
      // the deploy decides it: after every value and every name, against
      // all their needles and the stack's `NoEcho` seed.
      logger.debug(
        safeMsg`Diff skipping export alias of ${ownerDisplay(outputKey)} — the name carries a value this pass recorded as secret`
      );
    } else if (declaredExportIsIntrinsic && keepsSecretReferenceToken(exportName)) {
      // An INTRINSIC name that still carries a `{{resolve:...}}` token
      // after this resolver's `skipDynamicReferences` pass is one the deploy
      // WILL substitute plaintext into, and then refuse (the name would be a
      // state KEY, which no redaction pass walks). The TOKEN decides, not
      // the `secretsmanager` / `ssm-secure` spelling: a plain `ssm` token
      // to a `SecureString` survives the pass too, and the spelling test
      // published its alias as a phantom ADD (issue #4056). Gated on INTRINSIC
      // deliberately: for a LITERAL name the deploy substitutes nothing —
      // it uses the string verbatim as the key — so it publishes, and
      // refusing here would be a phantom REMOVE on every run. That gate is
      // the round-6 regression this replaces, which traded one divergence
      // for two.
      logger.debug(
        `Diff skipping export alias of ${stripControlChars(outputKey)} — the name carries a secret reference`
      );
    } else if (isExportAliasCollision(exportName, outputKey, publishedOutputNames)) {
      // Deploy skips this alias and keeps the colliding output's own value,
      // so previewing it here would be a permanent phantom row. NOT a
      // resolution failure: the bag matches what deploy writes, which is the
      // point of the suppression flag, so nothing needs withholding.
      logger.debug(
        `Diff skipping export alias ${stripControlChars(exportName)} of ${stripControlChars(outputKey)} — collides with an output name`
      );
    } else {
      // Written after the loop (a LITERAL one decided there, once
      // `passResolvesSecret` is known).
      pendingAliases.push({
        outputKey,
        exportName,
        value,
        literal: !declaredExportIsIntrinsic,
      });
    }
  }

  const deployRecordsSecret = secretSourceKeys.size > 0 || passResolvesSecret;
  for (const { outputKey, exportName, value, literal } of pendingAliases) {
    if (!literal || !deployRecordsSecret) {
      outputs[exportName] = value;
      exportNames.add(exportName);
      continue;
    }
    // The deploy refuses a LITERAL name that CONTAINS a resolved secret
    // plaintext — the `prod-<secret>-endpoint` shape — and this preview
    // never substitutes a plaintext, so it cannot evaluate that predicate
    // directly. Narrowed to stacks where the deploy actually records a
    // secret (`passResolvesSecret`, issue #4143): with none there is nothing
    // for a name to contain.
    //
    // STATE decides it (issue #1942). The stored bag holding this exact
    // alias KEY is proof that a PREVIOUS deploy — which did hold the
    // plaintext and did evaluate the predicate — published it, so this
    // preview can publish it too: same literal name, same output, so the
    // next deploy re-evaluates the same predicate over the same name. The
    // preview is not guessing at the predicate; it is reading a verdict
    // the apply already recorded.
    //
    // Publishing regardless of the stored VALUE, deliberately. The
    // refusal deploy makes is about the NAME, which is a template literal
    // and unchanged between the two runs; the value is what the output
    // resolves to today, and previewing a CHANGED one is exactly the #875
    // case this whole section exists for. Requiring value equality would
    // suppress the only row anyone needed.
    //
    // ABSENT key -> suppress, as before. Absence is not evidence: it means
    // either a first deploy of this alias or a first deploy of the stack,
    // and in both the apply's verdict does not exist yet. Guessing there
    // would be guessing at the predicate, which is what this arm refuses
    // to do.
    //
    // Two residuals, stated rather than papered over. (1) A secret that
    // ROTATES to a value which is a substring of the literal export name
    // flips deploy's verdict, so the preview would publish a row deploy
    // now refuses — a phantom, and the row's KEY would carry that
    // plaintext; the name is a fixed template literal and the value is
    // high-entropy, so this needs a coincidence rather than a mistake.
    // (2) A key stored by a PRE-#1919 binary records no verdict at all
    // (the refusal did not exist then) — that is the same key
    // `cdkd scrub` reports through `secretBearingStateKeyWarning`, and
    // it prints as a row on any stack whose section is not suppressed,
    // so publishing does not widen it. Its NAME goes through
    // `computeOutputsDiff`'s key verdict (issue #4015). While the name is
    // still declared it is template text -- the plaintext it would carry
    // is in the template itself -- and is masked only when the corpus
    // holds it; once removed, its stored key is a REMOVE row the
    // alias-name refusal there withholds.
    const storedProvesPublished =
      storedOutputs !== undefined &&
      Object.prototype.hasOwnProperty.call(storedOutputs, exportName);
    if (storedProvesPublished) {
      outputs[exportName] = value;
      exportNames.add(exportName);
    } else {
      // Suppressing is this module's existing answer to "cannot reproduce
      // what deploy will do", and it also avoids printing a row whose KEY
      // may hold that plaintext into CI logs.
      //
      // Recording the ALIAS key is what keeps the suppression honest: it
      // is absent from this bag but may well be PRESENT in state, and
      // without recording it the warning downstream reads it as a REMOVE
      // and blames "an output referencing a resource this deploy has yet
      // to create" — the wrong cause, on every run, forever.
      // `failedKeys.add` directly, NOT `recordFailure`: that helper also
      // records `outputKey`, whose value resolved fine and belongs in the
      // diff.
      logger.debug(
        `Diff cannot decide the export alias of ${stripControlChars(outputKey)} — a literal name may contain a resolved secret and state does not hold that key`
      );
      failedKeys.add(exportName);
      resolutionFailed = true;
      // Deploy DOES decide this alias, holding the plaintext, and the
      // merge has no verdict to carry or drop it by.
      failuresMirrorDeploy = false;
    }
  }

  return {
    outputs,
    exportNames,
    failedKeys,
    failedOutputKeys,
    failuresMirrorDeploy,
    secretSourceKeys,
    declaredKeys,
    templateHasSecretReference,
    resolutionFailed,
    secretBearingExportNames,
    refusedNoEchoExportNames,
    exportNameReadsNoEcho,
  };
}

/**
 * Compare the persisted Outputs bag against the one the next deploy would
 * write, key by key (issue #1921).
 *
 * Compares BAG KEYS rather than template output names on purpose. The bag is
 * what actually lands in `StackState.outputs` AND what
 * `ExportIndexStore.updateForStack` publishes, so a key-level comparison is
 * exactly the `outputMapsEqual` predicate the deploy engine gates its persist
 * on — no interpretive layer in between that could drift from apply semantics.
 * The practical payoff is that the motivating #875 case shows the user the
 * literal export name their downstream `Fn::ImportValue` needs.
 *
 * ## Withholding legacy secret plaintext
 *
 * This is the first code path that DISPLAYS a stored output value, and
 * `cdkd diff` is routinely run in CI — so a value that turns out to be secret
 * plaintext would land in build logs. `StackState.outputs` is only guaranteed
 * redacted for records written after the GHSA fix; an older binary persisted
 * the RESOLVED plaintext, which is the condition `cdkd scrub` repairs.
 *
 * Two independent signals identify such a record, and BOTH are needed:
 *
 * - the desired side is still a secret-bearing expression per
 *   {@link isSecretReferenceText} (this resolver runs with
 *   `skipDynamicReferences`, so a `SecureString` ssm token counts, issue
 *   #4056) while the stored side is not; and
 * - `secretSourceKeys` — the template itself declares the key's value as such a
 *   reference. This one reaches a case the first cannot: a condition-skipped
 *   secret output has NO desired side at all and would otherwise print in full
 *   as a REMOVE row.
 *
 * A hit on either makes the WHOLE record suspect, not just that key: the
 * record was written by a pre-GHSA binary, so every value in it is unredacted.
 * Withholding is therefore record-level. The change is still REPORTED — only
 * the value is withheld — so `--fail` and the exports story are unaffected.
 *
 * A third input forces the same verdict: `forceLegacyRecord`, set by the
 * no-change merge preview (issue #3101) when a value it carried from state for
 * a failed output, an export alias included, is not itself a secret expression.
 * The first signal reads a carried key's desired side, which is then the stored
 * value, so evidence only its resolved value held is gone; and where a resolved
 * secret expression can come from (a stored attribute, a parameter, another
 * stack's outputs) is not enumerable. Nothing short of the carried key's own stored expression can
 * excuse it — the one value the per-key veto below would have excused.
 *
 * ## The key today's template cannot account for (issue #1948)
 *
 * Neither signal above covers an output DELETED from the template, and an
 * earlier revision of this note claimed `secretSourceKeys` did — a false
 * coverage claim, which is exactly what lets a reader conclude the case is
 * handled. It structurally cannot: that set is built from DECLARATIONS, and a
 * deleted output declares nothing, so a record whose ONLY secret-bearing output
 * has since been removed is judged not-legacy and its stored pre-GHSA plaintext
 * renders as the `old:` side of a REMOVE row.
 *
 * The signal has to come from the STORED bag, and the honest statement about
 * the stored bag is that the case is UNDECIDABLE there: post-GHSA a secret
 * output stores its `{{resolve:...}}` EXPRESSION, but pre-GHSA it stores a
 * plaintext, and a plaintext is indistinguishable from an ordinary string. So
 * this is a REFUSAL rather than a detection — a stored key the template cannot
 * account for has its value withheld — bounded by two gates that keep it off
 * the common benign case (deleting an output is a normal refactor):
 *
 * - `templateHasSecretReference` — the template must still prove this stack
 *   handles secrets AT ALL (anywhere, `Resources` included). An ordinary stack
 *   with no secret reference keeps printing its REMOVE values.
 * - no stored value is itself a secret-bearing expression. One that is
 *   exonerates the record, read as evidence that the last write redacted the
 *   whole bag. A bag resolved whole by one post-GHSA pass earns that reading,
 *   and the no-change path's partial persist (issue #2771) refuses to carry a
 *   previous value into a bag it is about to give its FIRST expression. The
 *   reading is not unconditional: see the scrub and kept-whole residuals
 *   below. The refusal lives in `src/deployment/no-change-outputs-merge.ts`,
 *   beside the predicate both sides read.
 *
 *   That reasoning holds for a DEPLOY write and is weaker for a `cdkd scrub`
 *   one, which rewrites `state.outputs` IN PLACE: scrub redacts what it has a
 *   needle or a template position for. A key today's template cannot name
 *   whose value it cannot identify is DROPPED (go-to-k/cdkd#4120), except
 *   one it rewrote only in part (the text it keeps beside the reference is
 *   withheld per key below), one that may be a live export alias this run
 *   could not reproduce, one
 *   another stack still reads, every one when the other records could not be
 *   read, and one whose NAME holds a secret (#1919) — so a scrubbed bag
 *   holding one redacted key can still exonerate such a kept key's surviving
 *   plaintext. Scrub reports each of those as a finding, never clean. Recorded rather than closed: removing the
 *   exoneration would withhold values on every clean post-GHSA record in a
 *   secret-handling stack, which is the larger harm.
 *   The deploy's own save belongs to the same class when the no-change path
 *   keeps a previous bag whole: its value scan can redact one stored value into
 *   an expression while another stored plaintext, which no needle names,
 *   survives beside it. The partial persist refuses to CREATE that shape
 *   (issue #2771); a kept-whole save can still create it.
 *
 * Withholding here is PER-KEY, unlike the record-level arms above, and the
 * asymmetry follows from what each concludes: those conclude the record was
 * written by a pre-GHSA binary (a claim about the whole bag), while this one
 * concludes only that THIS key is undecidable. So a secret-handling stack that
 * deletes an ordinary output withholds that one row's value and prints the
 * rest.
 *
 * Residual, stated because the gate is what buys the low false-positive rate:
 * a stack whose ONLY secret reference WAS the deleted output has no secret left
 * in its template, so nothing here fires. Closing it would mean withholding
 * every REMOVE value on every stack, which is a worse trade.
 */
export function computeOutputsDiff(
  current: Record<string, unknown> | undefined,
  desired: Record<string, unknown>,
  exportNames: ReadonlySet<string>,
  secretSourceKeys: ReadonlySet<string> = new Set(),
  unaccountableScan: {
    declaredKeys?: ReadonlySet<string>;
    templateHasSecretReference?: boolean;
    /**
     * Treat the record as pre-GHSA whatever pass 1 finds. Set by the no-change
     * merge preview (issue #3101) when a value it carried from state for a failed
     * output, an export alias included, is not a secret expression: pass 1 reads
     * `desired`, and a carried key's desired side is the stored value, so
     * evidence only its resolved value held is gone.
     */
    forceLegacyRecord?: boolean;
    /** {@link ResolvedTemplateOutputs.secretBearingExportNames} (issue #4015). */
    secretBearingExportNames?: readonly string[];
    /** {@link ResolvedTemplateOutputs.refusedNoEchoExportNames} (go-to-k/cdkd#4657). */
    refusedNoEchoExportNames?: readonly string[];
    /** {@link ResolvedTemplateOutputs.exportNameReadsNoEcho} (go-to-k/cdkd#4723). */
    exportNameReadsNoEcho?: boolean;
    /**
     * The record's `exportNames` (schema v9+), or `undefined` when it records
     * none: which stored keys are export ALIASES (issue #4015).
     */
    storedExportNames?: readonly string[] | undefined;
  } = {}
): OutputChange[] {
  const changes: OutputChange[] = [];
  // `isReadableBag`, NOT the `?? {}` that stood here (go-to-k/cdkd#3189). The
  // parameter's TYPE says a bag, but its only production argument is
  // `StackState.outputs` read out of an unchecked cast — `parseStateBody`
  // validates the root object and the schema version and nothing inside — so a
  // hand-edited or truncated record reached the two walks below holding a
  // string or a list, which `Object.entries` enumerates as readily as a map:
  // `'abcdef'` produced six REMOVE rows named `"0"`..`"5"`, each printing a
  // character of the record as its `old:` side, and `--fail` exited 1 on them.
  //
  // SECOND line of defence, not the fix: the fix is at the LOAD, in
  // `diff-recursive.ts`'s `loadStateOrEmpty`, which is what WARNS and what
  // covers the lookups this function's caller makes against the same bag one
  // call earlier. This one keeps the fabrication out of a direct caller that
  // never passed through that load. It reads the SHARED predicate rather than
  // re-spelling the plain-object test, so the two cannot drift.
  // `current !== undefined` is NOT redundant, and reads as if it were —
  // `isReadableBag(undefined)` is already false, so it changes no VERDICT. It is
  // there for the TYPE: `isReadableBag` returns `boolean` rather than a type
  // predicate (deliberately — it is shared with callers that pass `unknown`), so
  // without this conjunct the true branch is still `... | undefined` and the
  // assignment needs an `as` cast. Deleting it therefore does not simplify the
  // line, it re-introduces the cast (review of go-to-k/cdkd#3194, which read it
  // as dead code).
  const currentBag: Record<string, unknown> =
    current !== undefined && isReadableBag(current) ? current : {};

  // Pass 1: is this a pre-GHSA record? See the "Withholding" note above.
  // Named, because issue #4015's corpus reads the keys that TRIGGER it.
  const provesLegacy = ([name, oldValue]: [string, unknown]): boolean => {
    // LEAF granularity on the VETO, deep on both positive arms — and the
    // asymmetry is the point rather than an oversight. Widening this one (as an
    // earlier revision did) makes a CONTAINER holding any expression leaf vote
    // "already redacted", so a partially-redacted bag —
    // `["{{resolve:secretsmanager:A}}", "prod-<plaintext>"]`, the residue
    // `cdkd scrub` itself admits it can leave — is read as post-GHSA and its
    // plaintext leaf then prints in a rendered row. A veto must be harder to
    // earn than a suspicion.
    //
    // Both arms read the secret's TOKEN, not only its `secretsmanager` /
    // `ssm-secure` spelling (issue #4056's sweep). `desired` is RESOLVED text,
    // where a plain `{{resolve:ssm:...}}` survives only for a `SecureString`,
    // so a record an older binary wrote with that parameter's plaintext printed
    // it as the `old:` side of a MODIFY row. The stored side reads that token
    // as an expression too, or a post-#1901 record storing it would be judged
    // pre-GHSA by its own desired side and lose every previous value -- but
    // only in the shape `storedSecretTokenIsExpression` accepts, never on a
    // substring hit beside text that may be plaintext, whatever the token's
    // spelling (issue #4101: the spelling arm vetoed on one and printed the
    // plaintext beside it).
    if (typeof oldValue === 'string' && storedSecretTokenIsExpression(oldValue, desired[name])) {
      return false;
    }
    return containsSecretReferenceText(desired[name]) || secretSourceKeys.has(name);
  };
  const legacyRecord =
    unaccountableScan.forceLegacyRecord === true || Object.entries(currentBag).some(provesLegacy);

  // Pass 2: the issue #1948 exoneration, RECORD-level unlike the per-key veto
  // above, and it has to be: the question is whether the LAST write redacted,
  // and one redacted key is read as answering it for the whole bag — a reading
  // with the residuals the note above names (issue #2771 refuses the merge that
  // would add one). Same LEAF granularity, so a container holding an expression
  // still does not earn it. A key earns it only in the shape the pass-1 veto
  // accepts (issue #4101): the shared `bagHoldsSecretExpression` is a substring
  // spelling test, so a stored `{{resolve:secretsmanager:A}}-<plaintext>` of a
  // REMOVED output exonerated its own record and printed on the REMOVE row.
  // That helper stays as-is for its deploy-side readers.
  //
  // And only a plain `ssm` token earns it (issue #4108): a `secretsmanager` /
  // `ssm-secure` expression proves the write came after the GHSA fix, not
  // after #1901, and a binary between the two stored a `SecureString`
  // parameter's PLAINTEXT beside that correctly redacted expression. A stored
  // plain `ssm` token is written only after #1901 (before it, every plain ssm
  // reference resolved): by a deploy, whose no-change merge refuses to put a
  // first one beside a carried value (`bagHoldsSecretExpression` counts it),
  // or by `cdkd scrub`, which drops an undeclared key it cannot identify but
  // keeps the kinds the note above names (the scrub residual). So it
  // is the strongest evidence the bag is redacted, not a proof. A record with
  // none keeps the unaccountable-key signal:
  // fail-closed, costing a removed output's value in a `secretsmanager`-only
  // stack.
  const recordProvesPost1901 = Object.entries(currentBag).some(
    ([name, value]) =>
      typeof value === 'string' &&
      holdsPlainSsmToken(value) &&
      storedSecretTokenIsExpression(value, desired[name])
  );
  const declaredKeys = unaccountableScan.declaredKeys ?? new Set<string>();
  // A key's OWN stored value can prove it unsafe whatever the record's verdict:
  // a secret token outside the shape `storedSecretTokenIsExpression` accepts
  // is what a pre-#1901 deploy wrote around a plaintext (issue #4101), and that
  // same deploy stored a sibling's whole token, which exonerates the record.
  // So this refusal is per key, for a declared key too (its template value may
  // since have turned public, so pass 1 has no desired-side signal), and is
  // gated by neither the exoneration nor the template. One whole token is
  // never refused here: it has no room for a plaintext. A CONTAINER is read
  // leaf by leaf with no desired side to line up against, so any leaf holding
  // a secret token beside other text withholds it (fail-closed; a pre-#1901
  // deploy's value scan wrote the same shape inside an array or object).
  const leafCarriesSecret = (leaf: string): boolean =>
    (isSecretDynamicReference(leaf) || keepsSecretReferenceToken(leaf)) &&
    !isWholeSecretReferenceToken(leaf);
  const anyLeafCarriesSecret = (value: unknown): boolean => {
    if (typeof value === 'string') return leafCarriesSecret(value);
    if (Array.isArray(value)) return value.some(anyLeafCarriesSecret);
    if (value !== null && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).some(anyLeafCarriesSecret);
    }
    return false;
  };
  const ownValueHidesSecret = (name: string): boolean => {
    const value = currentBag[name];
    if (typeof value !== 'string') return anyLeafCarriesSecret(value);
    return (
      leafCarriesSecret(value) &&
      !storedSecretTokenIsExpression(
        value,
        Object.prototype.hasOwnProperty.call(desired, name) ? desired[name] : undefined
      )
    );
  };
  const unaccountable = (name: string): boolean =>
    !declaredKeys.has(name) &&
    !Object.prototype.hasOwnProperty.call(desired, name) &&
    ((unaccountableScan.templateHasSecretReference === true && !recordProvesPost1901) ||
      ownValueHidesSecret(name));

  // THE KEY'S OWN VERDICT (issue #4015). A stored key is printed as a row
  // name, and a binary from before issue #1919 (or #2889) could publish an
  // alias key holding a resolved secret -- which no redaction pass rewrites,
  // since they all walk VALUES. So every row name goes through
  // `secretSafeKeyDisplay`, and the renderers print its verdict-bound text.
  //
  // The CORPUS is what this diff can know without fetching a secret, which it
  // must not do (the GHSA fix resolves with `skipDynamicReferences`):
  //
  // - in a record judged pre-GHSA, the stored values of the keys that proved
  //   it (the template declares them secret, so their stored value IS the
  //   plaintext), or the whole bag when the merge preview FORCED the verdict,
  //   whose evidence is gone by construction. Tested against every row name;
  // - the stored value of each key the template cannot account for, and the
  //   span an older binary substituted for the `{{resolve:...}}` tokens of a
  //   secret-bearing `Export.Name` (`secretSpanInStoredKey`, FORCE-MASK so a
  //   span below the containment floor is still masked). Tested ONLY against a
  //   name that is neither declared nor desired: resolution substituted no
  //   plaintext into any other, and a deleted `Stage: prod` must not mask an
  //   ADD `prod-ApiUrl` under a false "contains a secret" label.
  //
  // OVER-MASKING, stated, fail-closed on purpose: the span needs only the
  // literal ends to match, so a stale sibling alias sharing them is masked
  // too; and one removed output's stored value found inside ANOTHER removed
  // output's logical id masks that id (`Deleted: 'prod'` beside a removed
  // `prodOldApi`).
  //
  // Then a REFUSAL over what the corpus cannot see: see `withholdsAliasName`.
  const recordCorpus: RecordedSecretValues = new Map();
  const unaccountedCorpus: RecordedSecretValues = new Map();
  for (const entry of Object.entries(currentBag)) {
    // `provesLegacy(entry)` implies `legacyRecord`, so it needs no conjunct.
    if (unaccountableScan.forceLegacyRecord === true || provesLegacy(entry)) {
      addStringLeaves(entry[1], recordCorpus);
    }
    if (unaccountable(entry[0])) addStringLeaves(entry[1], unaccountedCorpus);
  }
  // Built ONCE, so every unaccountable row shares one map and the detection
  // cache `secretSafeKeyDisplay` keys by map identity hits.
  const unaccountedNameCorpus: RecordedSecretValues = new Map([
    ...recordCorpus,
    ...unaccountedCorpus,
  ]);
  const accountable = (name: string): boolean =>
    declaredKeys.has(name) || Object.prototype.hasOwnProperty.call(desired, name);

  // THE ALIAS-NAME REFUSAL (issue #4015, maintainer decision). A stored key
  // holding a secret the corpus cannot see -- its `Export.Name` since removed
  // or edited, or a LITERAL one containing the plaintext, on a record whose
  // values were redacted -- has its NAME withheld, when ALL hold: a REMOVE
  // row (implied by the next: an ADD or MODIFY key is desired, so accountable),
  // a key the template does not account for, a template that references
  // a secret, and a key that can only be an export ALIAS: carrying a character
  // a CloudFormation Output logical id cannot (outside `[A-Za-z0-9]`), and,
  // when the record lists `exportNames` (v9+), listed there. A plain Output
  // logical id is never withheld HERE -- not even one listed in `exportNames`,
  // which a self-aliased output (`exportName` equal to its own id) puts there.
  // `withholdsRotatedNoEchoAlias` below can withhold one (go-to-k/cdkd#4723).
  //
  // TWO BOUNDS remain, each printing unless the corpus or the span covers it:
  // - an alphanumeric-only alias key, which reads as an Output logical id;
  // - any alias in a stack whose template no longer references a secret by a
  //   spelling `templateHasSecretReference` knows (`secretsmanager` /
  //   `ssm-secure`) -- including one whose only secret is a plain
  //   `{{resolve:ssm:...}}` to a `SecureString`.
  const storedExportNames =
    unaccountableScan.storedExportNames === undefined
      ? undefined
      : new Set(unaccountableScan.storedExportNames);
  const withholdsAliasName = (name: string): boolean =>
    unaccountableScan.templateHasSecretReference === true &&
    !accountable(name) &&
    /[^A-Za-z0-9]/.test(name) &&
    (storedExportNames === undefined || storedExportNames.has(name));

  // A name this pass refused for a `NoEcho` reason holds the value, which a
  // 1-3 character value's containment floor cannot mask (go-to-k/cdkd#4657):
  // the REMOVE row of an alias an older binary published under it is withheld.
  const refusedNoEchoNames = new Set(unaccountableScan.refusedNoEchoExportNames ?? []);
  // That set holds TODAY's value only. An alias published while the value was
  // another one spells the OLD value, which nothing here can match
  // (go-to-k/cdkd#4723), so while any declared name reads a `NoEcho`
  // parameter, every stored alias the template cannot account for is
  // withheld. STACK-WIDE, not per owning output: state records no alias's
  // owner, and a value match misses an owner since renamed or removed. No
  // `[A-Za-z0-9]` exemption either: `x${Short}y` publishes `xaby`. Bound,
  // stated: a template that no longer declares such a name withholds nothing.
  const withholdsRotatedNoEchoAlias = (name: string): boolean =>
    unaccountableScan.exportNameReadsNoEcho === true &&
    !accountable(name) &&
    (storedExportNames === undefined || storedExportNames.has(name));
  const nameDisplay = (name: string): { nameDisplay?: SecretSafeKeyDisplay } => {
    if (
      withholdsAliasName(name) ||
      refusedNoEchoNames.has(name) ||
      withholdsRotatedNoEchoAlias(name)
    ) {
      return { nameDisplay: { kind: 'withheld' } };
    }
    let corpus = recordCorpus;
    let forceMask: RecordedSecretValues | undefined;
    if (!accountable(name)) {
      corpus = unaccountedNameCorpus;
      forceMask = new Map();
      for (const exportName of unaccountableScan.secretBearingExportNames ?? []) {
        const span = secretSpanInStoredKey(name, exportName);
        if (span !== undefined) forceMask.set(span, exportName);
      }
    }
    const display = secretSafeKeyDisplay(
      name,
      corpus,
      forceMask !== undefined && forceMask.size > 0 ? forceMask : undefined
    );
    return display.kind === 'safe' ? {} : { nameDisplay: display };
  };

  const push = (change: OutputChange): void => {
    const shown: OutputChange = { ...change, ...nameDisplay(change.name) };
    if (
      change.changeType !== 'ADD' &&
      (legacyRecord || unaccountable(change.name) || ownValueHidesSecret(change.name))
    ) {
      const { oldValue: _dropped, ...rest } = shown;
      changes.push({ ...rest, oldValueRedacted: true });
      return;
    }
    changes.push(shown);
  };

  for (const [name, newValue] of Object.entries(desired)) {
    const isExport = exportNames.has(name);
    if (!Object.prototype.hasOwnProperty.call(currentBag, name)) {
      // An ADD has no stored side, so there is nothing to withhold.
      changes.push({
        name,
        changeType: 'ADD',
        newValue,
        isExport,
        ...nameDisplay(name),
      });
      continue;
    }
    const oldValue = currentBag[name];
    if (!valuesEqual(oldValue, newValue)) {
      push({ name, changeType: 'MODIFY', oldValue, newValue, isExport });
    }
  }

  for (const [name, oldValue] of Object.entries(currentBag)) {
    if (Object.prototype.hasOwnProperty.call(desired, name)) continue;
    push({ name, changeType: 'REMOVE', oldValue, isExport: false });
  }

  return changes;
}
