import type { Deployment, Service, Tag, ThresholdConfiguration } from '@aws-sdk/client-ecs';
import { markNotGone } from '../../not-gone.js';
import type { CfnTagEntry } from '../../tag-list.js';
import { readConfigString } from '../../config-shape.js';
import { AmbiguousCreateLatch, RecentIdSet } from '../ambiguous-create.js';

/**
 * Issue #2080: `RegisterTaskDefinition` carries no idempotency token, and
 * every call registers the family's NEXT revision. A 5xx whose request had
 * succeeded therefore leaves an extra ACTIVE revision that no state records
 * and `cdkd destroy` never deregisters (`RegisterTaskDefinition` refuses
 * nothing on a replay, so nothing collides either). Armed by an ambiguous
 * create failure; the next attempt reports candidates before registering again.
 */
export const registerTaskDefinitionLatch = new AmbiguousCreateLatch('ecs:RegisterTaskDefinition');

/** Task definition ARNs this process registered, never reported as orphan candidates. */
export const taskDefinitionsRegisteredByThisProcess = new RecentIdSet();

/** Reset the module-scoped retry-safety state. TEST-ONLY. */
export function resetTaskDefinitionCreateRetryStateForTests(): void {
  registerTaskDefinitionLatch.resetForTests();
  taskDefinitionsRegisteredByThisProcess.resetForTests();
}

/** The family of a task definition ARN (`...:task-definition/<family>:<revision>`). */
export function familyOfTaskDefinitionArn(arn: string): string | undefined {
  return /:task-definition\/(.+):\d+$/.exec(arn)?.[1];
}

/**
 * Convert CFn Tags (Array<{Key, Value}>) to ECS Tags (Array<{key, value}>)
 */
export function convertTags(tags: CfnTagEntry[]): Tag[] | undefined {
  if (tags.length === 0) return undefined;
  return tags.map((t) => ({ key: t.Key, value: t.Value }));
}

/**
 * `DeploymentConfiguration.LifecycleHooks[].HookDetails` is a free-form JSON
 * document (SDK `__DocumentType`) whose inner keys are user-supplied hook
 * payload fields, NOT CloudFormation property names. The recursive
 * PascalCase->camelCase key flip must therefore copy its value subtree
 * verbatim (the `HookDetails` key itself is still flipped to `hookDetails`).
 * See `convertDeploymentConfiguration`.
 */
export const DEPLOYMENT_CONFIG_PRESERVE_KEYS: ReadonlySet<string> = new Set(['HookDetails']);

/**
 * Read-side (camelCase -> PascalCase) counterpart of
 * `DEPLOYMENT_CONFIG_PRESERVE_KEYS` for `readCurrentState` (issue #1165 /
 * #1167). The SDK response carries the free-form document under the camelCase
 * key `hookDetails`, so the reverse key-flip must copy its value subtree
 * verbatim (the key itself is still flipped to `HookDetails`).
 */
export const DEPLOYMENT_CONFIG_PRESERVE_KEYS_CAMEL: ReadonlySet<string> = new Set(['hookDetails']);

/**
 * `ServiceConnectConfiguration.LogConfiguration.Options` is a free-form
 * log-driver option map (e.g. `awslogs-group`) whose keys are user data, NOT
 * CloudFormation property names — copy the value subtree verbatim while the
 * `Options` key itself still flips to `options` (issue #609; same rule as
 * `DEPLOYMENT_CONFIG_PRESERVE_KEYS` above and the container-level
 * `LogConfiguration.Options` handling in `convertLogConfiguration`).
 */
export const SERVICE_CONNECT_PRESERVE_KEYS: ReadonlySet<string> = new Set(['Options']);

