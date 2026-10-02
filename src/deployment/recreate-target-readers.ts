import type { CloudFormationTemplate } from '../types/resource.js';
import type { StackState } from '../types/state.js';
import { ReplacementRulesRegistry } from '../analyzer/replacement-rules.js';
import { TemplateParser } from '../analyzer/template-parser.js';
import { getCreateOnlyPropertyPaths } from '../provisioning/create-only-properties.js';
import { tryGetTopLevelWriteOnlyProperties } from '../provisioning/write-only-properties.js';
import { plainIdentOr, safeMsg } from '../utils/display-safe.js';
import { CdkdError } from '../utils/error-handler.js';
import { markNonRetryable } from './retryable-errors.js';
import { reverseReplacementRewrittenNameTypes } from './replacement-name-holder.js';
import { explicitNamePropertyFor } from '../provisioning/resource-name.js';
import {
  isStatefulRecreateTargetForReplace,
  type StatefulReason,
} from '../provisioning/stateful-types.js';

/** A same-stack resource the recreate of a target replaces when the target's id moves. */
export interface RecreateTargetReplacedReader {
  logicalId: string;
  /** The STATE record's type: the resource being destroyed is the recorded one. */
  resourceType: string;
  /** The replaced resource it reads: a recreate target, or a reader replaced in turn. */
  reads: string;
  /** Its create-only properties holding that reference. */
  properties: string[];
  /**
   * The mid-deploy stateful verdict of the replaced resource, or `null` when it
   * holds no data, or when `UpdateReplacePolicy: Retain` keeps the old one.
   */
  statefulReason: StatefulReason;
}

/**
 * go-to-k/cdkd#4383: the same-stack resources a `--recreate-via-*` deploy
 * REPLACES besides its targets, found before anything is touched.
 *
 * The diff promotes every `Ref` / `Fn::GetAtt` reader of a recreate target as
 * it promotes the readers of a property-driven replacement. A reader whose
 * referencing property is create-only is then itself replaced whenever the
 * recreate gives the target a new physical id (an AWS-assigned one always
 * moves), and its own readers in turn. This walks the same edges and asks the
 * same question the diff's synthetic changes ask: the replacement registry
 * with no values, and, for a property the registry does not classify, a
 * whole-property create-only path of the CFn schema that is not write-only.
 *
 * Whether the id actually moves is known for certain only once the target is
 * recreated. A target whose fixed, literal name IS its recorded physical id
 * keeps it ({@link recreateKeepsPhysicalId}), so a reader holding only its id
 * (`Ref`, `${Id}`) is not replaced: the engine lowers that replacement to an
 * in-place update (go-to-k/cdkd#3662). A reader of one of its attributes, and
 * every reader of any other target, is listed as replaced IF the id changes
 * (fail-safe). The confirmation prompt names
 * them, and `refuseStatefulReplacedReaders` refuses a stateful one without
 * `--force-stateful-recreation` after the diff and before any provider call,
 * rather than once the target is destroyed.
 *
 * Only REPLACEMENT edges are followed. The diff also promotes along in-place
 * edges (a custom resource reading a target is updated, and its `Data` may
 * move), so a stateful resource holding such a value in a create-only
 * property is not found here; the engine's own guard still refuses it, mid-
 * deploy.
 *
 * Only a reader with a state record counts: one this deploy creates has
 * nothing to replace. The targets themselves are not listed; they are
 * validated and shown on their own.
 */
