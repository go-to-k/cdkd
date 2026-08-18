import type { CloudFormationTemplate } from '../types/resource.js';
import { getLogger } from '../utils/logger.js';
import type { IntrinsicResolveFn } from './diff-calculator.js';

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

const INTRINSIC_KEYS: ReadonlySet<string> = new Set([
  'Ref',
  'Fn::Sub',
  'Fn::GetAtt',
  'Fn::Join',
  'Fn::Select',
  'Fn::Split',
  'Fn::If',
  'Fn::ImportValue',
  'Fn::FindInMap',
  'Fn::Base64',
  'Fn::GetAZs',
  'Fn::Equals',
  'Fn::And',
  'Fn::Or',
  'Fn::Not',
]);

/**
 * True when `value` is, or anywhere CONTAINS, an unresolved intrinsic.
 *
 * The deploy engine detects a failed output resolution by testing the bag for
 * `undefined` — its resolver throws and the catch stores `undefined`. The diff
 * resolver is best-effort (`IntrinsicResolveFn` "returns the original value if
 * resolution fails"), so the same failure arrives as a surviving intrinsic
 * instead. This is that check ported to the best-effort world.
 *
 * DEEP, not shallow: an `Fn::Join` whose argument list holds one unresolvable
 * `Fn::GetAtt` resolves to a partially-substituted structure, not to a bare
 * intrinsic, and treating that as resolved would compare a half-built value
 * against state and report a phantom change.
 */
function containsIntrinsic(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsIntrinsic);
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 1 && INTRINSIC_KEYS.has(keys[0]!)) return true;
  return Object.values(value as Record<string, unknown>).some(containsIntrinsic);
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
    if (containsIntrinsic(value)) {
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
      if (typeof exportName === 'string') {
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
      changes.push({ name, changeType: 'MODIFY', oldValue, newValue, isExport });
    }
  }

  for (const [name, oldValue] of Object.entries(currentBag)) {
    if (Object.prototype.hasOwnProperty.call(desired, name)) continue;
    changes.push({ name, changeType: 'REMOVE', oldValue, isExport: false });
  }

  return changes;
}
