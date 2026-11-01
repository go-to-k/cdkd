import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateBucketCommand,
  CreateBucketMetadataConfigurationCommand,
  DeleteBucketCommand,
  DeleteBucketMetadataConfigurationCommand,
  DeleteBucketTaggingCommand,
  GetBucketAbacCommand,
  GetBucketLocationCommand,
  GetBucketMetadataConfigurationCommand,
  GetBucketTaggingCommand,
  HeadBucketCommand,
  PutBucketAbacCommand,
  PutBucketTaggingCommand,
  UpdateBucketMetadataAnnotationTableConfigurationCommand,
  UpdateBucketMetadataInventoryTableConfigurationCommand,
  UpdateBucketMetadataJournalTableConfigurationCommand,
} from '@aws-sdk/client-s3';
import { TagResourceCommand, UntagResourceCommand } from '@aws-sdk/client-s3-control';

// go-to-k/cdkd#2762: AbacStatus, BucketNamePrefix, BucketNamespace and
// MetadataConfiguration on the SDK route. The expectations pin what a real
// CloudFormation A/B showed on 2026-11-01: a prefix names exactly
// `<prefix>-<account>-<region>-an`, PutBucketTagging is refused while ABAC is
// on, removing AbacStatus sends Disabled, and a table's encryption is fixed.

const mockSend = vi.hoisted(() => vi.fn());
const controlSend = vi.hoisted(() => vi.fn());
const controlDestroy = vi.hoisted(() => vi.fn());
const controlConfigs = vi.hoisted((): unknown[] => []);

vi.mock('@aws-sdk/client-s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-s3')>()),
  ...(await import('./s3-create-client-forward.js')).forwardedS3Client(),
}));

vi.mock('@aws-sdk/client-s3-control', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-s3-control')>()),
  S3ControlClient: class {
    send = controlSend;
    destroy = controlDestroy;
    constructor(config: unknown) {
      controlConfigs.push(config);
    }
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve('eu-west-1') } },
    credentialConfig: { profile: 'the-profile' },
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/deployment/intrinsic-function-resolver.js')>()),
  getAccountInfo: async () => ({ accountId: '123456789012', region: 'eu-west-1' }),
}));

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import {
  S3BucketProvider,
  resetS3BucketCreateRetryStateForTests,
} from '../../../src/provisioning/providers/s3-bucket-provider.js';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import { secretDerivedNamePairs } from '../../../src/deployment/rollback-executor/names.js';
import { keptForReadoption } from '../../../src/deployment/retained-readoption.js';

const TYPE = 'AWS::S3::Bucket';
const BUCKET = 'bucket';
const TABLE_ARN = (name: string): string =>
  `arn:aws:s3tables:eu-west-1:123456789012:bucket/aws-s3/table/${name}`;

const JOURNAL = { RecordExpiration: { Expiration: 'ENABLED', Days: 7 } };
const METADATA = { JournalTableConfiguration: JOURNAL };

const table = (name: string): Record<string, unknown> => ({
  TableStatus: 'ACTIVE',
  TableName: name,
  TableArn: TABLE_ARN(name),
});

const metadataResult = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  GetBucketMetadataConfigurationResult: {
    MetadataConfigurationResult: {
      DestinationResult: {
        TableBucketType: 'aws',
        TableBucketArn: 'arn:aws:s3tables:eu-west-1:123456789012:bucket/aws-s3',
        TableNamespace: `b_${BUCKET}`,
      },
      JournalTableConfigurationResult: {
        ...table('journal'),
        RecordExpiration: { Expiration: 'ENABLED', Days: 7 },
      },
      InventoryTableConfigurationResult: { ConfigurationState: 'DISABLED' },
      AnnotationTableConfigurationResult: { ConfigurationState: 'DISABLED' },
      ...over,
    },
  },
});

const named = (name: string): Error => Object.assign(new Error(name), { name });

let readMetadata: () => unknown;
let readAbac: () => unknown;
let liveTags: Array<{ Key: string; Value: string }>;

const sent = <T>(command: new (input: never) => T): T[] =>
  mockSend.mock.calls.map(([c]) => c as T).filter((c) => c instanceof command);
const order = (): string[] => mockSend.mock.calls.map(([c]) => (c as object).constructor.name);

beforeEach(() => {
  vi.clearAllMocks();
  controlConfigs.length = 0;
  resetS3BucketCreateRetryStateForTests();
  readMetadata = () => metadataResult();
  readAbac = () => ({ AbacStatus: { Status: 'Disabled' } });
  liveTags = [];
  mockSend.mockImplementation(async (command: unknown) => {
    if (command instanceof GetBucketMetadataConfigurationCommand) return readMetadata();
    if (command instanceof GetBucketAbacCommand) return readAbac();
    if (command instanceof GetBucketTaggingCommand) return { TagSet: liveTags };
    if (command instanceof GetBucketLocationCommand) return { LocationConstraint: 'eu-west-1' };
    return {};
  });
  controlSend.mockResolvedValue({});
});

describe('AWS::S3::Bucket naming (go-to-k/cdkd#2762)', () => {
  it('names a prefixed bucket <prefix>-<account>-<region>-an and sends the namespace', async () => {
    const result = await new S3BucketProvider().create('B', TYPE, {
      BucketNamePrefix: 'prefix',
      BucketNamespace: 'account-regional',
    });
    expect(result.physicalId).toBe('prefix-123456789012-eu-west-1-an');
    const [create] = sent(CreateBucketCommand);
    expect(create?.input.Bucket).toBe('prefix-123456789012-eu-west-1-an');
    expect(create?.input.BucketNamespace).toBe('account-regional');
  });

  it('sends the namespace of an explicit name, and none when undeclared', async () => {
    const provider = new S3BucketProvider();
    await provider.create('B', TYPE, {
      BucketName: 'n-123456789012-eu-west-1-an',
      BucketNamespace: 'account-regional',
    });
    await provider.create('C', TYPE, { BucketName: 'plain' });
    expect(sent(CreateBucketCommand).map((c) => c.input.BucketNamespace)).toEqual([
      'account-regional',
      undefined,
    ]);
  });

  it('holds a prefix name to the explicit-name rules: it is the template name, never adopted', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof CreateBucketCommand) throw named('BucketAlreadyOwnedByYou');
      // In this bucket's own region a generated name's holder would be adopted.
      if (command instanceof GetBucketLocationCommand) return { LocationConstraint: 'eu-west-1' };
      return { $metadata: {}, $response: { headers: { 'x-amz-bucket-region': 'eu-west-1' } } };
    });
    const created = new S3BucketProvider().create('B', TYPE, {
      BucketNamePrefix: 'prefix',
      BucketNamespace: 'account-regional',
    });
    await expect(created).rejects.toThrow(/prefix-123456789012-eu-west-1-an/);
  });

  it.each([
    [{ BucketName: 'n', BucketNamePrefix: 'p', BucketNamespace: 'account-regional' }, /only one/],
    [{ BucketNamePrefix: 'p' }, /only supported with BucketNamespace/],
    [{ BucketNamePrefix: 'p', BucketNamespace: 'global' }, /only supported with BucketNamespace/],
    [{ BucketNamePrefix: '', BucketNamespace: 'account-regional' }, /not a non-empty string/],
    [{ BucketNamePrefix: 7, BucketNamespace: 'account-regional' }, /not a non-empty string/],
  ])('refuses %j before any call, as CloudFormation does', async (properties, message) => {
    await expect(new S3BucketProvider().create('B', TYPE, properties)).rejects.toThrow(message);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('warns on a name a rollback restores rather than stopping it', async () => {
    await new S3BucketProvider().create(
      'B',
      TYPE,
      { BucketName: BUCKET, BucketNamePrefix: 'p' },
      { replayingState: true }
    );
    expect(sent(CreateBucketCommand)).toHaveLength(1);
    expect(warn.mock.calls.flat().join('\n')).toContain('restoring it anyway');
  });

  it('generates no name for a prefix: there is nothing for the adoption guard to read', () => {
    const provider = new S3BucketProvider();
    expect(provider.generatedCreateName(TYPE, 'B', { BucketNamePrefix: 'p' })).toBeUndefined();
  });
});

