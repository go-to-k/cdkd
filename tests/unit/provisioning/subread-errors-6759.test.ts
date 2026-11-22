/**
 * go-to-k/cdkd#6759: a SUB-read inside `readCurrentState` (one extra call for
 * one property) that fails with anything but its own not-found code rejects
 * the whole read, so `cdkd drift` reports the resource `readFailed` instead of
 * leaving the property uncompared (or defaulting it). Each case pins both
 * polarities: AccessDenied rejects, and the not-found code keeps today's
 * answer. DynamoDB Table / GlobalTable have their own files.
 */
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { ResourceNotFoundException as CognitoNotFound } from '@aws-sdk/client-cognito-identity-provider';
import { NoSuchDistribution, NoSuchResource } from '@aws-sdk/client-cloudfront';
import { NotFoundException as S3TablesNotFound } from '@aws-sdk/client-s3tables';
import {
  ResourceNotFoundException as CloudMapResourceNotFound,
  ServiceNotFound,
} from '@aws-sdk/client-servicediscovery';
import { NotFoundException as AppSyncNotFound } from '@aws-sdk/client-appsync';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFront: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...logger, child: () => logger }) };
});

import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';
import { CloudFrontDistributionProvider } from '../../../src/provisioning/providers/cloudfront-distribution-provider.js';
import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import { S3TablesProvider } from '../../../src/provisioning/providers/s3-tables-provider.js';
import { ServiceDiscoveryProvider } from '../../../src/provisioning/providers/servicediscovery-provider.js';
import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

const meta = { $metadata: {} };
const denied = (): Error =>
  Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });
/** Route 53 throws its not-found as a named error; the provider matches on `name`. */
const noSuchHostedZone = (): Error =>
  Object.assign(new Error('zone gone'), { name: 'NoSuchHostedZone' });

type Command = { constructor: { name: string } };
type Answers = Record<string, unknown>;

/** Answer each command from `answers`; `failing` rejects with `error()`. */
function stub(answers: Answers, failing: string | undefined, error: () => Error): void {
  mockSend.mockImplementation((command: Command) => {
    const name = command.constructor.name;
    if (name === failing) return Promise.reject(error());
    return Promise.resolve(answers[name] ?? {});
  });
}

/** Route every provider's client to `mockSend`. */
function withClient<T>(provider: T): T {
  (provider as unknown as { getClient: () => unknown }).getClient = () => ({
    send: mockSend,
    config: { region: () => Promise.resolve('us-east-1') },
  });
  return provider;
}

type Case = {
  site: string;
  command: string;
  notFound: () => Error;
  answers: Answers;
  read: () => Promise<unknown>;
  /** The key the not-found code leaves at today's answer, and that answer. */
  key: (bag: Record<string, unknown>) => unknown;
  notFoundValue: unknown;
  /** The value a successful read gives, so the fixture is shown to reach the call. */
  readValue: unknown;
};

const ZONE_ANSWERS: Answers = {
  GetHostedZoneCommand: {
    HostedZone: { Id: '/hostedzone/Z1', Name: 'example.com.', Config: { PrivateZone: false } },
  },
  ListTagsForResourceCommand: { ResourceTagSet: { Tags: [{ Key: 'team', Value: 'a' }] } },
  ListQueryLoggingConfigsCommand: {
    QueryLoggingConfigs: [{ CloudWatchLogsLogGroupArn: 'arn:aws:logs:us-east-1:1:log-group:q' }],
  },
};

const RECORD_PROPS = {
  HostedZoneName: 'example.com.',
  Name: 'www.example.com.',
  Type: 'A',
  TTL: '60',
  ResourceRecords: ['1.2.3.4'],
};
const RECORD_ANSWERS: Answers = {
  ListHostedZonesByNameCommand: { HostedZones: [{ Id: '/hostedzone/Z1', Name: 'example.com.' }] },
  ListResourceRecordSetsCommand: {
    ResourceRecordSets: [
      { Name: 'www.example.com.', Type: 'A', TTL: 60, ResourceRecords: [{ Value: '1.2.3.4' }] },
    ],
  },
};

