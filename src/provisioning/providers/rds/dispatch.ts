import { ProvisioningError } from '../../../utils/error-handler.js';
import { type DeleteContext } from '../../region-check.js';
import type {
  CreateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
} from '../../../types/resource.js';
import { withRemovalDefaults } from '../../update-removal.js';
import type { RDSProvider } from '../rds-provider.js';

// ─── Dispatch ─────────────────────────────────────────────────────

export async function create(
  this: RDSProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  const mask = context?.maskSecrets;
  switch (resourceType) {
    case 'AWS::RDS::DBSubnetGroup':
      return this.createDBSubnetGroup(logicalId, resourceType, properties, mask);
    case 'AWS::RDS::DBCluster':
      return this.createDBCluster(
        logicalId,
        resourceType,
        properties,
        mask,
        context?.replayingState === true
      );
    case 'AWS::RDS::DBInstance':
      return this.createDBInstance(
        logicalId,
        resourceType,
        properties,
        mask,
        context?.replayingState === true
      );
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId
      );
  }
}

export async function update(
  this: RDSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  properties = withRemovalDefaults(
    this.removalDefaults,
    resourceType,
    properties,
    previousProperties,
    context
  );
  switch (resourceType) {
    case 'AWS::RDS::DBSubnetGroup':
      return this.updateDBSubnetGroup(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context?.maskSecrets
      );
    case 'AWS::RDS::DBCluster':
      return this.updateDBCluster(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    case 'AWS::RDS::DBInstance':
      return this.updateDBInstance(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        context
      );
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
  }
}

export async function deleteImpl(
  this: RDSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  switch (resourceType) {
    case 'AWS::RDS::DBSubnetGroup':
      return this.deleteDBSubnetGroup(logicalId, physicalId, resourceType, context);
    case 'AWS::RDS::DBCluster':
      return this.deleteDBCluster(logicalId, physicalId, resourceType, properties, context);
    case 'AWS::RDS::DBInstance':
      return this.deleteDBInstance(logicalId, physicalId, resourceType, properties, context);
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
  }
}

/**
 * Adopt an existing RDS resource into cdkd state.
 *
 * Supported types: `AWS::RDS::DBInstance`, `AWS::RDS::DBCluster`,
 * `AWS::RDS::DBSubnetGroup`. Resolution is by identifier name property
 * (`DBInstanceIdentifier` / `DBClusterIdentifier` / `DBSubnetGroupName`),
 * which is usually present in CDK templates, verified against the
 * corresponding `Describe*` call. A resource without one needs an
 * explicit `--resource` override (issue #1134).
 */
export async function importImpl(
  this: RDSProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  switch (input.resourceType) {
    case 'AWS::RDS::DBInstance':
      return this.importDBInstance(input);
    case 'AWS::RDS::DBCluster':
      return this.importDBCluster(input);
    case 'AWS::RDS::DBSubnetGroup':
      return this.importDBSubnetGroup(input);
    default:
      return null;
  }
}