/**
 * SHARED RATIONALE for both `CIRCUIT_BREAKER_*_DEFAULT` constants below —
 * WHERE THE VALUES COME FROM, and when they may be sent (issue #1861).
 *
 * They are the values CloudFormation was MEASURED to produce when a template
 * that previously DECLARED the member stops declaring it (us-east-1,
 * 2026-08-13, same service, `Rollback` flipped in the same call so the update
 * demonstrably applied and service identity captured on both sides so a
 * replacement could not be mistaken for a reset): `resetOnHealthyTask` false
 * -> `true`, `thresholdConfiguration` {COUNT, 7} -> {BOUNDED_PERCENT, 50}.
 * They match the SDK's documented defaults for both members, and the SDK
 * documents those unconditionally — they do not vary by scheduling strategy or
 * deployment type (see the strategy note in `updateService`'s comment block).
 *
 * They are used ONLY as `clearOnUpdateRemoval`'s clear value, i.e. only on a
 * previous-present / current-absent REMOVAL. They must NEVER be sent for a
 * member the template never declared — a third measurement in the same
 * session set both members OUT OF BAND on a service whose template never
 * declared them, then ran a CloudFormation update that flipped `Rollback`
 * INSIDE the block: the out-of-band `false` / {COUNT, 9} BOTH survived. That
 * arm is what excludes the competing reading "CFn re-serializes the struct
 * whenever its declared content changed" and makes this a genuine removal.
 */

/**
 * `DeploymentCircuitBreaker.ResetOnHealthyTask`'s AWS default. A primitive, so
 * it needs no copy-on-use treatment — unlike its object-valued sibling below.
 * Provenance and the send-only-on-removal rule: see the shared note above.
 */
export const CIRCUIT_BREAKER_RESET_ON_HEALTHY_TASK_DEFAULT = true;

/**
 * `DeploymentCircuitBreaker.ThresholdConfiguration`'s AWS default. Provenance
 * and the send-only-on-removal rule: see the shared note above.
 *
 * FROZEN, and spread into a fresh object at the use site rather than handed
 * over by reference. `ECSProvider` is a singleton serving concurrent
 * resources, so a module-level object reaching the SDK input directly would be
 * one shared mutable value across every in-flight `UpdateService` — a
 * middleware or a future normalization step mutating it would corrupt every
 * other caller. The two halves guard different failures and BOTH are pinned by
 * unit arms: the copy means no caller can ever reach this object, and the
 * freeze means a caller that somehow does fails LOUDLY instead of silently
 * poisoning every later update.
 *
 * @internal EXPORTED for tests only (issue #1861). Every production consumer
 * is in this file. The export exists because the freeze is otherwise
 * UNOBSERVABLE from a test: the resolver hands out a copy by design, so the
 * payload a test can reach is never this object, and dropping `Object.freeze`
 * left the whole suite green. Asserting it through a source grep was the
 * alternative and is the weaker fence this repo has retired elsewhere.
 */
export const CIRCUIT_BREAKER_THRESHOLD_CONFIGURATION_DEFAULT: Readonly<ThresholdConfiguration> =
  Object.freeze({
    type: 'BOUNDED_PERCENT',
    value: 50,
  });

/**
 * A plain object — something a CFn config block can legitimately be. Arrays
 * and non-objects are excluded on purpose: `typeof [] === 'object'` and every
 * non-empty string is truthy, so a truthiness check would wave a malformed
 * template through into a spread.
 *
 * Deliberately a module-local copy rather than an export added to
 * `src/provisioning/config-shape.ts`, whose private `isPlainObject` is
 * byte-identical: this lane may not widen a shared module's API.
 *
 * No "promote it if a third copy appears" trigger, because that already fired
 * long before this PR and adding it here would read as a new one. Grepped for
 * a standalone helper whose body is exactly this predicate: NINE across nine
 * files under six different names — `config-shape.ts`, `wafv2-provider.ts`,
 * `s3-bucket/shared.ts` (`isPlainObject`), `emr-configuration.ts`,
 * `lambda-microvm-image-provider.ts` (`isRecord`),
 * `apigateway/shared.ts` (`isPlainObjectBlock`), `drift.ts`
 * (`isPlainRecord`), `lambda-vpc-deps.ts` (`isObject`), and this one — plus
 * further INLINE copies (`route53/` x2,
 * `custom-resource-provider.ts`, `diff-recursive.ts`,
 * `intrinsic-resolver/string-functions.ts`). Consolidating them touches files across
 * several lanes and is a separate lane's job, not this PR's.
 */