const BUCKET_ARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/b1';
const TABLE_BUCKET_ANSWERS: Answers = {
  GetTableBucketCommand: { name: 'b1', arn: BUCKET_ARN },
  ListTagsForResourceCommand: { tags: { team: 'a' } },
  GetTableBucketEncryptionCommand: { encryptionConfiguration: { sseAlgorithm: 'aws:kms' } },
};
const TABLE_ANSWERS: Answers = {
  GetTableCommand: {
    name: 't1',
    format: 'ICEBERG',
    tableARN: `${BUCKET_ARN}/table/t-id`,
    namespace: ['ns'],
  },
  ListTagsForResourceCommand: { tags: { team: 'a' } },
  GetTableMaintenanceConfigurationCommand: {
    configuration: { icebergCompaction: { status: 'disabled' } },
  },
};

const SERVICE_ANSWERS: Answers = {
  GetServiceCommand: {
    Service: { Id: 'srv-1', Name: 's', Arn: 'arn:aws:servicediscovery:us-east-1:1:service/srv-1' },
  },
  GetServiceAttributesCommand: { ServiceAttributes: { Attributes: { k: 'v' } } },
  ListTagsForResourceCommand: { Tags: [{ Key: 'team', Value: 'a' }] },
};

const cases: Case[] = [
  {
    site: 'Cognito UserPool MFA-derived keys (EnabledMfas)',
    command: 'GetUserPoolMfaConfigCommand',
    notFound: () => new CognitoNotFound({ message: 'gone', ...meta }),
    answers: {
      DescribeUserPoolCommand: { UserPool: { Id: 'us-east-1_x', Name: 'p' } },
      GetUserPoolMfaConfigCommand: { SoftwareTokenMfaConfiguration: { Enabled: true } },
    },
    read: () =>
      withClient(new CognitoUserPoolProvider()).readCurrentState(
        'us-east-1_x',
        'P',
        'AWS::Cognito::UserPool'
      ),
    key: (bag) => bag['EnabledMfas'],
    notFoundValue: undefined,
    readValue: ['SOFTWARE_TOKEN_MFA'],
  },
  {
    site: 'CloudFront Distribution Tags',
    command: 'ListTagsForResourceCommand',
    notFound: () => new NoSuchDistribution({ message: 'gone', ...meta }),
    answers: {
      GetDistributionConfigCommand: { DistributionConfig: { Comment: 'c', Enabled: true } },
      GetDistributionCommand: { Distribution: { ARN: 'arn:aws:cloudfront::1:distribution/D1' } },
      ListTagsForResourceCommand: { Tags: { Items: [{ Key: 'team', Value: 'a' }] } },
    },
    read: () =>
      new CloudFrontDistributionProvider().readCurrentState(
        'D1',
        'D',
        'AWS::CloudFront::Distribution'
      ),
    key: (bag) => bag['Tags'],
    notFoundValue: undefined,
    readValue: [{ Key: 'team', Value: 'a' }],
  },
  {
    site: 'CloudFront Distribution Tags (tag read answers NoSuchResource)',
    command: 'ListTagsForResourceCommand',
    notFound: () => new NoSuchResource({ message: 'gone', ...meta }),
    answers: {
      GetDistributionConfigCommand: { DistributionConfig: { Comment: 'c', Enabled: true } },
      GetDistributionCommand: { Distribution: { ARN: 'arn:aws:cloudfront::1:distribution/D1' } },
      ListTagsForResourceCommand: { Tags: { Items: [{ Key: 'team', Value: 'a' }] } },
    },
    read: () =>
      new CloudFrontDistributionProvider().readCurrentState(
        'D1',
        'D',
        'AWS::CloudFront::Distribution'
      ),
    key: (bag) => bag['Tags'],
    notFoundValue: undefined,
    readValue: [{ Key: 'team', Value: 'a' }],
  },
  {
    site: 'Route 53 HostedZone HostedZoneTags',
    command: 'ListTagsForResourceCommand',
    notFound: noSuchHostedZone,
    answers: ZONE_ANSWERS,
    read: () =>
      withClient(new Route53Provider()).readCurrentState('Z1', 'Z', 'AWS::Route53::HostedZone'),
    key: (bag) => bag['HostedZoneTags'],
    notFoundValue: undefined,
    readValue: [{ Key: 'team', Value: 'a' }],
  },
  {
    site: 'Route 53 HostedZone QueryLoggingConfig',
    command: 'ListQueryLoggingConfigsCommand',
    notFound: noSuchHostedZone,
    answers: ZONE_ANSWERS,
    read: () =>
      withClient(new Route53Provider()).readCurrentState('Z1', 'Z', 'AWS::Route53::HostedZone'),
    key: (bag) => bag['QueryLoggingConfig'],
    notFoundValue: {},
    readValue: { CloudWatchLogsLogGroupArn: 'arn:aws:logs:us-east-1:1:log-group:q' },
  },
  {
    site: 'S3Tables TableBucket Tags',
    command: 'ListTagsForResourceCommand',
    notFound: () => new S3TablesNotFound({ message: 'gone', ...meta }),
    answers: TABLE_BUCKET_ANSWERS,
    read: () =>
      withClient(new S3TablesProvider()).readCurrentState(
        BUCKET_ARN,
        'B',
        'AWS::S3Tables::TableBucket'
      ),
    key: (bag) => bag['Tags'],
    notFoundValue: [],
    readValue: [{ Key: 'team', Value: 'a' }],
  },
  {
    site: 'S3Tables TableBucket configuration (EncryptionConfiguration)',
    command: 'GetTableBucketEncryptionCommand',
    notFound: () => new S3TablesNotFound({ message: 'gone', ...meta }),
    answers: TABLE_BUCKET_ANSWERS,
    read: () =>
      withClient(new S3TablesProvider()).readCurrentState(
        BUCKET_ARN,
        'B',
        'AWS::S3Tables::TableBucket'
      ),
    key: (bag) => bag['EncryptionConfiguration'],
    notFoundValue: { SSEAlgorithm: 'AES256' },
    readValue: { SSEAlgorithm: 'aws:kms' },
  },
  {
    site: 'S3Tables Table Tags',
    command: 'ListTagsForResourceCommand',
    notFound: () => new S3TablesNotFound({ message: 'gone', ...meta }),
    answers: TABLE_ANSWERS,
    read: () =>
      withClient(new S3TablesProvider()).readCurrentState(
        `${BUCKET_ARN}|ns|t1`,
        'T',
        'AWS::S3Tables::Table'
      ),
    key: (bag) => bag['Tags'],
    notFoundValue: [],
    readValue: [{ Key: 'team', Value: 'a' }],
  },
  {
    site: 'S3Tables Table Compaction / SnapshotManagement',
    command: 'GetTableMaintenanceConfigurationCommand',
    notFound: () => new S3TablesNotFound({ message: 'gone', ...meta }),
    answers: TABLE_ANSWERS,
    read: () =>
      withClient(new S3TablesProvider()).readCurrentState(
        `${BUCKET_ARN}|ns|t1`,
        'T',
        'AWS::S3Tables::Table'
      ),
    key: (bag) => bag['Compaction'],
    notFoundValue: { Status: 'enabled' },
    readValue: { Status: 'disabled' },
  },
  {
    site: 'ServiceDiscovery Service ServiceAttributes',
    command: 'GetServiceAttributesCommand',
    notFound: () => new ServiceNotFound({ message: 'gone', ...meta }),
    answers: SERVICE_ANSWERS,
    read: () =>
      withClient(new ServiceDiscoveryProvider()).readCurrentState(
        'srv-1',
        'S',
        'AWS::ServiceDiscovery::Service'
      ),
    key: (bag) => bag['ServiceAttributes'],
    notFoundValue: undefined,
    readValue: { k: 'v' },
  },
  {
    site: 'ServiceDiscovery Service Tags',
    command: 'ListTagsForResourceCommand',
    notFound: () => new CloudMapResourceNotFound({ message: 'gone', ...meta }),
    answers: SERVICE_ANSWERS,
    read: () =>
      withClient(new ServiceDiscoveryProvider()).readCurrentState(
        'srv-1',
        'S',
        'AWS::ServiceDiscovery::Service'
      ),
    key: (bag) => bag['Tags'],
    notFoundValue: undefined,
    readValue: [{ Key: 'team', Value: 'a' }],
  },
  {
    site: 'AppSync GraphQLApi EnvironmentVariables',
    command: 'GetGraphqlApiEnvironmentVariablesCommand',
    notFound: () => new AppSyncNotFound({ message: 'gone', ...meta }),
    answers: {
      GetGraphqlApiCommand: { graphqlApi: { apiId: 'api1', name: 'a', authenticationType: 'API_KEY' } },
      GetGraphqlApiEnvironmentVariablesCommand: { environmentVariables: { K: 'v' } },
    },
    read: () =>
      withClient(new AppSyncProvider()).readCurrentState('api1', 'A', 'AWS::AppSync::GraphQLApi'),
    key: (bag) => bag['EnvironmentVariables'],
    notFoundValue: undefined,
    readValue: { K: 'v' },
  },
];

