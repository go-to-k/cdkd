import type { ECSProvider } from '../ecs-provider.js';
import {
  ECSClient,
  DescribeTaskDefinitionCommand,
  ListTaskDefinitionsCommand,
} from '@aws-sdk/client-ecs';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../../deployment/retryable-errors.js';
import type { DeleteContext } from '../../region-check.js';
import type {
  ResourceCreateResult,
  ResourceDeleteResult,
  ResourceUpdateResult,
  CreateContext,
  UpdateContext,
} from '../../../types/resource.js';
import {
  createMaskedLogSinks,
  withDerivedNameMasks,
  type MaskedLogSinks,
  type MaskerFn,
} from '../../masked-retry-logger.js';
import { withRemovalDefaults } from '../../update-removal.js';
import { ambientClientDefaults } from '../../../utils/ambient-client-defaults.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import {
  isInsideWindow,
  withoutServerErrorRetries,
  type AmbiguousCreateWindow,
} from '../ambiguous-create.js';
import {
  MAX_ORPHAN_LIST_PAGES,
  orphanCommandRegionArg,
  reportPossibleOrphans,
} from '../orphan-report.js';
import {
  taskDefinitionsRegisteredByThisProcess,
  familyOfTaskDefinitionArn,
  isTaskDefinitionMissingError,
  clusterNameOfRef,
  recordedServiceNames,
} from './shared.js';

export function getClient(this: ECSProvider): ECSClient {
  if (!this.ecsClient) {
    this.ecsClient = new ECSClient({
      ...ambientClientDefaults(),
      ...(this.providerRegion ? { region: this.providerRegion } : {}),
    });
  }
  return this.ecsClient;
}

/**
 * The client `RegisterTaskDefinition` goes through: SDK retries on, except
 * a 5xx (`withoutServerErrorRetries`, issue #2080). Separate so every other
 * ECS call keeps the full SDK retry.
 */
export function getTaskDefinitionCreateClient(this: ECSProvider): ECSClient {
  if (!this.taskDefinitionCreateClient) {
    this.taskDefinitionCreateClient = withoutServerErrorRetries(
      new ECSClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      })
    );
  }
  return this.taskDefinitionCreateClient;
}

/**
 * Issue #2080: after an attempt at `RegisterTaskDefinition` ended AMBIGUOUS
 * (a 5xx: ECS may have registered the revision and lost the answer), name
 * the ACTIVE revisions of `family` registered inside the failed attempts'
 * window (`registeredAt`) that this process did not register, and warn: a
 * read command first, then a DEREGISTER command to run only after
 * confirming. Detection only: a family is per account and region and is
 * meant to be shared -- every deploy of the same family adds a revision --
 * so a revision in the window can be another deploy's.
 *
 * `ListTaskDefinitions` returns ARNs only, so each candidate's
 * `registeredAt` takes a `DescribeTaskDefinition`. Listed newest first, so
 * the walk stops at the first revision registered before the window (or
 * with no `registeredAt`, which only revisions older than the field carry):
 * revision numbers only grow, so every later one is older still.
 */
