/**
 * go-to-k/cdkd#6665: a CloudWatch Logs log group, a Step Functions state
 * machine and an ECR repository are deleted BY NAME (the state machine by its
 * name-built ARN). None has an AWS-minted id, so cdkd records the creation
 * time each create answers with (`LogGroupIdentity` =
 * `<logGroupArn>@<creationTime>`, `CreationDate`, `CreatedAt`) and the delete
 * compares it on one describe before any write. A record without a usable
 * value makes no read and deletes by name, as before.
 *
 * Every case drives the provider's real method against a mocked client and
 * reads the commands it sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { ResourceNotFoundException } from '@aws-sdk/client-cloudwatch-logs';
import { StateMachineDoesNotExist } from '@aws-sdk/client-sfn';
import { RepositoryNotFoundException } from '@aws-sdk/client-ecr';

const { logsSend, stsSend, sfnSend, ecrSend } = vi.hoisted(() => ({
  logsSend: vi.fn(),
  stsSend: vi.fn(),
  sfnSend: vi.fn(),
  ecrSend: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: { send: logsSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: stsSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-sfn', async () => {
  const actual = await vi.importActual('@aws-sdk/client-sfn');
  return {
    ...actual,
    SFNClient: vi.fn(() => ({
      send: sfnSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-ecr', async () => {
  const actual = await vi.importActual('@aws-sdk/client-ecr');
  return {
    ...actual,
    ECRClient: vi.fn(() => ({
      send: ecrSend,
      config: { region: () => Promise.resolve('us-east-1') },
      middlewareStack: { add: vi.fn(), addRelativeTo: vi.fn() },
    })),
  };
});

const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => {
  const child = { ...log, child: () => child };
  return { getLogger: () => ({ ...log, child: () => child }) };
});

import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import { StepFunctionsProvider } from '../../../src/provisioning/providers/stepfunctions-provider.js';
import { ECRProvider } from '../../../src/provisioning/providers/ecr-provider.js';
import { resetCreateLogGroupLatchForTests } from '../../../src/provisioning/providers/logs-loggroup/own-replay.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
} from '../../../src/deployment/retryable-errors.js';
import {
  RECORDED_IDENTITY_REREAD_DELAY_MS,
  RecordedIdentityError,
  RecordedIdentityMismatchError,
} from '../../../src/provisioning/recorded-identity.js';
import {
  SURVIVOR_IDENTITY_ATTRIBUTES,
  identityTimestamp,
} from '../../../src/deployment/recorded-identity-attributes.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction/pairs.js';
import {
  createdBeforeFailure,
  createdResourceIdentityBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import type { DeleteContext } from '../../../src/provisioning/region-check.js';
import { stateOrphanRecordRemedy } from '../../../src/provisioning/state-orphan-remedy.js';
import { deniedIdentityReadRefusal } from '../../../src/provisioning/identity-read-denied.js';

type Command = { constructor: { name: string }; input: Record<string, unknown> };
const names = (send: ReturnType<typeof vi.fn>): string[] =>
  send.mock.calls.map((c) => (c[0] as Command).constructor.name);

/** Settle `promise`, advancing past the mismatch re-read's wait. */
async function settled(promise: Promise<unknown>): Promise<{ error?: Error }> {
  const outcome = promise.then(
    () => ({}),
    (error: unknown) => ({ error: error as Error })
  );
  await vi.advanceTimersByTimeAsync(RECORDED_IDENTITY_REREAD_DELAY_MS + 1);
  return outcome;
}

const throttle = (): Error =>
  Object.assign(new Error('Rate exceeded'), {
    name: 'ThrottlingException',
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });

/** An authorization failure as the SDK raises it, with AWS's text naming the caller. */
const denied = (): Error =>
  Object.assign(
    new Error(
      'User: arn:aws:sts::123456789012:assumed-role/Deployer/s is not authorized to perform: x on resource: y'
    ),
    { name: 'AccessDeniedException', $fault: 'client', $metadata: { httpStatusCode: 400 } }
  );

const notFound = (): Error =>
  new ResourceNotFoundException({ message: 'The specified log group does not exist.', $metadata: {} });

function expectDeniedRefusal(error: Error | undefined, permission: string): void {
  expect(error).toBeInstanceOf(RecordedIdentityError);
  expect(error).not.toBeInstanceOf(RecordedIdentityMismatchError);
  expect(isMarkedNonRetryable(error)).toBe(true);
  expect(isMarkedNotGone(error)).toBe(true);
  expect(error!.message).toContain(`AWS refused the ${permission} read`);
  expect(error!.message).toContain('(AccessDeniedException)');
  expect(error!.message).toContain(`Allow ${permission} for the identity running cdkd`);
  expect(error!.message).toContain('cdkd state orphan');
  expect(error!.message).not.toContain('123456789012');
  expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
}

