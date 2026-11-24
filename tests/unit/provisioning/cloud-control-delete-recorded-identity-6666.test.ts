/**
 * go-to-k/cdkd#6666: a Cloud Control-routed delete of a record holding an
 * AWS-minted id compares it with the live resource holding the name before
 * `DeleteResource`, refusing a different one. Every other record gets no
 * extra call.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const mockCloudControlSend = vi.hoisted(() => vi.fn());
const mockCloudControlConfigRegion = vi.hoisted(() => vi.fn());
const mockRdsDelete = vi.hoisted(() => vi.fn());

vi.mock('../../../src/provisioning/providers/rds-provider.js', () => ({
  RDSProvider: vi.fn(() => ({ delete: mockRdsDelete })),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: mockCloudControlConfigRegion },
    },
    cloudFormation: { send: vi.fn() },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: (): unknown => child,
  };
  return { getLogger: () => child };
});

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
} from '../../../src/deployment/retryable-errors.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';
import {
  CC_DELETE_RECORDED_IDENTITY_ATTRIBUTES,
  recordedCcDeleteIdentity,
} from '../../../src/provisioning/cloud-control/delete-guards.js';
import type { DeleteContext } from '../../../src/provisioning/region-check.js';
import {
  RECORDED_IDENTITY_REREAD_DELAY_MS,
  RecordedIdentityError,
} from '../../../src/provisioning/recorded-identity.js';
import { SURVIVOR_IDENTITY_ATTRIBUTES } from '../../../src/deployment/recorded-identity-attributes.js';

const REGION = 'us-east-1';
const ROLE = 'AWS::IAM::Role';
const RECORDED_ROLE_ID = 'AROARECORDED0000000001';
const OTHER_ROLE_ID = 'AROAOTHERHOLDER0000002';

function awsError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

/**
 * `GetResource` answers `get` (a model object, or an error to reject with);
 * `DeleteResource` and its status poll succeed.
 */
function wire(get: Record<string, unknown> | Error | undefined): void {
  mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'GetResourceCommand') {
      if (get instanceof Error) return Promise.reject(get);
      return Promise.resolve({
        ResourceDescription: get === undefined ? {} : { Properties: JSON.stringify(get) },
      });
    }
    if (name === 'DeleteResourceCommand') {
      return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-6666' } });
    }
    if (name === 'GetResourceRequestStatusCommand') {
      return Promise.resolve({ ProgressEvent: { OperationStatus: 'SUCCESS' } });
    }
    return Promise.resolve({});
  });
}

function sent(): string[] {
  return mockCloudControlSend.mock.calls.map(
    (call) => (call[0] as { constructor: { name: string } }).constructor.name
  );
}