export function isPlainCfnObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when a `Describe{Clusters,Services}` answer that listed nothing says
 * the requested id is gone: at least one failure, and every one `MISSING`.
 * An empty failure list is no answer (`[].every` is vacuously true, so the
 * length check is load-bearing), and any other reason is a lookup that did not
 * answer.
 */
export function describeListedNothingGone(
  failures: Array<{ reason?: string }> | undefined
): boolean {
  return (failures ?? []).length > 0 && failures!.every((f) => f.reason === 'MISSING');
}

/**
 * `DescribeTaskDefinition`'s answer for a revision that does not exist: a
 * `ClientException` reading "Unable to describe task definition." Narrower
 * than `isNotFoundException` (which reads EVERY `ClientException` as gone), so
 * an access or validation failure never reads as a deleted revision. The
 * message match is safe to rely on: it is AWS's fixed ASCII wording, matched
 * case-insensitively, and ECS gives this case no error name of its own.
 */
export function isTaskDefinitionMissingError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.name === 'ClientException' &&
    /unable to describe task definition/i.test(err.message)
  );
}

/**
 * Whether a `DescribeTaskDefinition` status means the revision is gone in
 * cdkd's sense (go-to-k/cdkd#4272). `deleteTaskDefinition` DEREGISTERS, which
 * leaves the revision describable as `INACTIVE` indefinitely, and
 * `DELETE_IN_PROGRESS` lies past that. `ACTIVE`, an absent status and any
 * unknown one stay present.
 */
export function isDeregisteredTaskDefinitionStatus(status: string | undefined): boolean {
  return status === 'INACTIVE' || status === 'DELETE_IN_PROGRESS';
}

/**
 * Derive the cluster name from a long-format ECS Service ARN
 * (`arn:<partition>:ecs:<region>:<account>:service/<clusterName>/<serviceName>`)
 * so `DescribeServices` can be scoped to the right cluster (issue #1170).
 * Returns `undefined` for the legacy short-format ARN
 * (`.../service/<serviceName>`, which does not encode a cluster) or any input
 * that does not match the ARN shape — the caller then falls back to the default
 * cluster, matching what the short-format ARN implies.
 */
export function clusterNameFromServiceArn(arn: string): string | undefined {
  const segments = serviceArnResourceSegments(arn);
  if (segments === undefined) return undefined;
  return segments.length >= 3 ? segments[1] : undefined;
}

/**
 * The service name a Service ARN ends with, in either the long
 * (`service/<clusterName>/<serviceName>`) or the legacy short
 * (`service/<serviceName>`) format; `undefined` for anything else.
 */
export function serviceNameFromServiceArn(arn: string): string | undefined {
  const segments = serviceArnResourceSegments(arn);
  if (segments === undefined || segments.length < 2) return undefined;
  return segments[segments.length - 1] || undefined;
}

/**
 * The `/`-separated segments of a Service ARN's resource part
 * (`arn:<partition>:ecs:<region>:<account>:<resource>`), starting with
 * `service`; `undefined` when the input has no `service/...` resource. The one
 * ARN split both {@link clusterNameFromServiceArn} and
 * {@link serviceNameFromServiceArn} read, so they agree on every input.
 */
export function serviceArnResourceSegments(arn: string): string[] | undefined {
  const resource = arn.split(':').slice(5).join(':');
  if (!resource) return undefined;
  const segments = resource.split('/');
  return segments[0] === 'service' ? segments : undefined;
}