const ctx = (recordedAttributes?: Record<string, unknown>): DeleteContext => ({
  expectedRegion: 'us-east-1',
  ...(recordedAttributes !== undefined && { recordedAttributes }),
});

beforeEach(() => {
  vi.useFakeTimers();
  for (const send of [logsSend, stsSend, sfnSend, ecrSend]) send.mockReset();
  stsSend.mockResolvedValue({ Account: '123456789012' });
  resetCreateLogGroupLatchForTests();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('identityTimestamp (go-to-k/cdkd#6665)', () => {
  it('is ISO UTC at whole seconds, so a create answer and a describe cannot differ on precision', () => {
    expect(identityTimestamp(new Date('2026-11-21T03:04:05.678Z'))).toBe('2026-11-21T03:04:05Z');
    expect(identityTimestamp(new Date('2026-11-21T03:04:05.000Z'))).toBe('2026-11-21T03:04:05Z');
    expect(identityTimestamp(new Date('nope'))).toBeUndefined();
    expect(identityTimestamp(undefined)).toBeUndefined();
  });

  it('the table names each type with the key its provider records', () => {
    expect(SURVIVOR_IDENTITY_ATTRIBUTES['AWS::Logs::LogGroup']).toBe('LogGroupIdentity');
    expect(SURVIVOR_IDENTITY_ATTRIBUTES['AWS::StepFunctions::StateMachine']).toBe('CreationDate');
    expect(SURVIVOR_IDENTITY_ATTRIBUTES['AWS::ECR::Repository']).toBe('CreatedAt');
  });
});

// ─── AWS::Logs::LogGroup ────────────────────────────────────────────

const LG_TYPE = 'AWS::Logs::LogGroup';
const LG = '/cdkd/App-Lg';
const LG_ARN = `arn:aws:logs:us-east-1:123456789012:log-group:${LG}`;
const LG_CREATED = 1_763_700_000_123;
const LG_TOKEN = `${LG_ARN}@${LG_CREATED}`;
const listed = (creationTime: number, extra: Record<string, unknown> = {}) => ({
  logGroups: [{ logGroupName: LG, logGroupArn: LG_ARN, creationTime, ...extra }],
});

describe('AWS::Logs::LogGroup (go-to-k/cdkd#6665)', () => {
  let provider: LogsLogGroupProvider;
  beforeEach(() => {
    provider = new LogsLogGroupProvider();
  });

  it('create records Arn and LogGroupIdentity from one DescribeLogGroups, in place of the STS read', async () => {
    logsSend.mockResolvedValueOnce({}); // CreateLogGroup
    logsSend.mockResolvedValueOnce(listed(LG_CREATED)); // DescribeLogGroups

    const result = await provider.create('Lg', LG_TYPE, { LogGroupName: LG });

    expect(result.attributes).toEqual({ Arn: `${LG_ARN}:*`, LogGroupIdentity: LG_TOKEN });
    expect(names(logsSend)).toEqual(['CreateLogGroupCommand', 'DescribeLogGroupsCommand']);
    expect(stsSend).not.toHaveBeenCalled();
  });

  it('create with a listed ARN not ending in the name records the STS-built Arn and no identity', async () => {
    logsSend.mockResolvedValueOnce({}); // CreateLogGroup
    logsSend.mockResolvedValueOnce({
      logGroups: [{ logGroupName: LG, logGroupArn: `${LG_ARN}-other`, creationTime: LG_CREATED }],
    });
    const result = await provider.create('Lg', LG_TYPE, { LogGroupName: LG });
    expect(result.attributes).toEqual({ Arn: `${LG_ARN}:*` });
    expect(stsSend).toHaveBeenCalledTimes(1);
  });

  it('create with an unreadable listing records the STS-built Arn and no identity', async () => {
    logsSend.mockResolvedValueOnce({}); // CreateLogGroup
    logsSend.mockRejectedValueOnce(throttle()); // DescribeLogGroups

    const result = await provider.create('Lg', LG_TYPE, { LogGroupName: LG });

    expect(result.attributes).toEqual({ Arn: `${LG_ARN}:*` });
    expect(stsSend).toHaveBeenCalledTimes(1);
  });

  it('the recorded token is what resourceIdentity and import answer for the same group', async () => {
    logsSend.mockResolvedValueOnce({}); // CreateLogGroup
    logsSend.mockResolvedValueOnce(listed(LG_CREATED));
    const created = await provider.create('Lg', LG_TYPE, { LogGroupName: LG });

    logsSend.mockResolvedValueOnce(listed(LG_CREATED));
    const live = await provider.resourceIdentity(LG, LG_TYPE, { expectedRegion: 'us-east-1' });
    logsSend.mockResolvedValueOnce(listed(LG_CREATED));
    const imported = await provider.import({
      logicalId: 'Lg',
      resourceType: LG_TYPE,
      stackName: 'App',
      region: 'us-east-1',
      properties: { LogGroupName: LG },
    });

    expect(live).toBe(created.attributes?.['LogGroupIdentity']);
    expect(imported?.attributes).toEqual({ LogGroupIdentity: live });
  });

  it('update returns LogGroupIdentity (a record lacking one acquires it)', async () => {
    logsSend.mockResolvedValue({});
    logsSend.mockResolvedValueOnce(listed(LG_CREATED)); // the only call: nothing changed
    const result = await provider.update(
      'Lg',
      LG,
      LG_TYPE,
      { LogGroupName: LG },
      { LogGroupName: LG }
    );
    expect(result.attributes).toEqual({ Arn: `${LG_ARN}:*`, LogGroupIdentity: LG_TOKEN });
  });

  it('no recorded identity: no read, the by-name delete', async () => {
    logsSend.mockResolvedValueOnce({});
    await provider.delete('Lg', LG, LG_TYPE, undefined, ctx({ Arn: `${LG_ARN}:*` }));
    expect(names(logsSend)).toEqual(['DeleteLogGroupCommand']);
  });

  it.each([SECRET_MASK, `x${SECRET_MASK}`, '{{resolve:secretsmanager:s}}', ''])(
    'a recorded value that is no id (%j): no read, the by-name delete',
    async (value) => {
      logsSend.mockResolvedValueOnce({});
      await provider.delete('Lg', LG, LG_TYPE, undefined, ctx({ LogGroupIdentity: value }));
      expect(names(logsSend)).toEqual(['DeleteLogGroupCommand']);
    }
  );

  it('the recorded group: one read, then the delete', async () => {
    logsSend.mockResolvedValueOnce(listed(LG_CREATED));
    logsSend.mockResolvedValueOnce({});
    await provider.delete('Lg', LG, LG_TYPE, undefined, ctx({ LogGroupIdentity: LG_TOKEN }));
    expect(names(logsSend)).toEqual(['DescribeLogGroupsCommand', 'DeleteLogGroupCommand']);
  });

  it('a mismatch whose re-read no longer lists the group: refused (re-run), nothing written', async () => {
    logsSend.mockResolvedValueOnce(listed(LG_CREATED + 60_000));
    logsSend.mockResolvedValueOnce({ logGroups: [] });
    const { error } = await settled(
      provider.delete('Lg', LG, LG_TYPE, undefined, ctx({ LogGroupIdentity: LG_TOKEN }))
    );
    expect(error).toBeInstanceOf(RecordedIdentityError);
    expect(error).not.toBeInstanceOf(RecordedIdentityMismatchError);
    expect(isMarkedNotGone(error)).toBe(true);
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(names(logsSend)).toEqual(['DescribeLogGroupsCommand', 'DescribeLogGroupsCommand']);
  });

  it('a group created at another time under the name: refused after a re-read, nothing written', async () => {
    logsSend.mockResolvedValue(listed(LG_CREATED + 60_000));
    const { error } = await settled(
      provider.delete('Lg', LG, LG_TYPE, undefined, {
        ...ctx({ LogGroupIdentity: LG_TOKEN }),
        removeProtection: true,
      })
    );
    expect(error).toBeInstanceOf(RecordedIdentityMismatchError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    // The whole message: the benign AWS re-create (adopt it, or delete it by
    // hand), else leave it and drop the record; no value of either group.
    expect(error!.message).toBe(
      'Cannot delete log group Lg: the log group now holding the name cdkd recorded is not the ' +
        'one cdkd created (its LogGroupIdentity differs from the recorded one), so cdkd sent no ' +
        "delete and kept the record. If AWS re-created it for this stack's own resource (for " +
        'example Lambda writing to its /aws/lambda/<function> group), adopt it with ' +
        "cdkd import '<stack>' --region '<region>' --resource Lg='<physicalId>' --force and " +
        're-run, or delete it yourself and re-run. Otherwise leave that log group alone and drop ' +
        `the record with ${stateOrphanRecordRemedy(ctx(), 'Lg')}.`
    );
    expect(error!.message).not.toContain(String(LG_CREATED));
    expect(error!.message).not.toContain(LG);
    // No protection flip, no delete.
    expect(names(logsSend)).toEqual(['DescribeLogGroupsCommand', 'DescribeLogGroupsCommand']);
  });

  it('not listed (a lagging listing, say): the by-name delete still runs; a live group is deleted', async () => {
    logsSend.mockResolvedValueOnce({ logGroups: [] });
    logsSend.mockResolvedValueOnce({}); // DeleteLogGroup: it was there
    await provider.delete('Lg', LG, LG_TYPE, undefined, ctx({ LogGroupIdentity: LG_TOKEN }));
    expect(names(logsSend)).toEqual(['DescribeLogGroupsCommand', 'DeleteLogGroupCommand']);
  });

  it("not listed and DeleteLogGroup's typed not-found: gone", async () => {
    logsSend.mockResolvedValueOnce({ logGroups: [] });
    logsSend.mockRejectedValueOnce(notFound());
    await provider.delete('Lg', LG, LG_TYPE, undefined, ctx({ LogGroupIdentity: LG_TOKEN }));
    expect(names(logsSend)).toEqual(['DescribeLogGroupsCommand', 'DeleteLogGroupCommand']);
  });

  it('not listed, then not found by a client in another region than the record: refused, never read as gone', async () => {
    logsSend.mockResolvedValueOnce({ logGroups: [] });
    logsSend.mockRejectedValueOnce(notFound());
    const { error } = await settled(
      provider.delete('Lg', LG, LG_TYPE, undefined, {
        expectedRegion: 'eu-west-1',
        recordedAttributes: { LogGroupIdentity: LG_TOKEN },
      })
    );
    expect(error!.message).toContain('Refusing to treat NotFound as idempotent delete success');
    expect(names(logsSend)).toEqual(['DescribeLogGroupsCommand', 'DeleteLogGroupCommand']);
  });

  it('a denied identity read: a non-retryable refusal naming the permission, nothing written', async () => {
    logsSend.mockRejectedValueOnce(denied());
    const { error } = await settled(
      provider.delete('Lg', LG, LG_TYPE, undefined, ctx({ LogGroupIdentity: LG_TOKEN }))
    );
    expectDeniedRefusal(error, 'logs:DescribeLogGroups');
    expect(names(logsSend)).toEqual(['DescribeLogGroupsCommand']);
  });

  it('an unreadable identity is left to the retry, never a by-name delete', async () => {
    logsSend.mockRejectedValueOnce(throttle());
    const { error } = await settled(
      provider.delete('Lg', LG, LG_TYPE, undefined, ctx({ LogGroupIdentity: LG_TOKEN }))
    );
    expect(error).toBeDefined();
    expect(error).not.toBeInstanceOf(RecordedIdentityError);
    expect(isRetryableTransientError(error, error!.message)).toBe(true);
    expect(names(logsSend)).toEqual(['DescribeLogGroupsCommand']);
  });

  it('a listing without creationTime refuses (marked not gone), nothing written', async () => {
    logsSend.mockResolvedValueOnce({ logGroups: [{ logGroupName: LG, logGroupArn: LG_ARN }] });
    const { error } = await settled(
      provider.delete('Lg', LG, LG_TYPE, undefined, ctx({ LogGroupIdentity: LG_TOKEN }))
    );
    expect(error).toBeInstanceOf(RecordedIdentityError);
    expect(isMarkedNotGone(error)).toBe(true);
    expect(names(logsSend)).toEqual(['DescribeLogGroupsCommand']);
  });

  it('--remove-protection reuses the identity read for its observation (one DescribeLogGroups)', async () => {
    logsSend.mockResolvedValueOnce(listed(LG_CREATED, { deletionProtectionEnabled: true }));
    logsSend.mockResolvedValue({});
    await provider.delete('Lg', LG, LG_TYPE, undefined, {
      ...ctx({ LogGroupIdentity: LG_TOKEN }),
      removeProtection: true,
    });
    expect(names(logsSend)).toEqual([
      'DescribeLogGroupsCommand',
      'PutLogGroupDeletionProtectionCommand',
      'DeleteLogGroupCommand',
    ]);
    expect((logsSend.mock.calls[1]![0] as Command).input['deletionProtectionEnabled']).toBe(false);
  });
});

// ─── AWS::StepFunctions::StateMachine ───────────────────────────────

const SM_TYPE = 'AWS::StepFunctions::StateMachine';
const SM_ARN = 'arn:aws:states:us-east-1:123456789012:stateMachine:Sm';
const SM_DATE = new Date('2026-11-21T03:04:05.678Z');
const SM_ID = '2026-11-21T03:04:05Z';

describe('AWS::StepFunctions::StateMachine (go-to-k/cdkd#6665)', () => {
  let provider: StepFunctionsProvider;
  beforeEach(() => {
    provider = new StepFunctionsProvider();
  });

  const smProps = { StateMachineName: 'Sm', RoleArn: 'arn:aws:iam::123456789012:role/r', DefinitionString: '{}' };

  it('create records CreationDate from the describe it already makes (no added call)', async () => {
    // The create answer differs by seconds: the describe's value is recorded.
    sfnSend.mockResolvedValueOnce({
      stateMachineArn: SM_ARN,
      creationDate: new Date(SM_DATE.getTime() - 3_000),
    });
    sfnSend.mockResolvedValueOnce({ revisionId: 'rev-1', creationDate: SM_DATE });
    const result = await provider.create('Sm', SM_TYPE, smProps);
    expect(result.attributes?.['CreationDate']).toBe(SM_ID);
    expect(names(sfnSend)).toEqual(['CreateStateMachineCommand', 'DescribeStateMachineCommand']);
  });

  it('create records no CreationDate when its describe fails (never the create answer)', async () => {
    sfnSend.mockResolvedValueOnce({ stateMachineArn: SM_ARN, creationDate: SM_DATE });
    sfnSend.mockRejectedValueOnce(throttle());
    const result = await provider.create('Sm', SM_TYPE, smProps);
    expect(result.attributes).not.toHaveProperty('CreationDate');
  });

  it('a denied identity read: a non-retryable refusal naming the permission, nothing written', async () => {
    sfnSend.mockRejectedValueOnce(denied());
    const { error } = await settled(
      provider.delete('Sm', SM_ARN, SM_TYPE, undefined, ctx({ CreationDate: SM_ID }))
    );
    expectDeniedRefusal(error, 'states:DescribeStateMachine');
    expect(names(sfnSend)).toEqual(['DescribeStateMachineCommand']);
  });

  it('resourceIdentity and import answer the recorded value; other ids and regions answer none', async () => {
    sfnSend.mockResolvedValueOnce({ name: 'Sm', creationDate: SM_DATE });
    expect(await provider.resourceIdentity(SM_ARN, SM_TYPE, { expectedRegion: 'us-east-1' })).toBe(
      SM_ID
    );
    sfnSend.mockResolvedValueOnce({ name: 'Sm', creationDate: SM_DATE });
    const imported = await provider.import({
      logicalId: 'Sm',
      resourceType: SM_TYPE,
      stackName: 'App',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: SM_ARN,
    });
    expect(imported?.attributes?.['CreationDate']).toBe(SM_ID);

    sfnSend.mockRejectedValueOnce(
      new StateMachineDoesNotExist({ message: 'gone', $metadata: {} })
    );
    expect(await provider.resourceIdentity(SM_ARN, SM_TYPE, { expectedRegion: 'us-east-1' })).toBe(
      RESOURCE_NOT_FOUND
    );
    expect(
      await provider.resourceIdentity('Sm', SM_TYPE, { expectedRegion: 'us-east-1' })
    ).toBeUndefined();
    expect(
      await provider.resourceIdentity(SM_ARN, SM_TYPE, { expectedRegion: 'eu-west-1' })
    ).toBeUndefined();
    expect(
      await provider.resourceIdentity(SM_ARN, 'AWS::SNS::Topic', { expectedRegion: 'us-east-1' })
    ).toBeUndefined();
    expect(names(sfnSend)).toEqual([
      'DescribeStateMachineCommand',
      'DescribeStateMachineCommand',
      'DescribeStateMachineCommand',
    ]);
  });

  it('update returns CreationDate from its describe (a record lacking one acquires it)', async () => {
    sfnSend.mockResolvedValue({ name: 'Sm', revisionId: 'r', creationDate: SM_DATE });
    const result = await provider.update('Sm', SM_ARN, SM_TYPE, smProps, smProps);
    expect(result.attributes?.['CreationDate']).toBe(SM_ID);
  });

  it('no recorded CreationDate: no read, the by-name delete', async () => {
    sfnSend.mockResolvedValueOnce({});
    await provider.delete('Sm', SM_ARN, SM_TYPE, undefined, ctx({ Arn: SM_ARN }));
    expect(names(sfnSend)).toEqual(['DeleteStateMachineCommand']);
  });

  it('the recorded state machine: one read, then the delete', async () => {
    sfnSend.mockResolvedValueOnce({ creationDate: SM_DATE });
    sfnSend.mockResolvedValueOnce({});
    await provider.delete('Sm', SM_ARN, SM_TYPE, undefined, ctx({ CreationDate: SM_ID }));
    expect(names(sfnSend)).toEqual(['DescribeStateMachineCommand', 'DeleteStateMachineCommand']);
  });

  it('a mismatch whose re-read finds it gone: the typed not-found arm, no delete sent', async () => {
    sfnSend.mockResolvedValueOnce({ creationDate: new Date('2026-11-21T05:00:00Z') });
    sfnSend.mockRejectedValueOnce(
      new StateMachineDoesNotExist({ message: 'gone', $metadata: {} })
    );
    const { error } = await settled(
      provider.delete('Sm', SM_ARN, SM_TYPE, undefined, ctx({ CreationDate: SM_ID }))
    );
    expect(error).toBeUndefined();
    expect(names(sfnSend)).toEqual(['DescribeStateMachineCommand', 'DescribeStateMachineCommand']);
  });

  it('a describe without creationDate refuses (marked not gone), nothing written', async () => {
    sfnSend.mockResolvedValueOnce({ name: 'Sm' });
    const { error } = await settled(
      provider.delete('Sm', SM_ARN, SM_TYPE, undefined, ctx({ CreationDate: SM_ID }))
    );
    expect(error).toBeInstanceOf(RecordedIdentityError);
    expect(isMarkedNotGone(error)).toBe(true);
    expect(names(sfnSend)).toEqual(['DescribeStateMachineCommand']);
  });

  it.each([SECRET_MASK, '{{resolve:secretsmanager:s}}'])(
    'a recorded CreationDate that is no id (%j): no read, the by-name delete',
    async (value) => {
      sfnSend.mockResolvedValueOnce({});
      await provider.delete('Sm', SM_ARN, SM_TYPE, undefined, ctx({ CreationDate: value }));
      expect(names(sfnSend)).toEqual(['DeleteStateMachineCommand']);
    }
  );

  it('one created at another time under the ARN: refused after a re-read, nothing written', async () => {
    sfnSend.mockResolvedValue({ creationDate: new Date('2026-11-21T05:00:00Z') });
    const { error } = await settled(
      provider.delete('Sm', SM_ARN, SM_TYPE, undefined, ctx({ CreationDate: SM_ID }))
    );
    expect(error).toBeInstanceOf(RecordedIdentityMismatchError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(error!.message).toContain('its CreationDate differs from the recorded one');
    expect(error!.message).not.toContain('cdkd import');
    expect(error!.message).not.toContain(SM_ID);
    expect(names(sfnSend)).toEqual(['DescribeStateMachineCommand', 'DescribeStateMachineCommand']);
  });

  it('gone on the read: the typed not-found arm (no delete sent)', async () => {
    sfnSend.mockRejectedValueOnce(
      new StateMachineDoesNotExist({ message: 'gone', $metadata: {} })
    );
    await provider.delete('Sm', SM_ARN, SM_TYPE, undefined, ctx({ CreationDate: SM_ID }));
    expect(names(sfnSend)).toEqual(['DescribeStateMachineCommand']);
  });

  it('an unreadable identity is left to the retry, never a by-name delete', async () => {
    sfnSend.mockRejectedValueOnce(throttle());
    const { error } = await settled(
      provider.delete('Sm', SM_ARN, SM_TYPE, undefined, ctx({ CreationDate: SM_ID }))
    );
    expect(error).not.toBeInstanceOf(RecordedIdentityError);
    expect(isRetryableTransientError(error, error!.message)).toBe(true);
    expect(names(sfnSend)).toEqual(['DescribeStateMachineCommand']);
  });
});

// ─── AWS::ECR::Repository ───────────────────────────────────────────

const ECR_TYPE = 'AWS::ECR::Repository';
const REPO = 'my-repo';
const REPO_DATE = new Date('2026-11-21T03:04:05.250Z');
const REPO_ID = '2026-11-21T03:04:05Z';
const repoListed = (createdAt: Date) => ({
  repositories: [{ repositoryName: REPO, repositoryArn: 'arn:r', repositoryUri: 'u', createdAt }],
});

describe('AWS::ECR::Repository (go-to-k/cdkd#6665)', () => {
  let provider: ECRProvider;
  beforeEach(() => {
    provider = new ECRProvider();
  });

  it('create records CreatedAt from CreateRepository (no added call)', async () => {
    ecrSend.mockResolvedValueOnce({
      repository: { repositoryName: REPO, repositoryArn: 'arn:r', repositoryUri: 'u', createdAt: REPO_DATE },
    });
    const result = await provider.create('Repo', ECR_TYPE, { RepositoryName: REPO });
    expect(result.attributes).toEqual({ Arn: 'arn:r', RepositoryUri: 'u', CreatedAt: REPO_ID });
    expect(names(ecrSend)).toEqual(['CreateRepositoryCommand']);
  });

  it('a failure after CreateRepository journals CreatedAt as the orphan identity', async () => {
    ecrSend.mockResolvedValueOnce({
      repository: { repositoryName: REPO, createdAt: REPO_DATE },
    });
    ecrSend.mockRejectedValueOnce(throttle()); // PutLifecyclePolicy
    const error = await provider
      .create('Repo', ECR_TYPE, {
        RepositoryName: REPO,
        LifecyclePolicy: { LifecyclePolicyText: '{}' },
      })
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(createdBeforeFailure(error, 'Repo', ECR_TYPE)).toBe(REPO);
    expect(createdResourceIdentityBeforeFailure(error, 'Repo', ECR_TYPE)).toBe(REPO_ID);
  });

  it('resourceIdentity and import answer the recorded value', async () => {
    ecrSend.mockResolvedValueOnce(repoListed(REPO_DATE));
    expect(await provider.resourceIdentity(REPO, ECR_TYPE, { expectedRegion: 'us-east-1' })).toBe(
      REPO_ID
    );
    ecrSend.mockResolvedValueOnce(repoListed(REPO_DATE));
    const imported = await provider.import({
      logicalId: 'Repo',
      resourceType: ECR_TYPE,
      stackName: 'App',
      region: 'us-east-1',
      properties: { RepositoryName: REPO },
    });
    expect(imported?.attributes).toEqual({ CreatedAt: REPO_ID });
    ecrSend.mockRejectedValueOnce(
      new RepositoryNotFoundException({ message: 'gone', $metadata: {} })
    );
    expect(await provider.resourceIdentity(REPO, ECR_TYPE, { expectedRegion: 'us-east-1' })).toBe(
      RESOURCE_NOT_FOUND
    );
    expect(
      await provider.resourceIdentity(REPO, ECR_TYPE, { expectedRegion: 'eu-west-1' })
    ).toBeUndefined();
  });

  it('update returns CreatedAt from its describe (a record lacking one acquires it)', async () => {
    ecrSend.mockResolvedValue(repoListed(REPO_DATE));
    const result = await provider.update(
      'Repo',
      REPO,
      ECR_TYPE,
      { RepositoryName: REPO },
      { RepositoryName: REPO }
    );
    expect(result.attributes?.['CreatedAt']).toBe(REPO_ID);
  });

  it('a denied identity read: a non-retryable refusal naming the permission, nothing written', async () => {
    ecrSend.mockRejectedValueOnce(denied());
    const { error } = await settled(
      provider.delete('Repo', REPO, ECR_TYPE, { EmptyOnDelete: true }, ctx({ CreatedAt: REPO_ID }))
    );
    expectDeniedRefusal(error, 'ecr:DescribeRepositories');
    expect(names(ecrSend)).toEqual(['DescribeRepositoriesCommand']);
  });

  it('no recorded CreatedAt: no read, the by-name delete', async () => {
    ecrSend.mockResolvedValueOnce({});
    await provider.delete('Repo', REPO, ECR_TYPE, {}, ctx({ Arn: 'arn:r' }));
    expect(names(ecrSend)).toEqual(['DeleteRepositoryCommand']);
  });

  it('the recorded repository: one read, then the delete', async () => {
    ecrSend.mockResolvedValueOnce(repoListed(REPO_DATE));
    ecrSend.mockResolvedValueOnce({});
    await provider.delete('Repo', REPO, ECR_TYPE, {}, ctx({ CreatedAt: REPO_ID }));
    expect(names(ecrSend)).toEqual(['DescribeRepositoriesCommand', 'DeleteRepositoryCommand']);
  });

  it('a mismatch whose re-read finds it gone: the typed not-found arm, no delete sent', async () => {
    ecrSend.mockResolvedValueOnce(repoListed(new Date('2026-11-22T00:00:00Z')));
    ecrSend.mockRejectedValueOnce(
      new RepositoryNotFoundException({ message: 'gone', $metadata: {} })
    );
    const { error } = await settled(
      provider.delete('Repo', REPO, ECR_TYPE, {}, ctx({ CreatedAt: REPO_ID }))
    );
    expect(error).toBeUndefined();
    expect(names(ecrSend)).toEqual(['DescribeRepositoriesCommand', 'DescribeRepositoriesCommand']);
  });

  it.each([
    ['another repository', { repositories: [{ repositoryName: 'other-repo', createdAt: REPO_DATE }] }],
    ['no createdAt', { repositories: [{ repositoryName: REPO }] }],
  ])('a listing naming %s carries no id of this one: refused, nothing written', async (_, listing) => {
    ecrSend.mockResolvedValueOnce(listing);
    const { error } = await settled(
      provider.delete('Repo', REPO, ECR_TYPE, {}, ctx({ CreatedAt: REPO_ID }))
    );
    expect(error).toBeInstanceOf(RecordedIdentityError);
    expect(error).not.toBeInstanceOf(RecordedIdentityMismatchError);
    expect(isMarkedNotGone(error)).toBe(true);
    expect(names(ecrSend)).toEqual(['DescribeRepositoriesCommand']);
    ecrSend.mockResolvedValueOnce(listing);
    expect(
      await provider.resourceIdentity(REPO, ECR_TYPE, { expectedRegion: 'us-east-1' })
    ).toBeUndefined();
  });

  it.each([SECRET_MASK, '{{resolve:secretsmanager:s}}'])(
    'a recorded CreatedAt that is no id (%j): no read, the by-name delete',
    async (value) => {
      ecrSend.mockResolvedValueOnce({});
      await provider.delete('Repo', REPO, ECR_TYPE, {}, ctx({ CreatedAt: value }));
      expect(names(ecrSend)).toEqual(['DeleteRepositoryCommand']);
    }
  );

  it('a repository created at another time under the name: refused, even with EmptyOnDelete', async () => {
    ecrSend.mockResolvedValue(repoListed(new Date('2026-11-22T00:00:00Z')));
    const { error } = await settled(
      provider.delete('Repo', REPO, ECR_TYPE, { EmptyOnDelete: true }, ctx({ CreatedAt: REPO_ID }))
    );
    expect(error).toBeInstanceOf(RecordedIdentityMismatchError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(error!.message).toContain('its CreatedAt differs from the recorded one');
    expect(error!.message).not.toContain(REPO_ID);
    expect(names(ecrSend)).toEqual(['DescribeRepositoriesCommand', 'DescribeRepositoriesCommand']);
  });

  it('gone on the read: the typed not-found arm (no delete sent)', async () => {
    ecrSend.mockRejectedValueOnce(
      new RepositoryNotFoundException({ message: 'gone', $metadata: {} })
    );
    await provider.delete('Repo', REPO, ECR_TYPE, {}, ctx({ CreatedAt: REPO_ID }));
    expect(names(ecrSend)).toEqual(['DescribeRepositoriesCommand']);
  });

  it('an unreadable identity is left to the retry, never a by-name delete', async () => {
    ecrSend.mockRejectedValueOnce(throttle());
    const { error } = await settled(
      provider.delete('Repo', REPO, ECR_TYPE, {}, ctx({ CreatedAt: REPO_ID }))
    );
    expect(error).not.toBeInstanceOf(RecordedIdentityError);
    expect(isRetryableTransientError(error, error!.message)).toBe(true);
    expect(names(ecrSend)).toEqual(['DescribeRepositoriesCommand']);
  });
});

describe('deniedIdentityReadRefusal (go-to-k/cdkd#6655)', () => {
  const refuse = (name: string, status: number) =>
    deniedIdentityReadRefusal(
      Object.assign(new Error('x'), { name, $metadata: { httpStatusCode: status } }),
      {
        label: 'log group',
        permission: 'logs:DescribeLogGroups',
        resourceType: 'AWS::Logs::LogGroup',
        logicalId: 'L',
        physicalId: '/p',
        context: undefined,
      }
    );

  it.each([
    ['AccessDenied', 403],
    ['AccessDeniedException', 400],
    ['UnauthorizedOperation', 403],
    ['AuthorizationError', 403],
    ['Forbidden', 403],
  ])('%s (%i) is a missing permission: refused', (name, status) => {
    expect(refuse(name, status)).toBeInstanceOf(RecordedIdentityError);
  });

  // Measured: RDS answers a wrong secret and a bad session token with 403.
  it.each([
    'ExpiredToken',
    'ExpiredTokenException',
    'RequestExpired',
    'RequestTimeTooSkewed',
    'SignatureDoesNotMatch',
    'InvalidSignatureException',
    'InvalidClientTokenId',
    'UnrecognizedClientException',
    'InvalidAccessKeyId',
    'InvalidToken',
    'IncompleteSignature',
    'IncompleteSignatureException',
    'MissingAuthenticationToken',
    'MissingAuthenticationTokenException',
    'AuthFailure',
  ])('%s (403) is a credential or clock failure, not a missing permission: the normal path', (name) => {
    expect(refuse(name, 403)).toBeUndefined();
  });

  it('names an allow, not a grant: an SCP or boundary can be what denies it', () => {
    const message = refuse('AccessDenied', 403)!.message;
    expect(message).toContain(
      'Allow logs:DescribeLogGroups for the identity running cdkd (an IAM policy, permission boundary, SCP or VPC endpoint policy may deny it) and re-run'
    );
    expect(message).not.toContain('Grant ');
  });
});
