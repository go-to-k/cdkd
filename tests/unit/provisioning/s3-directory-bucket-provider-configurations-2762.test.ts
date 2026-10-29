import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockS3Send, mockStsSend, mockEc2Send, mockControlSend } = vi.hoisted(() => ({
  mockS3Send: vi.fn(),
  mockStsSend: vi.fn(),
  mockEc2Send: vi.fn(),
  mockControlSend: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockS3Send, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: mockStsSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

// The create goes through its own S3Client (issue #4639); answer it with the
// same send double as the shared one.
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({
      send: mockS3Send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ec2')>();
  return {
    ...actual,
    EC2Client: vi.fn().mockImplementation(() => ({
      send: mockEc2Send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-s3-control', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3-control')>();
  return {
    ...actual,
    S3ControlClient: vi.fn().mockImplementation(() => ({
      send: mockControlSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { S3DirectoryBucketProvider } from '../../../src/provisioning/providers/s3-directory-bucket-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const TYPE = 'AWS::S3Express::DirectoryBucket';
const BUCKET = 'my-bucket--use1-az1--x-s3';
const KEY_ARN = 'arn:aws:kms:us-east-1:123456789012:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const AP_ARN = 'arn:aws:s3express:us-east-1:123456789012:accesspoint/ap--use1-az1--xa-s3';
const BASE = { BucketName: BUCKET, LocationName: 'us-east-1a--x-s3' };

const ENCRYPTION = {
  ServerSideEncryptionConfiguration: [
    {
      ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: KEY_ARN },
      BucketKeyEnabled: true,
    },
  ],
};
const LIFECYCLE = {
  Rules: [
    {
      Id: 'all-three',
      Status: 'Enabled',
      Prefix: 'logs/',
      ObjectSizeGreaterThan: '100',
      ObjectSizeLessThan: '5000',
      ExpirationInDays: 7,
    },
    { Id: 'prefix-only', Status: 'Enabled', Prefix: 'tmp/', ExpirationInDays: 1 },
    { Id: 'abort-only', Status: 'Disabled', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 } },
  ],
};
const METRICS = [
  { Id: 'both', Prefix: 'p/', AccessPointArn: AP_ARN },
  { Id: 'prefix', Prefix: 'q/' },
  { Id: 'ap', AccessPointArn: AP_ARN },
  { Id: 'whole' },
];
const INVENTORY = [
  {
    Id: 'inv',
    Enabled: true,
    IncludedObjectVersions: 'Current',
    ScheduleFrequency: 'Daily',
    Prefix: 'inv/',
    OptionalFields: ['Size', 'ETag'],
    Destination: {
      BucketArn: 'arn:aws:s3:::dest',
      BucketAccountId: '123456789012',
      Format: 'CSV',
      Prefix: 'reports/',
    },
  },
];
const FULL = {
  ...BASE,
  BucketEncryption: ENCRYPTION,
  LifecycleConfiguration: LIFECYCLE,
  MetricsConfigurations: METRICS,
  InventoryConfigurations: INVENTORY,
};

/** Every S3 call as `[CommandName, input]`. */
function s3Calls(): Array<[string, Record<string, unknown>]> {
  return mockS3Send.mock.calls.map((c) => {
    const command = c[0] as { constructor: { name: string }; input: Record<string, unknown> };
    return [command.constructor.name, command.input];
  });
}

function s3Writes(): Array<[string, Record<string, unknown>]> {
  return s3Calls().filter(([name]) => !/^(Get|List|Head)/.test(name));
}

function inputOf(name: string): Record<string, unknown> | undefined {
  return s3Calls().find(([n]) => n === name)?.[1];
}

function inputsOf(name: string): Array<Record<string, unknown>> {
  return s3Calls()
    .filter(([n]) => n === name)
    .map(([, input]) => input);
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: unknown) => e as Error
  );
}

beforeEach(() => {
  mockS3Send.mockReset();
  mockStsSend.mockReset();
  mockEc2Send.mockReset();
  mockControlSend.mockReset();
  mockS3Send.mockResolvedValue({});
  mockStsSend.mockResolvedValue({ Account: '123456789012' });
  mockEc2Send.mockResolvedValue({ AvailabilityZones: [{ ZoneId: 'use1-az1' }] });
  mockControlSend.mockResolvedValue({ Tags: [] });
});

describe('S3DirectoryBucketProvider create: bucket configurations (go-to-k/cdkd#2762)', () => {
  it('declares the four configurations handled', () => {
    const handled = new S3DirectoryBucketProvider().handledProperties.get(TYPE)!;
    for (const key of [
      'BucketEncryption',
      'LifecycleConfiguration',
      'MetricsConfigurations',
      'InventoryConfigurations',
    ]) {
      expect(handled.has(key), key).toBe(true);
    }
  });

  it('sends each configuration after CreateBucket, in the S3 shape', async () => {
    await new S3DirectoryBucketProvider().create('Bucket', TYPE, structuredClone(FULL));

    const names = s3Writes().map(([n]) => n);
    expect(names[0]).toBe('CreateBucketCommand');
    expect(names.slice(1)).toEqual([
      'PutBucketEncryptionCommand',
      'PutBucketLifecycleConfigurationCommand',
      'PutBucketMetricsConfigurationCommand',
      'PutBucketMetricsConfigurationCommand',
      'PutBucketMetricsConfigurationCommand',
      'PutBucketMetricsConfigurationCommand',
      'PutBucketInventoryConfigurationCommand',
    ]);

    expect(inputOf('PutBucketEncryptionCommand')).toEqual({
      Bucket: BUCKET,
      ServerSideEncryptionConfiguration: {
        Rules: [
          {
            ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: KEY_ARN },
            BucketKeyEnabled: true,
          },
        ],
      },
    });

    expect(inputOf('PutBucketLifecycleConfigurationCommand')).toEqual({
      Bucket: BUCKET,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'all-three',
            Status: 'Enabled',
            // More than one scope member goes under `And`; sizes are numbers.
            Filter: { And: { Prefix: 'logs/', ObjectSizeGreaterThan: 100, ObjectSizeLessThan: 5000 } },
            Expiration: { Days: 7 },
          },
          {
            ID: 'prefix-only',
            Status: 'Enabled',
            Filter: { Prefix: 'tmp/' },
            Expiration: { Days: 1 },
          },
          {
            ID: 'abort-only',
            Status: 'Disabled',
            // No scope member: every object, S3's empty prefix.
            Filter: { Prefix: '' },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 },
          },
        ],
      },
    });

    expect(inputsOf('PutBucketMetricsConfigurationCommand')).toEqual([
      {
        Bucket: BUCKET,
        Id: 'both',
        MetricsConfiguration: { Id: 'both', Filter: { And: { Prefix: 'p/', AccessPointArn: AP_ARN } } },
      },
      { Bucket: BUCKET, Id: 'prefix', MetricsConfiguration: { Id: 'prefix', Filter: { Prefix: 'q/' } } },
      { Bucket: BUCKET, Id: 'ap', MetricsConfiguration: { Id: 'ap', Filter: { AccessPointArn: AP_ARN } } },
      { Bucket: BUCKET, Id: 'whole', MetricsConfiguration: { Id: 'whole' } },
    ]);

    expect(inputOf('PutBucketInventoryConfigurationCommand')).toEqual({
      Bucket: BUCKET,
      Id: 'inv',
      InventoryConfiguration: {
        Id: 'inv',
        IsEnabled: true,
        IncludedObjectVersions: 'Current',
        Schedule: { Frequency: 'Daily' },
        Filter: { Prefix: 'inv/' },
        OptionalFields: ['Size', 'ETag'],
        Destination: {
          S3BucketDestination: {
            Bucket: 'arn:aws:s3:::dest',
            AccountId: '123456789012',
            Format: 'CSV',
            Prefix: 'reports/',
          },
        },
      },
    });
  });

  it('sends no configuration call for a bucket declaring none, or empty rule lists', async () => {
    await new S3DirectoryBucketProvider().create('Bucket', TYPE, {
      ...BASE,
      BucketEncryption: { ServerSideEncryptionConfiguration: [] },
      LifecycleConfiguration: { Rules: [] },
      MetricsConfigurations: [],
      InventoryConfigurations: [],
    });
    expect(s3Writes().map(([n]) => n)).toEqual(['CreateBucketCommand']);
  });

  it.each([
    ['BucketEncryption', 'aes', /BucketEncryption of .* is not an object/],
    ['LifecycleConfiguration', { Rules: 'x' }, /LifecycleConfiguration\.Rules of .* is not a list/],
    [
      'LifecycleConfiguration',
      { Rules: [{ Status: 'Enabled', ObjectSizeGreaterThan: '1e3' }] },
      /ObjectSizeGreaterThan of .* is not a non-negative integer/,
    ],
    ['MetricsConfigurations', [{ Id: 'a' }, { Id: 'a' }], /is not an Id no other item of the list carries/],
    ['InventoryConfigurations', [{ Id: 'i' }], /Destination of .* is not an object/],
  ])('refuses a malformed %s before any call', async (key, value, says) => {
    const error = await rejection(
      new S3DirectoryBucketProvider().create('Bucket', TYPE, { ...BASE, [key]: value })
    );
    expect(error.message).toMatch(says);
    expect(error.message).toContain('the resource was not created');
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'Bucket', TYPE)).toBeUndefined();
  });

  it('marks the bucket created-before-failure when a configuration write fails after CreateBucket', async () => {
    mockS3Send.mockImplementation((command: { constructor: { name: string } }) =>
      command.constructor.name === 'PutBucketLifecycleConfigurationCommand'
        ? Promise.reject(Object.assign(new Error('nope'), { name: 'MalformedXML' }))
        : Promise.resolve({})
    );
    const error = await rejection(
      new S3DirectoryBucketProvider().create('Bucket', TYPE, structuredClone(FULL))
    );
    expect(error.message).toContain('Failed to create S3 Express Directory Bucket Bucket');
    expect(createdBeforeFailure(error, 'Bucket', TYPE)).toBe(BUCKET);
  });
});

describe('S3DirectoryBucketProvider update: bucket configurations (go-to-k/cdkd#2762)', () => {
  const update = (next: Record<string, unknown>, prev: Record<string, unknown>) =>
    new S3DirectoryBucketProvider().update(
      'Bucket',
      BUCKET,
      TYPE,
      structuredClone(next),
      structuredClone(prev)
    );

  it('sends nothing when no configuration changed (key order aside)', async () => {
    const reordered = {
      ...FULL,
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            BucketKeyEnabled: true,
            ServerSideEncryptionByDefault: { KMSMasterKeyID: KEY_ARN, SSEAlgorithm: 'aws:kms' },
          },
        ],
      },
    };
    await update(reordered, FULL);
    expect(s3Writes()).toEqual([]);
  });

  it('puts every configuration a template adds', async () => {
    await update(FULL, BASE);
    expect(s3Writes().map(([n]) => n)).toEqual([
      'PutBucketEncryptionCommand',
      'PutBucketLifecycleConfigurationCommand',
      'PutBucketMetricsConfigurationCommand',
      'PutBucketMetricsConfigurationCommand',
      'PutBucketMetricsConfigurationCommand',
      'PutBucketMetricsConfigurationCommand',
      'PutBucketInventoryConfigurationCommand',
    ]);
  });

  it('deletes every configuration the template removes (clear-on-removal)', async () => {
    await update(BASE, FULL);
    expect(s3Writes()).toEqual([
      ['DeleteBucketEncryptionCommand', { Bucket: BUCKET }],
      ['DeleteBucketLifecycleCommand', { Bucket: BUCKET }],
      ['DeleteBucketMetricsConfigurationCommand', { Bucket: BUCKET, Id: 'both' }],
      ['DeleteBucketMetricsConfigurationCommand', { Bucket: BUCKET, Id: 'prefix' }],
      ['DeleteBucketMetricsConfigurationCommand', { Bucket: BUCKET, Id: 'ap' }],
      ['DeleteBucketMetricsConfigurationCommand', { Bucket: BUCKET, Id: 'whole' }],
      ['DeleteBucketInventoryConfigurationCommand', { Bucket: BUCKET, Id: 'inv' }],
    ]);
  });

  it('treats an emptied rule list as a removal', async () => {
    await update(
      {
        ...BASE,
        BucketEncryption: { ServerSideEncryptionConfiguration: [] },
        LifecycleConfiguration: { Rules: [] },
      },
      FULL
    );
    const names = s3Writes().map(([n]) => n);
    expect(names).toContain('DeleteBucketEncryptionCommand');
    expect(names).toContain('DeleteBucketLifecycleCommand');
    expect(names).not.toContain('PutBucketEncryptionCommand');
    expect(names).not.toContain('PutBucketLifecycleConfigurationCommand');
  });

  it('puts only the changed list item and deletes only the removed one', async () => {
    const next = {
      ...FULL,
      MetricsConfigurations: [
        { Id: 'both', Prefix: 'p/', AccessPointArn: AP_ARN },
        { Id: 'prefix', Prefix: 'changed/' },
        { Id: 'ap', AccessPointArn: AP_ARN },
        { Id: 'added' },
      ],
      InventoryConfigurations: [{ ...INVENTORY[0], ScheduleFrequency: 'Weekly' }],
    };
    await update(next, FULL);
    expect(s3Writes()).toEqual([
      [
        'PutBucketMetricsConfigurationCommand',
        { Bucket: BUCKET, Id: 'prefix', MetricsConfiguration: { Id: 'prefix', Filter: { Prefix: 'changed/' } } },
      ],
      ['PutBucketMetricsConfigurationCommand', { Bucket: BUCKET, Id: 'added', MetricsConfiguration: { Id: 'added' } }],
      ['DeleteBucketMetricsConfigurationCommand', { Bucket: BUCKET, Id: 'whole' }],
      [
        'PutBucketInventoryConfigurationCommand',
        expect.objectContaining({
          Id: 'inv',
          InventoryConfiguration: expect.objectContaining({ Schedule: { Frequency: 'Weekly' } }),
        }),
      ],
    ]);
  });

  it('sends no Delete when neither side holds a configuration (empty forms are "none")', async () => {
    const empty = {
      ...BASE,
      BucketEncryption: { ServerSideEncryptionConfiguration: [] },
      LifecycleConfiguration: { Rules: [] },
      MetricsConfigurations: [],
      InventoryConfigurations: [],
    };
    await update(empty, BASE);
    expect(s3Writes()).toEqual([]);
    mockS3Send.mockClear();
    await update(BASE, empty);
    expect(s3Writes()).toEqual([]);
  });

  it('takes the boolean spelled as a string (a template parameter)', async () => {
    await update(
      {
        ...BASE,
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            { ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' }, BucketKeyEnabled: 'true' },
          ],
        },
        InventoryConfigurations: [{ ...INVENTORY[0], Enabled: 'false' }],
      },
      BASE
    );
    const rules = (inputOf('PutBucketEncryptionCommand') as {
      ServerSideEncryptionConfiguration: { Rules: Array<{ BucketKeyEnabled: unknown }> };
    }).ServerSideEncryptionConfiguration.Rules;
    expect(rules[0]!.BucketKeyEnabled).toBe(true);
    expect(
      (inputOf('PutBucketInventoryConfigurationCommand') as {
        InventoryConfiguration: { IsEnabled: unknown };
      }).InventoryConfiguration.IsEnabled
    ).toBe(false);
  });

  it('treats a per-Id Delete answering NoSuchConfiguration as done (a retried update)', async () => {
    mockS3Send.mockImplementation((command: { constructor: { name: string } }) =>
      /^DeleteBucket(Metrics|Inventory)ConfigurationCommand$/.test(command.constructor.name)
        ? Promise.reject(Object.assign(new Error('gone'), { name: 'NoSuchConfiguration' }))
        : Promise.resolve({})
    );
    await expect(update(BASE, FULL)).resolves.toMatchObject({ wasReplaced: false });
    expect(inputsOf('DeleteBucketMetricsConfigurationCommand')).toHaveLength(4);
    expect(inputsOf('DeleteBucketInventoryConfigurationCommand')).toHaveLength(1);
  });

  it('rethrows any other per-Id Delete failure', async () => {
    mockS3Send.mockImplementation((command: { constructor: { name: string } }) =>
      command.constructor.name === 'DeleteBucketMetricsConfigurationCommand'
        ? Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDenied' }))
        : Promise.resolve({})
    );
    await expect(update(BASE, FULL)).rejects.toThrow(/Failed to update S3 Express Directory Bucket/);
  });

  it('marks each configuration key unsettled before its first write, and nothing on a no-op', async () => {
    const marked: string[] = [];
    const order: string[] = [];
    mockS3Send.mockImplementation((command: { constructor: { name: string } }) => {
      order.push(command.constructor.name);
      return Promise.resolve({});
    });
    const markUnsettled = (key: string): void => {
      marked.push(key);
      order.push(`mark:${key}`);
    };
    const provider = new S3DirectoryBucketProvider();
    await provider.update('Bucket', BUCKET, TYPE, structuredClone(FULL), structuredClone(FULL), {
      markUnsettled,
    });
    expect(marked).toEqual([]);
    await provider.update('Bucket', BUCKET, TYPE, structuredClone(BASE), structuredClone(FULL), {
      markUnsettled,
    });
    expect([...new Set(marked)]).toEqual([
      'BucketEncryption',
      'LifecycleConfiguration',
      'MetricsConfigurations',
      'InventoryConfigurations',
    ]);
    // Each mark precedes the write it names.
    expect(order.indexOf('mark:BucketEncryption')).toBeLessThan(
      order.indexOf('DeleteBucketEncryptionCommand')
    );
    expect(order.indexOf('mark:InventoryConfigurations')).toBeLessThan(
      order.indexOf('DeleteBucketInventoryConfigurationCommand')
    );
  });

  it('names a malformed list item by its index, never its Id', async () => {
    const error = await rejection(
      update(
        { ...BASE, MetricsConfigurations: [{ Id: 'ok' }, { Id: 'secret-ish-id', Prefix: 7 }] },
        BASE
      )
    );
    expect(error.message).toMatch(/MetricsConfigurations\[1\]\.Prefix of .* is not a string/);
    expect(error.message).not.toContain('secret-ish-id');
  });

  it('refuses a malformed desired configuration before any call', async () => {
    const error = await rejection(update({ ...BASE, MetricsConfigurations: [{}] }, FULL));
    expect(error.message).toMatch(/desired MetricsConfigurations\[0\]\.Id of .* is not a non-empty string/);
    expect(error.message).toContain('the resource was not updated');
    expect(mockS3Send).not.toHaveBeenCalled();
    expect(mockControlSend).not.toHaveBeenCalled();
  });
});

