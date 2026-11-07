/**
 * Replacement rules for AWS resource types
 *
 * Defines which property changes require resource replacement (delete + recreate)
 * vs. in-place updates.
 *
 * Based on CloudFormation update behaviors:
 * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-update-behaviors.html
 */

import { getLogger, type ConsoleLogger } from '../utils/logger.js';
import type { ReplacementRule, ReplacementSiblings } from './replacement-rules/types.js';
import { initializeRules } from './replacement-rules/rules.js';

export type { ReplacementSiblings } from './replacement-rules/types.js';
export {
  vpcInstanceTenancyChangeReplaces,
  instanceSecurityGroupIdsChangeReplaces,
  instanceTenancyChangeReplaces,
  instancePrivateDnsNameOptionsChangeReplaces,
  instanceBlockDeviceMappingsChangeReplaces,
  blockDeviceMappingsDifferOnlyInDeleteOnTermination,
  durableConfigPresenceToggled,
  eventInvokeConfigFunctionChanged,
  attributeTypeChangedForSharedAttribute,
  globalTableLocalSecondaryIndexesRemoved,
  budgetNameChanged,
  iamRolePathChanged,
  glueTableNameChanged,
  natZoneAddressesAddedToAutomaticGateway,
  ecsServiceLaunchTypeSetOrChanged,
  elastiCachePreferredAvailabilityZonesMovedToDisjoint,
  elastiCacheAzModeRemovedFromSingleAz,
  elastiCachePreferredAvailabilityZonesRemovedFromSingleAz,
  emrClusterInstancesReplaced,
  dbClusterEngineChangeReplaces,
  dbInstanceEngineChangeIsInPlace,
  dbInstanceEngineChangeReplaces,
} from './replacement-rules/predicates.js';

/**
 * Replacement rules registry
 *
 * Maps resource types to their replacement rules
 */
export class ReplacementRulesRegistry {
  logger: ConsoleLogger = getLogger().child('ReplacementRulesRegistry');
  rules = new Map<string, ReplacementRule>();

  constructor() {
    this.initializeRules();
  }

  /**
   * Check if a property change requires replacement
   */
  requiresReplacement(
    resourceType: string,
    propertyPath: string,
    oldValue: unknown,
    newValue: unknown,
    siblings?: ReplacementSiblings
  ): boolean {
    const rule = this.rules.get(resourceType);

    if (!rule) {
      // No specific rule for this resource type
      // Conservative approach: assume replacement may be required
      this.logger.debug(
        `No replacement rule for ${resourceType}, conservatively assuming replacement may be required for ${propertyPath}`
      );
      return false; // Default to updateable for unknown types
    }

    // Check if property always requires replacement
    if (rule.replacementProperties.has(propertyPath)) {
      this.logger.debug(`Property ${propertyPath} of ${resourceType} requires replacement`);
      return true;
    }

    // Check if property is explicitly updateable
    if (rule.updateableProperties?.has(propertyPath)) {
      return false;
    }

    // Check conditional replacements
    if (rule.conditionalReplacements?.has(propertyPath)) {
      const condition = rule.conditionalReplacements.get(propertyPath);
      if (condition) {
        const requires = condition(oldValue, newValue, siblings);
        this.logger.debug(
          `Conditional replacement for ${propertyPath} of ${resourceType}: ${requires}`
        );
        return requires;
      }
    }

    // If not explicitly defined, assume it's updateable
    return false;
  }

  /**
   * The type's `conditionalReplacements` predicate for `propertyPath`, applied
   * to two concrete values, or `undefined` when the property has none (issue
   * [#4134](https://github.com/go-to-k/cdkd/issues/4134)). Deliberately not
   * {@link requiresReplacement}: that one answers `false` for an unclassified
   * property, which a caller outside the diff cannot tell from "in place".
   */
  conditionalReplacementVerdict(
    resourceType: string,
    propertyPath: string,
    oldValue: unknown,
    newValue: unknown,
    siblings?: ReplacementSiblings
  ): boolean | undefined {
    const condition = this.rules.get(resourceType)?.conditionalReplacements?.get(propertyPath);
    return condition === undefined ? undefined : condition(oldValue, newValue, siblings);
  }

  /**
   * Whether the registry has an EXPLICIT opinion about a property's
   * replacement behavior — i.e. the type has a rule AND the property is listed
   * in its `replacementProperties`, `updateableProperties`, OR
   * `conditionalReplacements`. Returns false for an unknown type, or for a
   * known type whose rule does not mention the property (the "default to
   * updateable" fall-through inside {@link requiresReplacement}).
   *
   * The diff calculator uses this to decide whether the CFn-schema
   * `createOnlyProperties` fallback may apply: the schema only fills the GAP
   * where the registry has no opinion, so a deliberate `updateableProperties`
   * (or conditional) classification is never overridden by the fallback.
   */
  isClassified(resourceType: string, propertyPath: string): boolean {
    const rule = this.rules.get(resourceType);
    if (!rule) return false;
    return (
      rule.replacementProperties.has(propertyPath) ||
      (rule.updateableProperties?.has(propertyPath) ?? false) ||
      (rule.conditionalReplacements?.has(propertyPath) ?? false)
    );
  }

  private initializeRules(): void {
    return initializeRules.call(this);
  }
}
