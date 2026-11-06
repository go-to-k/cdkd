import type { NeptuneProvider } from '../neptune-provider.js';
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  DescribeDBSubnetGroupsCommand,
} from '@aws-sdk/client-neptune';
import { resolveExplicitPhysicalId } from '../../import-helpers.js';
import type { ResourceImportInput, ResourceImportResult } from '../../../types/resource.js';
import { clusterAttributes, instanceAttributes } from './shared.js';

/**
 * Adopt an existing Neptune resource into cdkd state.
 */
export async function importImpl(
  this: NeptuneProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  switch (input.resourceType) {
    case 'AWS::Neptune::DBInstance':
      return this.importDBInstance(input);
    case 'AWS::Neptune::DBCluster':
      return this.importDBCluster(input);
    case 'AWS::Neptune::DBSubnetGroup':
      return this.importDBSubnetGroup(input);
    default:
      return null;
  }
}

export async function importDBInstance(
  this: NeptuneProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'DBInstanceIdentifier');
  if (explicit) {
    try {
      const resp = await this.getClient().send(
        new DescribeDBInstancesCommand({ DBInstanceIdentifier: explicit })
      );
      // The map `create()` records, from the describe this verification
      // already issues (issue #1852). It is what heals a record written
      // under `--no-wait` while the instance was still `creating`
      // (go-to-k/cdkd#3077): the deploy engine re-reads through `import()`
      // when a `Fn::GetAtt` misses. `definedAttributes` keeps an unassigned
      // endpoint ABSENT, so a still-`creating` instance heals nothing.
      const described = resp.DBInstances?.[0];
      return {
        physicalId: explicit,
        attributes: instanceAttributes(described),
      };
    } catch (err) {
      if ((err as { name?: string }).name === 'DBInstanceNotFoundFault') return null;
      throw err;
    }
  }
  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // `DescribeStackResources` or the template's physical-name property; a
  // DB instance reaching here needs an explicit `--resource` override.
  return null;
}

export async function importDBCluster(
  this: NeptuneProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'DBClusterIdentifier');
  if (explicit) {
    try {
      const resp = await this.getClient().send(
        new DescribeDBClustersCommand({ DBClusterIdentifier: explicit })
      );
      // Issue #3627: the same map `create()` records.
      return { physicalId: explicit, attributes: clusterAttributes(resp.DBClusters?.[0]) };
    } catch (err) {
      if ((err as { name?: string }).name === 'DBClusterNotFoundFault') return null;
      throw err;
    }
  }
  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // `DescribeStackResources` or the template's physical-name property; a
  // DB cluster reaching here needs an explicit `--resource` override.
  return null;
}

export async function importDBSubnetGroup(
  this: NeptuneProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'DBSubnetGroupName');
  if (explicit) {
    try {
      await this.getClient().send(
        new DescribeDBSubnetGroupsCommand({ DBSubnetGroupName: explicit })
      );
      return { physicalId: explicit, attributes: {} };
    } catch (err) {
      if ((err as { name?: string }).name === 'DBSubnetGroupNotFoundFault') return null;
      throw err;
    }
  }
  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // `DescribeStackResources` or the template's physical-name property; a
  // DB subnet group reaching here needs an explicit `--resource` override.
  return null;
}
