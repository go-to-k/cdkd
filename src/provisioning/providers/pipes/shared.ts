import type {
  PipeSourceParameters,
  PipeTargetParameters,
  UpdatePipeSourceParameters,
} from '@aws-sdk/client-pipes';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { parseCfnTimestamp } from '../../../utils/cfn-timestamp.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { refuseMalformedDesiredTags, tagMapAsList } from '../../tag-list.js';

export const PIPE_TYPE = 'AWS::Pipes::Pipe';

/**
 * A pipe NAME (1-64 of `. - _ A-Z a-z 0-9`, the API's `Name` pattern): the
 * physical id this provider records. The identity answers (`isSameResource`,
 * `resourceIdentity`) refuse anything else, an ARN included: this provider
 * never records one.
 */
export function isPipeName(id: string): boolean {
  return /^[.\-_A-Za-z0-9]{1,64}$/.test(id);
}

/**
 * Every state a pipe that still holds its name can report, `DELETING` left
 * out (go-to-k/cdkd#4606): a pipe on its way out is not read as the live
 * resource a token names, and a state this list does not know (one AWS adds
 * later) is not either, so both answer no token.
 */
export const IDENTITY_STATES: ReadonlySet<string> = new Set([
  'CREATING',
  'CREATE_FAILED',
  'CREATE_ROLLBACK_FAILED',
  'RUNNING',
  'STARTING',
  'START_FAILED',
  'STOPPED',
  'STOPPING',
  'STOP_FAILED',
  'UPDATING',
  'UPDATE_FAILED',
  'UPDATE_ROLLBACK_FAILED',
  'DELETE_FAILED',
  'DELETE_ROLLBACK_FAILED',
]);

/**
 * go-to-k/cdkd#4606: the identity token of the pipe `name`,
 * `<pipeArn>@<creationTime epoch seconds>`, or `undefined` unless the ARN is
 * the pipe ARN of `name` and the creation time a valid, positive time.
 *
 * The ARN is built from the name, so a pipe re-created under the name
 * repeats it; the creation time tells the two apart (the
 * `pipes-fix-forward-orphan` fixture measures the re-create). Whole seconds,
 * because `CreatePipe`'s answer (the failed CREATE's mark) and
 * `DescribePipe`'s (the settle's live read) must spell the same token
 * whatever fraction each carries, and no re-create can fall in the second
 * of the create it follows in practice: the name is freed only after the
 * earlier pipe's asynchronous delete finished. That is an assumption about
 * AWS's timing, not a guarantee: a residual risk.
 */
export function pipeIdentityToken(
  name: string,
  arn: string | undefined,
  creationTime: Date | undefined
): string | undefined {
  if (typeof arn !== 'string' || !arn.startsWith('arn:') || !arn.endsWith(`:pipe/${name}`)) {
    return undefined;
  }
  if (!(creationTime instanceof Date)) return undefined;
  const ms = creationTime.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return `${arn}@${Math.floor(ms / 1000)}`;
}

/** States a pipe rests in. */
export const SETTLED_STATES: ReadonlySet<string> = new Set(['RUNNING', 'STOPPED']);
/** go-to-k/cdkd#5487: the states AWS is still moving a pipe through. */
export const MOVING_STATES: ReadonlySet<string> = new Set([
  'CREATING',
  'UPDATING',
  'STARTING',
  'STOPPING',
  'DELETING',
]);

/** Poll interval for the settle and gone waits. */
export const PIPE_POLL_INTERVAL_MS = 5_000;
/** The settle wait's own cap, well under the default 30-minute resource deadline. */
export const PIPE_SETTLE_MAX_WAIT_MS = 15 * 60_000;
/** The delete wait's own cap. */
export const PIPE_DELETE_MAX_WAIT_MS = 10 * 60_000;
/** The gone wait after deleting a pipe whose create failed: short, see `retireFailedCreate`. */
export const PIPE_CLEANUP_MAX_WAIT_MS = 60_000;

/**
 * Members of each `UpdatePipeSource*Parameters` shape, per source block.
 * Every member the create-side block has and these lack is CREATE-ONLY in the
 * CFn schema (`StartingPosition`, `StartingPositionTimestamp`, `QueueName`,
 * `VirtualHost`, `TopicName`, `ConsumerGroupID`, `AdditionalBootstrapServers`),
 * and a change to one is a replacement the diff decides before `update()`.
 */