export async function reportPossibleOrphanTaskDefinitions(
  this: ECSProvider,
  logicalId: string,
  family: string,
  window: AmbiguousCreateWindow,
  log: MaskedLogSinks
): Promise<void> {
  const client = this.getClient();
  const aws = pasteableAwsCommand(log.mask);
  const regionArg = await orphanCommandRegionArg(client, aws);
  await reportPossibleOrphans(logicalId, window, log, {
    action: 'RegisterTaskDefinition',
    service: 'ECS',
    listAction: 'ListTaskDefinitions',
    subject: `a revision of task definition family ${log.value(family)}`,
    noun: 'task definition revision(s)',
    list: async () => {
      const ids: string[] = [];
      let nextToken: string | undefined;
      let pages = 0;
      do {
        const page = await client.send(
          new ListTaskDefinitionsCommand({
            familyPrefix: family,
            status: 'ACTIVE',
            sort: 'DESC',
            ...(nextToken && { nextToken }),
          })
        );
        pages++;
        for (const arn of page.taskDefinitionArns ?? []) {
          // `familyPrefix` is documented as the full family name; compare
          // exactly anyway, so a prefix match never names another family.
          if (familyOfTaskDefinitionArn(arn) !== family) continue;
          let registeredAt: Date | undefined;
          let active = true;
          try {
            const described = await client.send(
              new DescribeTaskDefinitionCommand({ taskDefinition: arn })
            );
            registeredAt = described.taskDefinition?.registeredAt;
            // Deregistered since the listing: someone already let it go.
            active = (described.taskDefinition?.status ?? 'ACTIVE') === 'ACTIVE';
          } catch (error) {
            // Deleted since the listing: not an orphan any more.
            if (isTaskDefinitionMissingError(error)) continue;
            throw error;
          }
          if (registeredAt === undefined || registeredAt.getTime() < window.floorMs) {
            return { ids, truncated: false };
          }
          if (
            active &&
            isInsideWindow(registeredAt, window) &&
            !taskDefinitionsRegisteredByThisProcess.has(arn)
          ) {
            ids.push(arn);
          }
        }
        nextToken = page.nextToken;
      } while (nextToken && pages < MAX_ORPHAN_LIST_PAGES);
      return { ids, truncated: Boolean(nextToken) };
    },
    inspect: (arn) =>
      aws`aws ecs describe-task-definition --task-definition ${arn}${regionArg}`.render(),
    remove: (arn) =>
      aws`aws ecs deregister-task-definition --task-definition ${arn}${regionArg}`.render(),
    removeVerb: 'deregister it',
  });
}

/**
 * The failure wrap every create / update / delete catch throws.
 *
 * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
 * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
 * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
 * caller's assumed-role ARN. AWS's own text goes to `debug` through `mask`,
 * and the wrap is stamped `markRedactedCause`, so the retry classifiers read
 * the withheld text on the `cause` chain. An "already exists" is restated
 * ({@link relayedNameCollision}). A non-`Error` throw is withheld the same
 * way, unstamped: it has no chain to read.
 *
 * A cdkd-authored or transport error keeps its text, masked RAW (issue
 * #2177: AWS text quotes a rejected request value back off the RESOLVED
 * `properties` bag, and a cdkd refusal can describe a bag value), stamped
 * exactly when the mask changed it (`wrapMaskedAwsError`, issue #4244). The
 * deletes check not-found by type before they wrap. A method, so
 * `gen-update-wrap-coverage` sees the catch that throws it as a wrap.
 *
 * `build` must thread `error` as `cause`, and runs twice, so it must stay a
 * side-effect-free constructor call.
 */
export function wrapCaughtError(
  this: ECSProvider,
  mask: MaskerFn,
  error: unknown,
  build: (maskedText: string) => ProvisioningError
): ProvisioningError {
  const failure = describeAwsFailure(error);
  if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
  this.logger.debug(mask(build(mask(failure.detail)).message));
  const wrapped = build(`${mask(failure.summary)}${relayedNameCollision(failure.detail)}`);
  return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
}

// ─── Dispatch ─────────────────────────────────────────────────────

/**
 * The masked sinks ONE `create()` / `update()` logs through (issue #2177,
 * `.claude/rules/provider-masking.md`): `createMaskedLogSinks` over the
 * context's masker, extended by `withDerivedNameMasks` with `pairs` — each
 * `[template value, name derived from it]`. An ECS physical id or ARN
 * embeds the cluster name, task-definition family or service name the
 * template chose, any of which can be secret-derived; the needle masks it
 * wherever it occurs (an ARN on a success line, an AWS echo, a pasteable
 * command, which it then withholds). Built per call; never cached on the
 * provider, which serves concurrent resources.
 */
export function operationSinks(
  this: ECSProvider,
  context: CreateContext | UpdateContext | undefined,
  pairs: ReadonlyArray<readonly [raw: unknown, name: string | undefined]>
): MaskedLogSinks {
  return withDerivedNameMasks(
    this.logger,
    createMaskedLogSinks(this.logger, context?.maskSecrets),
    pairs
  );
}

/**
 * Create a resource.
 *
 * Each `create()` / `update()` builds ONE masked sink set from its own
 * context (issue #2177) and routes every log line and wrapped AWS error text
 * through it; a bag value a cdkd line interpolates is also masked RAW
 * (`log.value`), so a secret below the masker's substring floor is caught
 * too. Absent context means identity.
 */
