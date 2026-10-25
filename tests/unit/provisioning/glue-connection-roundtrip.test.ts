import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateConnectionCommand,
  UpdateConnectionCommand,
  DeleteConnectionCommand,
  GetConnectionCommand,
  GetTagsCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from '@aws-sdk/client-glue';

const mockSend = vi.fn();
const mockStsSend = vi.fn();

// The Connection's tag ARN names the caller's account when no CatalogId is
// declared (go-to-k/cdkd#2762), resolved through STS.
vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({ send: mockStsSend })),
  };
});

vi.mock('@aws-sdk/client-glue', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-glue')>('@aws-sdk/client-glue');
  return {
    ...actual,
    GlueClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
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

import { GlueConnectionProvider } from '../../../src/provisioning/providers/glue-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

describe('GlueConnectionProvider', () => {
  let provider: GlueConnectionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueConnectionProvider();
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    mockStsSend.mockReset();
    mockStsSend.mockResolvedValue({ Account: '111122223333' });
  });

  it('create() builds CreateConnection with full ConnectionInput surface', async () => {
    const result = await provider.create('L', 'AWS::Glue::Connection', {
      ConnectionInput: {
        Name: 'my-connection',
        ConnectionType: 'JDBC',
        Description: 'My JDBC connection',
        ConnectionProperties: {
          JDBC_CONNECTION_URL: 'jdbc:mysql://my-rds.example.com:3306/mydb',
          USERNAME: 'admin',
          PASSWORD: 'secret',
        },
        MatchCriteria: ['MyMatchCriteria'],
        PhysicalConnectionRequirements: {
          AvailabilityZone: 'us-east-1a',
          SecurityGroupIdList: ['sg-12345'],
          SubnetId: 'subnet-12345',
        },
      },
      CatalogId: '123456789012',
    });

    expect(result).toEqual({ physicalId: 'my-connection', attributes: {} });
    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateConnectionCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({
      CatalogId: '123456789012',
      ConnectionInput: {
        Name: 'my-connection',
        ConnectionType: 'JDBC',
        Description: 'My JDBC connection',
        ConnectionProperties: {
          JDBC_CONNECTION_URL: 'jdbc:mysql://my-rds.example.com:3306/mydb',
          USERNAME: 'admin',
          PASSWORD: 'secret',
        },
        MatchCriteria: ['MyMatchCriteria'],
        PhysicalConnectionRequirements: {
          AvailabilityZone: 'us-east-1a',
          SecurityGroupIdList: ['sg-12345'],
          SubnetId: 'subnet-12345',
        },
      },
    });
  });

  it('create() omits CatalogId when not provided and falls back to logicalId for Name when ConnectionInput.Name absent', async () => {
    await provider.create('L', 'AWS::Glue::Connection', {
      ConnectionInput: {
        ConnectionType: 'NETWORK',
        ConnectionProperties: {},
      },
    });

    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateConnectionCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({
      ConnectionInput: {
        Name: 'L',
        ConnectionType: 'NETWORK',
        ConnectionProperties: {},
      },
    });
  });

  it('create() fails when ConnectionInput is missing', async () => {
    await expect(
      provider.create('L', 'AWS::Glue::Connection', { CatalogId: '123' })
    ).rejects.toThrow(/ConnectionInput is required/);
  });

  it('update() forwards UpdateConnection with name + ConnectionInput', async () => {
    await provider.update(
      'L',
      'my-connection',
      'AWS::Glue::Connection',
      {
        ConnectionInput: {
          Name: 'my-connection',
          ConnectionType: 'JDBC',
          ConnectionProperties: { JDBC_CONNECTION_URL: 'jdbc:mysql://new-host/db' },
          Description: 'updated',
        },
      },
      {}
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateConnectionCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({
      Name: 'my-connection',
      ConnectionInput: {
        Name: 'my-connection',
        ConnectionType: 'JDBC',
        ConnectionProperties: { JDBC_CONNECTION_URL: 'jdbc:mysql://new-host/db' },
        Description: 'updated',
      },
    });
  });

  it('update() fails when ConnectionInput is missing on update', async () => {
    await expect(
      provider.update(
        'L',
        'my-connection',
        'AWS::Glue::Connection',
        { CatalogId: '123' },
        {}
      )
    ).rejects.toThrow(/ConnectionInput is required/);
  });

  it('delete() calls DeleteConnection with optional CatalogId', async () => {
    await provider.delete(
      'L',
      'my-connection',
      'AWS::Glue::Connection',
      { CatalogId: '123456789012' },
      { expectedRegion: 'us-east-1' }
    );

    const call = mockSend.mock.calls.find((c) => c[0] instanceof DeleteConnectionCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({
      ConnectionName: 'my-connection',
      CatalogId: '123456789012',
    });
  });

  it('delete() omits CatalogId when not in properties', async () => {
    await provider.delete('L', 'my-connection', 'AWS::Glue::Connection', undefined, {
      expectedRegion: 'us-east-1',
    });

    const call = mockSend.mock.calls.find((c) => c[0] instanceof DeleteConnectionCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({ ConnectionName: 'my-connection' });
  });

  it('delete() treats EntityNotFoundException as idempotent when region matches', async () => {
    const { EntityNotFoundException } = await import('@aws-sdk/client-glue');
    mockSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'not found', $metadata: {} })
    );

    await expect(
      provider.delete('L', 'my-connection', 'AWS::Glue::Connection', undefined, {
        expectedRegion: 'us-east-1',
      })
    ).resolves.toBeUndefined();
  });

  it('getAttribute() returns physicalId for Id / Ref / Name', async () => {
    expect(await provider.getAttribute('my-connection', 'AWS::Glue::Connection', 'Id')).toBe(
      'my-connection'
    );
    expect(await provider.getAttribute('my-connection', 'AWS::Glue::Connection', 'Ref')).toBe(
      'my-connection'
    );
    expect(await provider.getAttribute('my-connection', 'AWS::Glue::Connection', 'Name')).toBe(
      'my-connection'
    );
    expect(
      await provider.getAttribute('my-connection', 'AWS::Glue::Connection', 'Unknown')
    ).toBeUndefined();
  });

  it('readCurrentState() emits PR #145 always-emit placeholders inside ConnectionInput on a default Connection', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetConnectionCommand) {
        return Promise.resolve({ Connection: { Name: 'my-connection' } });
      }
      return Promise.resolve({});
    });

    const result = await provider.readCurrentState('my-connection', 'L', 'AWS::Glue::Connection');
    expect(result).toEqual({
      ConnectionInput: {
        Name: 'my-connection',
        ConnectionType: '',
        Description: '',
        MatchCriteria: [],
        ConnectionProperties: {},
        SparkProperties: {},
        AthenaProperties: {},
        PythonProperties: {},
        PhysicalConnectionRequirements: {},
      },
      Tags: [],
    });
  });

  it('readCurrentState() surfaces AWS values when Connection is fully configured', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetConnectionCommand) {
        return Promise.resolve({
          Connection: {
            Name: 'my-connection',
            ConnectionType: 'JDBC',
            Description: 'desc',
            MatchCriteria: ['critA'],
            ConnectionProperties: { JDBC_CONNECTION_URL: 'jdbc:mysql://host/db' },
            PhysicalConnectionRequirements: {
              AvailabilityZone: 'us-east-1a',
              SecurityGroupIdList: ['sg-12345'],
              SubnetId: 'subnet-12345',
            },
          },
        });
      }
      return Promise.resolve({});
    });

    const result = await provider.readCurrentState('my-connection', 'L', 'AWS::Glue::Connection');
    expect(result).toEqual({
      ConnectionInput: {
        Name: 'my-connection',
        ConnectionType: 'JDBC',
        Description: 'desc',
        MatchCriteria: ['critA'],
        ConnectionProperties: { JDBC_CONNECTION_URL: 'jdbc:mysql://host/db' },
        SparkProperties: {},
        AthenaProperties: {},
        PythonProperties: {},
        PhysicalConnectionRequirements: {
          AvailabilityZone: 'us-east-1a',
          SecurityGroupIdList: ['sg-12345'],
          SubnetId: 'subnet-12345',
        },
      },
      Tags: [],
    });
  });

  it('readCurrentState() returns RESOURCE_NOT_FOUND when connection does not exist', async () => {
    const { EntityNotFoundException } = await import('@aws-sdk/client-glue');
    mockSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'not found', $metadata: {} })
    );

    const result = await provider.readCurrentState('missing', 'L', 'AWS::Glue::Connection');
    expect(result).toBe(RESOURCE_NOT_FOUND);
  });

  it('readCurrentState() forwards CatalogId from properties to GetConnection input', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetConnectionCommand) {
        return Promise.resolve({
          Connection: { Name: 'my-connection', ConnectionType: 'JDBC' },
        });
      }
      return Promise.resolve({});
    });

    await provider.readCurrentState('my-connection', 'L', 'AWS::Glue::Connection', {
      CatalogId: '123456789012',
    });
    const call = mockSend.mock.calls.find((c) => c[0] instanceof GetConnectionCommand);
    expect(call).toBeDefined();
    expect(call![0].input).toEqual({
      Name: 'my-connection',
      CatalogId: '123456789012',
    });
  });

  it('handledProperties declares the documented surface', () => {
    const set = provider.handledProperties.get('AWS::Glue::Connection');
    expect(set).toBeDefined();
    expect([...(set ?? new Set())].sort()).toEqual(['CatalogId', 'ConnectionInput', 'Tags']);
  });
});