export async function findReplacedReadersOfRecreateTargets(input: {
  template: CloudFormationTemplate;
  state: StackState;
  targetIds: ReadonlyArray<string>;
  /**
   * The deploy's evaluated conditions. Given, a resource whose `Condition` is
   * false is not in this deploy (the diff DELETEs it), and each `Fn::If` reads
   * only its taken arm, so a reference on the untaken arm is no edge: the
   * engine's own refusal passes them, as the engine diffs exactly that. Absent
   * (the confirmation prompt, which runs before parameters are resolved),
   * every resource and both arms count, so the list can only over-name.
   */
  conditions?: Readonly<Record<string, boolean>>;
}): Promise<RecreateTargetReplacedReader[]> {
  const conditions = input.conditions;
  // Null prototype: a template-controlled `__proto__` id must index like any
  // other, never reach the inherited setter and drop out of the walk.
  const resources = Object.create(null) as CloudFormationTemplate['Resources'];
  for (const [id, resource] of Object.entries(input.template.Resources ?? {})) {
    if (
      conditions !== undefined &&
      typeof resource.Condition === 'string' &&
      conditions[resource.Condition] === false
    ) {
      continue;
    }
    resources[id] = resource;
  }
  const recordOf = (id: string): StackState['resources'][string] | undefined =>
    Object.hasOwn(input.state.resources, id) ? input.state.resources[id] : undefined;
  const targets = new Set(
    input.targetIds.filter((id) => resources[id] !== undefined && recordOf(id) !== undefined)
  );
  if (targets.size === 0) return [];
  // Targets whose physical id survives the recreate. Only their id does: an
  // attribute a fixed-name recreate still changes (a table's `StreamArn`, a
  // database's `Endpoint`) is not covered, so the exclusion is per reference,
  // below, and only a `Ref` is skipped.
  const stableTargets = new Set(
    [...targets].filter((id) => recreateKeepsPhysicalId(resources[id]!, recordOf(id)!))
  );

  const parser = new TemplateParser();
  const rules = new ReplacementRulesRegistry();
  // referencedId -> (readerId -> top-level property keys referencing it)
  const readersOf = new Map<string, Map<string, Set<string>>>();
  // referencedId -> (readerId -> the property keys that read it ONLY through
  // its id: `Ref`, or `${Id}` in an `Fn::Sub`)
  const idOnly = new Map<string, Map<string, Set<string>>>();
  for (const [readerId, resource] of Object.entries(resources)) {
    if (resource.Type === 'AWS::CDK::Metadata') continue;
    for (const [key, value] of Object.entries(resource.Properties ?? {})) {
      const taken = conditions === undefined ? value : takenFnIfArms(value, conditions);
      for (const referencedId of parser.extractReferences(taken)) {
        if (referencedId === readerId) continue;
        let readers = readersOf.get(referencedId);
        if (!readers) {
          readers = new Map();
          readersOf.set(referencedId, readers);
        }
        let keys = readers.get(readerId);
        if (!keys) {
          keys = new Set();
          readers.set(readerId, keys);
        }
        keys.add(key);
        if (readsOnlyId(taken, referencedId)) {
          let byReader = idOnly.get(referencedId);
          if (!byReader) {
            byReader = new Map();
            idOnly.set(referencedId, byReader);
          }
          let idKeys = byReader.get(readerId);
          if (!idKeys) {
            idKeys = new Set();
            byReader.set(readerId, idKeys);
          }
          idKeys.add(key);
        }
      }
    }
  }

  const schemaCreateOnly = new Map<string, Promise<ReadonlySet<string>>>();
  const wholeCreateOnlyKeys = (type: string): Promise<ReadonlySet<string>> => {
    let pending = schemaCreateOnly.get(type);
    if (!pending) {
      pending = (async () => {
        const whole = (await getCreateOnlyPropertyPaths(type))
          .filter((path) => path.length === 1)
          .map((path) => path[0]!);
        if (whole.length === 0) return new Set<string>();
        // As the diff's loader: an unknown write-only list raises no ceiling,
        // and a write-only create-only property stays an in-place update.
        const writeOnly = await tryGetTopLevelWriteOnlyProperties(type);
        if (writeOnly === undefined) return new Set<string>();
        return new Set(whole.filter((key) => !writeOnly.has(key)));
      })();
      schemaCreateOnly.set(type, pending);
    }
    return pending;
  };
  const isCreateOnly = async (type: string, key: string): Promise<boolean> => {
    if (rules.requiresReplacement(type, key, undefined, undefined)) return true;
    if (rules.isClassified(type, key)) return false;
    return (await wholeCreateOnlyKeys(type)).has(key);
  };

  const found: RecreateTargetReplacedReader[] = [];
  const replaced = new Set<string>(targets);
  const queue = [...targets];
  while (queue.length > 0) {
    const replacedId = queue.shift()!;
    for (const [readerId, keys] of readersOf.get(replacedId) ?? []) {
      if (replaced.has(readerId)) continue;
      const record = recordOf(readerId);
      const resource = resources[readerId];
      if (!record || !resource) continue;
      const properties: string[] = [];
      for (const key of keys) {
        // A target that keeps its id moves nothing a bare id reference reads.
        if (stableTargets.has(replacedId) && idOnly.get(replacedId)?.get(readerId)?.has(key)) {
          continue;
        }
        if (await isCreateOnly(resource.Type, key)) properties.push(key);
      }
      if (properties.length === 0) continue;
      replaced.add(readerId);
      queue.push(readerId);
      found.push({
        logicalId: readerId,
        resourceType: record.resourceType,
        reads: replacedId,
        properties,
        // Exactly the engine's replacement guard: a `Retain` replace policy
        // keeps the old resource and its data.
        statefulReason:
          resource.UpdateReplacePolicy === 'Retain'
            ? null
            : isStatefulRecreateTargetForReplace(
                record.resourceType,
                record.properties,
                record.observedProperties
              ),
      });
    }
  }
  return found;
}

