import type { ECSProvider } from '../ecs-provider.js';
import {
  CreateClusterCommand,
  DeleteClusterCommand,
  DescribeClustersCommand,
  PutClusterCapacityProvidersCommand,
  UpdateClusterCommand,
  RegisterTaskDefinitionCommand,
  DeregisterTaskDefinitionCommand,
  DescribeTaskDefinitionCommand,
  type RegisterTaskDefinitionCommandOutput,
  type NetworkMode,
  type Compatibility,
  type PidMode,
  type IpcMode,
} from '@aws-sdk/client-ecs';
import { isDeepStrictEqual } from 'node:util';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { generatedNameFor } from '../../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type {
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
} from '../../../types/resource.js';
import { maskerOrIdentity, type MaskedLogSinks } from '../../masked-retry-logger.js';
import { unchangedBehindSecretReference } from '../../secret-reference-immutable.js';
import { replayedSendWindow } from '../ambiguous-create.js';
import {
  registerTaskDefinitionLatch,
  taskDefinitionsRegisteredByThisProcess,
  convertTags,
  markNotGoneOnNotFoundClass,
} from './shared.js';

// ─── AWS::ECS::Cluster ──────────────────────────────────────────

export async function createCluster(
  this: ECSProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceCreateResult> {
  log.debug(`Creating ECS cluster ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
  const client = this.getClient();

  const clusterName =
    (properties['ClusterName'] as string | undefined) ||
    (this.generatedCreateName(resourceType, logicalId, properties) as string);

  try {
    const response = await client.send(
      new CreateClusterCommand({
        clusterName,
        capacityProviders: properties['CapacityProviders'] as string[] | undefined,
        defaultCapacityProviderStrategy: this.convertCapacityProviderStrategy(
          properties['DefaultCapacityProviderStrategy'] as
            | Array<Record<string, unknown>>
            | undefined
        ),
        configuration: this.convertClusterConfiguration(
          properties['Configuration'] as Record<string, unknown> | undefined
        ),
        settings: properties['ClusterSettings']
          ? (properties['ClusterSettings'] as Array<Record<string, unknown>>).map((s) => ({
              name: (s['Name'] || s['name']) as string as 'containerInsights',
              value: ((s['Value'] || s['value']) as string) ?? undefined,
            }))
          : undefined,
        serviceConnectDefaults: properties['ServiceConnectDefaults']
          ? {
              namespace: (properties['ServiceConnectDefaults'] as Record<string, unknown>)[
                'Namespace'
              ] as string,
            }
          : undefined,
        tags: convertTags(desiredTags),
      })
    );

    const cluster = response.cluster;
    if (!cluster || !cluster.clusterArn) {
      throw new Error('CreateCluster did not return cluster ARN');
    }

    log.debug(`Successfully created ECS cluster ${logicalId}: ${cluster.clusterArn}`);

    // The name AWS answers with, not the one requested: were ECS to fold a
    // spelling, a record of the requested one would name a cluster that
    // does not exist under it (go-to-k/cdkd#3937 review).
    return {
      physicalId: cluster.clusterName ?? clusterName,
      attributes: {
        Arn: cluster.clusterArn,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create ECS cluster ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          clusterName,
          cause
        )
    );
  }
}

export async function updateCluster(
  this: ECSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceUpdateResult> {
  // The physical id is the cluster NAME, a template value: masked RAW.
  const shownCluster = log.value(physicalId);
  log.debug(`Updating ECS cluster ${logicalId}: ${shownCluster}`);
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  const client = this.getClient();

  try {
    // Update capacity providers if specified
    if (properties['CapacityProviders'] || properties['DefaultCapacityProviderStrategy']) {
      await client.send(
        new PutClusterCapacityProvidersCommand({
          cluster: physicalId,
          capacityProviders: (properties['CapacityProviders'] as string[]) || [],
          defaultCapacityProviderStrategy:
            this.convertCapacityProviderStrategy(
              properties['DefaultCapacityProviderStrategy'] as
                | Array<Record<string, unknown>>
                | undefined
            ) || [],
        })
      );
      log.debug(`Updated capacity providers for ECS cluster ${shownCluster}`);
    }

    // Apply ClusterSettings / Configuration / ServiceConnectDefaults via
    // UpdateClusterCommand when any changed. Issue a single call so AWS
    // evaluates the new shape atomically (avoids partial-apply on a
    // per-field call). Skipped entirely when nothing differs so a
    // no-drift round-trip stays mutation-free against AWS.
    const settingsChanged =
      JSON.stringify(previousProperties['ClusterSettings'] ?? null) !==
      JSON.stringify(properties['ClusterSettings'] ?? null);
    const configChanged =
      JSON.stringify(previousProperties['Configuration'] ?? null) !==
      JSON.stringify(properties['Configuration'] ?? null);
    const svcConnectChanged =
      JSON.stringify(previousProperties['ServiceConnectDefaults'] ?? null) !==
      JSON.stringify(properties['ServiceConnectDefaults'] ?? null);

    if (settingsChanged || configChanged || svcConnectChanged) {
      const settingsInput = settingsChanged
        ? ((properties['ClusterSettings'] as Array<Record<string, unknown>> | undefined) ?? []).map(
            (s) => ({
              name: (s['Name'] || s['name']) as 'containerInsights',
              value: ((s['Value'] || s['value']) as string) ?? undefined,
            })
          )
        : undefined;

      // AWS UpdateCluster accepts `serviceConnectDefaults: { namespace: '' }`
      // as the "clear the cluster's default namespace" sentinel (per
      // ClusterServiceConnectDefaultsRequest docs). When the user removes
      // the property from their template, pass that sentinel so AWS
      // actually clears the value instead of treating "absent" as no-op.
      const svcConnectInput = svcConnectChanged
        ? properties['ServiceConnectDefaults']
          ? {
              namespace: (properties['ServiceConnectDefaults'] as Record<string, unknown>)[
                'Namespace'
              ] as string,
            }
          : { namespace: '' }
        : undefined;

      await client.send(
        new UpdateClusterCommand({
          cluster: physicalId,
          ...(settingsChanged && { settings: settingsInput }),
          ...(configChanged && {
            configuration: this.convertClusterConfiguration(
              properties['Configuration'] as Record<string, unknown> | undefined
            ),
          }),
          ...(svcConnectChanged && { serviceConnectDefaults: svcConnectInput }),
        })
      );
      log.debug(
        `Updated ECS cluster ${shownCluster} (settings=${settingsChanged}, config=${configChanged}, svcConnect=${svcConnectChanged})`
      );
    }

    // Describe cluster to get current ARN
    const describeResponse = await client.send(
      new DescribeClustersCommand({ clusters: [physicalId] })
    );
    const cluster = describeResponse.clusters?.[0];

    // Apply tag diff. ECS uses lowercase camelCase tags.
    if (cluster?.clusterArn) {
      await this.applyTagDiff(
        cluster.clusterArn,
        resourceType,
        logicalId,
        previousProperties['Tags'],
        properties['Tags'],
        log
      );
    }

    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        Arn: cluster?.clusterArn,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update ECS cluster ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}

export async function deleteCluster(
  this: ECSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting ECS cluster ${logicalId}: ${physicalId}`);
  const client = this.getClient();

  try {
    await client.send(new DeleteClusterCommand({ cluster: physicalId }));
    this.logger.debug(`Successfully deleted ECS cluster ${logicalId}`);
  } catch (error) {
    // Handle ClusterNotFoundException for idempotent delete
    if (this.isClusterNotFoundException(error)) {
      const clientRegion = await client.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`ECS cluster ${physicalId} not found, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const refused = markNotGoneOnNotFoundClass(
      error,
      this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete ECS cluster ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      )
    );
    throw refused;
  }
}

export async function getClusterAttribute(
  this: ECSProvider,
  physicalId: string,
  attributeName: string
): Promise<unknown> {
  const client = this.getClient();
  const response = await client.send(new DescribeClustersCommand({ clusters: [physicalId] }));
  const cluster = response.clusters?.[0];
  if (!cluster) return undefined;

  switch (attributeName) {
    case 'Arn':
      return cluster.clusterArn;
    default:
      return undefined;
  }
}

// ─── AWS::ECS::TaskDefinition ───────────────────────────────────

export async function createTaskDefinition(
  this: ECSProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  log: MaskedLogSinks
): Promise<ResourceCreateResult> {
  log.debug(`Creating ECS task definition ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
  const family =
    (properties['Family'] as string | undefined) ||
    generatedNameFor('AWS::ECS::TaskDefinition', logicalId);

  try {
    // Issue #2080: after an earlier ambiguous attempt, name the revision it
    // may have registered before a second RegisterTaskDefinition is sent.
    // Detection only -- see `orphan-report.ts`.
    const orphanWindow = registerTaskDefinitionLatch.take(logicalId);
    if (orphanWindow !== undefined) {
      await this.reportPossibleOrphanTaskDefinitions(logicalId, family, orphanWindow, log);
    }
    const attemptStartMs = Date.now();
    let response: RegisterTaskDefinitionCommandOutput;
    try {
      response = await this.getTaskDefinitionCreateClient().send(
        new RegisterTaskDefinitionCommand({
          family,
          containerDefinitions: this.convertContainerDefinitions(
            properties['ContainerDefinitions'] as Array<Record<string, unknown>> | undefined
          ),
          cpu: properties['Cpu'] as string | undefined,
          memory: properties['Memory'] as string | undefined,
          networkMode: properties['NetworkMode'] as NetworkMode | undefined,
          requiresCompatibilities: properties['RequiresCompatibilities'] as
            | Compatibility[]
            | undefined,
          executionRoleArn: properties['ExecutionRoleArn'] as string | undefined,
          taskRoleArn: properties['TaskRoleArn'] as string | undefined,
          volumes: this.convertVolumes(
            properties['Volumes'] as Array<Record<string, unknown>> | undefined
          ),
          placementConstraints: this.convertTaskDefinitionPlacementConstraints(
            properties['PlacementConstraints'] as Array<Record<string, unknown>> | undefined
          ),
          tags: convertTags(desiredTags),
          runtimePlatform: this.convertRuntimePlatform(
            properties['RuntimePlatform'] as Record<string, unknown> | undefined
          ),
          proxyConfiguration: this.convertProxyConfiguration(
            properties['ProxyConfiguration'] as Record<string, unknown> | undefined
          ),
          pidMode: properties['PidMode'] as PidMode | undefined,
          ipcMode: properties['IpcMode'] as IpcMode | undefined,
          ephemeralStorage: this.convertEphemeralStorage(
            properties['EphemeralStorage'] as Record<string, unknown> | undefined
          ),
          enableFaultInjection: properties['EnableFaultInjection'] as boolean | undefined,
        })
      );
    } catch (error) {
      registerTaskDefinitionLatch.noteFailure(logicalId, error, attemptStartMs, orphanWindow);
      throw error;
    }

    const taskDef = response.taskDefinition;
    if (!taskDef || !taskDef.taskDefinitionArn) {
      throw new Error('RegisterTaskDefinition did not return task definition ARN');
    }
    taskDefinitionsRegisteredByThisProcess.add(taskDef.taskDefinitionArn);
    // Issue #4687: the SDK replayed this RegisterTaskDefinition inside its `send`, so
    // an earlier attempt may have made one too. Detection only.
    const replayWindow = replayedSendWindow(response, attemptStartMs);
    if (replayWindow !== undefined) {
      await this.reportPossibleOrphanTaskDefinitions(logicalId, family, replayWindow, log);
    }

    log.debug(
      `Successfully created ECS task definition ${logicalId}: ${taskDef.taskDefinitionArn}`
    );

    return {
      physicalId: taskDef.taskDefinitionArn,
      attributes: {
        TaskDefinitionArn: taskDef.taskDefinitionArn,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create ECS task definition ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

/**
 * ECS TaskDefinitions are immutable revisioned resources: every property
 * change but `Tags` registers a new revision whose `taskDefinitionArn`
 * differs from the cdkd-state physicalId. Routing such a change through
 * `cdkd drift --revert` would silently swap state's physicalId for a
 * freshly-registered revision (and deregister the previous one) without the
 * user's awareness, so it is refused; the deploy path replaces
 * (CREATE→DELETE) on those properties instead.
 *
 * `Tags` is the one property the registry schema leaves updatable
 * (`tagUpdatable`), and CloudFormation tags the SAME revision in place
 * (measured for issue #5392: a tags-only change set said `Modify`,
 * `Replacement: False`, and the revision kept its ARN). So a change whose
 * only moved key is `Tags` is applied with `TagResource` / `UntagResource`.
 *
 * `maskSecrets` is the caller's `context?.maskSecrets`, the raw masker
 * `unchangedBehindSecretReference` compares a recorded `{{resolve:...}}`
 * leaf with (`log.mask` carries derived name needles it must not see).
 */
export async function updateTaskDefinition(
  this: ECSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  log: MaskedLogSinks,
  maskSecrets: UpdateContext['maskSecrets']
): Promise<ResourceUpdateResult> {
  // A key whose record keeps a secret-derived leaf as its `{{resolve:...}}`
  // reference while the desired side holds the resolved value has not moved
  // (go-to-k/cdkd#4275); every key here but Tags is create-only, which the
  // helper's engine gate requires.
  let movedOutsideTags = false;
  for (const key of new Set([...Object.keys(properties), ...Object.keys(previousProperties)])) {
    if (key === 'Tags' || isDeepStrictEqual(properties[key], previousProperties[key])) continue;
    if (
      await unchangedBehindSecretReference({
        resourceType,
        key,
        desired: properties[key],
        previous: previousProperties[key],
        maskSecrets,
      })
    ) {
      continue;
    }
    movedOutsideTags = true;
    break;
  }
  if (movedOutsideTags) {
    throw new ResourceUpdateNotSupportedError(
      'AWS::ECS::TaskDefinition',
      logicalId,
      'ECS TaskDefinition revisions are immutable on AWS — there is no UpdateTaskDefinition API; every change but Tags registers a new revision via RegisterTaskDefinition. Re-deploy with cdkd deploy --replace, or destroy + redeploy the stack.'
    );
  }
  // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
  refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
  log.debug(`Updating tags of ECS task definition ${logicalId}: ${physicalId}`);
  try {
    await this.applyTagDiff(
      physicalId,
      resourceType,
      logicalId,
      previousProperties['Tags'],
      properties['Tags'],
      log
    );
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to update ECS task definition ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
  return {
    physicalId,
    wasReplaced: false,
    attributes: { TaskDefinitionArn: physicalId },
  };
}

export async function deleteTaskDefinition(
  this: ECSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting ECS task definition ${logicalId}: ${physicalId}`);
  const client = this.getClient();

  try {
    await client.send(new DeregisterTaskDefinitionCommand({ taskDefinition: physicalId }));
    this.logger.debug(`Successfully deregistered ECS task definition ${logicalId}`);
  } catch (error) {
    // Handle not found for idempotent delete
    if (this.isNotFoundException(error)) {
      const clientRegion = await client.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`ECS task definition ${physicalId} not found, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const refused = markNotGoneOnNotFoundClass(
      error,
      this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete ECS task definition ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      )
    );
    throw refused;
  }
}

export async function getTaskDefinitionAttribute(
  this: ECSProvider,
  physicalId: string,
  attributeName: string
): Promise<unknown> {
  const client = this.getClient();
  const response = await client.send(
    new DescribeTaskDefinitionCommand({ taskDefinition: physicalId })
  );
  const taskDef = response.taskDefinition;
  if (!taskDef) return undefined;

  switch (attributeName) {
    case 'TaskDefinitionArn':
      return taskDef.taskDefinitionArn;
    default:
      return undefined;
  }
}