export async function create(
  this: ECSProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // `withDerivedNameMasks` drops a non-string name at runtime, so each cast
  // below only narrows the type.
  switch (resourceType) {
    case 'AWS::ECS::Cluster':
      return this.createCluster(
        logicalId,
        resourceType,
        properties,
        this.operationSinks(context, [
          [properties['ClusterName'], properties['ClusterName'] as string | undefined],
        ])
      );
    case 'AWS::ECS::TaskDefinition':
      return this.createTaskDefinition(
        logicalId,
        resourceType,
        properties,
        this.operationSinks(context, [
          [properties['Family'], properties['Family'] as string | undefined],
        ])
      );
    case 'AWS::ECS::Service':
      return this.createService(
        logicalId,
        resourceType,
        properties,
        this.operationSinks(context, [
          [properties['ServiceName'], properties['ServiceName'] as string | undefined],
          // The cluster name the long-format service ARN embeds (the value
          // itself when it is a bare name).
          [properties['Cluster'], clusterNameOfRef(properties['Cluster'])],
        ]),
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

/**
 * Update a resource. `context` is read for its masker only (issue #2177);
 * see `create()`.
 *
 * The recorded name is what the physical id carries, and either side's
 * template value being secret-derived makes it a needle. The desired side
 * covers the threaded callers (a rotated secret resolves to a NEW plaintext
 * the masker knows, and the needle then removes the OLD one); the previous
 * side is a backstop for a name state recorded as a `{{resolve:` reference
 * or `***`. Both can only over-mask.
 */
export async function update(
  this: ECSProvider,
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
    case 'AWS::ECS::Cluster':
      // A Cluster's physical id IS its name.
      return this.updateCluster(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        this.operationSinks(context, [
          [properties['ClusterName'], physicalId],
          [previousProperties['ClusterName'], physicalId],
        ])
      );
    case 'AWS::ECS::TaskDefinition':
      // A change outside `Tags` refuses before any AWS call or log line,
      // interpolating no bag value. The physical id is the revision ARN,
      // which embeds the family.
      return this.updateTaskDefinition(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        this.operationSinks(context, [
          [properties['Family'], familyOfTaskDefinitionArn(physicalId)],
          [previousProperties['Family'], familyOfTaskDefinitionArn(physicalId)],
        ]),
        context?.maskSecrets
      );
    case 'AWS::ECS::Service': {
      // A Service's physical id is its ARN, which embeds the service name
      // and (long format) the cluster name.
      const { service: recordedService, cluster: recordedCluster } =
        recordedServiceNames(physicalId);
      return this.updateService(
        logicalId,
        physicalId,
        resourceType,
        properties,
        previousProperties,
        this.operationSinks(context, [
          [properties['ServiceName'], recordedService],
          [previousProperties['ServiceName'], recordedService],
          [properties['Cluster'], recordedCluster],
          [previousProperties['Cluster'], recordedCluster],
          [properties['Cluster'], clusterNameOfRef(properties['Cluster'])],
        ]),
        context?.desiredFromAwsReadback === true,
        context?.replayingState === true
      );
    }
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
  this: ECSProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void | ResourceDeleteResult> {
  switch (resourceType) {
    case 'AWS::ECS::Cluster':
      return this.deleteCluster(logicalId, physicalId, resourceType, context);
    case 'AWS::ECS::TaskDefinition':
      return this.deleteTaskDefinition(logicalId, physicalId, resourceType, context);
    case 'AWS::ECS::Service':
      return this.deleteService(logicalId, physicalId, resourceType, properties, context);
    default:
      throw new ProvisioningError(
        `Unsupported resource type: ${resourceType}`,
        resourceType,
        logicalId,
        physicalId
      );
  }
}

export async function getAttribute(
  this: ECSProvider,
  physicalId: string,
  resourceType: string,
  attributeName: string
): Promise<unknown> {
  switch (resourceType) {
    case 'AWS::ECS::Cluster':
      return this.getClusterAttribute(physicalId, attributeName);
    case 'AWS::ECS::TaskDefinition':
      return this.getTaskDefinitionAttribute(physicalId, attributeName);
    case 'AWS::ECS::Service':
      return this.getServiceAttribute(physicalId, attributeName);
    default:
      return undefined;
  }
}
