import type { ECSProvider } from '../ecs-provider.js';
import {
  DescribeClustersCommand,
  DescribeTaskDefinitionCommand,
  type DescribeClustersCommandOutput,
  type DescribeTaskDefinitionCommandOutput,
} from '@aws-sdk/client-ecs';
import { verbosePointerTail } from '../../../utils/aws-failure-text.js';
import { generatedNameFor } from '../../resource-name.js';
import { chunks, withApiLimit } from '../../name-lookup.js';
import { resolveExplicitPhysicalId } from '../../import-helpers.js';
import type { ResourceImportInput, ResourceImportResult } from '../../../types/resource.js';
import { displaySafe } from '../../../utils/display-safe.js';
import { isDeregisteredTaskDefinitionStatus } from './shared.js';

/**
 * Adopt an existing ECS resource into cdkd state.
 *
 * Supported types: `AWS::ECS::Cluster`, `AWS::ECS::Service`,
 * `AWS::ECS::TaskDefinition` — all explicit-override only (see the
 * per-branch notes on why the `aws:cdk:path` tag walk was removed).
 *
 * `createService` stores the service ARN as the Service physical id (and
 * the mutation ops pass it straight through as the `service` argument, with
 * the cluster read from the template `Cluster` property). The explicit
 * `--resource` override is honored verbatim, so a caller may also supply the
 * composite `<clusterArn>|<serviceName>` form that `readCurrentState` accepts.
 */
/**
 * go-to-k/cdkd#4705: the name a cluster's `create()` sends when the
 * template names none (clusters only: the one name-adopting ECS type).
 */
export function generatedCreateName(
  this: ECSProvider,
  resourceType: string,
  logicalId: string,
  properties: Record<string, unknown>
): string | undefined {
  if (resourceType !== 'AWS::ECS::Cluster' || properties['ClusterName']) return undefined;
  return generatedNameFor('AWS::ECS::Cluster', logicalId);
}

/**
 * go-to-k/cdkd#4705: `DescribeClusters`, exact names, 100 per call, the
 * chunks in parallel through one run-wide limiter. As `importCluster`
 * reads it: an `INACTIVE` (deleted) cluster frees its name, a `MISSING`
 * failure is absent, and any other failure did not answer (throws).
 */
export async function lookupNames(
  this: ECSProvider,
  resourceType: string,
  names: readonly string[]
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  if (resourceType !== 'AWS::ECS::Cluster') return found;
  const wanted = new Set(names);
  await Promise.all(
    chunks(names, 100).map((chunk) =>
      withApiLimit('ecs:DescribeClusters', 5, async () => {
        const resp = await this.getClient().send(new DescribeClustersCommand({ clusters: chunk }));
        const unanswered = (resp.failures ?? []).find((f) => f.reason !== 'MISSING');
        if (unanswered !== undefined) {
          throw new Error(
            `DescribeClusters did not answer: ${displaySafe(unanswered.reason ?? 'no reason given')}`
          );
        }
        for (const cluster of resp.clusters ?? []) {
          const name = cluster.clusterName;
          if (name !== undefined && wanted.has(name) && cluster.status !== 'INACTIVE') {
            found.set(name, name);
          }
        }
      })
    )
  );
  return found;
}

export async function importImpl(
  this: ECSProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  switch (input.resourceType) {
    case 'AWS::ECS::Cluster':
      return this.importCluster(input);
    case 'AWS::ECS::Service':
      return this.importService(input);
    case 'AWS::ECS::TaskDefinition':
      return this.importTaskDefinition(input);
    default:
      return null;
  }
}

export async function importCluster(
  this: ECSProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'ClusterName');
  if (explicit) {
    let resp: DescribeClustersCommandOutput;
    try {
      resp = await this.getClient().send(new DescribeClustersCommand({ clusters: [explicit] }));
    } catch (err) {
      if (this.isClusterNotFoundException(err) || this.isServiceNotFoundException(err)) {
        return null;
      }
      throw err;
    }
    // Read OUTSIDE the `try`: its not-found arm matches message substrings,
    // so an error this code throws from the answer must never reach it.
    //
    // `DescribeClusters` keeps listing a DELETED cluster, as `INACTIVE`,
    // for a while after its delete, and its name is free to create again,
    // so that one is absent — for every caller: `cdkd import` (an explicit
    // `--resource` included) and orphan adoption no longer adopt a dead
    // cluster, and the stale-attribute heal reads it as not found. Any
    // other status (ACTIVE, PROVISIONING, an unknown one) holds the name:
    // the replacement name probe reads a found cluster as its holder
    // (go-to-k/cdkd#3937), and refusing is the safe direction there.
    const cluster = resp.clusters?.[0];
    if (cluster?.clusterName) {
      return cluster.status !== 'INACTIVE'
        ? { physicalId: cluster.clusterName, attributes: {} }
        : null;
    }
    // No cluster listed: only a `MISSING` failure says the name is free.
    // Any other reason is a lookup that did not answer, and reading it as
    // free would let the probe hand the name to a create that adopts.
    const unanswered = (resp.failures ?? []).find((f) => f.reason !== 'MISSING');
    if (unanswered !== undefined) {
      // `reason` is ECS's short failure code; `detail` is AWS's free text,
      // which reaches a persisted deploy failure through the replacement
      // name probe, so it goes to `debug` and the message points at
      // `--verbose` instead (go-to-k/cdkd#2319).
      if (unanswered.detail !== undefined) {
        this.logger.debug(
          `DescribeClusters failure detail for cluster ${displaySafe(explicit)}: ${displaySafe(unanswered.detail)}`
        );
      }
      throw new Error(
        `DescribeClusters did not answer for cluster ${displaySafe(explicit)}: ` +
          `${displaySafe(unanswered.reason ?? 'no reason given')}` +
          (unanswered.detail !== undefined ? `.${verbosePointerTail()}` : '')
      );
    }
    return null;
  }
  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // `DescribeStackResources` or the template's physical-name property; a
  // cluster reaching here needs an explicit `--resource` override.
  return null;
}

export async function importService(
  this: ECSProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  // `createService` stores the service ARN as the physical id; an explicit
  // override is honored as-is (the composite `<clusterArn>|<serviceName>`
  // form is also accepted by readCurrentState).
  if (input.knownPhysicalId) {
    return { physicalId: input.knownPhysicalId, attributes: {} };
  }
  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // `DescribeStackResources` or the template's physical-name property; a
  // service reaching here needs an explicit `--resource` override.
  return null;
}

export async function importTaskDefinition(
  this: ECSProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  // TaskDefinitions are immutable revisions; physical id is the full
  // `family:revision` ARN. CDK templates rarely encode a stable
  // identifier, so we only support explicit overrides for these.
  if (input.knownPhysicalId) {
    let resp: DescribeTaskDefinitionCommandOutput;
    try {
      resp = await this.getClient().send(
        new DescribeTaskDefinitionCommand({ taskDefinition: input.knownPhysicalId })
      );
    } catch (err) {
      if (this.isClusterNotFoundException(err) || this.isServiceNotFoundException(err)) {
        return null;
      }
      throw err;
    }
    // Read OUTSIDE the `try`, as `importCluster` does: its not-found arm
    // matches message substrings. A deregistered revision is gone in cdkd's
    // sense, the same answer `readCurrentState` gives (go-to-k/cdkd#4272).
    if (isDeregisteredTaskDefinitionStatus(resp.taskDefinition?.status)) return null;
    const arn = resp.taskDefinition?.taskDefinitionArn;
    return arn ? { physicalId: arn, attributes: {} } : null;
  }
  return null;
}