describe('AbacStatus (go-to-k/cdkd#2762)', () => {
  it('turns ABAC on after the tags of a create', async () => {
    await new S3BucketProvider().create('B', TYPE, {
      BucketName: BUCKET,
      AbacStatus: 'Enabled',
      Tags: [{ Key: 'k', Value: 'v' }],
    });
    expect(sent(PutBucketAbacCommand)[0]?.input.AbacStatus).toEqual({ Status: 'Enabled' });
  });

  it('sends nothing on a create that leaves ABAC at its default', async () => {
    await new S3BucketProvider().create('B', TYPE, { BucketName: BUCKET, AbacStatus: 'Disabled' });
    expect(sent(PutBucketAbacCommand)).toEqual([]);
  });

  it('turns ABAC off BEFORE tagging, when the template drops it', async () => {
    await new S3BucketProvider().update(
      'B',
      BUCKET,
      TYPE,
      { BucketName: BUCKET, Tags: [{ Key: 'k', Value: 'new' }] },
      { BucketName: BUCKET, AbacStatus: 'Enabled', Tags: [{ Key: 'k', Value: 'old' }] }
    );
    expect(sent(PutBucketAbacCommand)[0]?.input.AbacStatus).toEqual({ Status: 'Disabled' });
    const calls = order();
    expect(calls).toContain('PutBucketTaggingCommand');
    expect(calls.indexOf('PutBucketAbacCommand')).toBeLessThan(
      calls.indexOf('PutBucketTaggingCommand')
    );
  });

  it('turns ABAC on AFTER tagging', async () => {
    await new S3BucketProvider().update(
      'B',
      BUCKET,
      TYPE,
      { BucketName: BUCKET, AbacStatus: 'Enabled', Tags: [{ Key: 'k', Value: 'new' }] },
      { BucketName: BUCKET, Tags: [{ Key: 'k', Value: 'old' }] }
    );
    const calls = order();
    expect(calls).toContain('PutBucketTaggingCommand');
    expect(calls.indexOf('PutBucketTaggingCommand')).toBeLessThan(
      calls.indexOf('PutBucketAbacCommand')
    );
    expect(controlSend).not.toHaveBeenCalled();
  });

  it('tags a bucket staying on ABAC through S3 Control, keeping AWS keys out', async () => {
    liveTags = [
      { Key: 'gone', Value: '1' },
      { Key: 'keep', Value: '1' },
      { Key: 'aws:cloudformation:stack-name', Value: 's' },
    ];
    await new S3BucketProvider().update(
      'B',
      BUCKET,
      TYPE,
      { BucketName: BUCKET, AbacStatus: 'Enabled', Tags: [{ Key: 'keep', Value: '2' }] },
      {
        BucketName: BUCKET,
        AbacStatus: 'Enabled',
        Tags: [
          { Key: 'gone', Value: '1' },
          { Key: 'keep', Value: '1' },
        ],
      }
    );
    expect(sent(PutBucketTaggingCommand)).toEqual([]);
    expect(sent(DeleteBucketTaggingCommand)).toEqual([]);
    const [untag, tag] = controlSend.mock.calls.map(([c]) => c as { input: object });
    expect(controlConfigs).toEqual([
      expect.objectContaining({ region: 'eu-west-1', profile: 'the-profile' }),
    ]);
    expect(controlDestroy).toHaveBeenCalledTimes(1);
    expect(tag).toBeInstanceOf(TagResourceCommand);
    expect(tag?.input).toEqual({
      AccountId: '123456789012',
      ResourceArn: `arn:aws:s3:::${BUCKET}`,
      Tags: [{ Key: 'keep', Value: '2' }],
    });
    expect(untag).toBeInstanceOf(UntagResourceCommand);
    expect((untag?.input as { TagKeys: string[] }).TagKeys).toEqual(['gone']);
  });

  it('clears the tags of a bucket staying on ABAC with UntagResource alone', async () => {
    liveTags = [{ Key: 'gone', Value: '1' }];
    await new S3BucketProvider().update(
      'B',
      BUCKET,
      TYPE,
      { BucketName: BUCKET, AbacStatus: 'Enabled' },
      { BucketName: BUCKET, AbacStatus: 'Enabled', Tags: [{ Key: 'gone', Value: '1' }] }
    );
    expect(sent(DeleteBucketTaggingCommand)).toEqual([]);
    expect(controlSend).toHaveBeenCalledTimes(1);
    expect(controlSend.mock.calls[0]?.[0]).toBeInstanceOf(UntagResourceCommand);
  });

  it('writes nothing when the status does not move', async () => {
    const bag = { BucketName: BUCKET, AbacStatus: 'Disabled' };
    await new S3BucketProvider().update('B', BUCKET, TYPE, bag, { BucketName: BUCKET });
    expect(sent(PutBucketAbacCommand)).toEqual([]);
  });
});