/**
 * The cluster NAME a Service's `Cluster` value addresses: the segment after
 * `:cluster/` of a cluster ARN, otherwise the value itself (a bare name, or an
 * ARN of another shape, whose whole value then becomes the needle: it can only
 * over-mask). `undefined` for a non-string. A long-format Service ARN embeds
 * this name.
 */
export function clusterNameOfRef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const marker = ':cluster/';
  const at = value.startsWith('arn:') ? value.indexOf(marker) : -1;
  return at >= 0 ? value.slice(at + marker.length) || undefined : value;
}

/**
 * The service and cluster names a recorded Service physical id carries. The
 * id is the service ARN `createService` stores, the composite
 * `<clusterArn>|<serviceName>` form `readCurrentState` also accepts, or a bare
 * service name (an import's explicit physical id), which is the name itself.
 */
export function recordedServiceNames(physicalId: string): {
  service: string | undefined;
  cluster: string | undefined;
} {
  const sep = physicalId.indexOf('|');
  if (sep >= 0) {
    return {
      service: physicalId.substring(sep + 1) || undefined,
      cluster: clusterNameOfRef(physicalId.substring(0, sep)),
    };
  }
  if (!physicalId.startsWith('arn:')) {
    return { service: physicalId || undefined, cluster: undefined };
  }
  return {
    service: serviceNameFromServiceArn(physicalId),
    cluster: clusterNameFromServiceArn(physicalId),
  };
}

/** An ECS error by exact NAME — the only answer that proves a resource gone (go-to-k/cdkd#4283). */
export function isEcsErrorNamed(error: unknown, names: readonly string[]): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === 'string' && names.includes(name);
}

/**
 * AWS ECS Provider
 *
 * Implements resource provisioning for ECS resources:
 * - AWS::ECS::Cluster
 * - AWS::ECS::TaskDefinition
 * - AWS::ECS::Service
 *
 * WHY: ECS CreateCluster and RegisterTaskDefinition are synchronous.
 * The CC API adds unnecessary polling overhead for operations that
 * complete immediately. This SDK provider eliminates that polling.
 */
/**
 * Test seam for `settleService`'s post-stability rollout poll (the sibling of
 * `finalSnapshotDelays` / `describeTypeRetryDelays`) — tests replace `sleep`
 * to skip the real 3s waits.
 */
export const settleRolloutDelays = {
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};

/**
 * Test seam for `deleteService`'s wait for the service to reach `INACTIVE`
 * (go-to-k/cdkd#5664) — tests replace `sleep` to skip the real poll interval
 * and `now` to drive the deadline.
 */
export const serviceInactiveWait = {
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * The rollout a `CreateService` / `UpdateService` started, read off its
 * response: the PRIMARY
 * deployment's `id`, and its `taskDefinition` (else the service's). Both are
 * AWS-minted (a deployment id, a full task-definition revision ARN), so the
 * comparison never meets the template's `family` / `family:revision`
 * spellings. The UpdateService API reference's example response carries
 * `deployments[].{id,status,taskDefinition}` and `service.taskDefinition`.
 */
export interface RequestedRollout {
  deploymentId?: string | undefined;
  taskDefinition?: string | undefined;
}

/** {@link RequestedRollout} from a `CreateService` / `UpdateService` response's service. */
export function requestedRolloutOf(service: Service | undefined): RequestedRollout | undefined {
  if (!service) return undefined;
  const primary = service.deployments?.find((d) => d.status === 'PRIMARY');
  const deploymentId = typeof primary?.id === 'string' && primary.id ? primary.id : undefined;
  const taskDefinitionRaw = primary?.taskDefinition ?? service.taskDefinition;
  const taskDefinition =
    typeof taskDefinitionRaw === 'string' && taskDefinitionRaw ? taskDefinitionRaw : undefined;
  if (deploymentId === undefined && taskDefinition === undefined) return undefined;
  return { deploymentId, taskDefinition };
}