const UPDATABLE_SOURCE_MEMBERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'KinesisStreamParameters',
    new Set([
      'BatchSize',
      'DeadLetterConfig',
      'OnPartialBatchItemFailure',
      'MaximumBatchingWindowInSeconds',
      'MaximumRecordAgeInSeconds',
      'MaximumRetryAttempts',
      'ParallelizationFactor',
    ]),
  ],
  [
    'DynamoDBStreamParameters',
    new Set([
      'BatchSize',
      'DeadLetterConfig',
      'OnPartialBatchItemFailure',
      'MaximumBatchingWindowInSeconds',
      'MaximumRecordAgeInSeconds',
      'MaximumRetryAttempts',
      'ParallelizationFactor',
    ]),
  ],
  ['SqsQueueParameters', new Set(['BatchSize', 'MaximumBatchingWindowInSeconds'])],
  [
    'ActiveMQBrokerParameters',
    new Set(['Credentials', 'BatchSize', 'MaximumBatchingWindowInSeconds']),
  ],
  [
    'RabbitMQBrokerParameters',
    new Set(['Credentials', 'BatchSize', 'MaximumBatchingWindowInSeconds']),
  ],
  [
    'ManagedStreamingKafkaParameters',
    new Set(['BatchSize', 'Credentials', 'MaximumBatchingWindowInSeconds']),
  ],
  [
    'SelfManagedKafkaParameters',
    new Set([
      'BatchSize',
      'MaximumBatchingWindowInSeconds',
      'Credentials',
      'ServerRootCaCertificate',
      'Vpc',
    ]),
  ],
]);

/**
 * The `EcsTaskParameters` members the CFn schema spells PascalCase and the
 * Pipes API spells camelCase. The SDK serializer silently drops a member it
 * does not know, so each is renamed on the way out. Enumerated mechanically
 * against `@aws-sdk/client-pipes`'s model: these are the only divergences
 * across the whole `AWS::Pipes::Pipe` property tree.
 */
function toSdkEcsTaskParameters(ecs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...ecs };
  const network = asRecord(out['NetworkConfiguration']);
  if (network && network['AwsvpcConfiguration'] !== undefined) {
    const { AwsvpcConfiguration, ...rest } = network;
    out['NetworkConfiguration'] = { ...rest, awsvpcConfiguration: AwsvpcConfiguration };
  }
  renameInList(out, 'CapacityProviderStrategy', ['CapacityProvider', 'Weight', 'Base']);
  renameInList(out, 'PlacementConstraints', ['Type', 'Expression']);
  renameInList(out, 'PlacementStrategy', ['Type', 'Field']);
  const overrides = asRecord(out['Overrides']);
  if (overrides) {
    const o: Record<string, unknown> = { ...overrides };
    if (Array.isArray(o['ContainerOverrides'])) {
      o['ContainerOverrides'] = (o['ContainerOverrides'] as unknown[]).map((item) => {
        const c = asRecord(item);
        if (!c) return item;
        const container: Record<string, unknown> = { ...c };
        renameInList(container, 'Environment', ['Name', 'Value']);
        renameInList(container, 'EnvironmentFiles', ['Type', 'Value']);
        renameInList(container, 'ResourceRequirements', ['Type', 'Value']);
        return container;
      });
    }
    const storage = asRecord(o['EphemeralStorage']);
    if (storage) o['EphemeralStorage'] = renameKeys(storage, ['SizeInGiB']);
    renameInList(o, 'InferenceAcceleratorOverrides', ['DeviceName', 'DeviceType']);
    out['Overrides'] = o;
  }
  return out;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `PascalCase` -> `camelCase` on the listed keys of one object; others pass through. */
function renameKeys(
  item: Record<string, unknown>,
  keys: readonly string[]
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...item };
  for (const key of keys) {
    if (out[key] === undefined) continue;
    out[key.charAt(0).toLowerCase() + key.slice(1)] = out[key];
    delete out[key];
  }
  return out;
}

/** {@link renameKeys} over each object element of `holder[listKey]`. */
function renameInList(
  holder: Record<string, unknown>,
  listKey: string,
  keys: readonly string[]
): void {
  const list = holder[listKey];
  if (!Array.isArray(list)) return;
  holder[listKey] = list.map((item) => {
    const r = asRecord(item);
    return r ? renameKeys(r, keys) : item;
  });
}