/** Answers the four configuration reads with `answers`, HeadBucket with `{}`. */
function armReads(answers: Record<string, unknown | Error>): void {
  mockS3Send.mockImplementation((command: { constructor: { name: string } }) => {
    const answer = answers[command.constructor.name];
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer ?? {});
  });
}

const READBACK_ANSWERS = {
  GetBucketEncryptionCommand: {
    ServerSideEncryptionConfiguration: {
      Rules: [
        {
          ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: KEY_ARN },
          BucketKeyEnabled: true,
        },
      ],
    },
  },
  GetBucketLifecycleConfigurationCommand: {
    Rules: [
      {
        ID: 'all-three',
        Status: 'Enabled',
        Filter: { And: { Prefix: 'logs/', ObjectSizeGreaterThan: 100, ObjectSizeLessThan: 5000 } },
        Expiration: { Days: 7 },
      },
      { ID: 'prefix-only', Status: 'Enabled', Filter: { Prefix: 'tmp/' }, Expiration: { Days: 1 } },
      {
        ID: 'abort-only',
        Status: 'Disabled',
        Filter: { Prefix: '' },
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 },
      },
    ],
  },
  ListBucketMetricsConfigurationsCommand: {
    MetricsConfigurationList: [
      { Id: 'both', Filter: { And: { Prefix: 'p/', AccessPointArn: AP_ARN } } },
      { Id: 'prefix', Filter: { Prefix: 'q/' } },
      { Id: 'ap', Filter: { AccessPointArn: AP_ARN } },
      { Id: 'whole' },
    ],
  },
  ListBucketInventoryConfigurationsCommand: {
    InventoryConfigurationList: [
      {
        Id: 'inv',
        IsEnabled: true,
        IncludedObjectVersions: 'Current',
        Schedule: { Frequency: 'Daily' },
        Filter: { Prefix: 'inv/' },
        OptionalFields: ['Size', 'ETag'],
        Destination: {
          S3BucketDestination: {
            Bucket: 'arn:aws:s3:::dest',
            AccountId: '123456789012',
            Format: 'CSV',
            Prefix: 'reports/',
          },
        },
      },
    ],
  },
};

