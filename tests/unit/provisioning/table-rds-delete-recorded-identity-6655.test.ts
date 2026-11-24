/**
 * go-to-k/cdkd#6655 (D1): a DynamoDB table / RDS DB instance / RDS DB cluster
 * delete addresses the resource BY NAME (identifier). With the AWS-minted id
 * recorded (`TableId` / `DbiResourceId` / `DBClusterResourceId`), ONE describe
 * must answer with that id, or the delete is refused before ANY write: no
 * protection flip, no global-cluster detach, no delete, no final snapshot.
 * A record without a usable id makes no extra read and deletes as before;
 * a delete that already reads (`--remove-protection`'s observation, the read
 * replica check, the express writer) reuses the identity read.
 *
 * Every case drives the provider's real `delete()` against a mocked client and
 * reads the commands it sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { ResourceNotFoundException } from '@aws-sdk/client-dynamodb';

const { ddbSend, rdsSend } = vi.hoisted(() => ({ ddbSend: vi.fn(), rdsSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: ddbSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn(() => ({
      send: rdsSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

const log = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = { ...log, child: () => child };
  return { getLogger: () => ({ ...log, child: () => child }) };
});

import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
} from '../../../src/deployment/retryable-errors.js';
import {
  RECORDED_IDENTITY_REREAD_DELAY_MS,
  RecordedIdentityError,
  RecordedIdentityMismatchError,
} from '../../../src/provisioning/recorded-identity.js';
import type { DeleteContext } from '../../../src/provisioning/region-check.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction/pairs.js';
import { buildStackState } from '../../../src/cli/commands/import.js';
import { TemplateParser } from '../../../src/analyzer/template-parser.js';
import type { CloudFormationTemplate, ResourceImportInput } from '../../../src/types/resource.js';

type Command = { constructor: { name: string }; input: Record<string, unknown> };

let sent: Command[];
const names = (): string[] => sent.map((c) => c.constructor.name);
/** The commands sent before the first one named `name` (all of them when none). */
const before = (name: string): string[] => {
  const all = names();
  const at = all.indexOf(name);
  return at === -1 ? all : all.slice(0, at);
};

/** Settle `promise`, advancing past the mismatch re-read's wait. */
async function settled(promise: Promise<unknown>): Promise<{ error?: Error }> {
  const outcome = promise.then(
    () => ({}),
    (error: unknown) => ({ error: error as Error })
  );
  await vi.advanceTimersByTimeAsync(RECORDED_IDENTITY_REREAD_DELAY_MS);
  return outcome;
}

async function thrownBy(promise: Promise<unknown>): Promise<Error> {
  const { error } = await settled(promise);
  if (error === undefined) throw new Error('expected the delete to throw');
  return error;
}

async function succeeds(promise: Promise<unknown>): Promise<void> {
  const { error } = await settled(promise);
  if (error !== undefined) throw error;
}

function awsError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name, $metadata: { httpStatusCode: 400 } });
}

const throttled = (): Error => awsError('Throttling', 'Rate exceeded');

const RECORDED = 'id-recorded';
const SUCCESSOR = 'id-successor';

/** Asserts the refusal's shape, shared by every type. */
function expectMismatch(error: Error, attribute: string, logicalId: string): void {
  expect(error).toBeInstanceOf(RecordedIdentityMismatchError);
  expect(isMarkedNonRetryable(error)).toBe(true);
  expect(error.message).toContain(`${attribute} differs`);
  expect(error.message).toContain('kept the record');
  expect(error.message).toContain('cdkd state orphan');
  expect(error.message).toContain(`--resource ${logicalId}`);
  expect(error.message).not.toContain(RECORDED);
  expect(error.message).not.toContain(SUCCESSOR);
  expect(error.message).not.toMatch(/does not exist|not found|NotFound/i);
  // The maintainer's remedy for a resource the user put under the name
  // (go-to-k/cdkd#6655): re-adopt it with `cdkd import --force`; never the
  // claim that the recorded one is gone (a blue/green switchover keeps it).
  expect(error.message).toContain('may still exist under another name');
  expect(error.message).toContain(
    `cdkd import '<stack>' --region '<region>' --resource ${logicalId}='<physicalId>' --force`
  );
  expect(error.message).not.toContain('is gone');
  expect(error.message.indexOf('cdkd import')).toBeLessThan(
    error.message.indexOf('cdkd state orphan')
  );
}

/**
 * An authorization failure as the SDK raises it (go-to-k/cdkd#6655), with
 * AWS's text naming the caller. Measured spellings: DynamoDB answers
 * `AccessDeniedException` / 400, RDS `AccessDenied` / 403.
 */
function deniedError(name: string, status: number): Error {
  return Object.assign(
    new Error(
      'User: arn:aws:sts::123456789012:assumed-role/Deployer/s is not authorized to perform: x on resource: y'
    ),
    { name, $fault: 'client', $metadata: { httpStatusCode: status } }
  );
}

