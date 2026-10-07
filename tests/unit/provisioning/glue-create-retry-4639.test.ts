import { vi } from 'vite-plus/test';

// go-to-k/cdkd#4639: the Glue creates carry no idempotency token, so the AWS SDK's own
// retry of a 5xx whose request had succeeded replayed them inside ONE `send`
// and collided with what the first send made. That "already exists" surfaced
// from the engine's first attempt and read as a name somebody else holds.

vi.mock('@aws-sdk/client-glue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-glue')>();
  const { sdkClientStandIn } = await import('./data-create-retry-4639-harness.js');
  return {
    ...actual,
    GlueClient: vi
      .fn()
      .mockImplementation((cfg?: Parameters<typeof sdkClientStandIn>[0]) => sdkClientStandIn(cfg)),
  };
});
vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  const { sdkClientStandIn } = await import('./data-create-retry-4639-harness.js');
  return {
    ...actual,
    STSClient: vi
      .fn()
      .mockImplementation((cfg?: Parameters<typeof sdkClientStandIn>[0]) => sdkClientStandIn(cfg)),
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

import { AlreadyExistsException } from '@aws-sdk/client-glue';
import {
  GlueConnectionProvider,
  GlueCrawlerProvider,
  GlueJobProvider,
  GlueProvider,
  GlueSecurityConfigurationProvider,
  GlueTriggerProvider,
  GlueWorkflowProvider,
} from '../../../src/provisioning/providers/glue-provider.js';
import { topLevel, type NamedCreate } from './data-create-retry-4639-harness.js';
import { describeCreateRetrySafety, type CreateSite } from './data-create-retry-4639-suite.js';

const exists = (what: string) => (n: string) =>
  new AlreadyExistsException({
    message: `${what} ${n} already exists.`,
    $metadata: { httpStatusCode: 400 },
  });
const nested = (shape: string) => (input: Record<string, unknown>) =>
  (input[shape] as { Name: string }).Name;

const CREATES: Record<string, NamedCreate> = {
  CreateDatabaseCommand: { nameOf: nested('DatabaseInput'), collision: exists('Database') },
  CreateTableCommand: { nameOf: nested('TableInput'), collision: exists('Table') },
  CreateWorkflowCommand: { nameOf: topLevel('Name'), collision: exists('Workflow') },
  CreateSecurityConfigurationCommand: {
    nameOf: topLevel('Name'),
    collision: exists('Security configuration'),
  },
  CreateJobCommand: { nameOf: topLevel('Name'), collision: exists('Job') },
  CreateCrawlerCommand: { nameOf: topLevel('Name'), collision: exists('Crawler') },
  CreateConnectionCommand: { nameOf: nested('ConnectionInput'), collision: exists('Connection') },
  CreateTriggerCommand: { nameOf: topLevel('Name'), collision: exists('Trigger') },
};

const ROLE = 'arn:aws:iam::123456789012:role/glue';

const SITES: CreateSite[] = [
  {
    type: 'AWS::Glue::Database',
    command: 'CreateDatabaseCommand',
    name: 'orders_db',
    props: { DatabaseInput: { Name: 'orders_db' } },
    provider: () => new GlueProvider(),
    prose: true,
    successResponses: {},
  },
  {
    type: 'AWS::Glue::Table',
    command: 'CreateTableCommand',
    name: 'orders',
    physicalId: 'orders_db|orders',
    props: { DatabaseName: 'orders_db', TableInput: { Name: 'orders' } },
    provider: () => new GlueProvider(),
    prose: true,
    successResponses: {},
  },
  {
    type: 'AWS::Glue::Workflow',
    command: 'CreateWorkflowCommand',
    name: 'orders-wf',
    props: { Name: 'orders-wf' },
    provider: () => new GlueWorkflowProvider(),
    prose: true,
    successResponses: {},
  },
  {
    type: 'AWS::Glue::SecurityConfiguration',
    command: 'CreateSecurityConfigurationCommand',
    name: 'orders-sec',
    props: { Name: 'orders-sec', EncryptionConfiguration: {} },
    provider: () => new GlueSecurityConfigurationProvider(),
    prose: true,
    successResponses: {},
  },
  {
    type: 'AWS::Glue::Job',
    command: 'CreateJobCommand',
    name: 'orders-job',
    props: {
      Name: 'orders-job',
      Role: ROLE,
      Command: { Name: 'glueetl', ScriptLocation: 's3://bucket/script.py' },
    },
    provider: () => new GlueJobProvider(),
    prose: true,
    successResponses: {},
  },
  {
    type: 'AWS::Glue::Crawler',
    command: 'CreateCrawlerCommand',
    name: 'orders-crawler',
    props: {
      Name: 'orders-crawler',
      Role: ROLE,
      Targets: { S3Targets: [{ Path: 's3://bucket/data/' }] },
    },
    provider: () => new GlueCrawlerProvider(),
    prose: true,
    successResponses: {},
  },
  {
    type: 'AWS::Glue::Connection',
    command: 'CreateConnectionCommand',
    name: 'orders-conn',
    props: {
      ConnectionInput: {
        Name: 'orders-conn',
        ConnectionType: 'NETWORK',
        ConnectionProperties: {},
      },
    },
    provider: () => new GlueConnectionProvider(),
    prose: true,
    successResponses: {},
  },
  {
    type: 'AWS::Glue::Trigger',
    command: 'CreateTriggerCommand',
    name: 'orders-trigger',
    props: { Name: 'orders-trigger', Type: 'ON_DEMAND', Actions: [{ JobName: 'orders-job' }] },
    provider: () => new GlueTriggerProvider(),
    prose: true,
    successResponses: {},
  },
];

describeCreateRetrySafety(SITES, CREATES);