describe('S3DirectoryBucketProvider readCurrentState: bucket configurations (go-to-k/cdkd#2762)', () => {
  it('reads each configuration back in the CFn shape the template declares', async () => {
    armReads(READBACK_ANSWERS);
    const result = await new S3DirectoryBucketProvider().readCurrentState(BUCKET, 'Bucket', TYPE);
    // Exact: an all-objects rule (abort-only) reads back with no Prefix.
    expect(result).toEqual({
      BucketName: BUCKET,
      DataRedundancy: 'SingleAvailabilityZone',
      Tags: [],
      BucketEncryption: ENCRYPTION,
      LifecycleConfiguration: LIFECYCLE,
      MetricsConfigurations: METRICS,
      InventoryConfigurations: INVENTORY,
    });
  });

  it('follows the list continuation tokens', async () => {
    let metricsPage = 0;
    mockS3Send.mockImplementation(
      (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command.constructor.name === 'ListBucketMetricsConfigurationsCommand') {
          metricsPage++;
          return Promise.resolve(
            metricsPage === 1
              ? { MetricsConfigurationList: [{ Id: 'a' }], IsTruncated: true, NextContinuationToken: 't' }
              : { MetricsConfigurationList: [{ Id: 'b' }], IsTruncated: false }
          );
        }
        return Promise.resolve({});
      }
    );
    const result = await new S3DirectoryBucketProvider().readCurrentState(BUCKET, 'Bucket', TYPE);
    expect(result).toMatchObject({ MetricsConfigurations: [{ Id: 'a' }, { Id: 'b' }] });
    expect(
      inputsOf('ListBucketMetricsConfigurationsCommand').map((i) => i['ContinuationToken'])
    ).toEqual([undefined, 't']);
  });

  it('reads an unset encryption / lifecycle (their not-found errors) as the empty form', async () => {
    armReads({
      GetBucketEncryptionCommand: Object.assign(new Error('none'), {
        name: 'ServerSideEncryptionConfigurationNotFoundError',
      }),
      GetBucketLifecycleConfigurationCommand: Object.assign(new Error('none'), {
        name: 'NoSuchLifecycleConfiguration',
      }),
    });
    const result = await new S3DirectoryBucketProvider().readCurrentState(BUCKET, 'Bucket', TYPE);
    expect(result).toMatchObject({
      BucketEncryption: { ServerSideEncryptionConfiguration: [] },
      LifecycleConfiguration: { Rules: [] },
      MetricsConfigurations: [],
      InventoryConfigurations: [],
    });
  });

  it.each([
    'GetBucketEncryptionCommand',
    'GetBucketLifecycleConfigurationCommand',
    'ListBucketMetricsConfigurationsCommand',
    'ListBucketInventoryConfigurationsCommand',
  ])('rethrows any other %s failure as it is (a throttle here)', async (name) => {
    const throttle = Object.assign(new Error('slow down'), { name: 'SlowDown' });
    armReads({ [name]: throttle });
    await expect(
      new S3DirectoryBucketProvider().readCurrentState(BUCKET, 'Bucket', TYPE)
    ).rejects.toBe(throttle);
  });

  it.each([
    ['GetBucketEncryptionCommand', 's3express:GetEncryptionConfiguration'],
    ['GetBucketLifecycleConfigurationCommand', 's3express:GetLifecycleConfiguration'],
    ['ListBucketMetricsConfigurationsCommand', 's3express:GetMetricsConfiguration'],
    ['ListBucketInventoryConfigurationsCommand', 's3express:GetInventoryConfiguration'],
  ])(
    'an AccessDenied %s read throws naming %s, even for an UNDECLARED configuration',
    async (command, action) => {
      // Left out, the value would read as REMOVED to drift (encryption is
      // recorded even undeclared), so a missing permission is an error.
      armReads({ [command]: Object.assign(new Error('denied'), { name: 'AccessDenied' }) });
      const error = await rejection(
        new S3DirectoryBucketProvider().readCurrentState(BUCKET, 'Bucket', TYPE)
      );
      expect(error.message).toContain(action);
      expect((error as { cause?: unknown }).cause).toMatchObject({ name: 'AccessDenied' });
    }
  );

  it('follows the inventory list continuation token', async () => {
    let page = 0;
    mockS3Send.mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name !== 'ListBucketInventoryConfigurationsCommand') {
        return Promise.resolve({});
      }
      page++;
      const item = (id: string) => ({
        Id: id,
        IsEnabled: true,
        IncludedObjectVersions: 'Current',
        Schedule: { Frequency: 'Daily' },
        Destination: { S3BucketDestination: { Bucket: 'arn:aws:s3:::dest', Format: 'CSV' } },
      });
      return Promise.resolve(
        page === 1
          ? { InventoryConfigurationList: [item('a')], IsTruncated: true, NextContinuationToken: 't' }
          : { InventoryConfigurationList: [item('b')], IsTruncated: false }
      );
    });
    const result = (await new S3DirectoryBucketProvider().readCurrentState(
      BUCKET,
      'Bucket',
      TYPE
    )) as { InventoryConfigurations: Array<{ Id: string }> };
    expect(result.InventoryConfigurations.map((i) => i.Id)).toEqual(['a', 'b']);
    expect(
      inputsOf('ListBucketInventoryConfigurationsCommand').map((i) => i['ContinuationToken'])
    ).toEqual([undefined, 't']);
  });

  it("reads a legacy rule-level Prefix, and omits an inventory's empty OptionalFields", async () => {
    armReads({
      GetBucketLifecycleConfigurationCommand: {
        Rules: [{ ID: 'legacy', Status: 'Enabled', Prefix: 'old/', Expiration: { Days: 2 } }],
      },
      ListBucketInventoryConfigurationsCommand: {
        InventoryConfigurationList: [
          {
            Id: 'i',
            IsEnabled: false,
            IncludedObjectVersions: 'Current',
            Schedule: { Frequency: 'Weekly' },
            OptionalFields: [],
            Destination: { S3BucketDestination: { Bucket: 'arn:aws:s3:::dest', Format: 'ORC' } },
          },
        ],
      },
    });
    const result = await new S3DirectoryBucketProvider().readCurrentState(BUCKET, 'Bucket', TYPE);
    expect(result).toMatchObject({
      LifecycleConfiguration: {
        Rules: [{ Id: 'legacy', Status: 'Enabled', Prefix: 'old/', ExpirationInDays: 2 }],
      },
      InventoryConfigurations: [
        {
          Id: 'i',
          Enabled: false,
          IncludedObjectVersions: 'Current',
          ScheduleFrequency: 'Weekly',
          Destination: { BucketArn: 'arn:aws:s3:::dest', Format: 'ORC' },
        },
      ],
    });
    expect(
      (result as { InventoryConfigurations: Array<Record<string, unknown>> })
        .InventoryConfigurations[0]
    ).not.toHaveProperty('OptionalFields');
  });

  it('round-trip: a readback fed back through update() as both sides sends no write', async () => {
    armReads(READBACK_ANSWERS);
    const observed = (await new S3DirectoryBucketProvider().readCurrentState(
      BUCKET,
      'Bucket',
      TYPE
    )) as Record<string, unknown>;
    mockS3Send.mockReset();
    mockS3Send.mockResolvedValue({});
    await new S3DirectoryBucketProvider().update('Bucket', BUCKET, TYPE, observed, observed);
    expect(s3Writes()).toEqual([]);
  });

  it('round-trip: an unset readback reverting a configured record deletes, never puts an empty list', async () => {
    armReads({});
    const observed = (await new S3DirectoryBucketProvider().readCurrentState(
      BUCKET,
      'Bucket',
      TYPE
    )) as Record<string, unknown>;
    mockS3Send.mockReset();
    mockS3Send.mockResolvedValue({});
    await new S3DirectoryBucketProvider().update('Bucket', BUCKET, TYPE, observed, {
      ...observed,
      ...FULL,
    });
    const names = s3Writes().map(([n]) => n);
    expect(names.filter((n) => n.startsWith('Put'))).toEqual([]);
    expect(names).toContain('DeleteBucketEncryptionCommand');
    expect(names).toContain('DeleteBucketLifecycleCommand');
    expect(names.filter((n) => n === 'DeleteBucketMetricsConfigurationCommand')).toHaveLength(4);
    expect(names).toContain('DeleteBucketInventoryConfigurationCommand');
  });
});