/** CFn `TargetParameters` -> the SDK shape (the `EcsTaskParameters` islands). */
export function toSdkTargetParameters(value: unknown): PipeTargetParameters | undefined {
  const target = asRecord(value);
  if (!target) return value as PipeTargetParameters | undefined;
  const ecs = asRecord(target['EcsTaskParameters']);
  if (!ecs) return target as PipeTargetParameters;
  return {
    ...target,
    EcsTaskParameters: toSdkEcsTaskParameters(ecs),
  } as unknown as PipeTargetParameters;
}

/**
 * go-to-k/cdkd#6233: the `UpdatePipe` value of a `TargetParameters` /
 * `EnrichmentParameters` block, given the desired and recorded CFn blocks.
 * `UpdatePipe` keeps a member it is not sent, so an `InputTemplate` the
 * previous template declared and the desired one drops is sent as `''`, which
 * clears it (measured us-east-1 2026-11-14: `{}` kept the template, `''`
 * cleared it, and CloudFormation cleared it on the same removal). `convert`
 * maps a desired block to its SDK shape. Returns `undefined` when there is
 * nothing to send; a malformed desired block is converted as it was before.
 */
export function toUpdateParameterBlock<T>(
  desired: unknown,
  previous: unknown,
  convert: (value: unknown) => T | undefined
): T | undefined {
  const next = asRecord(desired);
  const converted = desired === undefined ? undefined : convert(desired);
  const prev = asRecord(previous);
  const cleared =
    prev?.['InputTemplate'] !== undefined &&
    (desired === undefined || (next !== undefined && next['InputTemplate'] === undefined));
  if (!cleared) return converted;
  return { ...(converted ?? {}), InputTemplate: '' } as T;
}

/**
 * go-to-k/cdkd#6233: the members of a recorded `TargetParameters` /
 * `EnrichmentParameters` block the desired template drops and
 * {@link toUpdateParameterBlock} cannot clear, as `<block>.<member>`. What
 * `UpdatePipe` does with an omitted target block (`SqsQueueParameters`,
 * `HttpParameters`, ...) is unmeasured, so the update reports each one rather
 * than claim it. Empty when the desired block is malformed: that is refused or
 * warned about elsewhere, not read as a removal.
 */
export function parameterMembersLeftInPlace(
  block: 'TargetParameters' | 'EnrichmentParameters',
  desired: unknown,
  previous: unknown
): string[] {
  const prev = asRecord(previous);
  if (!prev) return [];
  const next = asRecord(desired);
  if (desired !== undefined && !next) return [];
  return Object.keys(prev)
    .filter((key) => key !== 'InputTemplate' && prev[key] !== undefined)
    .filter((key) => next?.[key] === undefined)
    .map((key) => `${block}.${key}`);
}

/**
 * The ONE warning line for {@link parameterMembersLeftInPlace}. Names are
 * template-borne, so they go through `safeMsg`. A rollback revert restores an
 * earlier state record, so there the member is one the failed deploy ADDED.
 */
export function parameterMembersLeftInPlaceWarning(
  logicalId: string,
  names: readonly string[],
  caller: 'deploy' | 'rollback'
): string {
  const one = names.length === 1;
  const subject = one ? 'property' : 'properties';
  return caller === 'rollback'
    ? safeMsg`${logicalId} (${PIPE_TYPE}): ${subject} ${names.join(', ')} ${one ? 'is' : 'are'} absent from the state being restored; UpdatePipe keeps a member it is not sent, so the rollback leaves the value the failed deploy applied in place.`
    : safeMsg`${logicalId} (${PIPE_TYPE}): ${subject} ${names.join(', ')} ${one ? 'was' : 'were'} removed from the template; cdkd leaves the current AWS value in place (whether CloudFormation resets it is unmeasured). Declare the intended value explicitly to change it.`;
}

/**
 * CFn `SourceParameters` -> the CreatePipe shape. The only divergence is
 * Kinesis `StartingPositionTimestamp`: CFn carries an ISO string, the SDK
 * types a `Date`; an offset-less string is read as UTC (issue #5311).
 */
export function toSdkSourceParameters(value: unknown): PipeSourceParameters | undefined {
  const source = asRecord(value);
  if (!source) return value as PipeSourceParameters | undefined;
  const kinesis = asRecord(source['KinesisStreamParameters']);
  if (!kinesis || typeof kinesis['StartingPositionTimestamp'] !== 'string') {
    return source as PipeSourceParameters;
  }
  return {
    ...source,
    KinesisStreamParameters: {
      ...kinesis,
      StartingPositionTimestamp: parseCfnTimestamp(kinesis['StartingPositionTimestamp']),
    },
  } as PipeSourceParameters;
}