/**
 * The pre-flight refusal for a stateful replaced reader without
 * `--force-stateful-recreation`: the message the engine's
 * `STATEFUL_REPLACE_BLOCKED` guard would raise mid-deploy, after the target
 * had already been destroyed and recreated. `undefined` when nothing is
 * refused.
 */
export function renderStatefulReplacedReadersRefusal(
  readers: ReadonlyArray<RecreateTargetReplacedReader>,
  forceStatefulRecreation: boolean
): string | undefined {
  if (forceStatefulRecreation) return undefined;
  const blocked = readers.filter((r) => r.statefulReason !== null);
  if (blocked.length === 0) return undefined;
  return [
    'A --recreate-via-* target is read through a create-only property of a stateful resource, ' +
      'which is replaced when the recreate gives the target a new physical id:',
    // Template-controlled ids, one line each: a newline in one cannot forge a
    // row of the refusal.
    ...blocked.map(
      (r) =>
        safeMsg`  - ${r.logicalId} (${shownType(r.resourceType)}) reads ${r.reads} via ${r.properties.join(', ')}`
    ),
    'Re-run with --force-stateful-recreation to confirm the data loss, or drop the recreate flag. ' +
      'Nothing was changed.',
  ].join('\n');
}

/**
 * A STATE record's type as printed: chosen by a state-bucket writer, so any
 * type that is not a plain identifier is described rather than echoed
 * (go-to-k/cdkd#4165).
 */
export function shownType(resourceType: string): string {
  return plainIdentOr(resourceType, 'a resource type that is not a plain identifier');
}

/**
 * The deploy engine's refusal, after the diff and before any provider call,
 * of a stateful resource the recreate would REPLACE without
 * `--force-stateful-recreation` (go-to-k/cdkd#4383). Raised there, on the
 * condition-evaluated template the engine diffs, rather than mid-deploy, where
 * the replacement guard fires only after the target was already destroyed and
 * recreated. `--dry-run` reports it too.
 */
export async function refuseStatefulReplacedReaders(input: {
  template: CloudFormationTemplate;
  state: StackState;
  targetIds: ReadonlyArray<string>;
  conditions: Readonly<Record<string, boolean>>;
  forceStatefulRecreation: boolean;
}): Promise<void> {
  if (input.forceStatefulRecreation || input.targetIds.length === 0) return;
  const readers = await findReplacedReadersOfRecreateTargets(input);
  const refusal = renderStatefulReplacedReadersRefusal(readers, false);
  // `markNonRetryable`, as the engine's sibling refusals: the verdict comes
  // from a flag and the template, which no retry changes, and the message
  // carries template-controlled ids the substring-matching classifiers read.
  if (refusal !== undefined) {
    throw markNonRetryable(new CdkdError(refusal, 'STATEFUL_REPLACE_BLOCKED'));
  }
}

