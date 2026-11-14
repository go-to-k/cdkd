import type { CloudFormationTemplate, TemplateResource } from '../types/resource.js';
import type {
  StackState,
  ChangeType,
  ResourceChange,
  PropertyChange,
  AttributeChange,
  ResourceState,
} from '../types/state.js';
import { getLogger, type ConsoleLogger } from '../utils/logger.js';
import { ReplacementRulesRegistry, type ReplacementSiblings } from './replacement-rules.js';
import { TemplateParser } from './template-parser.js';
import type { MaskedInputSources } from '../deployment/masked-property-fingerprints.js';
import type { MaskerFn } from '../provisioning/masked-retry-logger.js';
import type { LockRecoveryContext } from '../state/lock-contention-message.js';
import type { ReadProvenanceSources } from './read-provenance-promotion.js';
import { calculateDiff } from './diff-calculator/calculate-diff.js';
import {
  promoteReadProvenanceDependents,
  loadSyntheticCreateOnlyPaths,
  syntheticRequiresReplacement,
  promoteReplacementDependents,
} from './diff-calculator/promotion.js';
import {
  promoteInPlaceAttributeDependents,
  extractGetAttRefs,
} from './diff-calculator/in-place-promotion.js';
import {
  resolveBestEffort,
  compareAttributes,
  compareProperties,
  maskedEditRequiresReplacement,
  isIntrinsic,
  valuesEqual,
} from './diff-calculator/compare.js';
import {
  type SyntheticCreateOnly,
  type IntrinsicResolveFn,
  INTRINSIC_KEYS,
  type CanonicalizePropertiesFn,
  type NoEchoCompareFn,
} from './diff-calculator/shared.js';

export {
  INTRINSIC_KEYS,
  siblingsOf,
  type CanonicalizePropertiesFn,
  type IntrinsicResolveFn,
  type NoEchoCompareFn,
} from './diff-calculator/shared.js';

/**
 * Diff calculator for comparing desired state (template) with current state
 */
export class DiffCalculator {
  logger: ConsoleLogger = getLogger().child('DiffCalculator');
  replacementRules = new ReplacementRulesRegistry();
  parser = new TemplateParser();

  /**
   * {@link ReplacementRulesRegistry.conditionalReplacementVerdict}, for the
   * deploy engine's replacement-ceiling lowering (issue #4134).
   */
  conditionalReplacementVerdict(
    resourceType: string,
    propertyPath: string,
    oldValue: unknown,
    newValue: unknown,
    siblings?: ReplacementSiblings
  ): boolean | undefined {
    return this.replacementRules.conditionalReplacementVerdict(
      resourceType,
      propertyPath,
      oldValue,
      newValue,
      siblings
    );
  }

  calculateDiff(
    currentState: StackState,
    desiredTemplate: CloudFormationTemplate,
    resolveFn?: IntrinsicResolveFn,
    canonicalizeProperties?: CanonicalizePropertiesFn,
    allowedUnsupportedProperties?: ReadonlySet<string>,
    freshParameters?: ReadonlySet<string>,
    maskForLog?: MaskerFn,
    recreateTargets?: ReadonlySet<string>,
    maskedInputs?: {
      sources: MaskedInputSources;
      rebaselined?: Map<string, Record<string, string>>;
    },
    refusalRecovery?: LockRecoveryContext,
    noEchoCompare?: NoEchoCompareFn,
    readProvenance?: ReadProvenanceSources,
    forcedNestedChildRuns?: ReadonlySet<string>
  ): Promise<Map<string, ResourceChange>> {
    return calculateDiff.call(
      this,
      currentState,
      desiredTemplate,
      resolveFn,
      canonicalizeProperties,
      allowedUnsupportedProperties,
      freshParameters,
      maskForLog,
      recreateTargets,
      maskedInputs,
      refusalRecovery,
      noEchoCompare,
      readProvenance,
      forcedNestedChildRuns
    );
  }