describe('MetadataConfiguration writes (go-to-k/cdkd#2762)', () => {
  it('creates the configuration with only its writable members', async () => {
    const result = await new S3BucketProvider().create('B', TYPE, {
      BucketName: BUCKET,
      MetadataConfiguration: {
        Destination: { TableBucketType: 'aws' },
        JournalTableConfiguration: {
          TableName: 'journal',
          RecordExpiration: { Expiration: 'ENABLED', Days: '7' },
          EncryptionConfiguration: { SseAlgorithm: 'aws:kms', KmsKeyArn: 'k' },
        },
        InventoryTableConfiguration: { ConfigurationState: 'DISABLED' },
      },
    });
    expect(sent(CreateBucketMetadataConfigurationCommand)[0]?.input.MetadataConfiguration).toEqual({
      JournalTableConfiguration: {
        RecordExpiration: { Expiration: 'ENABLED', Days: 7 },
        EncryptionConfiguration: { SseAlgorithm: 'aws:kms', KmsKeyArn: 'k' },
      },
      InventoryTableConfiguration: { ConfigurationState: 'DISABLED' },
    });
    expect(result.attributes).toMatchObject({
      'MetadataConfiguration.Destination': {
        TableBucketArn: 'arn:aws:s3tables:eu-west-1:123456789012:bucket/aws-s3',
        TableBucketType: 'aws',
        TableNamespace: `b_${BUCKET}`,
      },
      'MetadataConfiguration.Destination.TableBucketArn':
        'arn:aws:s3tables:eu-west-1:123456789012:bucket/aws-s3',
      'MetadataConfiguration.Destination.TableBucketType': 'aws',
      'MetadataConfiguration.Destination.TableNamespace': `b_${BUCKET}`,
      'MetadataConfiguration.JournalTableConfiguration.TableArn': TABLE_ARN('journal'),
      'MetadataConfiguration.JournalTableConfiguration.TableName': 'journal',
    });
  });

  it('waits for the ARN of every table the configuration turns on', async () => {
    vi.useFakeTimers();
    try {
      const reads = [
        metadataResult({
          JournalTableConfigurationResult: { TableStatus: 'CREATING', TableName: 'journal' },
          InventoryTableConfigurationResult: { ConfigurationState: 'ENABLED' },
        }),
        metadataResult({
          InventoryTableConfigurationResult: { ConfigurationState: 'ENABLED' },
        }),
      ];
      const settled = metadataResult({
        InventoryTableConfigurationResult: {
          ConfigurationState: 'ENABLED',
          ...table('inventory'),
        },
      });
      readMetadata = () => reads.shift() ?? settled;
      const created = new S3BucketProvider().create('B', TYPE, {
        BucketName: BUCKET,
        MetadataConfiguration: {
          JournalTableConfiguration: JOURNAL,
          InventoryTableConfiguration: { ConfigurationState: 'ENABLED' },
        },
      });
      await vi.runAllTimersAsync();
      const { attributes } = await created;
      // Three wait reads, the last one settled, then the attribute read.
      expect(sent(GetBucketMetadataConfigurationCommand)).toHaveLength(4);
      expect(attributes?.['MetadataConfiguration.InventoryTableConfiguration.TableArn']).toBe(
        TABLE_ARN('inventory')
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('polls past a configuration S3 cannot read yet', async () => {
    vi.useFakeTimers();
    try {
      let first = true;
      readMetadata = () => {
        if (first) {
          first = false;
          throw named('MetadataConfigurationNotFound');
        }
        return metadataResult();
      };
      const created = new S3BucketProvider().create('B', TYPE, {
        BucketName: BUCKET,
        MetadataConfiguration: METADATA,
      });
      await vi.runAllTimersAsync();
      await expect(created).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives a table that never settles a bounded wait, then warns', async () => {
    vi.useFakeTimers();
    try {
      readMetadata = () =>
        metadataResult({
          JournalTableConfigurationResult: { TableStatus: 'CREATING', TableName: 'journal' },
        });
      const created = new S3BucketProvider().create('B', TYPE, {
        BucketName: BUCKET,
        MetadataConfiguration: METADATA,
      });
      await vi.runAllTimersAsync();
      await expect(created).resolves.toBeDefined();
      expect(warn.mock.calls.flat().join('\n')).toContain('Gave up waiting for the journal table');
    } finally {
      vi.useRealTimers();
    }
  });

  const failedJournal = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    JournalTableConfigurationResult: {
      TableStatus: 'FAILED',
      TableName: 'journal',
      Error: {
        ErrorCode: 'JournalTableAlreadyExists',
        ErrorMessage: 'role arn:aws:iam::123456789012:role/r failed',
      },
      ...over,
    },
  });

  it.each([
    ['create', true],
    ['update', false],
  ])('warns once on a failed table and completes the %s, as CloudFormation does', async (_, isCreate) => {
    // The journal has no ARN and another table is pending, so the wait polls
    // on and only `continue` and the one-warning guard keep this to one line.
    vi.useFakeTimers();
    try {
      const reads = [
        metadataResult({
          ...failedJournal(),
          InventoryTableConfigurationResult: { ConfigurationState: 'ENABLED' },
        }),
      ];
      const settled = metadataResult({
        ...failedJournal(),
        InventoryTableConfigurationResult: { ConfigurationState: 'ENABLED', ...table('inventory') },
      });
      readMetadata = () => reads.shift() ?? settled;
      const desired = {
        BucketName: BUCKET,
        MetadataConfiguration: {
          JournalTableConfiguration: JOURNAL,
          InventoryTableConfiguration: { ConfigurationState: 'ENABLED' },
        },
      };
      const provider = new S3BucketProvider();
      const done = isCreate
        ? provider.create('B', TYPE, desired)
        : provider.update('B', BUCKET, TYPE, desired, { BucketName: BUCKET });
      await vi.runAllTimersAsync();
      await expect(done).resolves.toBeDefined();
    } finally {
      vi.useRealTimers();
    }
    const lines = warn.mock.calls.flat().map(String);
    const failures = lines.filter((l) => l.includes('JournalTableAlreadyExists'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(`--namespace b_${BUCKET} --name journal`);
    expect(lines.join('\n')).not.toContain('role/r');
    expect(lines.join('\n')).not.toContain('Gave up');
    expect(sent(DeleteBucketCommand)).toEqual([]);
  });

  it('deletes the configuration when the template drops it, and tolerates it being gone', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof DeleteBucketMetadataConfigurationCommand) {
        throw named('MetadataConfigurationNotFound');
      }
      if (command instanceof GetBucketLocationCommand) return { LocationConstraint: 'eu-west-1' };
      return {};
    });
    await new S3BucketProvider().update(
      'B',
      BUCKET,
      TYPE,
      { BucketName: BUCKET },
      { BucketName: BUCKET, MetadataConfiguration: METADATA }
    );
    expect(sent(DeleteBucketMetadataConfigurationCommand)).toHaveLength(1);
  });

  it('does not swallow any other failure of the delete', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof DeleteBucketMetadataConfigurationCommand) throw named('AccessDenied');
      if (command instanceof GetBucketLocationCommand) return { LocationConstraint: 'eu-west-1' };
      return {};
    });
    await expect(
      new S3BucketProvider().update(
        'B',
        BUCKET,
        TYPE,
        { BucketName: BUCKET },
        { BucketName: BUCKET, MetadataConfiguration: METADATA }
      )
    ).rejects.toThrow();
  });

  it.each([
    ['a non-object', 'x', /MetadataConfiguration must be an object/],
    ['no journal', {}, /JournalTableConfiguration must be an object/],
    [
      'no expiration',
      { JournalTableConfiguration: { RecordExpiration: {} } },
      /Expiration must be a string/,
    ],
    [
      'a Days that is no integer',
      { JournalTableConfiguration: { RecordExpiration: { Expiration: 'ENABLED', Days: 'x' } } },
      /Days must be an integer/,
    ],
    [
      'an empty Days',
      { JournalTableConfiguration: { RecordExpiration: { Expiration: 'ENABLED', Days: '' } } },
      /Days must be an integer/,
    ],
    [
      'a table with no state',
      { JournalTableConfiguration: JOURNAL, InventoryTableConfiguration: {} },
      /ConfigurationState must be a string/,
    ],
    [
      'an encryption with no algorithm',
      {
        JournalTableConfiguration: JOURNAL,
        AnnotationTableConfiguration: { ConfigurationState: 'ENABLED', EncryptionConfiguration: {} },
      },
      /must be an object with an SseAlgorithm/,
    ],
  ])('refuses %s: a create before any call, an update before any write', async (_, bad, message) => {
    const desired = { BucketName: BUCKET, MetadataConfiguration: bad };
    await expect(new S3BucketProvider().create('B', TYPE, desired)).rejects.toThrow(message);
    expect(mockSend).not.toHaveBeenCalled();
    await expect(
      new S3BucketProvider().update('B', BUCKET, TYPE, desired, {
        BucketName: BUCKET,
        MetadataConfiguration: METADATA,
      })
    ).rejects.toThrow(message);
    expect(sent(DeleteBucketMetadataConfigurationCommand)).toEqual([]);
  });

  it('leaves a state-borne malformed value alone, with a warning, and records the previous one', async () => {
    const result = await new S3BucketProvider().update(
      'B',
      BUCKET,
      TYPE,
      { BucketName: BUCKET, MetadataConfiguration: 'x' },
      { BucketName: BUCKET, MetadataConfiguration: METADATA },
      { replayingState: true }
    );
    expect(sent(DeleteBucketMetadataConfigurationCommand)).toEqual([]);
    expect(warn.mock.calls.flat().join('\n')).toContain('was left as it is');
    expect(result.effectiveProperties?.['MetadataConfiguration']).toEqual(METADATA);
  });

  it.each([['x'], [{}]])(
    'restores no malformed configuration %j on a rollback, and does not stop it',
    async (bad) => {
      await new S3BucketProvider().create(
        'B',
        TYPE,
        { BucketName: BUCKET, MetadataConfiguration: bad },
        { replayingState: true }
      );
      expect(sent(CreateBucketMetadataConfigurationCommand)).toEqual([]);
      expect(warn.mock.calls.flat().join('\n')).toContain(
        'no S3 Metadata configuration was restored'
      );
    }
  );

  it('restores ABAC and the configuration of a valid record on a rollback', async () => {
    await new S3BucketProvider().create(
      'B',
      TYPE,
      { BucketName: BUCKET, AbacStatus: 'Enabled', MetadataConfiguration: METADATA },
      { replayingState: true }
    );
    expect(sent(PutBucketAbacCommand)).toHaveLength(1);
    expect(sent(CreateBucketMetadataConfigurationCommand)).toHaveLength(1);
  });

  it('warns when a rollback cannot read the tables it waits for, and a template fails', async () => {
    readMetadata = () => {
      throw named('AccessDenied');
    };
    const bag = { BucketName: BUCKET, MetadataConfiguration: METADATA };
    await new S3BucketProvider().update(
      'B',
      BUCKET,
      TYPE,
      bag,
      { BucketName: BUCKET },
      { replayingState: true }
    );
    expect(warn.mock.calls.flat().join('\n')).toContain('not waiting for them');
    await expect(
      new S3BucketProvider().update('B', BUCKET, TYPE, bag, { BucketName: BUCKET })
    ).rejects.toThrow('AccessDenied');
  });

  it('converges from what S3 holds when a retry finds the configuration already there', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof CreateBucketMetadataConfigurationCommand) {
        throw named('MetadataConfigurationAlreadyExists');
      }
      if (command instanceof GetBucketMetadataConfigurationCommand) return readMetadata();
      if (command instanceof GetBucketLocationCommand) return { LocationConstraint: 'eu-west-1' };
      return {};
    });
    await new S3BucketProvider().update(
      'B',
      BUCKET,
      TYPE,
      {
        BucketName: BUCKET,
        MetadataConfiguration: {
          JournalTableConfiguration: { RecordExpiration: { Expiration: 'ENABLED', Days: 30 } },
        },
      },
      { BucketName: BUCKET }
    );
    expect(
      sent(UpdateBucketMetadataJournalTableConfigurationCommand)[0]?.input.JournalTableConfiguration
    ).toEqual({ RecordExpiration: { Expiration: 'ENABLED', Days: 30 } });
  });

  it('rethrows the create error when the configuration it reports cannot be read', async () => {
    readMetadata = () => {
      throw named('AccessDenied');
    };
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof CreateBucketMetadataConfigurationCommand) {
        throw named('MetadataConfigurationAlreadyExists');
      }
      if (command instanceof GetBucketMetadataConfigurationCommand) return readMetadata();
      if (command instanceof GetBucketLocationCommand) return { LocationConstraint: 'eu-west-1' };
      return {};
    });
    await expect(
      new S3BucketProvider().update(
        'B',
        BUCKET,
        TYPE,
        { BucketName: BUCKET, MetadataConfiguration: METADATA },
        { BucketName: BUCKET }
      )
    ).rejects.toThrow('MetadataConfigurationAlreadyExists');
  });

  it('warns on the attribute read of a rollback re-create, rather than stopping it', async () => {
    readMetadata = () => {
      throw named('AccessDenied');
    };
    await new S3BucketProvider().create(
      'B',
      TYPE,
      { BucketName: BUCKET, MetadataConfiguration: METADATA },
      { replayingState: true }
    );
    expect(warn.mock.calls.flat().join('\n')).toContain('until the next deploy records them');
  });

  it('does not swallow any other failure of the create', async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof CreateBucketMetadataConfigurationCommand) throw named('AccessDenied');
      if (command instanceof GetBucketLocationCommand) return { LocationConstraint: 'eu-west-1' };
      return {};
    });
    await expect(
      new S3BucketProvider().update(
        'B',
        BUCKET,
        TYPE,
        { BucketName: BUCKET, MetadataConfiguration: METADATA },
        { BucketName: BUCKET }
      )
    ).rejects.toThrow('AccessDenied');
  });

  it('names a table with no ARN in the warning, and stays quiet when it has one', async () => {
    readMetadata = () =>
      metadataResult({
        JournalTableConfigurationResult: { TableStatus: 'FAILED', TableName: 'journal' },
      });
    await new S3BucketProvider().create('B', TYPE, {
      BucketName: BUCKET,
      MetadataConfiguration: METADATA,
    });
    expect(warn.mock.calls.flat().join('\n')).toContain('It has no ARN');
    warn.mockClear();
    readMetadata = () =>
      metadataResult({
        JournalTableConfigurationResult: { TableStatus: 'FAILED', TableArn: TABLE_ARN('journal') },
      });
    await new S3BucketProvider().create('C', TYPE, {
      BucketName: 'c',
      MetadataConfiguration: METADATA,
    });
    expect(warn.mock.calls.flat().join('\n')).not.toContain('It has no ARN');
  });

  it('warns that a revert creating a configuration could not restore encryption', async () => {
    await new S3BucketProvider().update(
      'B',
      BUCKET,
      TYPE,
      { BucketName: BUCKET, MetadataConfiguration: METADATA },
      { BucketName: BUCKET },
      { desiredFromAwsReadback: true }
    );
    expect(warn.mock.calls.flat().join('\n')).toContain('took S3');
  });

  it('says nothing about encryption on a template update turning a table on', async () => {
    await new S3BucketProvider().update(
      'B',
      BUCKET,
      TYPE,
      { BucketName: BUCKET, MetadataConfiguration: METADATA },
      { BucketName: BUCKET }
    );
    expect(warn.mock.calls.flat().join('\n')).not.toContain('took S3');
  });

  it.each([
    ['a template update fails', undefined, true],
    ['a revert warns', { desiredFromAwsReadback: true }, false],
    ['a rollback warns', { replayingState: true }, false],
  ])('on an attribute read it cannot answer, %s', async (_, context, fails) => {
    readMetadata = () => {
      throw named('AccessDenied');
    };
    const bag = { BucketName: BUCKET, MetadataConfiguration: METADATA };
    const updated = new S3BucketProvider().update('B', BUCKET, TYPE, bag, bag, context);
    if (fails) await expect(updated).rejects.toThrow('AccessDenied');
    else {
      await updated;
      expect(warn.mock.calls.flat().join('\n')).toContain('until the next deploy records them');
    }
  });

  it('warns that a revert turning a table on could not restore its encryption', async () => {
    readMetadata = () =>
      metadataResult({
        InventoryTableConfigurationResult: { ConfigurationState: 'ENABLED', ...table('inventory') },
      });
    await new S3BucketProvider().update(
      'B',
      BUCKET,
      TYPE,
      {
        BucketName: BUCKET,
        MetadataConfiguration: {
          JournalTableConfiguration: JOURNAL,
          InventoryTableConfiguration: { ConfigurationState: 'ENABLED' },
        },
      },
      { BucketName: BUCKET, MetadataConfiguration: METADATA },
      { desiredFromAwsReadback: true }
    );
    expect(warn.mock.calls.flat().join('\n')).toContain('took S3');
  });

  it('sends a turned-on annotation table its encryption and role, and neither when turned off', async () => {
    const on = {
      JournalTableConfiguration: JOURNAL,
      AnnotationTableConfiguration: {
        ConfigurationState: 'ENABLED',
        Role: 'r',
        EncryptionConfiguration: { SseAlgorithm: 'AES256' },
      },
    };
    readMetadata = () =>
      metadataResult({
        AnnotationTableConfigurationResult: { ConfigurationState: 'ENABLED', ...table('annotation') },
      });
    const provider = new S3BucketProvider();
    await provider.update(
      'B',
      BUCKET,
      TYPE,
      { BucketName: BUCKET, MetadataConfiguration: on },
      { BucketName: BUCKET, MetadataConfiguration: METADATA }
    );
    await provider.update(
      'B',
      BUCKET,
      TYPE,
      {
        BucketName: BUCKET,
        MetadataConfiguration: {
          JournalTableConfiguration: JOURNAL,
          AnnotationTableConfiguration: {
            ...on.AnnotationTableConfiguration,
            ConfigurationState: 'DISABLED',
          },
        },
      },
      { BucketName: BUCKET, MetadataConfiguration: on }
    );
    expect(
      sent(UpdateBucketMetadataAnnotationTableConfigurationCommand).map(
        (c) => c.input.AnnotationTableConfiguration
      )
    ).toEqual([on.AnnotationTableConfiguration, { ConfigurationState: 'DISABLED' }]);
  });

  it('waits for a table an update turns on', async () => {
    vi.useFakeTimers();
    try {
      const reads = [
        metadataResult({ AnnotationTableConfigurationResult: { ConfigurationState: 'ENABLED' } }),
      ];
      readMetadata = () =>
        reads.shift() ??
        metadataResult({
          AnnotationTableConfigurationResult: { ConfigurationState: 'ENABLED', ...table('annotation') },
        });
      const done = new S3BucketProvider().update(
        'B',
        BUCKET,
        TYPE,
        {
          BucketName: BUCKET,
          MetadataConfiguration: {
            JournalTableConfiguration: JOURNAL,
            AnnotationTableConfiguration: { ConfigurationState: 'ENABLED', Role: 'r' },
          },
        },
        { BucketName: BUCKET, MetadataConfiguration: METADATA }
      );
      await vi.runAllTimersAsync();
      await done;
      // Two wait reads and the attribute read.
      expect(sent(GetBucketMetadataConfigurationCommand)).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates only the table whose settings moved', async () => {
    await new S3BucketProvider().update(
      'B',
      BUCKET,
      TYPE,
      {
        BucketName: BUCKET,
        MetadataConfiguration: {
          JournalTableConfiguration: { RecordExpiration: { Expiration: 'ENABLED', Days: 30 } },
          InventoryTableConfiguration: { ConfigurationState: 'DISABLED' },
        },
      },
      { BucketName: BUCKET, MetadataConfiguration: METADATA }
    );
    expect(
      sent(UpdateBucketMetadataJournalTableConfigurationCommand)[0]?.input.JournalTableConfiguration
    ).toEqual({ RecordExpiration: { Expiration: 'ENABLED', Days: 30 } });
    expect(sent(UpdateBucketMetadataInventoryTableConfigurationCommand)).toEqual([]);
    expect(sent(UpdateBucketMetadataAnnotationTableConfigurationCommand)).toEqual([]);
    expect(sent(GetBucketMetadataConfigurationCommand)).toHaveLength(1);
  });

  it('turns a dropped inventory block off, and waits for one turned on', async () => {
    readMetadata = () =>
      metadataResult({
        InventoryTableConfigurationResult: { ConfigurationState: 'ENABLED', ...table('inventory') },
      });
    const provider = new S3BucketProvider();
    const on = {
      JournalTableConfiguration: JOURNAL,
      InventoryTableConfiguration: {
        ConfigurationState: 'ENABLED',
        EncryptionConfiguration: { SseAlgorithm: 'AES256' },
      },
    };
    await provider.update(
      'B',
      BUCKET,
      TYPE,
      { BucketName: BUCKET, MetadataConfiguration: on },
      { BucketName: BUCKET, MetadataConfiguration: METADATA }
    );
    await provider.update(
      'B',
      BUCKET,
      TYPE,
      {
        BucketName: BUCKET,
        MetadataConfiguration: {
          JournalTableConfiguration: JOURNAL,
          InventoryTableConfiguration: {
            ...on.InventoryTableConfiguration,
            ConfigurationState: 'DISABLED',
          },
        },
      },
      { BucketName: BUCKET, MetadataConfiguration: on }
    );
    expect(
      sent(UpdateBucketMetadataInventoryTableConfigurationCommand).map(
        (c) => c.input.InventoryTableConfiguration
      )
    ).toEqual([
      { ConfigurationState: 'ENABLED', EncryptionConfiguration: { SseAlgorithm: 'AES256' } },
      { ConfigurationState: 'DISABLED' },
    ]);
  });

  it('re-sends the annotation role when it moves on an enabled table', async () => {
    const annotation = (Role: string): Record<string, unknown> => ({
      JournalTableConfiguration: JOURNAL,
      AnnotationTableConfiguration: { ConfigurationState: 'ENABLED', Role },
    });
    readMetadata = () =>
      metadataResult({
        AnnotationTableConfigurationResult: { ConfigurationState: 'ENABLED', ...table('annotation') },
      });
    await new S3BucketProvider().update(
      'B',
      BUCKET,
      TYPE,
      { BucketName: BUCKET, MetadataConfiguration: annotation('new') },
      { BucketName: BUCKET, MetadataConfiguration: annotation('old') }
    );
    expect(
      sent(UpdateBucketMetadataAnnotationTableConfigurationCommand)[0]?.input
        .AnnotationTableConfiguration
    ).toEqual({ ConfigurationState: 'ENABLED', Role: 'new' });
  });

  const encrypted = (SseAlgorithm: string): Record<string, unknown> => ({
    JournalTableConfiguration: { ...JOURNAL, EncryptionConfiguration: { SseAlgorithm } },
  });

  it('refuses a journal encryption change before any write', async () => {
    await expect(
      new S3BucketProvider().update(
        'B',
        BUCKET,
        TYPE,
        { BucketName: BUCKET, AbacStatus: 'Enabled', MetadataConfiguration: METADATA },
        { BucketName: BUCKET, MetadataConfiguration: encrypted('AES256') }
      )
    ).rejects.toThrow(/once the table exists\. Revert it, or re-create the table.*Nothing was applied/);
    expect(sent(PutBucketAbacCommand)).toEqual([]);
  });

  it('accepts encryption on a table being turned on: it does not exist yet', async () => {
    readMetadata = () =>
      metadataResult({
        InventoryTableConfigurationResult: { ConfigurationState: 'ENABLED', ...table('inventory') },
      });
    await new S3BucketProvider().update(
      'B',
      BUCKET,
      TYPE,
      {
        BucketName: BUCKET,
        MetadataConfiguration: {
          JournalTableConfiguration: JOURNAL,
          InventoryTableConfiguration: {
            ConfigurationState: 'ENABLED',
            EncryptionConfiguration: { SseAlgorithm: 'AES256' },
          },
        },
      },
      {
        BucketName: BUCKET,
        MetadataConfiguration: {
          JournalTableConfiguration: JOURNAL,
          InventoryTableConfiguration: { ConfigurationState: 'DISABLED' },
        },
      }
    );
    expect(sent(UpdateBucketMetadataInventoryTableConfigurationCommand)).toHaveLength(1);
  });

  it('lets a state-borne revert through: the readback carries no encryption', async () => {
    await new S3BucketProvider().update(
      'B',
      BUCKET,
      TYPE,
      { BucketName: BUCKET, MetadataConfiguration: METADATA },
      { BucketName: BUCKET, MetadataConfiguration: encrypted('AES256') },
      { desiredFromAwsReadback: true }
    );
    expect(sent(UpdateBucketMetadataJournalTableConfigurationCommand)).toEqual([]);
  });
});

