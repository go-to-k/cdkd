import { namesRecreatedParent } from '../../deployment/child-of-recreated-parent.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import type { StackState, ResourceChange, PropertyChange } from '../../types/state.js';
import type { ReplacementSiblings } from '../replacement-rules.js';
import { getCreateOnlyPropertyPaths } from '../../provisioning/create-only-properties.js';
import { tryGetTopLevelWriteOnlyProperties } from '../../provisioning/write-only-properties.js';
import { safeMsg } from '../../utils/display-safe.js';
import { isPlainReferenceTo } from '../../deployment/recreate-target-readers.js';
import { isKnownTokenFreeState } from '../../state/token-free-state.js';
import {
  readProvenancePromotions,
  type ReadProvenanceSources,
} from '../read-provenance-promotion.js';
import type { DiffCalculator } from '../diff-calculator.js';
import { type SyntheticCreateOnly, containsIntrinsic, siblingsOf } from './shared.js';

/**
 * The read-provenance arm (go-to-k/cdkd#4852, `read-provenance-promotion.ts`):
 * each promoted reader's read-derived keys gain an `inPlacePropagated`
 * synthetic change (a `NO_CHANGE` row becomes an `UPDATE`; an `UPDATE` row
 * is augmented, so a create-only leaf's ceiling is not hidden by an
 * unrelated edit). The ceilings are set by the caller once the create-only
 * paths are loaded. A token-free stack returns at once.
 */
export async function promoteReadProvenanceDependents(
  this: DiffCalculator,
  changes: Map<string, ResourceChange>,
  currentState: StackState,
  desiredTemplate: CloudFormationTemplate,
  sources: ReadProvenanceSources | undefined
): Promise<Array<{ change: ResourceChange; pc: PropertyChange; upstreams: string[] }>> {
  if (isKnownTokenFreeState(currentState)) return [];
  const promotions = await readProvenancePromotions({
    rows: changes.values(),
    currentState,
    desiredTemplate,
    sources,
    parser: this.parser,
  });
  const out: Array<{ change: ResourceChange; pc: PropertyChange; upstreams: string[] }> = [];
  for (const promotion of promotions) {
    const change = changes.get(promotion.logicalId);
    if (change === undefined) continue;
    const existingPaths = new Set((change.propertyChanges ?? []).map((pc) => pc.path));
    const synthetic: PropertyChange[] = [];
    for (const { key, upstreams } of promotion.keys) {
      if (existingPaths.has(key)) continue;
      const pc: PropertyChange = {
        path: key,
        oldValue: change.currentProperties?.[key],
        newValue: change.desiredProperties?.[key],
        requiresReplacement: false,
        inPlacePropagated: true,
        readProvenancePromoted: true,
      };
      synthetic.push(pc);
      out.push({ change, pc, upstreams });
    }
    if (synthetic.length === 0) continue;
    if (change.changeType === 'NO_CHANGE') {
      change.changeType = 'UPDATE';
      change.propertyChanges = synthetic;
    } else {
      change.propertyChanges = [...(change.propertyChanges ?? []), ...synthetic];
    }
    this.logger.debug(
      safeMsg`UPDATE (promoted): ${promotion.logicalId} holds a secret reference read at a version its upstream no longer records (${synthetic.map((pc) => pc.path).join(', ')})`
    );
  }
  return out;
}

/**
 * The CFn-schema createOnly paths for every resource type a promotion pass
 * could query (go-to-k/cdkd#3803), loaded once here because both passes are
 * synchronous. Only a resource REACHABLE from something that can seed a
 * promotion is considered: an UPDATE (a replacement or an in-place update), a
 * recreate target (go-to-k/cdkd#4383) or a fresh parameter, followed
 * transitively along reverse reference edges. An unchanged stack with no
 * recreate target therefore loads nothing and calls no `DescribeType`. Among
 * those, only a type with a registry-unclassified property holding an
 * intrinsic is loaded, since only such a property can be promoted and reach
 * the schema fallback. The lookups are the ordinary diff's own
 * (`getCreateOnlyPropertyPaths`): never throwing, cached per type, and
 * schema-less types short-circuited.
 */
