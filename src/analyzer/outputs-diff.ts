import type { CloudFormationTemplate, TemplateOutput } from '../types/resource.js';
import { getLogger } from '../utils/logger.js';
import { INTRINSIC_KEYS, type IntrinsicResolveFn } from './diff-calculator.js';

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
   * True when {@link oldValue} was WITHHELD because it is legacy secret
   * plaintext (see {@link computeOutputsDiff}). Renderers and the `--json`
   * projection must not emit the value when this is set.
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
   */
  secretSourceKeys: Set<string>;
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
function isUnresolvedValue(value: unknown, sourceUsedSub: boolean): boolean {
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
function templateUsesSub(templateValue: unknown): boolean {
  if (templateValue === null || typeof templateValue !== 'object') return false;
  if (Array.isArray(templateValue)) return templateValue.some(templateUsesSub);
  const record = templateValue as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, 'Fn::Sub')) return true;
  return Object.values(record).some(templateUsesSub);
}

/**
 * True when `value` is a string carrying a CloudFormation dynamic reference.
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
 */
export async function resolveTemplateOutputs(
  template: CloudFormationTemplate,
  resolveFn: IntrinsicResolveFn,
  conditions?: Record<string, boolean>
): Promise<ResolvedTemplateOutputs> {
  const logger = getLogger().child('OutputsDiff');
  const outputs: Record<string, unknown> = {};
  const exportNames = new Set<string>();
  const failedKeys = new Set<string>();
  const secretSourceKeys = new Set<string>();
  let resolutionFailed = false;

  if (!template.Outputs) {
    return { outputs, exportNames, failedKeys, secretSourceKeys, resolutionFailed };
  }

  /**
   * Record a key the resolver DROPPED — plus the literal `Export.Name` alias the
   * deploy would have written alongside it. Both are absent from the bag, so
   * both would otherwise read as phantom REMOVEs and make the suppression
   * warning fire on the ordinary pending-resource case.
   */
  const recordFailure = (outputKey: string, output: TemplateOutput): void => {
    failedKeys.add(outputKey);
    if (typeof output.Export?.Name === 'string') failedKeys.add(output.Export.Name);
  };

  // Pass 1: which keys does the TEMPLATE prove are secret-bearing? Walked over
  // EVERY declared output — including condition-skipped ones, which never reach
  // the resolve loop below yet can still sit on the stored side and print as a
  // REMOVE row. A literal `Export.Name` alias is recorded too, since the deploy
  // writes the same value under both keys.
  for (const [outputKey, output] of Object.entries(template.Outputs)) {
    if (!isSecretDynamicReference(output.Value)) continue;
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
        outputs[exportName] = value;
        exportNames.add(exportName);
      } else {
        // An Export.Name that stayed intrinsic means the alias key the deploy
        // WILL write is unknown, so the bag is incomplete — same suppression as
        // an unresolvable value rather than a diff missing a key.
        resolutionFailed = true;
      }
    }
  }

  return { outputs, exportNames, failedKeys, secretSourceKeys, resolutionFailed };
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
 * - the desired side is still a `{{resolve:...}}` expression (this resolver
 *   runs with `skipDynamicReferences`) while the stored side is not; and
 * - `secretSourceKeys` — the template itself declares the key's value as a
 *   dynamic reference. This one reaches cases the first cannot: a
 *   condition-skipped secret output, or one deleted from the template, has NO
 *   desired side at all and would otherwise print in full as a REMOVE row.
 *
 * A hit on either makes the WHOLE record suspect, not just that key: the
 * record was written by a pre-GHSA binary, so every value in it is unredacted.
 * Withholding is therefore record-level. The change is still REPORTED — only
 * the value is withheld — so `--fail` and the exports story are unaffected.
 */
export function computeOutputsDiff(
  current: Record<string, unknown> | undefined,
  desired: Record<string, unknown>,
  exportNames: ReadonlySet<string>,
  secretSourceKeys: ReadonlySet<string> = new Set()
): OutputChange[] {
  const changes: OutputChange[] = [];
  const currentBag = current ?? {};

  // Pass 1: is this a pre-GHSA record? See the "Withholding" note above.
  const legacyRecord = Object.entries(currentBag).some(([name, oldValue]) => {
    if (isSecretDynamicReference(oldValue)) return false;
    return isSecretDynamicReference(desired[name]) || secretSourceKeys.has(name);
  });

  const push = (change: OutputChange): void => {
    if (legacyRecord && change.changeType !== 'ADD') {
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