describe('drift readback (go-to-k/cdkd#2762)', () => {
  const head = (): void => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof HeadBucketCommand) return {};
      if (command instanceof GetBucketMetadataConfigurationCommand) return readMetadata();
      if (command instanceof GetBucketAbacCommand) return readAbac();
      if (command instanceof GetBucketLocationCommand) return { LocationConstraint: 'eu-west-1' };
      return {};
    });
  };

  it('omits both properties at their defaults, so an older baseline stays clean', async () => {
    head();
    readMetadata = () => {
      throw named('MetadataConfigurationNotFound');
    };
    const state = (await new S3BucketProvider().readCurrentState(BUCKET, 'B', TYPE)) as object;
    expect(state).not.toHaveProperty('AbacStatus');
    expect(state).not.toHaveProperty('MetadataConfiguration');
  });

  it('reads both back in the writable CFn shape once they move', async () => {
    head();
    readAbac = () => ({ AbacStatus: { Status: 'Enabled' } });
    readMetadata = () =>
      metadataResult({
        AnnotationTableConfigurationResult: {
          ConfigurationState: 'ENABLED',
          Role: 'r',
          ...table('annotation'),
        },
      });
    const state = await new S3BucketProvider().readCurrentState(BUCKET, 'B', TYPE);
    expect(state).toMatchObject({
      AbacStatus: 'Enabled',
      MetadataConfiguration: {
        JournalTableConfiguration: JOURNAL,
        InventoryTableConfiguration: { ConfigurationState: 'DISABLED' },
        AnnotationTableConfiguration: { ConfigurationState: 'ENABLED', Role: 'r' },
      },
    });
    expect(JSON.stringify(state)).not.toContain('TableArn');
  });

  it('keeps a declared value when its read fails, so a narrow role reports no drift', async () => {
    head();
    readAbac = () => {
      throw named('AccessDenied');
    };
    readMetadata = () => {
      throw named('AccessDenied');
    };
    const state = await new S3BucketProvider().readCurrentState(BUCKET, 'B', TYPE, {
      AbacStatus: 'Enabled',
      MetadataConfiguration: METADATA,
    });
    expect(state).toMatchObject({ AbacStatus: 'Enabled', MetadataConfiguration: METADATA });
  });

  it('reads an ABAC answer with no status as Disabled', async () => {
    head();
    readAbac = () => ({});
    const state = await new S3BucketProvider().readCurrentState(BUCKET, 'B', TYPE, {
      AbacStatus: 'Enabled',
    });
    expect(state).toMatchObject({ AbacStatus: 'Disabled' });
  });

  it('reads a declared Disabled back, which the no-baseline comparison needs', async () => {
    head();
    const state = await new S3BucketProvider().readCurrentState(BUCKET, 'B', TYPE, {
      AbacStatus: 'Disabled',
    });
    expect(state).toMatchObject({ AbacStatus: 'Disabled' });
  });

  it('keeps every other readback when a narrow role cannot read these two', async () => {
    head();
    readAbac = () => {
      throw named('AccessDenied');
    };
    readMetadata = () => {
      throw named('AccessDenied');
    };
    await expect(new S3BucketProvider().readCurrentState(BUCKET, 'B', TYPE)).resolves.toMatchObject({
      BucketName: BUCKET,
    });
  });

  it('round-trips a readback through update() with no write', async () => {
    head();
    readAbac = () => ({ AbacStatus: { Status: 'Enabled' } });
    const provider = new S3BucketProvider();
    const state = (await provider.readCurrentState(BUCKET, 'B', TYPE)) as Record<string, unknown>;
    mockSend.mockClear();
    const { AbacStatus, MetadataConfiguration } = state;
    const bag = { BucketName: BUCKET, AbacStatus, MetadataConfiguration };
    await provider.update('B', BUCKET, TYPE, bag, bag);
    expect(sent(PutBucketAbacCommand)).toEqual([]);
    expect(sent(CreateBucketMetadataConfigurationCommand)).toEqual([]);
    expect(sent(UpdateBucketMetadataJournalTableConfigurationCommand)).toEqual([]);
    expect(sent(UpdateBucketMetadataInventoryTableConfigurationCommand)).toEqual([]);
    expect(sent(UpdateBucketMetadataAnnotationTableConfigurationCommand)).toEqual([]);
  });

  it('names each key for the absent-means-default comparison only at its default', () => {
    const provider = new S3BucketProvider();
    expect(provider.getDriftAbsentMeansDefaultKeys(TYPE, {})).toEqual([
      'AbacStatus',
      'MetadataConfiguration',
    ]);
    expect(
      provider.getDriftAbsentMeansDefaultKeys(TYPE, {
        AbacStatus: 'Enabled',
        MetadataConfiguration: METADATA,
      })
    ).toEqual([]);
    expect(provider.getDriftAbsentMeansDefaultKeys(TYPE, { AbacStatus: 'Disabled' })).toContain(
      'AbacStatus'
    );
  });

  it('declares the write-only members unknown to drift', () => {
    expect(new S3BucketProvider().getDriftUnknownPaths()).toEqual([
      'BucketNamePrefix',
      'BucketNamespace',
      'MetadataConfiguration.JournalTableConfiguration.EncryptionConfiguration',
      'MetadataConfiguration.InventoryTableConfiguration.EncryptionConfiguration',
      'MetadataConfiguration.AnnotationTableConfiguration.EncryptionConfiguration',
    ]);
  });

  it('fails an attribute read it cannot answer, rather than dropping the ARN', async () => {
    readMetadata = () => {
      throw named('AccessDenied');
    };
    await expect(
      new S3BucketProvider().getAttribute(
        BUCKET,
        TYPE,
        'MetadataConfiguration.JournalTableConfiguration.TableArn'
      )
    ).rejects.toThrow('AccessDenied');
  });

  it('serves a MetadataConfiguration attribute live', async () => {
    await expect(
      new S3BucketProvider().getAttribute(
        BUCKET,
        TYPE,
        'MetadataConfiguration.JournalTableConfiguration.TableArn'
      )
    ).resolves.toBe(TABLE_ARN('journal'));
  });
});