export async function loadSyntheticCreateOnlyPaths(
  this: DiffCalculator,
  changes: Map<string, ResourceChange>,
  desiredTemplate: CloudFormationTemplate,
  rawGetAttRefs: Map<string, Map<string, Map<string, Set<string>>>>,
  freshParameters: ReadonlySet<string> | undefined,
  forcedReplacements: ReadonlySet<string>
): Promise<Map<string, SyntheticCreateOnly>> {
  const loaded = new Map<string, SyntheticCreateOnly>();
  const queue: string[] = [...(freshParameters ?? [])];
  for (const [logicalId, change] of changes) {
    if (change.changeType === 'UPDATE' || forcedReplacements.has(logicalId)) {
      queue.push(logicalId);
    }
  }
  if (queue.length === 0) return loaded;

  // Reverse reference edges: referenced id -> ids of the resources reading it.
  const readersOf = new Map<string, Set<string>>();
  const addEdge = (referencedId: string, readerId: string): void => {
    if (referencedId === readerId) return;
    let readers = readersOf.get(referencedId);
    if (!readers) {
      readers = new Set();
      readersOf.set(referencedId, readers);
    }
    readers.add(readerId);
  };
  for (const [logicalId, resource] of Object.entries(desiredTemplate.Resources)) {
    if (resource.Type === 'AWS::CDK::Metadata') continue;
    for (const value of Object.values(resource.Properties ?? {})) {
      for (const referencedId of this.parser.extractReferences(value)) {
        addEdge(referencedId, logicalId);
      }
    }
    for (const perUpstream of rawGetAttRefs.get(logicalId)?.values() ?? []) {
      for (const referencedId of perUpstream.keys()) addEdge(referencedId, logicalId);
    }
  }

  const reached = new Set<string>(queue);
  while (queue.length > 0) {
    for (const readerId of readersOf.get(queue.shift()!) ?? []) {
      if (reached.has(readerId)) continue;
      reached.add(readerId);
      queue.push(readerId);
    }
  }

  // Per type, the registry-unclassified properties holding an intrinsic.
  const candidateKeys = new Map<string, Set<string>>();
  for (const logicalId of reached) {
    const change = changes.get(logicalId);
    if (!change) continue;
    if (change.changeType !== 'NO_CHANGE' && change.changeType !== 'UPDATE') continue;
    for (const [key, value] of Object.entries(change.desiredProperties ?? {})) {
      if (this.replacementRules.isClassified(change.resourceType, key)) continue;
      if (!containsIntrinsic(value)) continue;
      let keys = candidateKeys.get(change.resourceType);
      if (!keys) {
        keys = new Set();
        candidateKeys.set(change.resourceType, keys);
      }
      keys.add(key);
    }
  }
  const types = candidateKeys.keys();
  await Promise.all(
    [...types].map(async (type) => {
      const whole = new Set(
        (await getCreateOnlyPropertyPaths(type))
          .filter((path) => path.length === 1)
          .map((path) => path[0]!)
      );
      const keys = candidateKeys.get(type)!;
      // A WRITE-ONLY create-only property raises no ceiling from a value
      // that may be a fresh `NoEcho` one: AWS never returns it, so the
      // engine could not confirm such a value there and would replace a
      // resource CloudFormation leaves alone
      // (`AWS::DirectoryService::SimpleAD.Password`). It stays an in-place
      // update, as before, unless it holds a plain reference to a replaced
      // resource (go-to-k/cdkd#4701, `isPlainReferenceTo`). Asked only when a
      // candidate property has a whole-property path, i.e. when a ceiling
      // could be raised.
      if (![...keys].some((key) => whole.has(key))) {
        loaded.set(type, { whole, unconfirmable: new Set() });
        return;
      }
      const writeOnly = await tryGetTopLevelWriteOnlyProperties(type);
      if (writeOnly === undefined) {
        // Unknown (DescribeType failed; there is no write-only snapshot):
        // any whole-property path might be write-only, so none raises a
        // ceiling for this type from such a value. That is `main`'s
        // in-place behaviour, never a replacement nobody can confirm.
        this.logger.debug(
          safeMsg`Write-only properties of ${type} unknown: no create-only replacement ceiling for its promoted readers but a plain reference to a replaced resource`
        );
        loaded.set(type, { whole, unconfirmable: 'all' });
        return;
      }
      loaded.set(type, {
        whole,
        unconfirmable: new Set([...whole].filter((key) => writeOnly.has(key))),
      });
    })
  );
  return loaded;
}

/**
 * The `requiresReplacement` of a SYNTHETIC change (a promoted reader's
 * referencing property), which is a ceiling the engine may lower once it has
 * resolved the value (go-to-k/cdkd#3662).
 *
 * The registry answers first, with `undefined` old / new values (see the
 * replacement pass for why). Where the registry has no opinion on the
 * property, the CFn schema decides, as in the ordinary diff
 * (go-to-k/cdkd#3803) — but only for a WHOLE-property createOnly path. A
 * NESTED path (`ConnectionInput.Name`) does not raise the ceiling: the engine
 * lowers a ceiling by comparing the whole top-level value with the record, so
 * a nested ceiling would stand whenever a MUTABLE sibling moved and replace a
 * resource CloudFormation updates in place. A moved value under a nested
 * create-only path stays an in-place update, as before. So does a
 * WRITE-ONLY create-only property (or any, when the write-only list is
 * unknown), unless `plainReference`: the property is exactly a `Ref` /
 * `Fn::GetAtt` of the replaced resource it was promoted for
 * (go-to-k/cdkd#4701, `isPlainReferenceTo`).
 */