/**
 * The deployment this create / update started, if a DescribeServices answer
 * shows it `FAILED` — a deployment circuit breaker's verdict (the API
 * reference: "If the service fails to reach a steady state and circuit
 * breaker is turned on, the deployment transitions to a FAILED state").
 * Matched by the requested deployment id; with none readable, the PRIMARY
 * deployment stands in for it. `undefined` when no such deployment is FAILED.
 */
export function failedRequestedDeployment(
  requested: RequestedRollout | undefined,
  deployments: readonly Deployment[] | undefined
): Deployment | undefined {
  if (!Array.isArray(deployments)) return undefined;
  const target =
    requested?.deploymentId !== undefined
      ? deployments.find((d) => d?.id === requested.deploymentId)
      : deployments.find((d) => d?.status === 'PRIMARY');
  return target?.rolloutState === 'FAILED' ? target : undefined;
}

/**
 * The revision NUMBER of a task-definition revision ARN, or `undefined`.
 * Only the number: the family is template-chosen, can be secret-derived and
 * too short for the substring masker, so it never reaches a message.
 */
export function taskDefinitionRevision(arn: string | undefined): string | undefined {
  const match = typeof arn === 'string' ? /:task-definition\/[^:]+:(\d+)$/.exec(arn) : null;
  return match ? match[1] : undefined;
}

/**
 * A rollout for a message, by AWS-minted identity only: its deployment id
 * (`ecs-svc/<digits>`) and its task definition's revision number. Never the
 * family (see {@link taskDefinitionRevision}).
 */
export function describeRollout(rollout: {
  id?: string | undefined;
  taskDefinition?: string | undefined;
}): string {
  const revision = taskDefinitionRevision(rollout.taskDefinition);
  const id =
    typeof rollout.id === 'string' && /^ecs-svc\/\d+$/.test(rollout.id) ? rollout.id : undefined;
  if (id && revision) return `deployment ${id} (task definition revision ${revision})`;
  if (id) return `deployment ${id}`;
  if (revision) return `task definition revision ${revision}`;
  return 'another deployment';
}

/**
 * A deployment circuit breaker's verdict (go-to-k/cdkd#5571): the rollout
 * FAILED, or the service settled on another deployment. Its own class so
 * `wrapSteadyStateError` does not offer a longer `--resource-timeout` for a
 * verdict no wait would change.
 */
export class EcsCircuitBreakerVerdict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcsCircuitBreakerVerdict';
  }
}

/** The verdict for a requested deployment ECS marked `FAILED`. */
export function wrapBreakerFailedError(failed: Deployment): EcsCircuitBreakerVerdict {
  return new EcsCircuitBreakerVerdict(
    `its deployment circuit breaker failed the rollout of ${describeRollout(failed)} (deployment FAILED). The new tasks failed to start or failed their health checks`
  );
}

/**
 * Whether the DESIRED `DeploymentController` lets ECS settle the service
 * (go-to-k/cdkd#5571): only the `ECS` rolling-update controller (also the
 * default when absent) has the ECS-managed deployment the ServicesStable
 * waiter and the rollout checks read. `CODE_DEPLOY` and `EXTERNAL` (task
 * sets) never produce one, so waiting would time out and the create arm would
 * DELETE a healthy new service. An unreadable value fails toward NOT waiting,
 * never toward that delete. Returns `undefined` to wait, else the reason.
 */
export function controllerSkipsWait(properties: Record<string, unknown>): string | undefined {
  let type: string;
  try {
    type = readConfigString(
      properties['DeploymentController'],
      'Type',
      'ECS',
      'DeploymentController'
    );
  } catch {
    return 'its DeploymentController could not be read';
  }
  if (type === 'ECS') return undefined;
  if (type === 'CODE_DEPLOY' || type === 'EXTERNAL') {
    return `its DeploymentController is ${type}, which ECS does not settle`;
  }
  return 'its DeploymentController type is not one cdkd can settle';
}