describe('GlueConnectionProvider Tags (go-to-k/cdkd#2762)', () => {
  let provider: GlueConnectionProvider;
  const CONNECTION_INPUT = {
    Name: 'my-connection',
    ConnectionType: 'JDBC',
    ConnectionProperties: { JDBC_CONNECTION_URL: 'jdbc:mysql://host/db' },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueConnectionProvider();
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    mockStsSend.mockReset();
    mockStsSend.mockResolvedValue({ Account: '111122223333' });
  });

  function sent<T>(ctor: new (...args: never[]) => T): T[] {
    return mockSend.mock.calls.map((c) => c[0]).filter((c): c is T => c instanceof ctor);
  }

  it('sends the tag MAP on CreateConnection itself, with no separate TagResource', async () => {
    await provider.create('L', 'AWS::Glue::Connection', {
      ConnectionInput: CONNECTION_INPUT,
      Tags: { env: 'integ', team: 'data' },
    });
    const [create] = sent(CreateConnectionCommand);
    expect(create!.input.Tags).toEqual({ env: 'integ', team: 'data' });
    expect(sent(TagResourceCommand)).toHaveLength(0);
  });

  it('omits Tags from CreateConnection when the template declares none', async () => {
    await provider.create('L', 'AWS::Glue::Connection', { ConnectionInput: CONNECTION_INPUT });
    const [create] = sent(CreateConnectionCommand);
    expect(create!.input).not.toHaveProperty('Tags');
  });

  it('refuses a malformed Tags before any call', async () => {
    await expect(
      provider.create('L', 'AWS::Glue::Connection', {
        ConnectionInput: CONNECTION_INPUT,
        Tags: 'not-tags',
      })
    ).rejects.toThrow(/Tags/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('diffs tags on update: sets the changed and added keys, untags the dropped one', async () => {
    await provider.update(
      'L',
      'my-connection',
      'AWS::Glue::Connection',
      { ConnectionInput: CONNECTION_INPUT, Tags: { env: 'updated', owner: 'cdkd' } },
      { ConnectionInput: CONNECTION_INPUT, Tags: { env: 'integ', team: 'data' } }
    );
    const arn = 'arn:aws:glue:us-east-1:111122223333:connection/my-connection';
    const [tag] = sent(TagResourceCommand);
    expect(tag!.input).toEqual({ ResourceArn: arn, TagsToAdd: { env: 'updated', owner: 'cdkd' } });
    const [untag] = sent(UntagResourceCommand);
    expect(untag!.input).toEqual({ ResourceArn: arn, TagsToRemove: ['team'] });
    // The tags follow the definition update, never precede it.
    const order = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(order.indexOf('UpdateConnectionCommand')).toBeLessThan(
      order.indexOf('TagResourceCommand')
    );
    expect(order.indexOf('UpdateConnectionCommand')).toBeGreaterThanOrEqual(0);
  });

  it('untags every key when the template removes Tags', async () => {
    await provider.update(
      'L',
      'my-connection',
      'AWS::Glue::Connection',
      { ConnectionInput: CONNECTION_INPUT },
      { ConnectionInput: CONNECTION_INPUT, Tags: { env: 'integ' } }
    );
    expect(sent(TagResourceCommand)).toHaveLength(0);
    const [untag] = sent(UntagResourceCommand);
    expect(untag!.input.TagsToRemove).toEqual(['env']);
  });

  it('makes no tag call when the tags are unchanged', async () => {
    await provider.update(
      'L',
      'my-connection',
      'AWS::Glue::Connection',
      { ConnectionInput: CONNECTION_INPUT, Tags: { env: 'integ' } },
      { ConnectionInput: CONNECTION_INPUT, Tags: { env: 'integ' } }
    );
    expect(sent(TagResourceCommand)).toHaveLength(0);
    expect(sent(UntagResourceCommand)).toHaveLength(0);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('addresses the tag ARN by a declared CatalogId, without STS', async () => {
    await provider.update(
      'L',
      'my-connection',
      'AWS::Glue::Connection',
      { ConnectionInput: CONNECTION_INPUT, CatalogId: '444455556666', Tags: { env: 'b' } },
      { ConnectionInput: CONNECTION_INPUT, CatalogId: '444455556666', Tags: { env: 'a' } }
    );
    const [tag] = sent(TagResourceCommand);
    expect(tag!.input.ResourceArn).toBe(
      'arn:aws:glue:us-east-1:444455556666:connection/my-connection'
    );
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('refuses a malformed desired Tags on update before UpdateConnection', async () => {
    await expect(
      provider.update(
        'L',
        'my-connection',
        'AWS::Glue::Connection',
        { ConnectionInput: CONNECTION_INPUT, Tags: ['not-a-tag'] },
        { ConnectionInput: CONNECTION_INPUT }
      )
    ).rejects.toThrow(/Tags/);
    expect(sent(UpdateConnectionCommand)).toHaveLength(0);
  });

  it('reads the tags back from GetTags on the connection ARN', async () => {
    mockSend.mockImplementation((cmd) => {
      if (cmd instanceof GetConnectionCommand) {
        return Promise.resolve({ Connection: { Name: 'my-connection' } });
      }
      if (cmd instanceof GetTagsCommand) {
        return Promise.resolve({ Tags: { env: 'integ', 'aws:cloudformation:stack-name': 'x' } });
      }
      return Promise.resolve({});
    });
    const result = (await provider.readCurrentState(
      'my-connection',
      'L',
      'AWS::Glue::Connection'
    )) as Record<string, unknown>;
    expect(result['Tags']).toEqual([{ Key: 'env', Value: 'integ' }]);
    const [getTags] = sent(GetTagsCommand);
    expect(getTags!.input.ResourceArn).toBe(
      'arn:aws:glue:us-east-1:111122223333:connection/my-connection'
    );
  });
});