export function syntheticRequiresReplacement(
  this: DiffCalculator,
  resourceType: string,
  propKey: string,
  syntheticCreateOnlyPaths: ReadonlyMap<string, SyntheticCreateOnly>,
  plainReference: boolean,
  siblings?: ReplacementSiblings
): boolean {
  if (
    this.replacementRules.requiresReplacement(resourceType, propKey, undefined, undefined, siblings)
  ) {
    return true;
  }
  if (this.replacementRules.isClassified(resourceType, propKey)) return false;
  const createOnly = syntheticCreateOnlyPaths.get(resourceType);
  if (createOnly === undefined || !createOnly.whole.has(propKey)) return false;
  if (plainReference) return true;
  return createOnly.unconfirmable !== 'all' && !createOnly.unconfirmable.has(propKey);
}

/**
 * Promote transitive dependents of to-be-replaced resources from
 * NO_CHANGE to UPDATE (issue #807).
 *
 * Diff-time intrinsic resolution runs against the CURRENT state, so a
 * dependent referencing a resource that will be REPLACED (new physical
 * ID — e.g. an `AWS::ECS::TaskDefinition` revision) compares equal and
 * stays NO_CHANGE; the deploy engine then never re-points it at the new
 * physical resource (for ECS: `UpdateService` is never issued and the
 * service keeps running the old, now-deregistered revision).
 * CloudFormation propagates the new physical ID to dependents — mirror
 * that here by walking reverse reference edges (`Ref` / `Fn::GetAtt` /
 * `Fn::Sub` and intrinsics nesting them — the same extraction the DAG
 * builder uses) from every replacement-triggering UPDATE and promoting
 * NO_CHANGE dependents to UPDATE.
 *
 * Promotion is safe even when speculative: the deploy engine re-resolves
 * the promoted resource's properties against the in-flight state map
 * (which the DAG guarantees already carries the dependency's new
 * physical ID) and skips the provider call if nothing actually changed.
 *
 * Promotion is transitive: each referencing property of a promoted
 * dependent is re-evaluated against the replacement rules, and if the
 * dependent is itself replacement-triggering (the referencing property
 * is immutable for its type), its own dependents are promoted in turn.
 * The same re-evaluation also applies to dependents that already had
 * their own (non-replacement) property changes — their referencing
 * property gains a synthetic PropertyChange so a replacement cascade is
 * not masked by an unrelated in-place change.
 *
 * `forcedReplacements` (go-to-k/cdkd#4383) seeds the walk with this
 * stack's `--recreate-via-*` targets, whose diff carries no replacing
 * property change, whatever their row says.
 */