/**
 * Did the service settle on a rollout OTHER than the one this update started
 * (go-to-k/cdkd#5571)? When a deployment circuit breaker with `rollback`
 * fires, ECS marks the new deployment `FAILED` and rolls back to the last
 * `COMPLETED` deployment; once the failed one drains, `DescribeServices`
 * lists that single rollback deployment, `COMPLETED`, which the
 * ServicesStable waiter accepts. The `FAILED` deployment is no longer listed
 * then, so `rolloutState` cannot carry the signal; what does is the IDENTITY
 * of the settled deployment.
 *
 * The deployment id decides when both sides carry one: a rollback deployment
 * is never the deployment the update started, whether ECS reactivates the
 * previous one or starts a new one with the previous configuration, and an
 * update that starts no new deployment (a `DesiredCount`-only change) keeps
 * the PRIMARY's id, so it compares equal. Otherwise the task-definition ARN
 * decides. Either side unreadable answers `undefined` (no verdict): fail open
 * rather than fail a deploy on a shape cdkd could not read.
 *
 * Returns the settled rollout's description when superseded.
 */
export function rolloutSupersededBy(
  requested: RequestedRollout | undefined,
  settled: Deployment | undefined
): string | undefined {
  if (!requested || !settled) return undefined;
  if (requested.deploymentId !== undefined && typeof settled.id === 'string' && settled.id) {
    return settled.id === requested.deploymentId ? undefined : describeRollout(settled);
  }
  if (
    requested.taskDefinition !== undefined &&
    typeof settled.taskDefinition === 'string' &&
    settled.taskDefinition
  ) {
    return settled.taskDefinition === requested.taskDefinition
      ? undefined
      : describeRollout(settled);
  }
  return undefined;
}

/**
 * A DELETE failure wrap whose caught error's CLASS spells `NotFound`, marked
 * not gone (go-to-k/cdkd#2319, #5228). The wrap names the class, and the
 * deploy and destroy delete classifiers (`deploy-engine/delete.ts`,
 * `deploy-engine/update-in-place.ts`, `destroy-runner.ts`) read `NotFound`
 * in a message as "already deleted" unless the error is marked. This
 * resource's own not-found returned before the wrap, so a `NotFound` class
 * reaching it is another object's (an operation, a key, a namespace) and the
 * resource may still exist. Retryability stays the retry classifiers'.
 */
export function markNotGoneOnNotFoundClass<E extends Error>(error: unknown, wrapped: E): E {
  return error instanceof Error && error.name.includes('NotFound') ? markNotGone(wrapped) : wrapped;
}

/**
 * The `GatewayConnectors` update gate's comparison key (go-to-k/cdkd#5634).
 * Each connector's `Filters.AccessTypes` is CFn `insertionOrder: false`, so a
 * reorder of it is not a change and must not start a deployment; it is
 * compared sorted. Everything else, the connector list's own order included,
 * compares as written. Used only for the change gate, never for the value
 * sent. A shape this does not model (a non-array list, a non-object element,
 * a non-array `AccessTypes`) falls through to the plain serialization.
 */
export function gatewayConnectorsGateKey(value: unknown): string {
  if (!Array.isArray(value)) return JSON.stringify(value ?? null);
  return JSON.stringify(
    value.map((connector: unknown) => {
      if (typeof connector !== 'object' || connector === null || Array.isArray(connector)) {
        return connector;
      }
      const filters = (connector as Record<string, unknown>)['Filters'];
      if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
        return connector;
      }
      const accessTypes = (filters as Record<string, unknown>)['AccessTypes'];
      if (!Array.isArray(accessTypes)) return connector;
      return {
        ...(connector as Record<string, unknown>),
        Filters: {
          ...(filters as Record<string, unknown>),
          // Sorted by serialization: the values are enum strings, but a
          // malformed element must still sort deterministically.
          AccessTypes: accessTypes.map((v) => JSON.stringify(v) ?? 'undefined').sort(),
        },
      };
    })
  );
}
