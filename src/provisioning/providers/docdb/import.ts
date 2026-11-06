import type { DocDBProvider } from '../docdb-provider.js';
import { DescribeDBClustersCommand, DescribeDBInstancesCommand } from '@aws-sdk/client-docdb';
import { resolveExplicitPhysicalId } from '../../import-helpers.js';
import type { ResourceImportInput, ResourceImportResult } from '../../../types/resource.js';
import { clusterAttributes, instanceAttributes } from './shared.js';

/**
 * Adopt an existing DocDB resource into cdkd state.
 *
 * Supported types: `AWS::DocDB::DBInstance`, `AWS::DocDB::DBCluster`.
 * Identifier name properties (`DBInstanceIdentifier` /
 * `DBClusterIdentifier`) are usually
 * present in CDK templates and are resolved via the corresponding
 * `Describe*` existence check. There is no `aws:cdk:path` tag fallback:
 * AWS rejects `aws:`-prefixed tag writes, so that tag never exists on a
 * real resource and the walk could not match (issue #1134).
 */
export async function importImpl(
  this: DocDBProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  switch (input.resourceType) {
    case 'AWS::DocDB::DBInstance':
      return this.importDBInstance(input);
    case 'AWS::DocDB::DBCluster':
      return this.importDBCluster(input);
    default:
      return null;
  }
}

export async function importDBInstance(
  this: DocDBProvider,
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
  // No `aws:cdk:path` tag walk: the tag never exists on a real resource
  // (issue #1134). A DBInstance reaching here needs an explicit `--resource`
  // override or a `DBInstanceIdentifier` in the template.
  return null;
}

export async function importDBCluster(
  this: DocDBProvider,
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
  // No `aws:cdk:path` tag walk: the tag never exists on a real resource
  // (issue #1134). A DBCluster reaching here needs an explicit `--resource`
  // override or a `DBClusterIdentifier` in the template.
  return null;
}