export function promoteReplacementDependents(
  this: DiffCalculator,
  changes: Map<string, ResourceChange>,
  desiredTemplate: CloudFormationTemplate,
  syntheticCreateOnlyPaths: ReadonlyMap<string, SyntheticCreateOnly>,
  forcedReplacements: ReadonlySet<string>
): void {
  // Seed queue: resources whose computed diff already requires replacement,
  // and the recreate targets.
  const queue: string[] = [];
  for (const [logicalId, change] of changes) {
    if (
      forcedReplacements.has(logicalId) ||
      (change.changeType === 'UPDATE' &&
        // A `noEchoPromoted` ceiling (go-to-k/cdkd#4043) is a comparison
        // the engine settles, never a replacement on its own word
        // (maintainer decision 1), so it seeds no replacement propagation.
        change.propertyChanges?.some((pc) => pc.requiresReplacement && pc.noEchoPromoted !== true))
    ) {
      queue.push(logicalId);
    }
  }
  if (queue.length === 0) {
    return;
  }

  // Reverse reference edges from the desired template:
  // referencedId -> (dependentId -> top-level property keys referencing it).
  const dependentsOf = new Map<string, Map<string, Set<string>>>();
  for (const [logicalId, resource] of Object.entries(desiredTemplate.Resources)) {
    if (resource.Type === 'AWS::CDK::Metadata') continue;
    for (const [propKey, propValue] of Object.entries(resource.Properties ?? {})) {
      for (const referencedId of this.parser.extractReferences(propValue)) {
        if (referencedId === logicalId) continue; // self-reference defense
        let dependents = dependentsOf.get(referencedId);
        if (!dependents) {
          dependents = new Map();
          dependentsOf.set(referencedId, dependents);
        }
        let propKeys = dependents.get(logicalId);
        if (!propKeys) {
          propKeys = new Set();
          dependents.set(logicalId, propKeys);
        }
        propKeys.add(propKey);
      }
    }
  }

  const enqueued = new Set(queue);
  while (queue.length > 0) {
    const replacedId = queue.shift()!;
    const dependents = dependentsOf.get(replacedId);
    if (!dependents) continue;

    for (const [dependentId, refPropKeys] of dependents) {
      const change = changes.get(dependentId);
      if (!change) continue;
      // CREATE resolves fresh at provisioning time anyway; DELETE is
      // going away — neither needs propagation.
      if (change.changeType !== 'NO_CHANGE' && change.changeType !== 'UPDATE') continue;

      const existingPaths = new Set((change.propertyChanges ?? []).map((pc) => pc.path));
      const syntheticChanges: PropertyChange[] = [];
      for (const propKey of refPropKeys) {
        if (existingPaths.has(propKey)) {
          // Already diffed on its own, so its replacement verdict stands; but
          // its `newValue` was resolved against the resource being replaced
          // (go-to-k/cdkd#6078), so the preview must not print it as final.
          for (const pc of change.propertyChanges ?? []) {
            if (pc.path === propKey && pc.replacementPropagated !== true) {
              pc.newValueKnownAfterDeploy = true;
            }
          }
          continue;
        }
        const oldValue = change.currentProperties?.[propKey];
        const newValue = change.desiredProperties?.[propKey];
        syntheticChanges.push({
          path: propKey,
          oldValue,
          newValue,
          replacementPropagated: true,
          // Re-evaluate the replacement rules for the dependent itself:
          // if the property carrying the reference is immutable for the
          // dependent's type, the dependent must be replaced too (and
          // its own dependents promoted transitively below).
          //
          // The referencing property's value is NOT actually changing in
          // the template — only the resolved physical ID / ARN it points
          // at will change after the upstream replacement. `oldValue` is
          // the resolved current value (e.g. an old ARN string) while
          // `newValue` is the still-unresolved intrinsic ({Ref: ...}), so
          // feeding both to a conditionalReplacement's `condition(old,
          // new)` would compare a string against an object and reliably
          // (and spuriously) report "changed". We therefore pass
          // undefined/undefined: UNCONDITIONAL replacementProperties match
          // on the property NAME alone and still fire correctly (the
          // immutable-property case this propagation cares about), while
          // conditional rules see no phantom delta and don't over-promote.
          // A type the registry does not classify falls back to the CFn
          // schema's createOnly paths (go-to-k/cdkd#3803), write-only ones
          // included when the property is a plain reference to the replaced
          // resource (go-to-k/cdkd#4701).
          //
          // A resource AWS stores inside the replaced one (a permission on
          // a function, go-to-k/cdkd#4411) goes with it, so it is replaced
          // too whatever the schema answers, and its own readers (a
          // permission on an alias of the function) are promoted in turn.
          requiresReplacement:
            this.syntheticRequiresReplacement(
              change.resourceType,
              propKey,
              syntheticCreateOnlyPaths,
              isPlainReferenceTo(
                desiredTemplate.Resources[dependentId]?.Properties?.[propKey],
                replacedId,
                desiredTemplate.Resources[replacedId]?.Type
              ),
              siblingsOf(change)
            ) ||
            namesRecreatedParent(
              change.resourceType,
              propKey,
              changes.get(replacedId)?.resourceType
            ),
        });
      }
      if (syntheticChanges.length === 0) continue;

      if (change.changeType === 'NO_CHANGE') {
        change.changeType = 'UPDATE';
        change.propertyChanges = syntheticChanges;
        this.logger.debug(
          `UPDATE (promoted): ${dependentId} references replaced resource ${replacedId} via ${[...refPropKeys].join(', ')}`
        );
      } else {
        change.propertyChanges = [...(change.propertyChanges ?? []), ...syntheticChanges];
        this.logger.debug(
          `UPDATE (augmented): ${dependentId} references replaced resource ${replacedId} via ${[...refPropKeys].join(', ')}`
        );
      }

      if (
        !enqueued.has(dependentId) &&
        change.propertyChanges.some((pc) => pc.requiresReplacement)
      ) {
        enqueued.add(dependentId);
        queue.push(dependentId);
      }
    }
  }
}
