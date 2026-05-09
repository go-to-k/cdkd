import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CreateConnectionCommand,
  UpdateConnectionCommand,
  DeleteConnectionCommand,
  GetConnectionCommand,
} from '@aws-sdk/client-glue';

const mockSend = vi.fn();

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

describe('GlueConnectionProvider', () => {
  let provider: GlueConnectionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueConnectionProvider();
    mockSend.mockResolvedValue({});
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
    });
  });

  it('readCurrentState() returns undefined when connection does not exist', async () => {
    const { EntityNotFoundException } = await import('@aws-sdk/client-glue');
    mockSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'not found', $metadata: {} })
    );

    const result = await provider.readCurrentState('missing', 'L', 'AWS::Glue::Connection');
    expect(result).toBeUndefined();
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
    expect([...(set ?? new Set())].sort()).toEqual(['CatalogId', 'ConnectionInput']);
  });
});
