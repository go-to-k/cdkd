/**
 * Issue #2613: the pre-delete region guard on the S3 directory bucket, S3
 * Tables, WAFv2 web ACL and every Glue provider class. Each `delete()` refuses a
 * client in another region than the state record BEFORE any AWS call (not only
 * on NotFound), deletes when the regions match, and never resolves the client
 * region when the record carries none.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.hoisted(() => vi.fn());
const mockStsSend = vi.hoisted(() => vi.fn());

const regionalClient = vi.hoisted(() => () => ({
  send: mockSend,
  config: { region: () => Promise.resolve('us-east-1') },
}));

vi.mock('@aws-sdk/client-glue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-glue')>();
  return { ...actual, GlueClient: vi.fn().mockImplementation(regionalClient) };
});
vi.mock('@aws-sdk/client-s3tables', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3tables')>();
  return { ...actual, S3TablesClient: vi.fn().mockImplementation(regionalClient) };
});
vi.mock('@aws-sdk/client-wafv2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-wafv2')>();
  return { ...actual, WAFV2Client: vi.fn().mockImplementation(regionalClient) };
});
vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return { ...actual, S3Client: vi.fn().mockImplementation(regionalClient) };
});
vi.mock('@aws-sdk/client-s3-control', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3-control')>();
  return { ...actual, S3ControlClient: vi.fn().mockImplementation(regionalClient) };
});
vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ec2')>();
  return { ...actual, EC2Client: vi.fn().mockImplementation(regionalClient) };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ s3: regionalClient(), sts: { send: mockStsSend } }),
}));

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

import {
  GlueProvider,
  GlueWorkflowProvider,
  GlueSecurityConfigurationProvider,
  GlueJobProvider,
  GlueCrawlerProvider,
  GlueConnectionProvider,
  GlueTriggerProvider,
} from '../../../src/provisioning/providers/glue-provider.js';
import { S3DirectoryBucketProvider } from '../../../src/provisioning/providers/s3-directory-bucket-provider.js';
import { S3TablesProvider } from '../../../src/provisioning/providers/s3-tables-provider.js';
import { WAFv2WebACLProvider } from '../../../src/provisioning/providers/wafv2-provider.js';
import type { ResourceProvider } from '../../../src/types/resource.js';

type RegionHolder = { config: { region: unknown } };
const viaGetClient = (p: ResourceProvider): RegionHolder =>
  (p as unknown as { getClient(): RegionHolder }).getClient();
const viaS3Client = (p: ResourceProvider): RegionHolder =>
  (p as unknown as { s3Client: RegionHolder }).s3Client;

const TABLE_BUCKET_ARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/my-bucket';
const WEB_ACL_ARN = 'arn:aws:wafv2:us-east-1:123456789012:regional/webacl/my-acl/abc-123';

interface Case {
  name: string;
  make: () => ResourceProvider;
  type: string;
  physicalId: string;
  /** The first command a matching-region delete sends. */
  firstCommand: string;
  /** The client whose region the delete would act through. */
  client: (p: ResourceProvider) => RegionHolder;
}