describe('S3DirectoryBucketProvider drift hooks (go-to-k/cdkd#2762)', () => {
  const provider = new S3DirectoryBucketProvider();

  it('compares the two Id-keyed lists as sets', () => {
    expect(provider.getDriftUnorderedPaths(TYPE)).toEqual([
      'MetricsConfigurations',
      'InventoryConfigurations',
    ]);
    expect(provider.getDriftUnorderedPaths('AWS::S3::Bucket')).toEqual([]);
  });

  it.each([
    ['AES256', false],
    ['aws:kms', true],
  ])('drops a BucketKeyEnabled at what %s implies (%s)', (algorithm, implied) => {
    const bag = {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: algorithm }, BucketKeyEnabled: implied },
        ],
      },
    };
    expect(provider.canonicalizeDriftProperties(TYPE, bag)).toEqual({
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: algorithm } }],
      },
    });
    // Non-mutating.
    expect(bag.BucketEncryption.ServerSideEncryptionConfiguration[0]).toHaveProperty('BucketKeyEnabled');
  });

  it("reads a BucketKeyEnabled spelled 'true' as the boolean", () => {
    const bag = {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' }, BucketKeyEnabled: 'true' },
        ],
      },
    };
    expect(provider.canonicalizeDriftProperties(TYPE, bag)).toEqual({
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' } }],
      },
    });
  });

  it('keeps a BucketKeyEnabled that differs from what its algorithm implies', () => {
    const bag = {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: true },
        ],
      },
    };
    expect(provider.canonicalizeDriftProperties(TYPE, bag)).toBe(bag);
  });

  it("drops a lifecycle rule's empty Prefix, and keeps a real one", () => {
    const bag = {
      LifecycleConfiguration: {
        Rules: [
          { Id: 'a', Status: 'Enabled', Prefix: '' },
          { Id: 'b', Status: 'Enabled', Prefix: 'x/' },
        ],
      },
    };
    expect(provider.canonicalizeDriftProperties(TYPE, bag)).toEqual({
      LifecycleConfiguration: {
        Rules: [
          { Id: 'a', Status: 'Enabled' },
          { Id: 'b', Status: 'Enabled', Prefix: 'x/' },
        ],
      },
    });
  });

  it('returns the bag by identity when nothing applies, and for another type', () => {
    const bag = {
      ...FULL,
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: KEY_ARN } },
        ],
      },
    };
    expect(provider.canonicalizeDriftProperties(TYPE, bag)).toBe(bag);
    const other = { LifecycleConfiguration: { Rules: [{ Prefix: '' }] } };
    expect(provider.canonicalizeDriftProperties('AWS::S3::Bucket', other)).toBe(other);
  });
});