/**
 * `value` with every `Fn::If` replaced by the arm its condition takes. A
 * condition missing from the bag keeps the whole `Fn::If`, so both arms still
 * count.
 */
export function takenFnIfArms(
  value: unknown,
  conditions: Readonly<Record<string, boolean>>
): unknown {
  if (Array.isArray(value)) return value.map((item) => takenFnIfArms(item, conditions));
  if (value === null || typeof value !== 'object') return value;
  const obj = value as Record<string, unknown>;
  const fnIf = obj['Fn::If'];
  if (Object.keys(obj).length === 1 && Array.isArray(fnIf) && fnIf.length === 3) {
    const [name, whenTrue, whenFalse] = fnIf as [unknown, unknown, unknown];
    if (typeof name === 'string' && Object.hasOwn(conditions, name)) {
      return takenFnIfArms(conditions[name] ? whenTrue : whenFalse, conditions);
    }
  }
  // Null prototype, as above: a `__proto__` key would otherwise be lost to the
  // inherited setter, and a reference under it with it.
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(obj)) out[key] = takenFnIfArms(item, conditions);
  return out;
}

/**
 * Is the target's physical id known to survive its recreate? True only where
 * it provably does: the type's physical id is its name, the template fixes
 * that name as a literal, and the record's physical id IS that literal (a
 * fixed-name Lambda function or parameter). A type whose provider rewrites the
 * sent name (IAM, ELBv2), a computed or generated name, or any other id
 * answers false, so its readers stay listed and refused (fail-safe). Only a
 * reference to a stable target's id ({@link readsOnlyId}) is left alone, as
 * the engine lowers its replacement ceiling once it sees the unchanged id
 * (go-to-k/cdkd#3662); an attribute may still move, so a `Fn::GetAtt` of it
 * keeps its reader listed and refused.
 */
function recreateKeepsPhysicalId(
  resource: CloudFormationTemplate['Resources'][string],
  record: StackState['resources'][string]
): boolean {
  if (record.resourceType !== resource.Type) return false;
  if (Object.hasOwn(reverseReplacementRewrittenNameTypes(), resource.Type)) return false;
  const property = explicitNamePropertyFor(resource.Type);
  if (property === undefined) return false;
  const properties = resource.Properties ?? {};
  if (!Object.hasOwn(properties, property)) return false;
  const name = properties[property];
  return typeof name === 'string' && name !== '' && record.physicalId === name;
}

/**
 * Does `value` reference `id` ONLY through its physical id: `{ Ref: id }` or a
 * bare `${id}` in an `Fn::Sub` template? Any `Fn::GetAtt` of it, a
 * `${id.Attr}`, or a shape this walk does not model answers false, so the
 * reference counts as one that can move (fail-safe).
 */
function readsOnlyId(value: unknown, id: string): boolean {
  let other = false;
  let ids = 0;
  const subRefs = (template: string): void => {
    for (const match of template.matchAll(/\$\{([^}!]*)\}/g)) {
      const name = match[1]!.trim();
      if (name === id) ids++;
      else if (name.startsWith(`${id}.`)) other = true;
    }
  };
  const walk = (node: unknown): void => {
    if (other) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 1 && keys[0] === 'Ref') {
      if (obj['Ref'] === id) ids++;
      return;
    }
    if (keys.length === 1 && keys[0] === 'Fn::GetAtt') {
      const target = obj['Fn::GetAtt'];
      const head = Array.isArray(target)
        ? target[0]
        : typeof target === 'string'
          ? target.split('.')[0]
          : undefined;
      if (head === id || typeof head !== 'string') other = true;
      else walk(target);
      return;
    }
    if (keys.length === 1 && keys[0] === 'Fn::Sub') {
      const sub = obj['Fn::Sub'];
      if (typeof sub === 'string') subRefs(sub);
      else if (Array.isArray(sub) && typeof sub[0] === 'string') {
        subRefs(sub[0]);
        walk(sub[1]);
      } else other = true;
      return;
    }
    for (const key of keys) walk(obj[key]);
  };
  walk(value);
  return !other && ids > 0;
}