const CASES: Case[] = [
  {
    name: 'Glue Database',
    make: () => new GlueProvider(),
    type: 'AWS::Glue::Database',
    physicalId: 'my_db',
    firstCommand: 'DeleteDatabaseCommand',
    client: viaGetClient,
  },
  {
    name: 'Glue Table',
    make: () => new GlueProvider(),
    type: 'AWS::Glue::Table',
    physicalId: 'my_db|my_table',
    firstCommand: 'DeleteTableCommand',
    client: viaGetClient,
  },
  {
    name: 'Glue Workflow',
    make: () => new GlueWorkflowProvider(),
    type: 'AWS::Glue::Workflow',
    physicalId: 'my-workflow',
    firstCommand: 'DeleteWorkflowCommand',
    client: viaGetClient,
  },
  {
    name: 'Glue SecurityConfiguration',
    make: () => new GlueSecurityConfigurationProvider(),
    type: 'AWS::Glue::SecurityConfiguration',
    physicalId: 'my-sec',
    firstCommand: 'DeleteSecurityConfigurationCommand',
    client: viaGetClient,
  },
  {
    name: 'Glue Job',
    make: () => new GlueJobProvider(),
    type: 'AWS::Glue::Job',
    physicalId: 'my-job',
    firstCommand: 'DeleteJobCommand',
    client: viaGetClient,
  },
  {
    name: 'Glue Crawler',
    make: () => new GlueCrawlerProvider(),
    type: 'AWS::Glue::Crawler',
    physicalId: 'my-crawler',
    firstCommand: 'DeleteCrawlerCommand',
    client: viaGetClient,
  },
  {
    name: 'Glue Connection',
    make: () => new GlueConnectionProvider(),
    type: 'AWS::Glue::Connection',
    physicalId: 'my-connection',
    firstCommand: 'DeleteConnectionCommand',
    client: viaGetClient,
  },
  {
    name: 'Glue Trigger',
    make: () => new GlueTriggerProvider(),
    type: 'AWS::Glue::Trigger',
    physicalId: 'my-trigger',
    firstCommand: 'GetTriggerCommand',
    client: viaGetClient,
  },
  {
    name: 'S3 Express directory bucket',
    make: () => new S3DirectoryBucketProvider(),
    type: 'AWS::S3Express::DirectoryBucket',
    physicalId: 'my-bucket--use1-az4--x-s3',
    firstCommand: 'DeleteBucketCommand',
    client: viaS3Client,
  },
  {
    name: 'S3 Tables table bucket',
    make: () => new S3TablesProvider(),
    type: 'AWS::S3Tables::TableBucket',
    physicalId: TABLE_BUCKET_ARN,
    firstCommand: 'ListNamespacesCommand',
    client: viaGetClient,
  },
  {
    name: 'S3 Tables namespace',
    make: () => new S3TablesProvider(),
    type: 'AWS::S3Tables::Namespace',
    physicalId: `${TABLE_BUCKET_ARN}|ns`,
    firstCommand: 'DeleteNamespaceCommand',
    client: viaGetClient,
  },
  {
    name: 'S3 Tables table',
    make: () => new S3TablesProvider(),
    type: 'AWS::S3Tables::Table',
    physicalId: `${TABLE_BUCKET_ARN}|ns|tbl`,
    firstCommand: 'DeleteTableCommand',
    client: viaGetClient,
  },
  {
    name: 'WAFv2 web ACL',
    make: () => new WAFv2WebACLProvider(),
    type: 'AWS::WAFv2::WebACL',
    physicalId: WEB_ACL_ARN,
    firstCommand: 'GetWebACLCommand',
    client: viaGetClient,
  },
];

describe.each(CASES)('$name delete region guard (issue #2613)', (c) => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Every send answers with an empty success; the trigger's GetTrigger
    // reports a non-activated trigger, and WAFv2's GetWebACL a LockToken.
    mockSend.mockResolvedValue({ LockToken: 'lock', Trigger: { State: 'CREATED' } });
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
  });

  it('refuses a wrong-region client before any call', async () => {
    const provider = c.make();
    await expect(
      provider.delete('Res', c.physicalId, c.type, {}, { expectedRegion: 'us-west-2' })
    ).rejects.toThrow(
      /Refusing to delete Res .*region us-east-1 does not match stack state region us-west-2/
    );
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('deletes when the client region matches the recorded one', async () => {
    const provider = c.make();
    await provider.delete('Res', c.physicalId, c.type, {}, { expectedRegion: 'us-east-1' });
    expect(mockSend.mock.calls[0]![0].constructor.name).toBe(c.firstCommand);
  });

  it('without a recorded region proceeds and never resolves the client region', async () => {
    const provider = c.make();
    const region = vi.fn(() => Promise.resolve('us-west-2'));
    c.client(provider).config.region = region;
    await provider.delete('Res', c.physicalId, c.type, {});
    expect(region).not.toHaveBeenCalled();
    expect(mockSend.mock.calls[0]![0].constructor.name).toBe(c.firstCommand);
  });
});