  promoteReadProvenanceDependents(
    changes: Map<string, ResourceChange>,
    currentState: StackState,
    desiredTemplate: CloudFormationTemplate,
    sources: ReadProvenanceSources | undefined
  ): Promise<Array<{ change: ResourceChange; pc: PropertyChange; upstreams: string[] }>> {
    return promoteReadProvenanceDependents.call(
      this,
      changes,
      currentState,
      desiredTemplate,
      sources
    );
  }

  loadSyntheticCreateOnlyPaths(
    changes: Map<string, ResourceChange>,
    desiredTemplate: CloudFormationTemplate,
    rawGetAttRefs: Map<string, Map<string, Map<string, Set<string>>>>,
    freshParameters: ReadonlySet<string> | undefined,
    forcedReplacements: ReadonlySet<string>
  ): Promise<Map<string, SyntheticCreateOnly>> {
    return loadSyntheticCreateOnlyPaths.call(
      this,
      changes,
      desiredTemplate,
      rawGetAttRefs,
      freshParameters,
      forcedReplacements
    );
  }

  syntheticRequiresReplacement(
    resourceType: string,
    propKey: string,
    syntheticCreateOnlyPaths: ReadonlyMap<string, SyntheticCreateOnly>,
    plainReference: boolean,
    siblings?: ReplacementSiblings
  ): boolean {
    return syntheticRequiresReplacement.call(
      this,
      resourceType,
      propKey,
      syntheticCreateOnlyPaths,
      plainReference,
      siblings
    );
  }

  promoteReplacementDependents(
    changes: Map<string, ResourceChange>,
    desiredTemplate: CloudFormationTemplate,
    syntheticCreateOnlyPaths: ReadonlyMap<string, SyntheticCreateOnly>,
    forcedReplacements: ReadonlySet<string>
  ): void {
    return promoteReplacementDependents.call(
      this,
      changes,
      desiredTemplate,
      syntheticCreateOnlyPaths,
      forcedReplacements
    );
  }

  promoteInPlaceAttributeDependents(
    changes: Map<string, ResourceChange>,
    desiredTemplate: CloudFormationTemplate,
    rawGetAttRefs: Map<string, Map<string, Map<string, Set<string>>>>,
    syntheticCreateOnlyPaths: ReadonlyMap<string, SyntheticCreateOnly>,
    freshParameters?: ReadonlySet<string>
  ): boolean {
    return promoteInPlaceAttributeDependents.call(
      this,
      changes,
      desiredTemplate,
      rawGetAttRefs,
      syntheticCreateOnlyPaths,
      freshParameters
    );
  }

  static extractGetAttRefs(value: unknown): Map<string, Set<string>> {
    return extractGetAttRefs(value);
  }

  resolveBestEffort(
    properties: Record<string, unknown>,
    resolveFn: IntrinsicResolveFn
  ): Promise<Record<string, unknown>> {
    return resolveBestEffort.call(this, properties, resolveFn);
  }

  compareAttributes(
    currentResource: ResourceState,
    desiredResource: TemplateResource
  ): AttributeChange[] {
    return compareAttributes.call(this, currentResource, desiredResource);
  }

  compareProperties(
    resourceType: string,
    currentProperties: Record<string, unknown>,
    desiredProperties: Record<string, unknown>,
    maskForLog?: MaskerFn
  ): Promise<PropertyChange[]> {
    return compareProperties.call(
      this,
      resourceType,
      currentProperties,
      desiredProperties,
      maskForLog
    );
  }

  maskedEditRequiresReplacement(
    resourceType: string,
    key: string,
    oldValue: unknown,
    newValue: unknown,
    siblings: ReplacementSiblings
  ): Promise<boolean> {
    return maskedEditRequiresReplacement.call(
      this,
      resourceType,
      key,
      oldValue,
      newValue,
      siblings
    );
  }

  static readonly INTRINSIC_KEYS = INTRINSIC_KEYS;

  static isIntrinsic(value: unknown): boolean {
    return isIntrinsic(value);
  }

  valuesEqual(a: unknown, b: unknown): boolean {
    return valuesEqual.call(this, a, b);
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