describe('secret-derived prefixes (go-to-k/cdkd#2762)', () => {
  // As the masker treats a secret under its substring floor: whole values only.
  const maskSecrets = (text: string): string => (text === 'abc' ? '***' : text);
  const NAME = 'abc-123456789012-eu-west-1-an';

  it('masks the whole derived name of a create', async () => {
    readMetadata = () => {
      throw named('AccessDenied');
    };
    await new S3BucketProvider()
      .create(
        'B',
        TYPE,
        {
          BucketNamePrefix: 'abc',
          BucketNamespace: 'account-regional',
          MetadataConfiguration: 'x',
        },
        { maskSecrets, replayingState: true }
      )
      .catch(() => undefined);
    const lines = warn.mock.calls.flat().join('\n');
    expect(lines).toContain('no S3 Metadata configuration was restored');
    expect(lines).not.toContain(NAME);
  });

  it('masks the whole derived name of an update', async () => {
    await new S3BucketProvider().update(
      'B',
      NAME,
      TYPE,
      { BucketNamePrefix: 'abc', MetadataConfiguration: 'x' },
      { BucketNamePrefix: 'abc', MetadataConfiguration: METADATA },
      { maskSecrets, replayingState: true }
    );
    const lines = warn.mock.calls.flat().join('\n');
    expect(lines).toContain('was left as it is');
    expect(lines).not.toContain(NAME);
  });

  it('masks the bucket and the status text of a failed table', async () => {
    const mask = (text: string): string => text.replaceAll('secret-bucket', '***');
    readMetadata = () =>
      metadataResult({
        JournalTableConfigurationResult: {
          TableStatus: 'FAILED',
          TableName: 'journal',
          Error: { ErrorCode: 'X', ErrorMessage: 'on secret-bucket' },
        },
      });
    await new S3BucketProvider().create(
      'B',
      TYPE,
      { BucketName: 'secret-bucket', MetadataConfiguration: METADATA },
      { maskSecrets: mask }
    );
    expect(warn.mock.calls.flat().join('\n')).not.toContain('secret-bucket');
  });
});