describe('Cloud Control delete compares a recorded AWS-minted id (issue #6666)', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    mockCloudControlSend.mockReset();
    mockCloudControlConfigRegion.mockReset();
    mockCloudControlConfigRegion.mockResolvedValue(REGION);
    provider = new CloudControlProvider();
    vi.spyOn(provider as unknown as { sleep: (ms: number) => Promise<void> }, 'sleep').mockResolvedValue(
      undefined
    );
    vi.useFakeTimers({ toFake: ['setTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Settle a delete, advancing past the mismatch re-read's wait. */
  async function settle(
    logicalId: string,
    resourceType: string,
    physicalId: string,
    context: DeleteContext
  ): Promise<unknown> {
    const outcome = provider.delete(logicalId, physicalId, resourceType, {}, context).then(
      (value) => ({ resolved: value }),
      (e: unknown) => e
    );
    await vi.advanceTimersByTimeAsync(RECORDED_IDENTITY_REREAD_DELAY_MS);
    return outcome;
  }

  function del(
    resourceType: string,
    physicalId: string,
    context: DeleteContext
  ): Promise<unknown> {
    return settle('MyRes', resourceType, physicalId, { expectedRegion: REGION, ...context });
  }

  it('a live holder with the recorded id is deleted, after one GetResource', async () => {
    wire({ RoleName: 'my-role', RoleId: RECORDED_ROLE_ID });

    const outcome = await del(ROLE, 'my-role', { recordedAttributes: { RoleId: RECORDED_ROLE_ID } });

    expect(outcome).toEqual({ resolved: undefined });
    expect(sent().slice(0, 2)).toEqual(['GetResourceCommand', 'DeleteResourceCommand']);
    expect(sent().filter((n) => n === 'GetResourceCommand')).toHaveLength(1);
    const get = mockCloudControlSend.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(get.input).toEqual({ TypeName: ROLE, Identifier: 'my-role' });
  });

  it('a live holder with another id is refused, non-retryable, nothing deleted, neither id printed', async () => {
    wire({ RoleName: 'my-role', RoleId: OTHER_ROLE_ID });

    const error = await del(ROLE, 'my-role', { recordedAttributes: { RoleId: RECORDED_ROLE_ID } });

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('its RoleId differs from the recorded one');
    expect(message).toContain('sent no delete and kept the record');
    expect(message).toContain('cdkd state orphan');
    expect(message).toContain('--resource MyRes');
    expect(message).not.toContain(RECORDED_ROLE_ID);
    expect(message).not.toContain(OTHER_ROLE_ID);
    expect(isMarkedNonRetryable(error)).toBe(true);
    // The shared re-read after the eventual-consistency delay, then the refusal.
    expect(sent()).toEqual(['GetResourceCommand', 'GetResourceCommand']);
  });

  it('a mismatch that the re-read answers with the recorded id is deleted (a stale first read)', async () => {
    let reads = 0;
    mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === 'GetResourceCommand') {
        reads++;
        const RoleId = reads === 1 ? OTHER_ROLE_ID : RECORDED_ROLE_ID;
        return Promise.resolve({ ResourceDescription: { Properties: JSON.stringify({ RoleId }) } });
      }
      if (name === 'DeleteResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok' } });
      }
      return Promise.resolve({ ProgressEvent: { OperationStatus: 'SUCCESS' } });
    });

    const outcome = await del(ROLE, 'my-role', { recordedAttributes: { RoleId: RECORDED_ROLE_ID } });

    expect(outcome).toEqual({ resolved: undefined });
    expect(sent().slice(0, 3)).toEqual([
      'GetResourceCommand',
      'GetResourceCommand',
      'DeleteResourceCommand',
    ]);
  });

  it('a mismatch whose holder is gone on the re-read throws not gone, never a by-name delete', async () => {
    let reads = 0;
    mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name === 'GetResourceCommand') {
        reads++;
        return reads === 1
          ? Promise.resolve({
              ResourceDescription: { Properties: JSON.stringify({ RoleId: OTHER_ROLE_ID }) },
            })
          : Promise.reject(awsError('ResourceNotFoundException', 'gone'));
      }
      if (cmd.constructor.name === 'DeleteResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok' } });
      }
      return Promise.resolve({ ProgressEvent: { OperationStatus: 'SUCCESS' } });
    });

    const error = await del(ROLE, 'my-role', { recordedAttributes: { RoleId: RECORDED_ROLE_ID } });

    expect(error).toBeInstanceOf(Error);
    expect(isMarkedNotGone(error)).toBe(true);
    expect((error as Error).message).not.toContain(RECORDED_ROLE_ID);
    expect((error as Error).message).not.toContain(OTHER_ROLE_ID);
    expect(sent()).toEqual(['GetResourceCommand', 'GetResourceCommand']);
  });

  it('a stack destroy names the whole-stack orphan remedy', async () => {
    wire({ RoleId: OTHER_ROLE_ID });

    const error = await del(ROLE, 'my-role', {
      recordedAttributes: { RoleId: RECORDED_ROLE_ID },
      stackDestroy: true,
    });

    expect((error as Error).message).toContain('which drops every record the stack still has');
    expect(sent()).toEqual(['GetResourceCommand', 'GetResourceCommand']);
  });

  it.each([
    ['AWS::IAM::ManagedPolicy', 'arn:aws:iam::123456789012:policy/p', 'PolicyId'],
    ['AWS::RDS::DBInstance', 'my-db', 'DbiResourceId'],
    ['AWS::RDS::DBCluster', 'my-cluster', 'DBClusterResourceId'],
  ])('%s (%s): a different recorded %s is refused before DeleteResource', async (type, id, attribute) => {
    wire({ [attribute]: 'live-other' });

    const error = await del(type, id, { recordedAttributes: { [attribute]: 'recorded-own' } });

    expect((error as Error).message).toContain(`its ${attribute} differs`);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(sent()).toEqual(['GetResourceCommand', 'GetResourceCommand']);
  });

  it.each([
    ['AWS::RDS::DBInstance', 'DbiResourceId', { deletionPolicy: 'Delete' as const }],
    ['AWS::RDS::DBCluster', 'DBClusterResourceId', { skipFinalSnapshot: true }],
  ])(
    '%s handed to the SDK provider is compared first: a match is handed off with its recorded attributes',
    async (type, attribute, delegation) => {
      wire({ [attribute]: 'db-RECORDED' });
      mockRdsDelete.mockReset();
      mockRdsDelete.mockResolvedValue(undefined);
      const recordedAttributes = { [attribute]: 'db-RECORDED' };

      const outcome = await del(type, 'my-db', { recordedAttributes, ...delegation });

      expect(outcome).toEqual({ resolved: undefined });
      expect(sent()).toEqual(['GetResourceCommand']);
      expect(mockRdsDelete).toHaveBeenCalledTimes(1);
      expect((mockRdsDelete.mock.calls[0]![4] as DeleteContext).recordedAttributes).toBe(
        recordedAttributes
      );
    }
  );

  it('an RDS instance handed to the SDK provider with another holder is refused before the hand-off', async () => {
    wire({ DbiResourceId: 'db-OTHER' });
    mockRdsDelete.mockReset();

    const error = await del('AWS::RDS::DBInstance', 'my-db', {
      recordedAttributes: { DbiResourceId: 'db-RECORDED' },
      deletionPolicy: 'Delete',
    });

    expect((error as Error).message).toContain('its DbiResourceId differs');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(mockRdsDelete).not.toHaveBeenCalled();
  });

  it('a failed read whose text holds a not-found phrase is marked not gone and stays retryable', async () => {
    wire(awsError('ThrottlingException', 'Rate exceeded while the handler said resource not found'));

    const error = await settle('RoleNotFound', ROLE, 'my-role', {
      expectedRegion: REGION,
      recordedAttributes: { RoleId: RECORDED_ROLE_ID },
    });

    expect(isMarkedNotGone(error)).toBe(true);
    expect(isRetryableTransientError(error, (error as Error).message)).toBe(true);
    expect(sent()).toEqual(['GetResourceCommand']);
  });

  it('a refusal for a logical id spelling NotFound is non-retryable, so no classifier reads it as gone', async () => {
    wire({ RoleId: OTHER_ROLE_ID });

    const error = await settle('FooNotFoundRole', ROLE, 'my-role', {
      expectedRegion: REGION,
      recordedAttributes: { RoleId: RECORDED_ROLE_ID },
    });

    expect((error as Error).message).toContain('FooNotFoundRole');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(sent()).toEqual(['GetResourceCommand', 'GetResourceCommand']);
  });

  it.each([
    ['no recordedAttributes', undefined],
    ['a record without the id', { Arn: 'arn:aws:iam::123456789012:role/my-role' }],
    ['a masked id', { RoleId: '***' }],
    ['a secret reference', { RoleId: '{{resolve:secretsmanager:s}}' }],
    ['an empty id', { RoleId: '' }],
    ['a non-string id', { RoleId: 42 }],
  ])('%s: no read, the by-name delete as before', async (_label, recordedAttributes) => {
    wire(new Error('GetResource must not be sent'));

    const outcome = await del(ROLE, 'my-role', {
      ...(recordedAttributes !== undefined && { recordedAttributes }),
    });

    expect(outcome).toEqual({ resolved: undefined });
    expect(sent()).not.toContain('GetResourceCommand');
    expect(sent()).toContain('DeleteResourceCommand');
  });

  it.each([
    ['AWS::SQS::Queue', { QueueUrl: 'u', Arn: 'a' }],
    // CC's model has no TableId, so a recorded one (an SDK-shaped key) is not read.
    ['AWS::DynamoDB::Table', { TableId: 'abc', Arn: 'a' }],
    // Nor UserId / GroupId / InstanceProfileId (go-to-k/cdkd#6655's SDK ids).
    ['AWS::IAM::User', { UserId: 'AIDA0', Arn: 'a' }],
    ['AWS::IAM::Group', { GroupId: 'AGPA0', Arn: 'a' }],
    ['AWS::IAM::InstanceProfile', { InstanceProfileId: 'AIPA0', Arn: 'a' }],
  ])('%s: a type with no listed id gets no extra call', async (type, recordedAttributes) => {
    wire(new Error('GetResource must not be sent'));

    const outcome = await del(type, 'name', { recordedAttributes });

    expect(outcome).toEqual({ resolved: undefined });
    expect(sent()).not.toContain('GetResourceCommand');
  });

  it('Cloud Control reporting the resource absent proceeds to the delete and its already-deleted arm', async () => {
    mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === 'GetResourceCommand' || name === 'DeleteResourceCommand') {
        return Promise.reject(awsError('ResourceNotFoundException', 'gone'));
      }
      return Promise.resolve({});
    });

    const outcome = await del(ROLE, 'my-role', { recordedAttributes: { RoleId: RECORDED_ROLE_ID } });

    expect(outcome).toEqual({ resolved: undefined });
    expect(sent()).toEqual(['GetResourceCommand', 'DeleteResourceCommand']);
  });

  it('a throttled read throws for the retry classifiers, and nothing is deleted', async () => {
    wire(awsError('ThrottlingException', 'Rate exceeded'));

    const error = await del(ROLE, 'my-role', { recordedAttributes: { RoleId: RECORDED_ROLE_ID } });

    expect(error).toBeInstanceOf(Error);
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(isRetryableTransientError(error, (error as Error).message)).toBe(true);
    expect(sent()).toEqual(['GetResourceCommand']);
  });

  /**
   * go-to-k/cdkd#6655: measured on Cloud Control, both a denied
   * `cloudformation:GetResource` and the read handler's own denied call answer
   * `AccessDeniedException` (400), AWS's text naming the caller.
   */
  const deniedRead = (message: string): Error =>
    Object.assign(new Error(message), {
      name: 'AccessDeniedException',
      $fault: 'client',
      $metadata: { httpStatusCode: 400 },
    });
  const PERMISSION = `cloudformation:GetResource (with the ${ROLE} read handler's permissions)`;

  function expectDenied(error: unknown): void {
    expect(error).toBeInstanceOf(RecordedIdentityError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(isMarkedNotGone(error)).toBe(true);
    const message = (error as Error).message;
    expect(message).toContain(`AWS refused the ${PERMISSION} read`);
    expect(message).toContain('(AccessDeniedException)');
    expect(message).toContain(`Allow ${PERMISSION} for the identity running cdkd`);
    expect(message).toContain('--resource MyRes');
    expect(message).not.toContain('123456789012');
    expect(message).not.toContain('READ failed');
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
  }

  it.each([
    [
      'cloudformation:GetResource denied',
      'User: arn:aws:sts::123456789012:assumed-role/D/s is not authorized to perform: cloudformation:GetResource',
    ],
    [
      "the read handler's own call denied",
      'AWS::IAM::Role Handler returned status FAILED: User: arn:aws:sts::123456789012:assumed-role/D/s is not authorized to perform: iam:GetRole (Service: Iam, Status Code: 403) (HandlerErrorCode: AccessDenied)',
    ],
  ])('%s: refused non-retryably naming the permissions, never the by-name delete', async (_label, message) => {
    wire(deniedRead(message));

    const error = await del(ROLE, 'my-role', { recordedAttributes: { RoleId: RECORDED_ROLE_ID } });

    expectDenied(error);
    expect(sent()).toEqual(['GetResourceCommand']);
  });

  it('a denied re-read after a mismatch: the denied refusal, nothing deleted', async () => {
    let reads = 0;
    mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      if (cmd.constructor.name !== 'GetResourceCommand') return Promise.resolve({});
      reads += 1;
      if (reads > 1) return Promise.reject(deniedRead('not authorized'));
      return Promise.resolve({
        ResourceDescription: { Properties: JSON.stringify({ RoleId: OTHER_ROLE_ID }) },
      });
    });

    const error = await del(ROLE, 'my-role', { recordedAttributes: { RoleId: RECORDED_ROLE_ID } });

    expectDenied(error);
    expect(sent()).toEqual(['GetResourceCommand', 'GetResourceCommand']);
  });

  it('a denied read of an RDS instance is refused before the SDK hand-off', async () => {
    wire(deniedRead('not authorized'));
    mockRdsDelete.mockReset();

    const error = await del('AWS::RDS::DBInstance', 'my-db', {
      recordedAttributes: { DbiResourceId: 'db-RECORDED' },
      deletionPolicy: 'Delete',
    });

    expect(error).toBeInstanceOf(RecordedIdentityError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect((error as Error).message).toContain('Allow cloudformation:GetResource');
    expect(mockRdsDelete).not.toHaveBeenCalled();
    expect(sent()).toEqual(['GetResourceCommand']);
  });

  it('a credential failure on the read keeps the wrapped path, not a missing permission', async () => {
    wire(
      Object.assign(new Error('The security token included in the request is expired'), {
        name: 'ExpiredTokenException',
        $fault: 'client',
        $metadata: { httpStatusCode: 403 },
      })
    );

    const error = await del(ROLE, 'my-role', { recordedAttributes: { RoleId: RECORDED_ROLE_ID } });

    expect(error).not.toBeInstanceOf(RecordedIdentityError);
    expect((error as Error).message).toContain('READ failed for MyRes');
    expect(sent()).toEqual(['GetResourceCommand']);
  });

  it.each([
    ['a model without the id', { RoleName: 'my-role' }],
    ['no Properties at all', undefined],
  ])('%s throws, marked not gone and left to the retry classifiers: the identity cannot be confirmed', async (_label, model) => {
    wire(model);

    const error = await del(ROLE, 'my-role', { recordedAttributes: { RoleId: RECORDED_ROLE_ID } });

    expect((error as Error).message).toContain('answered without its RoleId');
    expect((error as Error).message).not.toContain(RECORDED_ROLE_ID);
    expect(isMarkedNotGone(error)).toBe(true);
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(sent()).toEqual(['GetResourceCommand']);
  });

  it('the identity table names only ids the Cloud Control schemas return', () => {
    expect([...CC_DELETE_RECORDED_IDENTITY_ATTRIBUTES]).toEqual([
      ['AWS::IAM::Role', 'RoleId'],
      ['AWS::IAM::ManagedPolicy', 'PolicyId'],
      ['AWS::RDS::DBInstance', 'DbiResourceId'],
      ['AWS::RDS::DBCluster', 'DBClusterResourceId'],
    ]);
    const readOnly = (type: string): string[] =>
      (
        JSON.parse(
          readFileSync(
            join(__dirname, '../../fixtures/cfn-schemas', `${type.replace(/::/g, '-')}.json`),
            'utf8'
          )
        ) as { readOnlyProperties: string[] }
      ).readOnlyProperties;
    for (const [type, attribute] of CC_DELETE_RECORDED_IDENTITY_ATTRIBUTES) {
      expect(readOnly(type)).toContain(attribute);
    }
    // Left out because Cloud Control's model does not return them.
    expect(readOnly('AWS::DynamoDB::Table')).not.toContain('TableId');
    expect(readOnly('AWS::IAM::User')).not.toContain('UserId');
    expect(readOnly('AWS::IAM::Group')).not.toContain('GroupId');
    expect(readOnly('AWS::IAM::InstanceProfile')).not.toContain('InstanceProfileId');
    expect(readOnly('AWS::Logs::LogGroup')).not.toContain('LogGroupIdentity');
    expect(readOnly('AWS::StepFunctions::StateMachine')).not.toContain('CreationDate');
    expect(readOnly('AWS::ECR::Repository')).not.toContain('CreatedAt');
    // Derived from the shared table: every entry but the types CC omits.
    expect(SURVIVOR_IDENTITY_ATTRIBUTES['AWS::DynamoDB::Table']).toBe('TableId');
    for (const omitted of [
      'AWS::DynamoDB::Table',
      'AWS::IAM::User',
      'AWS::IAM::Group',
      'AWS::IAM::InstanceProfile',
      'AWS::Logs::LogGroup',
      'AWS::StepFunctions::StateMachine',
      'AWS::ECR::Repository',
    ]) {
      expect(SURVIVOR_IDENTITY_ATTRIBUTES[omitted]).toBeDefined();
      expect(CC_DELETE_RECORDED_IDENTITY_ATTRIBUTES.has(omitted)).toBe(false);
    }
    expect(
      recordedCcDeleteIdentity('AWS::IAM::Role', { recordedAttributes: { RoleId: 'AROA1' } })
    ).toEqual({ key: 'RoleId', value: 'AROA1' });
    expect(
      recordedCcDeleteIdentity('AWS::DynamoDB::Table', { recordedAttributes: { TableId: 't' } })
    ).toBeUndefined();
  });
});