describe('S3DirectoryBucketProvider readUnsettled (go-to-k/cdkd#5487)', () => {
  const names = new Set([
    'BucketEncryption',
    'LifecycleConfiguration',
    'MetricsConfigurations',
    'Tags',
  ]);

  it("answers a configuration AWS holds as asked in the template's spelling", async () => {
    armReads({
      GetBucketEncryptionCommand: {
        ServerSideEncryptionConfiguration: {
          Rules: [
            {
              ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: KEY_ARN },
              BucketKeyEnabled: true,
            },
          ],
        },
      },
      GetBucketLifecycleConfigurationCommand: {
        Rules: [{ ID: 'assigned-by-s3', Status: 'Enabled', Filter: { Prefix: 'tmp/' }, Expiration: { Days: 1 } }],
      },
      ListBucketMetricsConfigurationsCommand: {
        MetricsConfigurationList: [{ Id: 'b' }, { Id: 'a', Filter: { Prefix: 'p/' } }],
      },
    });
    const desired = {
      ...BASE,
      // No BucketKeyEnabled (implied for aws:kms), no lifecycle Id, another list order.
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: KEY_ARN } },
        ],
      },
      LifecycleConfiguration: { Rules: [{ Status: 'Enabled', Prefix: 'tmp/', ExpirationInDays: 1 }] },
      MetricsConfigurations: [{ Id: 'a', Prefix: 'p/' }, { Id: 'b' }],
    };
    const live = await new S3DirectoryBucketProvider().readUnsettled(
      BUCKET,
      'Bucket',
      TYPE,
      names,
      {},
      desired
    );
    expect(live).toEqual({
      BucketEncryption: desired.BucketEncryption,
      LifecycleConfiguration: desired.LifecycleConfiguration,
      MetricsConfigurations: desired.MetricsConfigurations,
      Tags: [],
    });
  });

  it('answers a configuration AWS holds otherwise as read', async () => {
    armReads({
      GetBucketLifecycleConfigurationCommand: {
        Rules: [{ ID: 'r', Status: 'Enabled', Filter: { Prefix: 'tmp/' }, Expiration: { Days: 9 } }],
      },
    });
    const live = (await new S3DirectoryBucketProvider().readUnsettled(
      BUCKET,
      'Bucket',
      TYPE,
      new Set(['LifecycleConfiguration']),
      {},
      { ...BASE, LifecycleConfiguration: { Rules: [{ Id: 'r', Status: 'Enabled', Prefix: 'tmp/', ExpirationInDays: 1 }] } }
    )) as Record<string, unknown>;
    expect(live).toEqual({
      LifecycleConfiguration: { Rules: [{ Id: 'r', Status: 'Enabled', Prefix: 'tmp/', ExpirationInDays: 9 }] },
    });
  });

  it("reads an inventory's OptionalFields as a set", async () => {
    armReads({
      ListBucketInventoryConfigurationsCommand: {
        InventoryConfigurationList: [
          {
            Id: 'inv',
            IsEnabled: true,
            IncludedObjectVersions: 'Current',
            Schedule: { Frequency: 'Daily' },
            Filter: { Prefix: 'inv/' },
            OptionalFields: ['ETag', 'Size'],
            Destination: {
              S3BucketDestination: {
                Bucket: 'arn:aws:s3:::dest',
                AccountId: '123456789012',
                Format: 'CSV',
                Prefix: 'reports/',
              },
            },
          },
        ],
      },
    });
    const live = await new S3DirectoryBucketProvider().readUnsettled(
      BUCKET,
      'Bucket',
      TYPE,
      new Set(['InventoryConfigurations']),
      {},
      { ...BASE, InventoryConfigurations: INVENTORY }
    );
    // INVENTORY declares ['Size', 'ETag']: the template's spelling comes back.
    expect(live).toEqual({ InventoryConfigurations: INVENTORY });
  });

  it('throws when a read fails', async () => {
    armReads({
      ListBucketMetricsConfigurationsCommand: Object.assign(new Error('denied'), { name: 'AccessDenied' }),
    });
    await expect(
      new S3DirectoryBucketProvider().readUnsettled(BUCKET, 'Bucket', TYPE, names, {}, FULL)
    ).rejects.toThrow('s3express:GetMetricsConfiguration');
  });
});