describe('readCurrentState sub-read failures (go-to-k/cdkd#6759)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  for (const c of cases) {
    it(`${c.site}: AccessDenied rejects the read`, async () => {
      stub(c.answers, c.command, denied);
      await expect(c.read()).rejects.toThrow('not authorized');
    });

    it(`${c.site}: the not-found code keeps today's answer`, async () => {
      stub(c.answers, c.command, c.notFound);
      const bag = (await c.read()) as Record<string, unknown>;
      expect(bag).not.toBe(RESOURCE_NOT_FOUND);
      expect(c.key(bag)).toEqual(c.notFoundValue);
    });

    it(`${c.site}: a successful read reaches the call`, async () => {
      stub(c.answers, undefined, denied);
      const bag = (await c.read()) as Record<string, unknown>;
      expect(c.key(bag)).toEqual(c.readValue);
    });
  }
});

describe('Route 53 whole-resource reads on a failed zone lookup (go-to-k/cdkd#6759)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  const readRecord = () =>
    withClient(new Route53Provider()).readCurrentState(
      'www.example.com.',
      'R',
      'AWS::Route53::RecordSet',
      RECORD_PROPS
    );
  const GROUP_PROPS = { HostedZoneName: 'example.com.', RecordSets: [RECORD_PROPS] };
  const readGroup = () =>
    withClient(new Route53Provider()).readCurrentState(
      'G',
      'G',
      'AWS::Route53::RecordSetGroup',
      GROUP_PROPS
    );

  it('RecordSet: a denied ListHostedZonesByName rejects the read (it used to be undefined)', async () => {
    stub(RECORD_ANSWERS, 'ListHostedZonesByNameCommand', denied);
    await expect(readRecord()).rejects.toThrow('Could not resolve HostedZoneName');
  });

  it('RecordSet: a listing that throws a non-Error value also rejects the read', async () => {
    mockSend.mockImplementation((command: Command) =>
      command.constructor.name === 'ListHostedZonesByNameCommand'
        ? Promise.reject('socket hang up')
        : Promise.resolve(RECORD_ANSWERS[command.constructor.name] ?? {})
    );
    await expect(readRecord()).rejects.toThrow('Could not resolve HostedZoneName');
  });

  it('RecordSet: a zone name that matches no zone is still "cannot tell"', async () => {
    stub({ ...RECORD_ANSWERS, ListHostedZonesByNameCommand: { HostedZones: [] } }, undefined, denied);
    await expect(readRecord()).resolves.toBeUndefined();
  });

  it('RecordSet: a resolvable zone reads the record', async () => {
    stub(RECORD_ANSWERS, undefined, denied);
    const bag = (await readRecord()) as Record<string, unknown>;
    expect(bag['Type']).toBe('A');
  });

  it('RecordSetGroup: a denied ListHostedZonesByName rejects the read (it used to be undefined)', async () => {
    stub(RECORD_ANSWERS, 'ListHostedZonesByNameCommand', denied);
    await expect(readGroup()).rejects.toThrow('Could not resolve HostedZoneName');
  });

  it('RecordSetGroup: a zone name that matches no zone is still "cannot tell"', async () => {
    stub({ ...RECORD_ANSWERS, ListHostedZonesByNameCommand: { HostedZones: [] } }, undefined, denied);
    await expect(readGroup()).resolves.toBeUndefined();
  });

  it('RecordSetGroup: a resolvable zone reads the records', async () => {
    stub(RECORD_ANSWERS, undefined, denied);
    const bag = (await readGroup()) as Record<string, unknown>;
    expect(bag['RecordSets']).toHaveLength(1);
  });
});

describe('S3Tables Table identity resolution (go-to-k/cdkd#6759)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  const TABLE_ARN = `${BUCKET_ARN}/table/t-id`;
  const readByArn = () =>
    withClient(new S3TablesProvider()).readCurrentState(TABLE_ARN, 'T', 'AWS::S3Tables::Table');

  it('a denied GetTable on a bare-ARN row rejects the read (it used to be undefined)', async () => {
    stub(TABLE_ANSWERS, 'GetTableCommand', denied);
    await expect(readByArn()).rejects.toThrow('not authorized');
  });

  it('a bare-ARN row whose table is gone still reads RESOURCE_NOT_FOUND', async () => {
    stub(TABLE_ANSWERS, 'GetTableCommand', () => new S3TablesNotFound({ message: 'gone', ...meta }));
    await expect(readByArn()).resolves.toBe(RESOURCE_NOT_FOUND);
  });
});