/** A credential failure answering 403 (measured on RDS): not a missing permission. */
const badSignature = (): Error =>
  Object.assign(new Error('The request signature we calculated does not match'), {
    name: 'SignatureDoesNotMatch',
    $fault: 'client',
    $metadata: { httpStatusCode: 403 },
  });

/** Asserts the denied-read refusal's shape, shared by every type. */
function expectDenied(error: Error, permission: string, errorClass: string, logicalId: string): void {
  expect(error).toBeInstanceOf(RecordedIdentityError);
  expect(error).not.toBeInstanceOf(RecordedIdentityMismatchError);
  expect(isMarkedNonRetryable(error)).toBe(true);
  expect(isMarkedNotGone(error)).toBe(true);
  expect(error.message).toContain(`AWS refused the ${permission} read`);
  expect(error.message).toContain(`(${errorClass})`);
  expect(error.message).toContain(`Allow ${permission} for the identity running cdkd`);
  expect(error.message).toContain('permission boundary, SCP or VPC endpoint policy');
  expect(error.message).toContain(`cdkd state orphan`);
  expect(error.message).toContain(`--resource ${logicalId}`);
  expect(error.message).not.toContain('123456789012');
  expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
}

const flipWarnings = (): string[] =>
  log.warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('deletion protection off'));

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(log)) fn.mockReset();
  ddbSend.mockReset();
  rdsSend.mockReset();
  sent = [];
  vi.useFakeTimers({ toFake: ['setTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// AWS::DynamoDB::Table
// ---------------------------------------------------------------------------

describe('AWS::DynamoDB::Table delete compares the recorded TableId (go-to-k/cdkd#6655)', () => {
  const TYPE = 'AWS::DynamoDB::Table';
  const NAME = 'orders';
  const gone = () =>
    new ResourceNotFoundException({ message: 'Requested resource not found', $metadata: {} });

  /**
   * A table answering `liveIds` (one per pre-delete read, the last repeated),
   * gone once `DeleteTable` is taken. `describeError` replaces every
   * pre-delete read.
   */
  function table(opts: {
    liveIds?: (string | undefined)[];
    describeError?: () => Error;
    protection?: boolean;
  }): void {
    let deleted = false;
    let reads = 0;
    ddbSend.mockImplementation(async (command: Command) => {
      sent.push(command);
      const name = command.constructor.name;
      if (name === 'DeleteTableCommand') {
        deleted = true;
        return {};
      }
      if (name === 'DescribeTableCommand') {
        if (deleted) throw gone();
        if (opts.describeError) throw opts.describeError();
        const ids = opts.liveIds ?? [RECORDED];
        const id = ids[Math.min(reads, ids.length - 1)];
        reads += 1;
        return {
          Table: {
            TableName: NAME,
            TableStatus: 'ACTIVE',
            ...(id !== undefined && { TableId: id }),
            DeletionProtectionEnabled: opts.protection === true,
          },
        };
      }
      return {};
    });
  }

  const del = (context?: DeleteContext) =>
    new DynamoDBTableProvider().delete('T', NAME, TYPE, undefined, context);
  const recorded = (extra?: Partial<DeleteContext>): DeleteContext => ({
    recordedAttributes: { TableId: RECORDED },
    expectedRegion: 'us-east-1',
    ...extra,
  });

  it('the live table carries the recorded TableId: one read, then deleted as before', async () => {
    table({});
    await succeeds(del(recorded()));
    expect(before('DeleteTableCommand')).toEqual(['DescribeTableCommand']);
    expect(names()).toContain('DeleteTableCommand');
  });

  it('another TableId under the name: refused, non-retryable, nothing written', async () => {
    table({ liveIds: [SUCCESSOR] });
    const error = await thrownBy(del(recorded()));
    expectMismatch(error, 'TableId', 'T');
    expect(error.message).toContain('a restore from a backup or to a point in time');
    // The read, and the one re-read after the wait.
    expect(names()).toEqual(['DescribeTableCommand', 'DescribeTableCommand']);
  });

  it('another TableId under --remove-protection: refused before the protection flip', async () => {
    table({ liveIds: [SUCCESSOR], protection: true });
    const error = await thrownBy(del(recorded({ removeProtection: true })));
    expectMismatch(error, 'TableId', 'T');
    expect(names()).not.toContain('UpdateTableCommand');
    expect(names()).not.toContain('DeleteTableCommand');
  });

  it.each([
    ['another holder', SUCCESSOR],
    ['an answer without the id', undefined],
  ] as const)(
    'an earlier attempt flipped the guard, then %s: nothing is re-protected by name, and it is said',
    async (_case, secondId) => {
    // Attempt 1 matches, flips protection off, and its DeleteTable is
    // throttled; by attempt 2 another table holds the name.
    let deleteCalls = 0;
    let reads = 0;
    ddbSend.mockImplementation(async (command: Command) => {
      sent.push(command);
      const name = command.constructor.name;
      if (name === 'DeleteTableCommand') {
        deleteCalls += 1;
        throw throttled();
      }
      if (name === 'DescribeTableCommand') {
        reads += 1;
        return {
          Table: {
            TableName: NAME,
            TableStatus: 'ACTIVE',
            TableId: deleteCalls === 0 ? RECORDED : secondId,
            DeletionProtectionEnabled: reads === 1,
          },
        };
      }
      return {};
    });
    const provider = new DynamoDBTableProvider();
    const run = () => provider.delete('T', NAME, TYPE, undefined, recorded({ removeProtection: true }));
    const first = await thrownBy(run());
    expect(first).not.toBeInstanceOf(RecordedIdentityError);
    expect(deleteCalls).toBeGreaterThan(0);
    sent = [];
    const second = await thrownBy(run());
    if (secondId === undefined) {
      expect(second).toBeInstanceOf(RecordedIdentityError);
      expect(second).not.toBeInstanceOf(RecordedIdentityMismatchError);
    } else {
      expectMismatch(second, 'TableId', 'T');
    }
    expect(flipWarnings()).toHaveLength(1);
    expect(flipWarnings()[0]).not.toContain(RECORDED);
    expect(names().filter((n) => n === 'UpdateTableCommand')).toEqual([]);
    expect(names()).not.toContain('DeleteTableCommand');
  }
  );

  it('--remove-protection with a match: the identity read is the observation (no second read)', async () => {
    table({ protection: true });
    await succeeds(del(recorded({ removeProtection: true })));
    expect(before('UpdateTableCommand')).toEqual(['DescribeTableCommand']);
    const flip = sent.find((c) => c.constructor.name === 'UpdateTableCommand');
    expect(flip?.input['DeletionProtectionEnabled']).toBe(false);
    expect(names()).toContain('DeleteTableCommand');
  });

  it('a first read answering the previous holder: the re-read decides, and it is deleted', async () => {
    table({ liveIds: [SUCCESSOR, RECORDED] });
    await succeeds(del(recorded()));
    expect(before('DeleteTableCommand')).toEqual(['DescribeTableCommand', 'DescribeTableCommand']);
  });

  it('no TableId recorded (a legacy record): no extra read, the by-name delete as before', async () => {
    table({ liveIds: [SUCCESSOR] });
    await succeeds(del({ recordedAttributes: { Arn: 'arn:aws:dynamodb:x' } }));
    expect(names()[0]).toBe('DeleteTableCommand');
    await succeeds(del(undefined));
    expect(names().filter((n) => n === 'DeleteTableCommand')).toHaveLength(2);
  });

  it('a masked recorded TableId is no id: no extra read, the by-name delete as before', async () => {
    table({ liveIds: [SUCCESSOR] });
    await succeeds(del({ recordedAttributes: { TableId: SECRET_MASK } }));
    expect(names()[0]).toBe('DeleteTableCommand');
  });

  it('the table is gone: the idempotent not-found path, nothing deleted', async () => {
    table({ describeError: gone });
    await succeeds(del(recorded()));
    expect(names()).toEqual(['DescribeTableCommand']);
  });

  it('DescribeTable throttled: thrown for the retry classifier, never a by-name delete', async () => {
    table({ describeError: throttled });
    const error = await thrownBy(del(recorded()));
    expect(error).not.toBeInstanceOf(RecordedIdentityError);
    expect(isRetryableTransientError(error, error.message)).toBe(true);
    expect(names()).toEqual(['DescribeTableCommand']);
  });

  it('DescribeTable denied: refused non-retryably naming the permission, nothing written', async () => {
    table({ describeError: () => deniedError('AccessDeniedException', 400) });
    const error = await thrownBy(del(recorded()));
    expectDenied(error, 'dynamodb:DescribeTable', 'AccessDeniedException', 'T');
    expect(names()).toEqual(['DescribeTableCommand']);
  });

  it('DescribeTable denied under --remove-protection: refused before the protection flip', async () => {
    table({ describeError: () => deniedError('AccessDeniedException', 400) });
    const error = await thrownBy(del(recorded({ removeProtection: true })));
    expectDenied(error, 'dynamodb:DescribeTable', 'AccessDeniedException', 'T');
    expect(names()).toEqual(['DescribeTableCommand']);
  });

  it('the re-read after a mismatch denied: the denied refusal, nothing written', async () => {
    let reads = 0;
    ddbSend.mockImplementation(async (command: Command) => {
      sent.push(command);
      if (command.constructor.name !== 'DescribeTableCommand') return {};
      reads += 1;
      if (reads > 1) throw deniedError('AccessDeniedException', 400);
      return { Table: { TableName: NAME, TableStatus: 'ACTIVE', TableId: SUCCESSOR } };
    });
    const error = await thrownBy(del(recorded()));
    expectDenied(error, 'dynamodb:DescribeTable', 'AccessDeniedException', 'T');
    expect(names()).toEqual(['DescribeTableCommand', 'DescribeTableCommand']);
  });

  it('DescribeTable answering an expired token: not reported as a missing permission', async () => {
    table({
      describeError: () =>
        Object.assign(new Error('The security token included in the request is expired'), {
          name: 'ExpiredTokenException',
          $fault: 'client',
          $metadata: { httpStatusCode: 403 },
        }),
    });
    const error = await thrownBy(del(recorded()));
    expect(error).not.toBeInstanceOf(RecordedIdentityError);
    expect(error.message).not.toContain('AWS refused the');
    expect(names()).toEqual(['DescribeTableCommand']);
  });

  it('DescribeTable answering without a TableId while one is recorded: thrown, nothing written', async () => {
    table({ liveIds: [undefined] });
    const error = await thrownBy(del(recorded()));
    expect(error).toBeInstanceOf(RecordedIdentityError);
    expect(error).not.toBeInstanceOf(RecordedIdentityMismatchError);
    expect(isMarkedNotGone(error)).toBe(true);
    expect(names()).toEqual(['DescribeTableCommand']);
  });
});

// ---------------------------------------------------------------------------
// AWS::RDS::DBInstance / AWS::RDS::DBCluster
// ---------------------------------------------------------------------------

/**
 * An RDS resource answering `liveIds` (one per pre-delete read, the last
 * repeated), gone once its `Delete*` is taken. `describeError` replaces every
 * pre-delete read.
 */
function rds(opts: {
  kind: 'instance' | 'cluster';
  identifier: string;
  liveIds?: (string | undefined)[];
  describeError?: () => Error;
  extra?: Record<string, unknown>;
}): void {
  const isCluster = opts.kind === 'cluster';
  const describeName = isCluster ? 'DescribeDBClustersCommand' : 'DescribeDBInstancesCommand';
  const deleteName = isCluster ? 'DeleteDBClusterCommand' : 'DeleteDBInstanceCommand';
  const notFound = isCluster ? 'DBClusterNotFoundFault' : 'DBInstanceNotFoundFault';
  let deleted = false;
  let reads = 0;
  rdsSend.mockImplementation(async (command: Command) => {
    sent.push(command);
    const name = command.constructor.name;
    if (name === deleteName) {
      deleted = true;
      return {};
    }
    if (name === describeName) {
      if (deleted) throw awsError(notFound);
      if (opts.describeError) throw opts.describeError();
      const ids = opts.liveIds ?? [RECORDED];
      const id = ids[Math.min(reads, ids.length - 1)];
      reads += 1;
      return isCluster
        ? {
            DBClusters: [
              {
                DBClusterIdentifier: opts.identifier,
                Status: 'available',
                DeletionProtection: false,
                ...(id !== undefined && { DbClusterResourceId: id }),
                ...opts.extra,
              },
            ],
          }
        : {
            DBInstances: [
              {
                DBInstanceIdentifier: opts.identifier,
                DBInstanceStatus: 'available',
                DeletionProtection: false,
                ...(id !== undefined && { DbiResourceId: id }),
                ...opts.extra,
              },
            ],
          };
    }
    return {};
  });
}

function rdsProvider(): RDSProvider {
  const provider = new RDSProvider();
  vi.spyOn(
    provider as unknown as { sleep: (ms: number) => Promise<void> },
    'sleep'
  ).mockResolvedValue(undefined);
  return provider;
}

/** Every RDS command that changes something: none may be sent on a refusal. */
const RDS_WRITES = /^(Delete|Modify|RemoveFrom)/;

describe('AWS::RDS::DBInstance delete compares the recorded DbiResourceId (go-to-k/cdkd#6655)', () => {
  const TYPE = 'AWS::RDS::DBInstance';
  const ID = 'db-1';
  const del = (context?: DeleteContext, properties?: Record<string, unknown>) =>
    rdsProvider().delete('I', ID, TYPE, properties, context);
  const recorded = (extra?: Partial<DeleteContext>): DeleteContext => ({
    recordedAttributes: { DbiResourceId: RECORDED },
    expectedRegion: 'us-east-1',
    ...extra,
  });
  const deleteInput = () =>
    sent.find((c) => c.constructor.name === 'DeleteDBInstanceCommand')?.input;

  it('the live instance carries the recorded id: one read, then the final-snapshot delete as before', async () => {
    rds({ kind: 'instance', identifier: ID });
    await succeeds(del(recorded({ finalSnapshotIdentifier: 'db-1-final-x' })));
    expect(before('DeleteDBInstanceCommand')).toEqual(['DescribeDBInstancesCommand']);
    expect(deleteInput()).toMatchObject({
      SkipFinalSnapshot: false,
      FinalDBSnapshotIdentifier: 'db-1-final-x',
    });
  });

  it('another DbiResourceId under the identifier: refused before the flip, the snapshot and the delete', async () => {
    rds({ kind: 'instance', identifier: ID, liveIds: [SUCCESSOR] });
    const error = await thrownBy(
      del(recorded({ finalSnapshotIdentifier: 'db-1-final-x', removeProtection: true }))
    );
    expectMismatch(error, 'DbiResourceId', 'I');
    expect(error.message).toContain('blue/green switchover');
    expect(names()).toEqual(['DescribeDBInstancesCommand', 'DescribeDBInstancesCommand']);
    expect(names().some((n) => RDS_WRITES.test(n))).toBe(false);
  });

  it('--remove-protection with a match: the identity read is the observation (no second read)', async () => {
    rds({ kind: 'instance', identifier: ID, extra: { DeletionProtection: true } });
    await succeeds(del(recorded({ removeProtection: true })));
    expect(before('ModifyDBInstanceCommand')).toEqual(['DescribeDBInstancesCommand']);
    expect(names()).toContain('DeleteDBInstanceCommand');
  });

  it.each([
    ['another holder', SUCCESSOR],
    ['an answer without the id', undefined],
  ] as const)(
    'an earlier attempt flipped the guard, then %s: nothing is re-protected by name, and it is said',
    async (_case, secondId) => {
    let deleteCalls = 0;
    let reads = 0;
    rdsSend.mockImplementation(async (command: Command) => {
      sent.push(command);
      const name = command.constructor.name;
      if (name === 'DeleteDBInstanceCommand') {
        deleteCalls += 1;
        throw throttled();
      }
      if (name === 'DescribeDBInstancesCommand') {
        reads += 1;
        return {
          DBInstances: [
            {
              DBInstanceIdentifier: ID,
              DBInstanceStatus: 'available',
              DeletionProtection: reads === 1,
              DbiResourceId: deleteCalls === 0 ? RECORDED : secondId,
            },
          ],
        };
      }
      return {};
    });
    const provider = rdsProvider();
    const run = () =>
      provider.delete('I', ID, TYPE, undefined, recorded({ removeProtection: true }));
    const first = await thrownBy(run());
    expect(first).not.toBeInstanceOf(RecordedIdentityError);
    expect(deleteCalls).toBeGreaterThan(0);
    sent = [];
    const second = await thrownBy(run());
    if (secondId === undefined) {
      expect(second).toBeInstanceOf(RecordedIdentityError);
      expect(second).not.toBeInstanceOf(RecordedIdentityMismatchError);
    } else {
      expectMismatch(second, 'DbiResourceId', 'I');
    }
    expect(flipWarnings()).toHaveLength(1);
    expect(flipWarnings()[0]).not.toContain(RECORDED);
    expect(names().some((n) => RDS_WRITES.test(n))).toBe(false);
  }
  );

  it('a declared read replica with a match: the identity read answers the replica check (no second read)', async () => {
    rds({
      kind: 'instance',
      identifier: ID,
      extra: { ReadReplicaSourceDBInstanceIdentifier: 'db-src' },
    });
    await succeeds(
      del(recorded({ finalSnapshotIdentifier: 'db-1-final-x' }), {
        SourceDBInstanceIdentifier: 'db-src',
      })
    );
    expect(before('DeleteDBInstanceCommand')).toEqual(['DescribeDBInstancesCommand']);
    expect(deleteInput()).toMatchObject({ SkipFinalSnapshot: true });
  });

  it('no DbiResourceId recorded (a legacy record): no extra read, the delete as before', async () => {
    rds({ kind: 'instance', identifier: ID, liveIds: [SUCCESSOR] });
    await succeeds(del({ recordedAttributes: { Endpoint: { Address: 'x' } } }));
    expect(names()[0]).toBe('DeleteDBInstanceCommand');
  });

  it('a masked recorded DbiResourceId is no id: no extra read', async () => {
    rds({ kind: 'instance', identifier: ID, liveIds: [SUCCESSOR] });
    await succeeds(del({ recordedAttributes: { DbiResourceId: `db-${SECRET_MASK}` } }));
    expect(names()[0]).toBe('DeleteDBInstanceCommand');
  });

  it('the instance is gone: the idempotent not-found path, nothing deleted', async () => {
    rds({
      kind: 'instance',
      identifier: ID,
      describeError: () => awsError('DBInstanceNotFoundFault'),
    });
    await succeeds(del(recorded()));
    expect(names()).toEqual(['DescribeDBInstancesCommand']);
  });

  it('DescribeDBInstances throttled: thrown for the retry classifier, never a by-identifier delete', async () => {
    rds({ kind: 'instance', identifier: ID, describeError: throttled });
    const error = await thrownBy(del(recorded()));
    expect(error).not.toBeInstanceOf(RecordedIdentityError);
    expect(isRetryableTransientError(error, error.message)).toBe(true);
    expect(names()).toEqual(['DescribeDBInstancesCommand']);
  });

  it('DescribeDBInstances denied: refused non-retryably naming the permission, nothing written', async () => {
    rds({ kind: 'instance', identifier: ID, describeError: () => deniedError('AccessDenied', 403) });
    const error = await thrownBy(del(recorded({ removeProtection: true })));
    expectDenied(error, 'rds:DescribeDBInstances', 'AccessDenied', 'I');
    expect(names()).toEqual(['DescribeDBInstancesCommand']);
  });

  it('the re-read after a mismatch denied: the denied refusal, nothing written', async () => {
    let reads = 0;
    rdsSend.mockImplementation(async (command: Command) => {
      sent.push(command);
      if (command.constructor.name !== 'DescribeDBInstancesCommand') return {};
      reads += 1;
      if (reads > 1) throw deniedError('AccessDenied', 403);
      return {
        DBInstances: [
          { DBInstanceIdentifier: ID, DBInstanceStatus: 'available', DbiResourceId: SUCCESSOR },
        ],
      };
    });
    const error = await thrownBy(del(recorded()));
    expectDenied(error, 'rds:DescribeDBInstances', 'AccessDenied', 'I');
    expect(names()).toEqual(['DescribeDBInstancesCommand', 'DescribeDBInstancesCommand']);
  });

  it('DescribeDBInstances answering a bad signature (403): not reported as a missing permission', async () => {
    rds({ kind: 'instance', identifier: ID, describeError: badSignature });
    const error = await thrownBy(del(recorded()));
    expect(error).not.toBeInstanceOf(RecordedIdentityError);
    expect(error.message).not.toContain('AWS refused the');
    expect(names()).toEqual(['DescribeDBInstancesCommand']);
  });

  it('a describe answering without a DbiResourceId while one is recorded: thrown, nothing written', async () => {
    rds({ kind: 'instance', identifier: ID, liveIds: [undefined] });
    const error = await thrownBy(del(recorded()));
    expect(error).toBeInstanceOf(RecordedIdentityError);
    expect(isMarkedNotGone(error)).toBe(true);
    expect(names().some((n) => RDS_WRITES.test(n))).toBe(false);
  });
});

describe('AWS::RDS::DBCluster delete compares the recorded DBClusterResourceId (go-to-k/cdkd#6655)', () => {
  const TYPE = 'AWS::RDS::DBCluster';
  const ID = 'cluster-1';
  const del = (context?: DeleteContext, properties?: Record<string, unknown>) =>
    rdsProvider().delete('C', ID, TYPE, properties, context);
  const recorded = (extra?: Partial<DeleteContext>): DeleteContext => ({
    recordedAttributes: { DBClusterResourceId: RECORDED },
    expectedRegion: 'us-east-1',
    ...extra,
  });
  const deleteInput = () =>
    sent.find((c) => c.constructor.name === 'DeleteDBClusterCommand')?.input;

  it('the live cluster carries the recorded id: one read, then the final-snapshot delete as before', async () => {
    rds({ kind: 'cluster', identifier: ID });
    await succeeds(del(recorded({ finalSnapshotIdentifier: 'cluster-1-final-x' })));
    expect(before('DeleteDBClusterCommand')).toEqual(['DescribeDBClustersCommand']);
    expect(deleteInput()).toMatchObject({
      SkipFinalSnapshot: false,
      FinalDBSnapshotIdentifier: 'cluster-1-final-x',
    });
  });

  it('another DBClusterResourceId: refused before the flip, the global detach, the snapshot and the delete', async () => {
    rds({ kind: 'cluster', identifier: ID, liveIds: [SUCCESSOR] });
    const error = await thrownBy(
      del(recorded({ finalSnapshotIdentifier: 'cluster-1-final-x', removeProtection: true }), {
        GlobalClusterIdentifier: 'my-global',
      })
    );
    expectMismatch(error, 'DBClusterResourceId', 'C');
    expect(names()).toEqual(['DescribeDBClustersCommand', 'DescribeDBClustersCommand']);
    expect(names().some((n) => RDS_WRITES.test(n))).toBe(false);
  });

  it.each([
    ['another holder', SUCCESSOR],
    ['an answer without the id', undefined],
  ] as const)(
    'an earlier attempt flipped the guard, then %s: nothing is re-protected by name, and it is said',
    async (_case, secondId) => {
    let deleteCalls = 0;
    let reads = 0;
    rdsSend.mockImplementation(async (command: Command) => {
      sent.push(command);
      const name = command.constructor.name;
      if (name === 'DeleteDBClusterCommand') {
        deleteCalls += 1;
        throw throttled();
      }
      if (name === 'DescribeDBClustersCommand') {
        reads += 1;
        return {
          DBClusters: [
            {
              DBClusterIdentifier: ID,
              Status: 'available',
              DeletionProtection: reads === 1,
              DbClusterResourceId: deleteCalls === 0 ? RECORDED : secondId,
            },
          ],
        };
      }
      return {};
    });
    const provider = rdsProvider();
    const run = () =>
      provider.delete('C', ID, TYPE, undefined, recorded({ removeProtection: true }));
    const first = await thrownBy(run());
    expect(first).not.toBeInstanceOf(RecordedIdentityError);
    expect(deleteCalls).toBeGreaterThan(0);
    sent = [];
    const second = await thrownBy(run());
    if (secondId === undefined) {
      expect(second).toBeInstanceOf(RecordedIdentityError);
      expect(second).not.toBeInstanceOf(RecordedIdentityMismatchError);
    } else {
      expectMismatch(second, 'DBClusterResourceId', 'C');
    }
    expect(flipWarnings()).toHaveLength(1);
    expect(flipWarnings()[0]).not.toContain(RECORDED);
    expect(names().some((n) => RDS_WRITES.test(n))).toBe(false);
  }
  );

  it('--remove-protection with a match: the identity read is the observation (no second read)', async () => {
    rds({ kind: 'cluster', identifier: ID, extra: { DeletionProtection: true } });
    await succeeds(del(recorded({ removeProtection: true })));
    expect(before('ModifyDBClusterCommand')).toEqual(['DescribeDBClustersCommand']);
    expect(names()).toContain('DeleteDBClusterCommand');
  });

  const WRITER = `${ID}-instance-1`;
  const withWriter = { DBClusterMembers: [{ DBInstanceIdentifier: WRITER, IsClusterWriter: true }] };

  it('an express-configuration cluster with a match: the identity read answers the writer check (no second read)', async () => {
    rds({ kind: 'cluster', identifier: ID, extra: withWriter });
    await succeeds(del(recorded(), { WithExpressConfiguration: true }));
    expect(before('DeleteDBClusterCommand')).toEqual([
      'DescribeDBClustersCommand',
      'DeleteDBInstanceCommand',
    ]);
    const writerDelete = sent.find((c) => c.constructor.name === 'DeleteDBInstanceCommand');
    expect(writerDelete?.input['DBInstanceIdentifier']).toBe(WRITER);
  });

  it('another DBClusterResourceId on an express-configuration cluster: the writer is not deleted either', async () => {
    rds({ kind: 'cluster', identifier: ID, liveIds: [SUCCESSOR], extra: withWriter });
    const error = await thrownBy(del(recorded(), { WithExpressConfiguration: true }));
    expectMismatch(error, 'DBClusterResourceId', 'C');
    expect(error.message).toContain('blue/green switchover');
    expect(names().some((n) => RDS_WRITES.test(n))).toBe(false);
  });

  it('no DBClusterResourceId recorded (a legacy record): no extra read, the delete as before', async () => {
    rds({ kind: 'cluster', identifier: ID, liveIds: [SUCCESSOR] });
    await succeeds(del({ recordedAttributes: { Endpoint: 'x' } }));
    expect(names()[0]).toBe('DeleteDBClusterCommand');
  });

  it('a masked recorded DBClusterResourceId is no id: no extra read', async () => {
    rds({ kind: 'cluster', identifier: ID, liveIds: [SUCCESSOR] });
    await succeeds(del({ recordedAttributes: { DBClusterResourceId: SECRET_MASK } }));
    expect(names()[0]).toBe('DeleteDBClusterCommand');
  });

  it('the cluster is gone: the idempotent not-found path, nothing deleted', async () => {
    rds({
      kind: 'cluster',
      identifier: ID,
      describeError: () => awsError('DBClusterNotFoundFault'),
    });
    await succeeds(del(recorded()));
    expect(names()).toEqual(['DescribeDBClustersCommand']);
  });

  it('DescribeDBClusters throttled: thrown for the retry classifier, never a by-identifier delete', async () => {
    rds({ kind: 'cluster', identifier: ID, describeError: throttled });
    const error = await thrownBy(del(recorded()));
    expect(error).not.toBeInstanceOf(RecordedIdentityError);
    expect(isRetryableTransientError(error, error.message)).toBe(true);
    expect(names()).toEqual(['DescribeDBClustersCommand']);
  });

  it('DescribeDBClusters denied: refused non-retryably naming the permission, nothing written', async () => {
    rds({ kind: 'cluster', identifier: ID, describeError: () => deniedError('AccessDenied', 403) });
    const error = await thrownBy(del(recorded({ removeProtection: true })));
    expectDenied(error, 'rds:DescribeDBClusters', 'AccessDenied', 'C');
    expect(names()).toEqual(['DescribeDBClustersCommand']);
  });

  it('DescribeDBClusters answering a bad signature (403): not reported as a missing permission', async () => {
    rds({ kind: 'cluster', identifier: ID, describeError: badSignature });
    const error = await thrownBy(del(recorded()));
    expect(error).not.toBeInstanceOf(RecordedIdentityError);
    expect(error.message).not.toContain('AWS refused the');
    expect(names()).toEqual(['DescribeDBClustersCommand']);
  });

  it('a describe naming another cluster while an id is recorded: thrown, nothing written', async () => {
    rds({ kind: 'cluster', identifier: 'cluster-other' });
    const error = await thrownBy(del(recorded()));
    expect(error).toBeInstanceOf(RecordedIdentityError);
    expect(isMarkedNotGone(error)).toBe(true);
    expect(names().some((n) => RDS_WRITES.test(n))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The refusal's remedy for a resource the user put under the name
// ---------------------------------------------------------------------------

describe('cdkd import --force over the record replaces the recorded id, so the next delete matches (go-to-k/cdkd#6655)', () => {
  /**
   * What `cdkd import <stack> --resource <id>=<physicalId> --force` writes for
   * one record: the provider's real `import()` read, merged over the existing
   * record (same physical id) by the command's own `buildStackState`.
   */
  async function reimport(
    provider: { import: (input: ResourceImportInput) => Promise<{ attributes?: Record<string, unknown> } | null> },
    resourceType: string,
    logicalId: string,
    physicalId: string,
    priorAttributes: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const imported = await provider.import({
      logicalId,
      resourceType,
      stackName: 'Stack',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: physicalId,
    } as ResourceImportInput);
    expect(imported).not.toBeNull();
    const template: CloudFormationTemplate = {
      Resources: { [logicalId]: { Type: resourceType, Properties: {} } },
    };
    const existing = {
      version: 10,
      stackName: 'Stack',
      region: 'us-east-1',
      resources: {
        [logicalId]: {
          physicalId,
          resourceType,
          properties: {},
          attributes: priorAttributes,
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    } as Parameters<typeof buildStackState>[5];
    const state = buildStackState(
      'Stack',
      'us-east-1',
      [
        {
          logicalId,
          resourceType,
          outcome: 'imported',
          physicalId,
          ...(imported?.attributes && { attributes: imported.attributes }),
        },
      ],
      new TemplateParser(),
      template,
      existing,
      true
    );
    return state.resources[logicalId]!.attributes ?? {};
  }

  it('AWS::DynamoDB::Table: TableId', async () => {
    const TYPE = 'AWS::DynamoDB::Table';
    let deleted = false;
    ddbSend.mockImplementation(async (command: Command) => {
      sent.push(command);
      const name = command.constructor.name;
      if (name === 'DeleteTableCommand') {
        deleted = true;
        return {};
      }
      if (name === 'DescribeTableCommand') {
        if (deleted) {
          throw new ResourceNotFoundException({ message: 'gone', $metadata: {} });
        }
        return { Table: { TableName: 'orders', TableStatus: 'ACTIVE', TableId: SUCCESSOR } };
      }
      return {};
    });
    const provider = new DynamoDBTableProvider();
    const attributes = await reimport(provider, TYPE, 'T', 'orders', {
      TableId: RECORDED,
      TableName: 'orders',
    });
    expect(attributes['TableId']).toBe(SUCCESSOR);
    sent = [];
    await succeeds(
      provider.delete('T', 'orders', TYPE, undefined, {
        recordedAttributes: attributes,
        expectedRegion: 'us-east-1',
      })
    );
    expect(names()).toContain('DeleteTableCommand');
  });

  it('AWS::RDS::DBInstance: DbiResourceId', async () => {
    const TYPE = 'AWS::RDS::DBInstance';
    rds({ kind: 'instance', identifier: 'db-1', liveIds: [SUCCESSOR] });
    const provider = rdsProvider();
    const attributes = await reimport(provider, TYPE, 'I', 'db-1', { DbiResourceId: RECORDED });
    expect(attributes['DbiResourceId']).toBe(SUCCESSOR);
    sent = [];
    await succeeds(
      provider.delete('I', 'db-1', TYPE, undefined, {
        recordedAttributes: attributes,
        expectedRegion: 'us-east-1',
      })
    );
    expect(names()).toContain('DeleteDBInstanceCommand');
  });

  it('AWS::RDS::DBCluster: DBClusterResourceId', async () => {
    const TYPE = 'AWS::RDS::DBCluster';
    rds({ kind: 'cluster', identifier: 'cluster-1', liveIds: [SUCCESSOR] });
    const provider = rdsProvider();
    const attributes = await reimport(provider, TYPE, 'C', 'cluster-1', {
      DBClusterResourceId: RECORDED,
    });
    expect(attributes['DBClusterResourceId']).toBe(SUCCESSOR);
    sent = [];
    await succeeds(
      provider.delete('C', 'cluster-1', TYPE, undefined, {
        recordedAttributes: attributes,
        expectedRegion: 'us-east-1',
      })
    );
    expect(names()).toContain('DeleteDBClusterCommand');
  });
});