describe('S3DirectoryBucketProvider review round 2 (go-to-k/cdkd#2762)', () => {
  /** What a directory bucket reads as with no configuration declared: SSE-S3. */
  const DEFAULT_ANSWERS = {
    GetBucketEncryptionCommand: {
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: false }],
      },
    },
    GetBucketLifecycleConfigurationCommand: Object.assign(new Error('none'), {
      name: 'NoSuchLifecycleConfiguration',
    }),
  };

  it('a default (SSE-S3) readback round-trips through update() with no write', async () => {
    armReads(DEFAULT_ANSWERS);
    const observed = (await new S3DirectoryBucketProvider().readCurrentState(
      BUCKET,
      'Bucket',
      TYPE
    )) as Record<string, unknown>;
    expect(observed['BucketEncryption']).toEqual({
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: false },
      ],
    });
    mockS3Send.mockReset();
    mockS3Send.mockResolvedValue({});
    await new S3DirectoryBucketProvider().update('Bucket', BUCKET, TYPE, observed, observed);
    expect(s3Writes()).toEqual([]);
  });

  it('a template omitting BucketEncryption sends nothing against a default readback record', async () => {
    armReads(DEFAULT_ANSWERS);
    const observed = (await new S3DirectoryBucketProvider().readCurrentState(
      BUCKET,
      'Bucket',
      TYPE
    )) as Record<string, unknown>;
    mockS3Send.mockReset();
    mockS3Send.mockResolvedValue({});
    // The deploy compares the template with the RECORD, which is the template too.
    await new S3DirectoryBucketProvider().update('Bucket', BUCKET, TYPE, BASE, BASE);
    expect(s3Writes()).toEqual([]);
    // drift --revert of a default readback against a KMS record puts SSE-S3 back.
    await new S3DirectoryBucketProvider().update('Bucket', BUCKET, TYPE, observed, {
      ...observed,
      BucketEncryption: ENCRYPTION,
    });
    expect(s3Writes()).toEqual([
      [
        'PutBucketEncryptionCommand',
        {
          Bucket: BUCKET,
          ServerSideEncryptionConfiguration: {
            Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: false }],
          },
        },
      ],
    ]);
  });

  it('a default readback proves a declared SSE-S3 encryption settled (no unsettled loop)', async () => {
    armReads(DEFAULT_ANSWERS);
    const declared = {
      ...BASE,
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    };
    const live = await new S3DirectoryBucketProvider().readUnsettled(
      BUCKET,
      'Bucket',
      TYPE,
      new Set(['BucketEncryption']),
      {},
      declared
    );
    expect(live).toEqual({ BucketEncryption: declared.BucketEncryption });
  });

  it('the drift canonicalization makes a default readback equal a declared SSE-S3', () => {
    const provider = new S3DirectoryBucketProvider();
    const readback = {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' }, BucketKeyEnabled: false },
        ],
      },
    };
    expect(provider.canonicalizeDriftProperties(TYPE, readback)).toEqual({
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    });
  });

  it('readUnsettled compares against the RECORD when no desired bag is given', async () => {
    armReads(DEFAULT_ANSWERS);
    const recorded = {
      ...BASE,
      // No BucketKeyEnabled: the readback's implied `false` matches it.
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      },
    };
    const live = await new S3DirectoryBucketProvider().readUnsettled(
      BUCKET,
      'Bucket',
      TYPE,
      new Set(['BucketEncryption']),
      recorded
    );
    // The record's own spelling comes back: it matched.
    expect(live).toEqual({ BucketEncryption: recorded.BucketEncryption });
  });

  it('readUnsettled leaves out a metrics or inventory Id neither the record nor the template names', async () => {
    armReads({
      ListBucketMetricsConfigurationsCommand: {
        MetricsConfigurationList: [{ Id: 'recorded' }, { Id: 'console-added' }, { Id: 'desired' }],
      },
      ListBucketInventoryConfigurationsCommand: {
        InventoryConfigurationList: [
          {
            Id: 'console-inventory',
            IsEnabled: true,
            IncludedObjectVersions: 'Current',
            Schedule: { Frequency: 'Daily' },
            Destination: { S3BucketDestination: { Bucket: 'arn:aws:s3:::dest', Format: 'CSV' } },
          },
        ],
      },
    });
    const live = (await new S3DirectoryBucketProvider().readUnsettled(
      BUCKET,
      'Bucket',
      TYPE,
      new Set(['MetricsConfigurations', 'InventoryConfigurations']),
      { ...BASE, MetricsConfigurations: [{ Id: 'recorded' }] },
      { ...BASE, MetricsConfigurations: [{ Id: 'desired', Prefix: 'x/' }] }
    )) as Record<string, unknown>;
    expect(live).toEqual({
      MetricsConfigurations: [{ Id: 'recorded' }, { Id: 'desired' }],
      InventoryConfigurations: [],
    });
    // Fed to update() as the previous side, the out-of-band Ids are not deleted.
    mockS3Send.mockReset();
    mockS3Send.mockResolvedValue({});
    await new S3DirectoryBucketProvider().update(
      'Bucket',
      BUCKET,
      TYPE,
      { ...BASE, MetricsConfigurations: [{ Id: 'desired', Prefix: 'x/' }] },
      { ...BASE, ...live }
    );
    const deleted = inputsOf('DeleteBucketMetricsConfigurationCommand').map((i) => i['Id']);
    expect(deleted).toEqual(['recorded']);
    expect(inputsOf('DeleteBucketInventoryConfigurationCommand')).toEqual([]);
  });

  it('a create replaying a state record warns and leaves a malformed configuration out', async () => {
    const result = await new S3DirectoryBucketProvider().create(
      'Bucket',
      TYPE,
      { ...BASE, LifecycleConfiguration: { Rules: 'x' }, MetricsConfigurations: [{ Id: 'm' }] },
      { replayingState: true }
    );
    expect(result.physicalId).toBe(BUCKET);
    const names = s3Writes().map(([n]) => n);
    expect(names).toEqual(['CreateBucketCommand', 'PutBucketMetricsConfigurationCommand']);
  });

  it('a replayed create leaves out only the malformed list item, keeping the others', async () => {
    await new S3DirectoryBucketProvider().create(
      'Bucket',
      TYPE,
      {
        ...BASE,
        MetricsConfigurations: [{ Id: 'good' }, { Id: 'bad', Prefix: 7 }, { Id: 'good' }, {}],
      },
      { replayingState: true }
    );
    expect(inputsOf('PutBucketMetricsConfigurationCommand').map((i) => i['Id'])).toEqual(['good']);
  });

  it('a replayed create leaves out a list that is not a list at all', async () => {
    await new S3DirectoryBucketProvider().create(
      'Bucket',
      TYPE,
      { ...BASE, InventoryConfigurations: 'x', MetricsConfigurations: [{ Id: 'm' }] },
      { replayingState: true }
    );
    expect(s3Writes().map(([n]) => n)).toEqual([
      'CreateBucketCommand',
      'PutBucketMetricsConfigurationCommand',
    ]);
  });

  it('a template-path create still refuses the same value', async () => {
    const error = await rejection(
      new S3DirectoryBucketProvider().create('Bucket', TYPE, {
        ...BASE,
        LifecycleConfiguration: { Rules: 'x' },
      })
    );
    expect(error.message).toMatch(/LifecycleConfiguration\.Rules of .* is not a list/);
    expect(mockS3Send).not.toHaveBeenCalled();
  });
});
