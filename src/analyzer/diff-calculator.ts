import type { CloudFormationTemplate } from '../types/resource.js';
import type { StackState, ChangeType, ResourceChange, PropertyChange } from '../types/state.js';
import { getLogger } from '../utils/logger.js';
import { ReplacementRulesRegistry } from './replacement-rules.js';

/**
 * Diff calculator for comparing desired state (template) with current state
 */
export class DiffCalculator {
  private logger = getLogger().child('DiffCalculator');
  private replacementRules = new ReplacementRulesRegistry();

  /**
   * Calculate changes needed to reach desired state
   *
   * @param currentState Current stack state (use existing state or create a new StackState with empty resources for new stacks)
   * @param desiredTemplate Desired CloudFormation template
   * @returns Map of logical ID to resource change
   */
  calculateDiff(
    currentState: StackState,
    desiredTemplate: CloudFormationTemplate
  ): Map<string, ResourceChange> {
    const changes = new Map<string, ResourceChange>();

    const currentResources = currentState.resources;
    const desiredResources = desiredTemplate.Resources;

    this.logger.debug('Calculating diff...');
    this.logger.debug(`Current resources: ${Object.keys(currentResources).length}`);
    this.logger.debug(`Desired resources: ${Object.keys(desiredResources).length}`);

    // Track which resources we've seen
    const processedLogicalIds = new Set<string>();

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
        // Resource exists with same type -> check properties
        const propertyChanges = this.compareProperties(
          desiredResource.Type,
          currentResource.properties,
          desiredResource.Properties || {}
        );

        if (propertyChanges.length > 0) {
          // Properties changed -> UPDATE
          changes.set(logicalId, {
            logicalId,
            changeType: 'UPDATE',
            resourceType: desiredResource.Type,
            currentProperties: currentResource.properties,
            desiredProperties: desiredResource.Properties || {},
            propertyChanges,
          });
          this.logger.debug(`UPDATE: ${logicalId} (${propertyChanges.length} property changes)`);
        } else {
          // No changes -> NO_CHANGE
          changes.set(logicalId, {
            logicalId,
            changeType: 'NO_CHANGE',
            resourceType: desiredResource.Type,
            currentProperties: currentResource.properties,
            desiredProperties: desiredResource.Properties || {},
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

    const summary = this.getSummary(changes);
    this.logger.info(
      `Diff calculated: ${summary.create} CREATE, ${summary.update} UPDATE, ${summary.delete} DELETE, ${summary.noChange} NO_CHANGE`
    );

    return changes;
  }

  /**
   * Compare properties and return list of changes
   *
   * Uses ReplacementRulesRegistry to determine which property changes require replacement.
   * Reference: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-update-behaviors.html
   */
  private compareProperties(
    resourceType: string,
    currentProperties: Record<string, unknown>,
    desiredProperties: Record<string, unknown>
  ): PropertyChange[] {
    const changes: PropertyChange[] = [];

    // Get all property keys
    const allKeys = new Set([...Object.keys(currentProperties), ...Object.keys(desiredProperties)]);

    for (const key of allKeys) {
      const oldValue = currentProperties[key];
      const newValue = desiredProperties[key];

      if (!this.valuesEqual(oldValue, newValue)) {
        // Check if this property change requires replacement
        const requiresReplacement = this.replacementRules.requiresReplacement(
          resourceType,
          key,
          oldValue,
          newValue
        );

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

  /**
   * Deep equality check for values
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

    // Array check
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) {
        return false;
      }
      return a.every((val, index) => this.valuesEqual(val, b[index]));
    }

    // Object check
    if (typeof a === 'object' && typeof b === 'object') {
      const aObj = a as Record<string, unknown>;
      const bObj = b as Record<string, unknown>;

      const aKeys = Object.keys(aObj);
      const bKeys = Object.keys(bObj);

      if (aKeys.length !== bKeys.length) {
        return false;
      }

      return aKeys.every((key) => this.valuesEqual(aObj[key], bObj[key]));
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
