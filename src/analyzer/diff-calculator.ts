import type { CloudFormationTemplate, TemplateResource } from '../types/resource.js';
import type {
  StackState,
  ChangeType,
  ResourceChange,
  PropertyChange,
  AttributeChange,
  ResourceState,
} from '../types/state.js';
import { getLogger } from '../utils/logger.js';
import { ReplacementRulesRegistry } from './replacement-rules.js';
import { TemplateParser } from './template-parser.js';
import { getTopLevelCreateOnlyProperties } from '../provisioning/create-only-properties.js';

/**
 * Best-effort resolver for intrinsic functions during diff calculation.
 * Should return the resolved value on success, or the original value if resolution fails.
 * Kept as a callback to avoid circular dependency between analyzer and deployment layers.
 */
export type IntrinsicResolveFn = (value: unknown) => Promise<unknown>;

/**
 * Diff calculator for comparing desired state (template) with current state
 */
export class DiffCalculator {
  private logger = getLogger().child('DiffCalculator');
  private replacementRules = new ReplacementRulesRegistry();
  private parser = new TemplateParser();

  /**
   * Calculate changes needed to reach desired state
   *
   * @param currentState Current stack state (use existing state or create a new StackState with empty resources for new stacks)
   * @param desiredTemplate Desired CloudFormation template
   * @param resolveFn Optional intrinsic resolver. When provided, desired properties are
   *                  resolved against current state before comparison so that changes
   *                  buried inside intrinsics (e.g. `Fn::Join` literal args) are detected.
   *                  If resolution throws for a given property value, the unresolved
   *                  value is used (falling back to the original "assume equal" behavior).
   * @returns Map of logical ID to resource change
   */
  async calculateDiff(
    currentState: StackState,
    desiredTemplate: CloudFormationTemplate,
    resolveFn?: IntrinsicResolveFn
  ): Promise<Map<string, ResourceChange>> {
    const changes = new Map<string, ResourceChange>();

    const currentResources = currentState.resources;
    const desiredResources = desiredTemplate.Resources;

    this.logger.debug('Calculating diff...');
    this.logger.debug(`Current resources: ${Object.keys(currentResources).length}`);
    this.logger.debug(`Desired resources: ${Object.keys(desiredResources).length}`);

    // Track which resources we've seen
    const processedLogicalIds = new Set<string>();

    // Snapshot each resource's `Fn::GetAtt` / `Fn::Sub`-`${X.Attr}` references
    // from the RAW template, BEFORE the comparison loop below resolves (and
    // mutates in place) the desired property intrinsics. Used by
    // promoteInPlaceAttributeDependents — once `resolveBestEffort` runs, a
    // GetAtt to an in-place-referenceable resource has been replaced by its
    // resolved current value and can no longer be detected.
    const rawGetAttRefs = new Map<string, Map<string, Map<string, Set<string>>>>();
    for (const [logicalId, desiredResource] of Object.entries(desiredResources)) {
      if (desiredResource.Type === 'AWS::CDK::Metadata') continue;
      const perProp = new Map<string, Map<string, Set<string>>>();
      for (const [propKey, propValue] of Object.entries(desiredResource.Properties ?? {})) {
        const refs = DiffCalculator.extractGetAttRefs(propValue);
        if (refs.size > 0) perProp.set(propKey, refs);
      }
      if (perProp.size > 0) rawGetAttRefs.set(logicalId, perProp);
    }

    // Check for CREATE and UPDATE
    for (const [logicalId, desiredResource] of Object.entries(desiredResources)) {
      // Skip CDK metadata resources (they don't actually deploy anything)
      if (desiredResource.Type === 'AWS::CDK::Metadata') {
        this.logger.debug(`Skipping metadata resource: ${logicalId}`);
        processedLogicalIds.add(logicalId);
        continue;
      }

      processedLogicalIds.add(logicalId);

      const currentResource = currentResources[logicalId];

      if (!currentResource) {
        // Resource doesn't exist in current state -> CREATE
        changes.set(logicalId, {
          logicalId,
          changeType: 'CREATE',
          resourceType: desiredResource.Type,
          desiredProperties: desiredResource.Properties || {},
        });
        this.logger.debug(`CREATE: ${logicalId} (${desiredResource.Type})`);
      } else if (currentResource.resourceType !== desiredResource.Type) {
        // Resource type changed -> requires replacement (DELETE + CREATE)
        // For simplicity, we'll mark this as UPDATE with requiresReplacement
        const propertyChanges: PropertyChange[] = [
          {
            path: 'Type',
            oldValue: currentResource.resourceType,
            newValue: desiredResource.Type,
            requiresReplacement: true,
          },
        ];

        changes.set(logicalId, {
          logicalId,
          changeType: 'UPDATE',
          resourceType: desiredResource.Type,
          currentProperties: currentResource.properties,
          desiredProperties: desiredResource.Properties || {},
          propertyChanges,
        });
        this.logger.debug(
          `UPDATE (Type change): ${logicalId} (${currentResource.resourceType} -> ${desiredResource.Type})`
        );
      } else {
        // Resource exists with same type -> check properties.
        //
        // State stores already-resolved values (e.g. "my-bucket-value"), while the
        // template holds unresolved intrinsics (e.g. { "Fn::Join": [...] }). When an
        // intrinsic wraps literal content that changed (e.g. "-value" -> "-value2"),
        // a naive comparison would short-circuit on the intrinsic node and miss the
        // change. Resolving desired props against current state first avoids that.
        const rawDesiredProps = desiredResource.Properties || {};
        const desiredPropsForCompare = resolveFn
          ? await this.resolveBestEffort(rawDesiredProps, resolveFn)
          : rawDesiredProps;

        const propertyChanges = await this.compareProperties(
          desiredResource.Type,
          currentResource.properties,
          desiredPropsForCompare
        );

        // Schema v5+ template-attribute diff: `DeletionPolicy` /
        // `UpdateReplacePolicy` may change without any property change. cdkd
        // pre-v5 silently reported `No changes detected` for those, so a
        // user who removed `RemovalPolicy.DESTROY` from their CDK code saw
        // nothing happen on the next deploy. Detect them here too so the
        // attribute flip is surfaced (and the deploy engine refreshes the
        // value in state).
        const attributeChanges = this.compareAttributes(currentResource, desiredResource);

        if (propertyChanges.length > 0 || attributeChanges.length > 0) {
          // Property and/or attribute changed -> UPDATE
          changes.set(logicalId, {
            logicalId,
            changeType: 'UPDATE',
            resourceType: desiredResource.Type,
            currentProperties: currentResource.properties,
            desiredProperties: rawDesiredProps,
            propertyChanges,
            ...(attributeChanges.length > 0 && { attributeChanges }),
          });
          this.logger.debug(
            `UPDATE: ${logicalId} (${propertyChanges.length} property changes, ${attributeChanges.length} attribute changes)`
          );
        } else {
          // No changes -> NO_CHANGE
          changes.set(logicalId, {
            logicalId,
            changeType: 'NO_CHANGE',
            resourceType: desiredResource.Type,
            currentProperties: currentResource.properties,
            desiredProperties: rawDesiredProps,
          });
          this.logger.debug(`NO_CHANGE: ${logicalId}`);
        }
      }
    }

    // Check for DELETE (resources in current state but not in desired template)
    for (const [logicalId, currentResource] of Object.entries(currentResources)) {
      if (!processedLogicalIds.has(logicalId)) {
        changes.set(logicalId, {
          logicalId,
          changeType: 'DELETE',
          resourceType: currentResource.resourceType,
          currentProperties: currentResource.properties,
        });
        this.logger.debug(`DELETE: ${logicalId} (${currentResource.resourceType})`);
      }
    }

    // Propagate replacements to dependents (issue #807): a dependent whose
    // only "change" is a Ref / Fn::GetAtt to a resource that will be
    // REPLACED resolves against CURRENT state above and lands on NO_CHANGE,
    // even though the reference's value (new physical ID / ARN) WILL change.
    this.promoteReplacementDependents(changes, desiredTemplate);

    // Propagate IN-PLACE attribute changes to dependents (bug-hunt 2026-06-29):
    // a dependent that embeds `Fn::GetAtt[Up, Attr]` (e.g. an SSM Parameter whose
    // Value is `Fn::Sub[..., {V: Fn::GetAtt[Base, Value]}]`) resolves against the
    // CURRENT state above, so when `Up`'s in-place UPDATE changes the property
    // `Attr` names, the dependent's resolved value DID change but it lands on
    // NO_CHANGE and never re-provisions -> stale. Unlike a replacement (where the
    // physical id always changes, so EVERY reference is affected), here only a
    // GetAtt whose attribute NAME matches a CHANGED property of the upstream is
    // affected -- a `Ref` (physical id, unchanged in-place) or a GetAtt of an
    // unchanged / computed attribute (e.g. a Lambda `Arn`, which does not move on
    // an in-place Description update) is correctly left NO_CHANGE.
    this.promoteInPlaceAttributeDependents(changes, desiredTemplate, rawGetAttRefs);

    const summary = this.getSummary(changes);
    this.logger.debug(
      `Diff calculated: ${summary.create} CREATE, ${summary.update} UPDATE, ${summary.delete} DELETE, ${summary.noChange} NO_CHANGE`
    );

    return changes;
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
   */
  private promoteReplacementDependents(
    changes: Map<string, ResourceChange>,
    desiredTemplate: CloudFormationTemplate
  ): void {
    // Seed queue: resources whose computed diff already requires replacement.
    const queue: string[] = [];
    for (const [logicalId, change] of changes) {
      if (
        change.changeType === 'UPDATE' &&
        change.propertyChanges?.some((pc) => pc.requiresReplacement)
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
          if (existingPaths.has(propKey)) continue; // already diffed on its own
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
            requiresReplacement: this.replacementRules.requiresReplacement(
              change.resourceType,
              propKey,
              undefined,
              undefined
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

  /**
   * Promote NO_CHANGE dependents of an IN-PLACE update whose referenced ATTRIBUTE
   * actually changed (bug-hunt 2026-06-29).
   *
   * Distinct from {@link promoteReplacementDependents}: a replacement changes the
   * physical id, so any reference is affected. An in-place update changes only
   * specific properties, so a dependent is affected ONLY when it reads (via
   * `Fn::GetAtt[Up, Attr]` or `Fn::Sub`'s `${Up.Attr}`) an attribute whose NAME
   * matches a property that changed in `Up`'s update. (`Ref` resolves to the
   * physical id, which an in-place update never moves, so Ref-only dependents are
   * left NO_CHANGE; likewise a GetAtt of a computed / unchanged attribute.)
   *
   * Promotion is safe even when speculative: the deploy engine re-resolves the
   * promoted resource against the in-flight state and skips the provider call
   * when nothing actually changed.
   *
   * Single-hop by design (unlike {@link promoteReplacementDependents}, which is
   * fully transitive via a worklist): `changedPropsByUpstream` is frozen at entry,
   * so a chain `A(in-place) -> B(reads A's changed attr) -> C(reads B's now-changed
   * attr)` promotes B but not C. Deep GetAtt-of-a-changed-attr chains are rare in
   * practice; if one ever needs full transitivity, promote to a worklist that
   * re-derives changed props as dependents are promoted.
   */
  private promoteInPlaceAttributeDependents(
    changes: Map<string, ResourceChange>,
    desiredTemplate: CloudFormationTemplate,
    rawGetAttRefs: Map<string, Map<string, Map<string, Set<string>>>>
  ): void {
    // Per upstream UPDATE: the set of top-level property names that changed.
    const changedPropsByUpstream = new Map<string, Set<string>>();
    for (const [logicalId, change] of changes) {
      if (change.changeType !== 'UPDATE') continue;
      const props = (change.propertyChanges ?? [])
        .map((pc) => pc.path)
        .filter((p): p is string => typeof p === 'string');
      if (props.length > 0) changedPropsByUpstream.set(logicalId, new Set(props));
    }
    if (changedPropsByUpstream.size === 0) return;

    for (const [dependentId, perProp] of rawGetAttRefs) {
      const resource = desiredTemplate.Resources[dependentId];
      if (!resource || resource.Type === 'AWS::CDK::Metadata') continue;
      const change = changes.get(dependentId);
      if (!change) continue;
      // CREATE resolves fresh at provision time; DELETE is going away.
      if (change.changeType !== 'NO_CHANGE' && change.changeType !== 'UPDATE') continue;

      const existingPaths = new Set((change.propertyChanges ?? []).map((pc) => pc.path));
      const syntheticChanges: PropertyChange[] = [];

      for (const [propKey, getAttRefs] of perProp) {
        if (existingPaths.has(propKey)) continue; // already diffed on its own
        // Which upstreams + attributes does this property read via GetAtt / Sub?
        let matched = false;
        for (const [upstreamId, attrs] of getAttRefs) {
          if (upstreamId === dependentId) continue; // self-reference defense
          const changedProps = changedPropsByUpstream.get(upstreamId);
          if (!changedProps) continue;
          // Affected only when the referenced attribute names a changed property.
          if ([...attrs].some((attr) => changedProps.has(attr))) {
            matched = true;
            break;
          }
        }
        if (!matched) continue;

        syntheticChanges.push({
          path: propKey,
          oldValue: change.currentProperties?.[propKey],
          newValue: change.desiredProperties?.[propKey],
          // Re-evaluate the dependent's own replacement rules: if the referencing
          // property is immutable for its type, the dependent is replaced too.
          requiresReplacement: this.replacementRules.requiresReplacement(
            change.resourceType,
            propKey,
            undefined,
            undefined
          ),
        });
      }

      if (syntheticChanges.length === 0) continue;

      if (change.changeType === 'NO_CHANGE') {
        change.changeType = 'UPDATE';
        change.propertyChanges = syntheticChanges;
        this.logger.debug(
          `UPDATE (in-place attr propagated): ${dependentId} reads a changed attribute of an updated resource`
        );
      } else {
        change.propertyChanges = [...(change.propertyChanges ?? []), ...syntheticChanges];
      }
    }
  }

  /**
   * Extract `Fn::GetAtt` / `Fn::Sub`-`${X.Attr}` references from a property value
   * as a map of `referencedLogicalId -> set of referenced attribute names`.
   * Plain `Ref` is intentionally NOT captured: it resolves to the physical id,
   * which an in-place update never changes. Recurses into arrays / objects so
   * intrinsics nested inside `Fn::Sub`'s variable map / `Fn::Join` etc. are seen.
   */
  private static extractGetAttRefs(value: unknown): Map<string, Set<string>> {
    const refs = new Map<string, Set<string>>();
    const add = (id: string, attr: string): void => {
      if (id.startsWith('AWS::')) return; // pseudo parameter
      let set = refs.get(id);
      if (!set) {
        set = new Set();
        refs.set(id, set);
      }
      set.add(attr);
    };
    const walk = (v: unknown): void => {
      if (v === null || typeof v !== 'object') return;
      if (Array.isArray(v)) {
        v.forEach(walk);
        return;
      }
      const obj = v as Record<string, unknown>;
      if ('Fn::GetAtt' in obj) {
        const ga = obj['Fn::GetAtt'];
        if (Array.isArray(ga) && typeof ga[0] === 'string' && typeof ga[1] === 'string') {
          add(ga[0], ga[1]);
        }
        return;
      }
      if ('Fn::Sub' in obj) {
        const sub = obj['Fn::Sub'];
        let body: string | undefined;
        let mapKeys: Set<string> | undefined;
        if (typeof sub === 'string') {
          body = sub;
        } else if (Array.isArray(sub) && typeof sub[0] === 'string') {
          body = sub[0];
          const vars = sub[1];
          if (vars && typeof vars === 'object' && !Array.isArray(vars)) {
            mapKeys = new Set(Object.keys(vars as Record<string, unknown>));
            Object.values(vars as Record<string, unknown>).forEach(walk);
          }
        }
        if (body !== undefined) {
          for (const m of body.matchAll(/\$\{(!)?([^}]+)\}/g)) {
            if (m[1] === '!') continue; // literal escape
            const placeholder = m[2];
            if (!placeholder) continue;
            const dot = placeholder.indexOf('.');
            if (dot < 0) continue; // `${X}` is a Ref, not a GetAtt
            const id = placeholder.slice(0, dot);
            const attr = placeholder.slice(dot + 1);
            if (!id || mapKeys?.has(id)) continue;
            add(id, attr);
          }
        }
        return;
      }
      // Ref is intentionally skipped (physical id, unchanged in-place).
      if ('Ref' in obj && Object.keys(obj).length === 1) return;
      Object.values(obj).forEach(walk);
    };
    walk(value);
    return refs;
  }

  /**
   * Best-effort resolution of template property intrinsics against current state.
   *
   * Iterates top-level properties and resolves each independently: if resolution
   * throws (e.g. Ref to a resource that isn't in state yet), the original value
   * is kept so downstream comparison falls back to the "assume intrinsic equals
   * anything" behavior for that one value instead of failing the whole diff.
   */
  private async resolveBestEffort(
    properties: Record<string, unknown>,
    resolveFn: IntrinsicResolveFn
  ): Promise<Record<string, unknown>> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      try {
        // Resolve a CLONE: the intrinsic resolver mutates its input in place
        // (e.g. it rewrites an `Fn::Sub` variable map's `Fn::GetAtt` to the
        // resolved current-state value). Mutating the shared desired template
        // here would bake the OLD value into the template, so the deploy phase's
        // later re-resolution (against the in-flight state, where an in-place-
        // updated upstream now holds its NEW value) would still see the stale
        // literal and skip a genuinely-changed dependent. Cloning keeps the raw
        // intrinsics intact for the deploy phase.
        resolved[key] = await resolveFn(structuredClone(value));
      } catch {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  /**
   * Compare CloudFormation template-level attributes (`DeletionPolicy`,
   * `UpdateReplacePolicy`) between cdkd state and the synth template.
   *
   * Schema v5+ records these in `ResourceState`; state written by an older
   * cdkd binary has the fields undefined. Treating `undefined === undefined`
   * as "no change" means the first post-upgrade deploy of an unchanged
   * template doesn't spuriously fire an attribute diff.
   */
  private compareAttributes(
    currentResource: ResourceState,
    desiredResource: TemplateResource
  ): AttributeChange[] {
    const changes: AttributeChange[] = [];
    if (currentResource.deletionPolicy !== desiredResource.DeletionPolicy) {
      changes.push({
        attribute: 'DeletionPolicy',
        oldValue: currentResource.deletionPolicy,
        newValue: desiredResource.DeletionPolicy,
      });
    }
    if (currentResource.updateReplacePolicy !== desiredResource.UpdateReplacePolicy) {
      changes.push({
        attribute: 'UpdateReplacePolicy',
        oldValue: currentResource.updateReplacePolicy,
        newValue: desiredResource.UpdateReplacePolicy,
      });
    }
    return changes;
  }

  /**
   * Compare properties and return list of changes
   *
   * Uses ReplacementRulesRegistry to determine which property changes require replacement.
   * Reference: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-update-behaviors.html
   */
  private async compareProperties(
    resourceType: string,
    currentProperties: Record<string, unknown>,
    desiredProperties: Record<string, unknown>
  ): Promise<PropertyChange[]> {
    const changes: PropertyChange[] = [];

    // Get all property keys
    const allKeys = new Set([...Object.keys(currentProperties), ...Object.keys(desiredProperties)]);

    // Properties to ignore in diff (non-deterministic, changes on every synth)
    const ignoredProperties = new Set<string>();
    if (
      resourceType === 'AWS::CloudFormation::CustomResource' ||
      resourceType.startsWith('Custom::')
    ) {
      ignoredProperties.add('Timestamp');
    }

    // CFn-schema `createOnlyProperties` fallback for replacement detection.
    // The hand-authored `ReplacementRulesRegistry` only covers ~25 types, so an
    // immutable-property change on any OTHER type was previously mis-classified
    // as an in-place UPDATE. We consult the type's CFn registry schema (via
    // DescribeType, cached + graceful-degradation) for any changed property the
    // registry does not explicitly classify, so a createOnly change drives a
    // replacement regardless of whether the type has a hand-written rule.
    // Resolved lazily — only when a changed, registry-unclassified property is
    // actually found — so a no-change / fully-classified diff makes no AWS call.
    let createOnlyProps: ReadonlySet<string> | undefined;

    for (const key of allKeys) {
      if (ignoredProperties.has(key)) continue;

      const oldValue = currentProperties[key];
      const newValue = desiredProperties[key];

      if (!this.valuesEqual(oldValue, newValue)) {
        // Check if this property change requires replacement
        let requiresReplacement = this.replacementRules.requiresReplacement(
          resourceType,
          key,
          oldValue,
          newValue
        );

        // Schema fallback: only where the registry has NO explicit opinion (so
        // a deliberate `updateableProperties` / conditional classification is
        // never overridden). A createOnly property change IS a replacement.
        if (!requiresReplacement && !this.replacementRules.isClassified(resourceType, key)) {
          if (createOnlyProps === undefined) {
            createOnlyProps = await getTopLevelCreateOnlyProperties(resourceType);
          }
          if (createOnlyProps.has(key)) {
            requiresReplacement = true;
            this.logger.debug(
              `Property ${key} of ${resourceType} is createOnly per the CFn schema — requires replacement`
            );
          }
        }

        changes.push({
          path: key,
          oldValue,
          newValue,
          requiresReplacement,
        });

        if (requiresReplacement) {
          this.logger.debug(
            `Property ${key} of ${resourceType} requires replacement (${JSON.stringify(oldValue)} -> ${JSON.stringify(newValue)})`
          );
        }
      }
    }

    return changes;
  }

  private static readonly INTRINSIC_KEYS = new Set([
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
   * Check if a value is itself a CloudFormation intrinsic function.
   * e.g. { "Ref": "MyResource" } or { "Fn::GetAtt": ["Res", "Arn"] }
   * Does NOT match objects that merely contain intrinsics as nested children.
   */
  private static isIntrinsic(value: unknown): boolean {
    if (
      value === null ||
      value === undefined ||
      typeof value !== 'object' ||
      Array.isArray(value)
    ) {
      return false;
    }
    const keys = Object.keys(value as Record<string, unknown>);
    return keys.length === 1 && DiffCalculator.INTRINSIC_KEYS.has(keys[0]!);
  }

  /**
   * Deep equality check for values
   *
   * State stores resolved values (`"arn:aws:s3:::my-bucket"`); the synth
   * template holds unresolved intrinsics (`{ "Fn::GetAtt": ["MyBucket", "Arn"] }`).
   * Before reaching this comparator, `resolveBestEffort` already tried to
   * resolve the template side against current state, so a remaining raw
   * intrinsic typically means the resolver couldn't resolve it — most
   * commonly because the intrinsic references a resource NOT YET in state
   * (e.g., a newly-introduced resource the next deploy will CREATE).
   *
   * Two cases when an intrinsic still reaches here:
   *
   * 1. Both sides intrinsic: state was written by an older cdkd that didn't
   *    fully resolve at deploy time. Structural compare suffices —
   *    `Fn::GetAtt: [X, Arn]` matches `Fn::GetAtt: [X, Arn]` byte-for-byte.
   *
   * 2. One side intrinsic, other side concrete: the unresolvable intrinsic
   *    points at something different from what's currently in state. Treat
   *    as NOT equal so the resource is classified as UPDATE.
   *
   * Pre-fix this branch returned `true` (equal) for case 2, which silently
   * dropped real diffs — e.g., when an IAM Policy's `Resource: Fn::GetAtt:
   * [Bucket, Arn]` is rebound to a renamed bucket (logical ID changed
   * because the construct path moved), the resolver couldn't find the new
   * bucket in state and the policy stayed at the old bucket's ARN after
   * deploy. The next CR invocation against the new bucket then failed with
   * AccessDenied because the IAM Policy was never UPDATED.
   */
  private valuesEqual(a: unknown, b: unknown): boolean {
    // Strict equality check
    if (a === b) {
      return true;
    }

    // Null/undefined check
    if (a == null || b == null) {
      return a === b;
    }

    const aIntrinsic = DiffCalculator.isIntrinsic(a);
    const bIntrinsic = DiffCalculator.isIntrinsic(b);
    if (aIntrinsic !== bIntrinsic) {
      // One side intrinsic, other side concrete: changed.
      return false;
    }
    // Both intrinsics OR both concrete: fall through to the standard
    // array / object / primitive compare. For two intrinsics the
    // object-compare path below walks the single intrinsic key and
    // recursively compares its value (arrays positionally; nested
    // objects by key membership, key-order-insensitive — which matters
    // for `Fn::Sub`'s 2-arg form `[template, {VarA, VarB}]` where the
    // variable map's key order can differ between a synth-fresh object
    // literal and a `JSON.parse`'d state record).

    // Array check
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) {
        return false;
      }
      return a.every((val, index) => this.valuesEqual(val, b[index]));
    }

    // Object check — recurse into each key so intrinsics are detected per-value
    if (typeof a === 'object' && typeof b === 'object') {
      const aObj = a as Record<string, unknown>;
      const bObj = b as Record<string, unknown>;

      const aKeys = Object.keys(aObj);
      const bKeys = Object.keys(bObj);

      // SYMMETRIC compare: a key present only in the OLD (state) side is a
      // genuine REMOVAL and must be detected — e.g. a Lambda env var dropped from
      // `Environment.Variables`, which AWS replaces wholesale (the dropped key
      // must reach AWS). The prior asymmetric compare (only walking the new-side
      // keys) silently swallowed nested-map-key removals: top-level property
      // removal + array-element removal were already caught (by the caller's
      // key-union + array-length check), but a key removed from a NESTED object
      // (Environment.Variables, Tags maps, etc.) compared equal and never
      // re-provisioned. cdkd stores the resolved TEMPLATE properties in
      // `state.properties` (AWS-observed defaults live in `observedProperties`),
      // so the old-side keys here are template-derived too — a length mismatch is
      // a real add or remove, not an AWS-added default.
      if (aKeys.length !== bKeys.length) {
        return false; // key added OR removed
      }
      for (const key of bKeys) {
        if (!(key in aObj)) {
          return false; // New key added in template
        }
        if (!this.valuesEqual(aObj[key], bObj[key])) {
          return false;
        }
      }
      return true;
    }

    // Primitive types
    return false;
  }

  /**
   * Get summary of changes
   */
  getSummary(changes: Map<string, ResourceChange>): {
    create: number;
    update: number;
    delete: number;
    noChange: number;
    total: number;
  } {
    const summary = {
      create: 0,
      update: 0,
      delete: 0,
      noChange: 0,
      total: changes.size,
    };

    for (const change of changes.values()) {
      switch (change.changeType) {
        case 'CREATE':
          summary.create++;
          break;
        case 'UPDATE':
          summary.update++;
          break;
        case 'DELETE':
          summary.delete++;
          break;
        case 'NO_CHANGE':
          summary.noChange++;
          break;
      }
    }

    return summary;
  }

  /**
   * Filter changes by type
   */
  filterByType(changes: Map<string, ResourceChange>, type: ChangeType): ResourceChange[] {
    return Array.from(changes.values()).filter((change) => change.changeType === type);
  }

  /**
   * Check if there are any changes
   */
  hasChanges(changes: Map<string, ResourceChange>): boolean {
    return Array.from(changes.values()).some((change) => change.changeType !== 'NO_CHANGE');
  }

  /**
   * Get changes that require replacement
   */
  getReplacementChanges(changes: Map<string, ResourceChange>): ResourceChange[] {
    return Array.from(changes.values()).filter(
      (change) =>
        change.changeType === 'UPDATE' &&
        change.propertyChanges?.some((pc) => pc.requiresReplacement)
    );
  }
}
