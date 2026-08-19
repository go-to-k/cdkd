import type { CloudFormationTemplate, TemplateOutput } from '../types/resource.js';
import { getLogger } from '../utils/logger.js';
import { INTRINSIC_KEYS, type IntrinsicResolveFn } from './diff-calculator.js';
import {
  collectPublishedOutputNames,
  isExportAliasCollision,
} from '../deployment/outputs-export-alias.js';
import { stripControlChars } from '../utils/regexp.js';

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
   * a record judged pre-GHSA, and a stored key today's template cannot account
   * for (issue #1948). Every consumer does the same thing with it (do not print
   * the value), so a reason code would add a `--json` field nothing branches on.
   * "MAY be": both are SUSPICIONS by construction, which is why the rendered
   * stand-in is worded as a possibility.
   */
  oldValueRedacted?: boolean;
}

/** Result of resolving a template's `Outputs` section for the diff. */
export interface ResolvedTemplateOutputs {
  /** The bag the next deploy would persist, in `StackState.outputs` shape. */
  outputs: Record<string, unknown>;
  /** Every `Export.Name` key present in {@link outputs}. */
  exportNames: Set<string>;
  /**
   * True when at least one output could not be fully resolved against current
   * state. See {@link computeOutputsDiff}'s caller contract: the diff must then
   * report NO outputs delta — the deploy engine's NO-CHANGE branch likewise
   * declines to persist a partially-resolved bag. (Its changed-resources branch
   * has no such gate, because by then every resource exists and resolution is
   * expected to succeed; the mirrored semantics here are the no-change one.)
   */
  resolutionFailed: boolean;
  /**
   * The bag keys that FAILED to resolve, so they are absent from {@link outputs}
   * rather than present-with-a-bad-value.
   *
   * The deploy side keeps such a key with the value `undefined`; dropping it
   * instead means a naive diff reads it as a REMOVE. Callers deciding whether a
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
   * An INTRINSIC `Export.Name` is deliberately absent: its resolved alias is
   * knowable only when resolution succeeded, and in that case the key is in
   * {@link outputs} — which the consumer checks first — while a failed one is
   * already in {@link failedKeys} and suppresses the whole section.
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
 *    (`AWS::DynamoDB::Table.StreamArn`, `AWS::IAM::Policy.PolicyId`,
 *    `AWS::EC2::SecurityGroup.VpcId`, ...). `JSON.stringify` drops an
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

/**
 * True when `value` is a string carrying a SECRET-BEARING CloudFormation
 * dynamic reference — `{{resolve:secretsmanager:` or `{{resolve:ssm-secure:`,
 * the two spellings that are secret regardless of what they point at.
 *
 * The diff resolves with `skipDynamicReferences`, so a secret-bearing output
 * arrives here as its unresolved `{{resolve:...}}` expression — which is also
 * what post-GHSA state stores. A state record written by an OLDER binary can
 * still hold the resolved PLAINTEXT instead (that mismatch is exactly what
 * `cdkd scrub` exists to repair), and printing it is this module's problem
 * because it is the first code path that DISPLAYS a stored output value.
 */
function isSecretDynamicReference(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  // Only the spellings that are secret-bearing REGARDLESS of what they point at.
  // A plain `{{resolve:ssm:...}}` is deliberately excluded: per issue #1901 it is
  // classified by the parameter's TYPE, and a `String` / `StringList` parameter
  // is PUBLIC and legitimately persisted RESOLVED. Treating it as a signal would
  // fire on a perfectly ordinary record — and since the verdict is record-WIDE,
  // that would withhold every previous value in the stack and tell the user to
  // run `cdkd scrub`, which would find nothing to fix. The residual is a
  // pre-#1901 SecureString `ssm:` record, a strictly narrower gap than the
  // false positive this exclusion removes.
  return value.includes('{{resolve:secretsmanager:') || value.includes('{{resolve:ssm-secure:');
}

/**
 * The same question asked of a whole template VALUE, walking every string leaf.
 *
 * The leaf predicate answers `false` for a non-string, and an output's `Value`
 * is very often an OBJECT: `secret.secretValueFromJson(...)` renders the
 * secret's ARN as a `Ref`, so the value is an `Fn::Join` / `Fn::Sub` — which
 * CLAUDE.md's #1916 note calls the DOMINANT CDK shape, not an edge case.
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
 * one decision — the LITERAL `Export.Name` of a secret-bearing stack, see issue
 * #1942 at that branch — and never merged into the result: everything else here
 * previews what the template says, and reading state anywhere else would make
 * the preview agree with the past instead of with the next deploy.
 */
export async function resolveTemplateOutputs(
  template: CloudFormationTemplate,
  resolveFn: IntrinsicResolveFn,
  conditions?: Record<string, boolean>,
  storedOutputs?: Record<string, unknown>
): Promise<ResolvedTemplateOutputs> {
  const logger = getLogger().child('OutputsDiff');
  const outputs: Record<string, unknown> = {};
  const exportNames = new Set<string>();
  const failedKeys = new Set<string>();
  const secretSourceKeys = new Set<string>();
  const declaredKeys = new Set<string>();
  // Walked over the WHOLE template, `Resources` included (issue #1948). The
  // question this answers is "does this stack handle secrets at all?", and the
  // deleted-output case it gates is precisely one where `Outputs` no longer
  // mentions the secret — so an Outputs-only walk would answer `false` for
  // every case the gate exists to catch.
  const templateHasSecretReference = containsSecretDynamicReference(template);
  let resolutionFailed = false;
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
      secretSourceKeys,
      declaredKeys,
      templateHasSecretReference,
      resolutionFailed,
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
  for (const [outputKey, output] of Object.entries(template.Outputs)) {
    // Every declared key, secret-bearing or not (issue #1948): a stored key
    // this set does NOT hold is one today's template cannot account for, which
    // is the deleted-output signal `secretSourceKeys` structurally cannot give.
    declaredKeys.add(outputKey);
    if (typeof output.Export?.Name === 'string') declaredKeys.add(output.Export.Name);
    if (!containsSecretDynamicReference(output.Value)) continue;
    secretSourceKeys.add(outputKey);
    if (typeof output.Export?.Name === 'string') secretSourceKeys.add(output.Export.Name);
  }

  for (const [outputKey, output] of Object.entries(template.Outputs)) {
    if (output.Condition !== undefined && conditions?.[output.Condition] === false) {
      logger.debug(`Skipping output ${outputKey} — condition ${output.Condition} is false`);
      // NOT a resolution failure — CFn genuinely does not create it, so the
      // deploy drops it from the bag too and a REMOVE here is CORRECT.
      continue;
    }
    const sourceUsedSub = templateUsesSub(output.Value);

    let value: unknown;
    try {
      // Resolve a CLONE: the intrinsic resolver mutates its input in place, and
      // the template is shared with the resource diff that already ran.
      value = await resolveFn(structuredClone(output.Value));
    } catch (error) {
      logger.debug(`Diff could not resolve output ${outputKey}: ${String(error)}`);
      resolutionFailed = true;
      recordFailure(outputKey, output);
      continue;
    }
    if (isUnresolvedValue(value, sourceUsedSub)) {
      // The common, EXPECTED case: the output references a resource this deploy
      // has not created yet. Not a warning — the resource section already shows
      // that CREATE.
      logger.debug(`Diff left output ${outputKey} unresolved (references a pending resource)`);
      resolutionFailed = true;
      recordFailure(outputKey, output);
      continue;
    }
    outputs[outputKey] = value;

    if (output.Export?.Name) {
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
          exportName = await resolveFn(structuredClone(exportName));
        } catch (error) {
          logger.debug(`Diff could not resolve Export.Name of ${outputKey}: ${String(error)}`);
          resolutionFailed = true;
          continue;
        }
      }
      if (typeof exportName === 'string' && !isUnresolvedValue(exportName, exportSourceUsedSub)) {
        // The refusal order MIRRORS the deploy engine's — secret first, then
        // collision — so a name matching both is attributed the same way on
        // both sides. See `outputs-export-alias.ts`'s parity table for the full
        // row-by-row correspondence this block is written against.
        if (declaredExportIsIntrinsic && isSecretDynamicReference(exportName)) {
          // An INTRINSIC name that still carries a `{{resolve:...}}` spelling
          // after this resolver's `skipDynamicReferences` pass is one the deploy
          // WILL substitute plaintext into, and then refuse (the name would be a
          // state KEY, which no redaction pass walks). Gated on INTRINSIC
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
        } else if (!declaredExportIsIntrinsic && secretSourceKeys.size > 0) {
          // The deploy refuses a LITERAL name that CONTAINS a resolved secret
          // plaintext — the `prod-<secret>-endpoint` shape — and this preview
          // never substitutes a plaintext, so it cannot evaluate that predicate
          // directly. Narrowed to stacks where the deploy actually records a
          // secret: with no secret-bearing output there is nothing for a name
          // to contain.
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
          // it prints today as a REMOVE row on any stack whose section is not
          // suppressed, so publishing does not widen it.
          const storedProvesPublished =
            storedOutputs !== undefined && Object.hasOwn(storedOutputs, exportName);
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
          }
        } else {
          outputs[exportName] = value;
          exportNames.add(exportName);
        }
      } else {
        // An Export.Name that stayed intrinsic means the alias key the deploy
        // WILL write is unknown, so the bag is incomplete — same suppression as
        // an unresolvable value rather than a diff missing a key.
        resolutionFailed = true;
      }
    }
  }

  return {
    outputs,
    exportNames,
    failedKeys,
    secretSourceKeys,
    declaredKeys,
    templateHasSecretReference,
    resolutionFailed,
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
 *   {@link isSecretDynamicReference} (this resolver runs with
 *   `skipDynamicReferences`) while the stored side is not; and
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
 * - no stored value is itself a secret-bearing expression. One that is proves
 *   the LAST write was post-GHSA, and the bag is rewritten wholesale by
 *   `resolveOutputs` on every deploy, so every other value in it is redacted
 *   too. This exonerates the record.
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
  } = {}
): OutputChange[] {
  const changes: OutputChange[] = [];
  const currentBag = current ?? {};

  // Pass 1: is this a pre-GHSA record? See the "Withholding" note above.
  const legacyRecord = Object.entries(currentBag).some(([name, oldValue]) => {
    // LEAF granularity on the VETO, deep on both positive arms — and the
    // asymmetry is the point rather than an oversight. Widening this one (as an
    // earlier revision did) makes a CONTAINER holding any expression leaf vote
    // "already redacted", so a partially-redacted bag —
    // `["{{resolve:secretsmanager:A}}", "prod-<plaintext>"]`, the residue
    // `cdkd scrub` itself admits it can leave — is read as post-GHSA and its
    // plaintext leaf then prints in a rendered row. A veto must be harder to
    // earn than a suspicion.
    if (typeof oldValue === 'string' && isSecretDynamicReference(oldValue)) return false;
    return containsSecretDynamicReference(desired[name]) || secretSourceKeys.has(name);
  });

  // Pass 2: the issue #1948 exoneration, RECORD-level unlike the per-key veto
  // above, and it has to be: the question is whether the LAST write redacted,
  // and one redacted key answers it for the whole bag (`resolveOutputs`
  // rewrites every key on every deploy). Same LEAF granularity, so a container
  // holding an expression still does not earn it.
  const recordProvesPostGhsa = Object.values(currentBag).some(
    (v) => typeof v === 'string' && isSecretDynamicReference(v)
  );
  const declaredKeys = unaccountableScan.declaredKeys ?? new Set<string>();
  const unaccountable = (name: string): boolean =>
    unaccountableScan.templateHasSecretReference === true &&
    !recordProvesPostGhsa &&
    !declaredKeys.has(name) &&
    !Object.prototype.hasOwnProperty.call(desired, name);

  const push = (change: OutputChange): void => {
    if (change.changeType !== 'ADD' && (legacyRecord || unaccountable(change.name))) {
      const { oldValue: _dropped, ...rest } = change;
      changes.push({ ...rest, oldValueRedacted: true });
      return;
    }
    changes.push(change);
  };

  for (const [name, newValue] of Object.entries(desired)) {
    const isExport = exportNames.has(name);
    if (!Object.prototype.hasOwnProperty.call(currentBag, name)) {
      // An ADD has no stored side, so there is nothing to withhold.
      changes.push({ name, changeType: 'ADD', newValue, isExport });
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
