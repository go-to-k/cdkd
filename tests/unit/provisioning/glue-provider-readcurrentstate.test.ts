import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetDatabaseCommand,
  GetTableCommand,
  EntityNotFoundException,
} from '@aws-sdk/client-glue';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-glue', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-glue')>(
    '@aws-sdk/client-glue'
  );
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

import { GlueProvider } from '../../../src/provisioning/providers/glue-provider.js';

describe('GlueProvider.readCurrentState', () => {
  let provider: GlueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueProvider();
  });

  describe('AWS::Glue::Database', () => {
    it('returns CFn-shaped DatabaseInput (happy path)', async () => {
      mockSend.mockResolvedValueOnce({
        Database: {
          Name: 'mydb',
          Description: 'a db',
          LocationUri: 's3://bucket/path',
          Parameters: { foo: 'bar' },
        },
      });

      const result = await provider.readCurrentState('mydb', 'L', 'AWS::Glue::Database');

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetDatabaseCommand);
      expect(result).toEqual({
        DatabaseInput: {
          Name: 'mydb',
          Description: 'a db',
          LocationUri: 's3://bucket/path',
          Parameters: { foo: 'bar' },
        },
      });
    });

    it('returns undefined when DB is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new EntityNotFoundException({ message: 'gone', $metadata: {} })
      );
      const result = await provider.readCurrentState('mydb', 'L', 'AWS::Glue::Database');
      expect(result).toBeUndefined();
    });
  });

  describe('AWS::Glue::Table', () => {
    it('returns CFn-shaped TableInput (happy path)', async () => {
      mockSend.mockResolvedValueOnce({
        Table: {
          Name: 'mytbl',
          Owner: 'me',
          Retention: 0,
          TableType: 'EXTERNAL_TABLE',
          PartitionKeys: [{ Name: 'd', Type: 'string' }],
          Parameters: { classification: 'json' },
          StorageDescriptor: { Location: 's3://b/p' },
        },
      });

      const result = await provider.readCurrentState(
        'mydb|mytbl',
        'L',
        'AWS::Glue::Table'
      );

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetTableCommand);
      expect(result).toEqual({
        DatabaseName: 'mydb',
        TableInput: {
          Name: 'mytbl',
          Owner: 'me',
          Retention: 0,
          TableType: 'EXTERNAL_TABLE',
          PartitionKeys: [{ Name: 'd', Type: 'string' }],
          Parameters: { classification: 'json' },
          StorageDescriptor: { Location: 's3://b/p' },
        },
      });
    });

    it('returns undefined when table is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new EntityNotFoundException({ message: 'gone', $metadata: {} })
      );
      const result = await provider.readCurrentState(
        'mydb|mytbl',
        'L',
        'AWS::Glue::Table'
      );
      expect(result).toBeUndefined();
    });
  });
});