/**
 * The `UpdatePipe` `SourceParameters` for a desired / previous pair
 * (go-to-k/cdkd#4423). Exported for the unit suite.
 *
 * - Each source block keeps only its {@link UPDATABLE_SOURCE_MEMBERS}: the
 *   create-only members are not members of the update shape at all.
 * - A block the previous template declared and the desired one drops is sent
 *   EMPTY. The API reference says an unspecified optional field goes to its
 *   system default, but that is not what was measured (us-east-1 2026-11-14,
 *   go-to-k/cdkd#6233): `SqsQueueParameters: {}` kept `BatchSize: 5`. Real
 *   CloudFormation removing the whole `SourceParameters` kept it too.
 * - A removed `FilterCriteria` is sent as `{ Filters: [] }`, the documented
 *   way to remove a filter; an absent one would keep the live filter. This is
 *   deliberately NOT CloudFormation parity: CloudFormation removing the whole
 *   `SourceParameters` kept the filter (same measurement).
 *
 * Returns `undefined` when neither side declares anything.
 */
export function toUpdateSourceParameters(
  desired: unknown,
  previous: unknown
): UpdatePipeSourceParameters | undefined {
  const next = asRecord(desired) ?? {};
  const prev = asRecord(previous) ?? {};
  const out: Record<string, unknown> = {};
  if (next['FilterCriteria'] !== undefined) {
    out['FilterCriteria'] = next['FilterCriteria'];
  } else if (prev['FilterCriteria'] !== undefined) {
    out['FilterCriteria'] = { Filters: [] };
  }
  for (const [block, members] of UPDATABLE_SOURCE_MEMBERS) {
    const desiredBlock = asRecord(next[block]);
    if (desiredBlock) {
      const kept: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(desiredBlock)) {
        if (members.has(key) && value !== undefined) kept[key] = value;
      }
      out[block] = kept;
    } else if (next[block] === undefined && prev[block] !== undefined) {
      out[block] = {};
    }
  }
  return Object.keys(out).length === 0 ? undefined : (out as UpdatePipeSourceParameters);
}

/** A key -> value tag map, refused when malformed (it would read as "no tags"). */
export function desiredTagMap(
  value: unknown,
  logicalId: string,
  physicalId?: string
): Record<string, string> {
  const tags = refuseMalformedDesiredTags(
    tagMapAsList(value),
    PIPE_TYPE,
    logicalId,
    physicalId,
    'Tags',
    'a map of tag keys to scalar values'
  );
  return Object.fromEntries(tags.map((t) => [t.Key, t.Value]));
}

/** Delete failures that are terminal on any read. */
const DELETE_FAILED_STATES: ReadonlySet<string> = new Set([
  'DELETE_FAILED',
  'DELETE_ROLLBACK_FAILED',
]);

/**
 * The delete wait's TERMINAL states, for one delete. Returning normally on
 * any of them would drop the state record of a live pipe.
 * - `DELETE_FAILED` / `DELETE_ROLLBACK_FAILED`, on any read.
 * - Any other `*_FAILED` state, only AFTER a `DELETING` read. Before it, the
 *   read may still show the state the pipe was in when the delete was sent
 *   (a pipe destroyed while in `UPDATE_FAILED`).
 * - Two consecutive `RUNNING` / `STOPPED` reads AFTER a `DELETING` read: the
 *   delete rolled back. A settled read before any `DELETING` read is not
 *   terminal: the delete may not have started yet.
 * The message names no already-deleted phrase (`delete-outcome.ts`).
 */
export function deleteFailureClassifier(
  resourceType: string,
  logicalId: string,
  physicalId: string
): (status: string) => Error | undefined {
  let sawDeleting = false;
  let settledAfterDeleting = 0;
  return (status) => {
    if (status === 'DELETING') {
      sawDeleting = true;
      settledAfterDeleting = 0;
      return undefined;
    }
    settledAfterDeleting = sawDeleting && SETTLED_STATES.has(status) ? settledAfterDeleting + 1 : 0;
    const terminal =
      DELETE_FAILED_STATES.has(status) ||
      (sawDeleting && status.endsWith('_FAILED')) ||
      settledAfterDeleting >= 2;
    if (!terminal) return undefined;
    return new ProvisioningError(
      `Pipe ${logicalId} reached ${status} after its delete was accepted; AWS will not ` +
        `finish the delete on its own, so cdkd keeps its record`,
      resourceType,
      logicalId,
      physicalId
    );
  };
}
