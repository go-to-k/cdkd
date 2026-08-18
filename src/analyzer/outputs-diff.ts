import type { CloudFormationTemplate } from '../types/resource.js';
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
   * report NO outputs delta, because the deploy engine likewise declines to
   * persist a partially-resolved bag.
   */
  resolutionFailed: boolean;
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
 * `${!Literal}` is `Fn::Sub`'s ESCAPE and resolves to the literal text
 * `${Literal}` — which, after resolution, is indistinguishable from a
 * placeholder that failed to substitute. This pattern therefore also matches
 * that legitimately-resolved case. The false positive is deliberate: it
 * SUPPRESSES the outputs delta, which is the pre-#1921 behavior for that stack,
 * while the alternative is a phantom change reported on every single run.
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
 * 3. A surviving intrinsic OBJECT, or an unsubstituted `Fn::Sub` placeholder
 *    STRING (see {@link UNSUBSTITUTED_SUB_PLACEHOLDER}).
 *
 * DEEP rather than shallow: an unresolved leaf can sit anywhere inside an array
 * or object an outer intrinsic already built.
 */
function isUnresolvedValue(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value === 'symbol') return true;
  if (typeof value === 'string') return UNSUBSTITUTED_SUB_PLACEHOLDER.test(value);
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(isUnresolvedValue);
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 1 && INTRINSIC_KEYS.has(keys[0]!)) return true;
  return Object.values(value as Record<string, unknown>).some(isUnresolvedValue);
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
function isDynamicReference(value: unknown): boolean {
  return typeof value === 'string' && value.includes('{{resolve:');
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
  let resolutionFailed = false;

  if (!template.Outputs) return { outputs, exportNames, resolutionFailed };

  for (const [outputKey, output] of Object.entries(template.Outputs)) {
    if (output.Condition !== undefined && conditions?.[output.Condition] === false) {
      logger.debug(`Skipping output ${outputKey} — condition ${output.Condition} is false`);
      continue;
    }

    let value: unknown;
    try {
      // Resolve a CLONE: the intrinsic resolver mutates its input in place, and
      // the template is shared with the resource diff that already ran.
      value = await resolveFn(structuredClone(output.Value));
    } catch (error) {
      logger.debug(`Diff could not resolve output ${outputKey}: ${String(error)}`);
      resolutionFailed = true;
      continue;
    }
    if (isUnresolvedValue(value)) {
      // The common, EXPECTED case: the output references a resource this deploy
      // has not created yet. Not a warning — the resource section already shows
      // that CREATE.
      logger.debug(`Diff left output ${outputKey} unresolved (references a pending resource)`);
      resolutionFailed = true;
      continue;
    }
    outputs[outputKey] = value;

    if (output.Export?.Name) {
      let exportName: unknown = output.Export.Name;
      if (typeof exportName !== 'string') {
        try {
          exportName = await resolveFn(structuredClone(exportName));
        } catch (error) {
          logger.debug(`Diff could not resolve Export.Name of ${outputKey}: ${String(error)}`);
          resolutionFailed = true;
          continue;
        }
      }
      if (typeof exportName === 'string' && !isUnresolvedValue(exportName)) {
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

  return { outputs, exportNames, resolutionFailed };
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
 * Keys are emitted in a stable order: template order for keys the desired bag
 * still has, then the state-only (removed) keys.
 */
export function computeOutputsDiff(
  current: Record<string, unknown> | undefined,
  desired: Record<string, unknown>,
  exportNames: ReadonlySet<string>
): OutputChange[] {
  const changes: OutputChange[] = [];
  const currentBag = current ?? {};

  for (const [name, newValue] of Object.entries(desired)) {
    const isExport = exportNames.has(name);
    if (!Object.prototype.hasOwnProperty.call(currentBag, name)) {
      changes.push({ name, changeType: 'ADD', newValue, isExport });
      continue;
    }
    const oldValue = currentBag[name];
    if (!valuesEqual(oldValue, newValue)) {
      // A desired side that is STILL a `{{resolve:...}}` expression, against a
      // stored side that is NOT, means state holds the RESOLVED PLAINTEXT of
      // that secret — a record written before the GHSA redaction landed (the
      // condition `cdkd scrub` repairs). Report the change, WITHHOLD the value:
      // `cdkd diff` is a preview routinely run in CI, so printing it would put
      // the secret in build logs. Deliberately narrow — it fires only where the
      // desired side PROVES the key is secret-bearing.
      if (isDynamicReference(newValue) && !isDynamicReference(oldValue)) {
        changes.push({
          name,
          changeType: 'MODIFY',
          newValue,
          isExport,
          oldValueRedacted: true,
        });
        continue;
      }
      changes.push({ name, changeType: 'MODIFY', oldValue, newValue, isExport });
    }
  }

  for (const [name, oldValue] of Object.entries(currentBag)) {
    if (Object.prototype.hasOwnProperty.call(desired, name)) continue;
    changes.push({ name, changeType: 'REMOVE', oldValue, isExport: false });
  }

  return changes;
}