describe('the replacement rule (go-to-k/cdkd#2762)', () => {
  it('replaces on the two create-only properties and updates the other two in place', () => {
    const rule = new ReplacementRulesRegistry();
    expect(rule.requiresReplacement(TYPE, 'BucketNamePrefix', 'a', 'b')).toBe(true);
    expect(rule.requiresReplacement(TYPE, 'BucketNamespace', 'a', 'b')).toBe(true);
    expect(rule.requiresReplacement(TYPE, 'AbacStatus', 'a', 'b')).toBe(false);
    expect(rule.requiresReplacement(TYPE, 'MetadataConfiguration', 'a', 'b')).toBe(false);
  });
});

describe('a kept prefix-named bucket (go-to-k/cdkd#2762)', () => {
  it('is not read back by name: the template named it, not cdkd', () => {
    const kept = (properties: Record<string, unknown>): boolean =>
      keptForReadoption({
        physicalId: 'p-123456789012-eu-west-1-an',
        resourceType: TYPE,
        provisionedBy: 'sdk',
        properties,
      } as never);
    expect(kept({})).toBe(true);
    expect(kept({ BucketNamePrefix: 'p' })).toBe(false);
  });
});

describe('a create reclaiming a bucket that already exists (go-to-k/cdkd#2762)', () => {
  const held = (over: (command: unknown) => unknown = () => undefined): void => {
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof CreateBucketCommand) throw named('BucketAlreadyOwnedByYou');
      const answer = over(command);
      if (answer !== undefined) return answer;
      if (command instanceof GetBucketMetadataConfigurationCommand) return readMetadata();
      if (command instanceof GetBucketAbacCommand) return readAbac();
      if (command instanceof GetBucketTaggingCommand) return { TagSet: liveTags };
      if (command instanceof GetBucketLocationCommand) return { LocationConstraint: 'eu-west-1' };
      return { $metadata: {}, $response: { headers: { 'x-amz-bucket-region': 'eu-west-1' } } };
    });
  };
  const TAGS = [{ Key: 'k', Value: 'v' }];

  it('reads nothing extra on a plain create', async () => {
    await new S3BucketProvider().create('B', TYPE, { BucketName: BUCKET, Tags: TAGS });
    expect(sent(GetBucketAbacCommand)).toEqual([]);
    expect(sent(GetBucketMetadataConfigurationCommand)).toEqual([]);
  });

  it('tags through S3 Control while ABAC stays on', async () => {
    held();
    readAbac = () => ({ AbacStatus: { Status: 'Enabled' } });
    readMetadata = () => {
      throw named('MetadataConfigurationNotFound');
    };
    await new S3BucketProvider().create('B', TYPE, { AbacStatus: 'Enabled', Tags: TAGS });
    expect(sent(PutBucketTaggingCommand)).toEqual([]);
    expect(controlSend.mock.calls[0]?.[0]).toBeInstanceOf(TagResourceCommand);
  });

  it('turns ABAC off first only when the template declares Disabled', async () => {
    held();
    readAbac = () => ({ AbacStatus: { Status: 'Enabled' } });
    await new S3BucketProvider().create('B', TYPE, { AbacStatus: 'Disabled', Tags: TAGS });
    expect(sent(PutBucketAbacCommand)[0]?.input.AbacStatus).toEqual({ Status: 'Disabled' });
    const calls = order();
    expect(calls).toContain('PutBucketTaggingCommand');
    expect(calls.indexOf('PutBucketAbacCommand')).toBeLessThan(
      calls.indexOf('PutBucketTaggingCommand')
    );
    expect(controlSend).not.toHaveBeenCalled();
  });

  it('leaves an undeclared live ABAC on, tags through S3 Control, and warns', async () => {
    held();
    readAbac = () => ({ AbacStatus: { Status: 'Enabled' } });
    await new S3BucketProvider().create('B', TYPE, { Tags: TAGS });
    expect(sent(PutBucketAbacCommand)).toEqual([]);
    expect(sent(PutBucketTaggingCommand)).toEqual([]);
    expect(controlSend.mock.calls[0]?.[0]).toBeInstanceOf(TagResourceCommand);
    expect(warn.mock.calls.flat().join('\n')).toContain('until the template declares AbacStatus');
  });

  it('converges a live configuration through the diff, with no second create', async () => {
    held();
    await new S3BucketProvider().create('B', TYPE, {
      MetadataConfiguration: {
        JournalTableConfiguration: { RecordExpiration: { Expiration: 'ENABLED', Days: 30 } },
      },
    });
    expect(sent(CreateBucketMetadataConfigurationCommand)).toEqual([]);
    expect(sent(UpdateBucketMetadataJournalTableConfigurationCommand)).toHaveLength(1);
  });

  it('leaves an undeclared live configuration alone', async () => {
    held();
    await new S3BucketProvider().create('B', TYPE, {});
    expect(sent(GetBucketMetadataConfigurationCommand)).toEqual([]);
    expect(sent(DeleteBucketMetadataConfigurationCommand)).toEqual([]);
  });

  it('waits on the tables of a configuration it converges, with no diff to send', async () => {
    vi.useFakeTimers();
    try {
      held();
      const creating = {
        JournalTableConfigurationResult: {
          TableStatus: 'CREATING',
          TableName: 'journal',
          RecordExpiration: { Expiration: 'ENABLED', Days: 7 },
        },
      };
      const reads = [metadataResult(creating), metadataResult(creating)];
      readMetadata = () => reads.shift() ?? metadataResult();
      const created = new S3BucketProvider().create('B', TYPE, { MetadataConfiguration: METADATA });
      await vi.runAllTimersAsync();
      const { attributes } = await created;
      expect(attributes?.['MetadataConfiguration.JournalTableConfiguration.TableArn']).toBe(
        TABLE_ARN('journal')
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('warns that a declared encryption is unverified over a live configuration', async () => {
    held();
    await new S3BucketProvider().create('B', TYPE, {
      MetadataConfiguration: {
        JournalTableConfiguration: { ...JOURNAL, EncryptionConfiguration: { SseAlgorithm: 'AES256' } },
      },
    });
    expect(warn.mock.calls.flat().join('\n')).toContain('EncryptionConfiguration is unverified');
  });

  it('creates the configuration of a held bucket that has none', async () => {
    held();
    let reads = 0;
    readMetadata = () => {
      reads += 1;
      if (reads === 1) throw named('MetadataConfigurationNotFound');
      return metadataResult();
    };
    await new S3BucketProvider().create('B', TYPE, { MetadataConfiguration: METADATA });
    expect(sent(CreateBucketMetadataConfigurationCommand)).toHaveLength(1);
  });
});

describe('the rollback name needles (go-to-k/cdkd#2762)', () => {
  it('reads a prefix as a bucket name key', () => {
    const pairs = secretDerivedNamePairs({
      resourceType: TYPE,
      properties: { BucketNamePrefix: 'abc' },
      logicalId: 'B',
      physicalIds: ['abc-123456789012-eu-west-1-an'],
    });
    expect(pairs.map(([raw]) => raw)).toContain('abc');
  });
});
