import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateDatabaseCommand,
  GetDatabaseCommand,
  UpdateDatabaseCommand,
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

import { GlueProvider } from '../../../src/provisioning/providers/glue-provider.js';

/**
 * `AWS::Glue::Database` DatabaseInput members that reached NO AWS call before
 * issue #1807 (`TargetDatabase` / `FederatedDatabase` /
 * `CreateTableDefaultPermissions`).
 *
 * Every assertion here is a WHOLE-PAYLOAD `toEqual` rather than a per-key
 * probe, because the regression this fences is a member SILENTLY MISSING from
 * `DatabaseInput` — the SDK serializer drops what the builder never names, so
 * a `toMatchObject` / per-key check would pass against the exact shape the bug
 * produced.
 */
const databaseInputOf = (command: unknown): Record<string, unknown> =>
  (command as { input: { DatabaseInput: Record<string, unknown> } }).input.DatabaseInput;

describe('GlueProvider AWS::Glue::Database — TargetDatabase / FederatedDatabase / CreateTableDefaultPermissions (#1807)', () => {
  let provider: GlueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueProvider();
  });

  describe('create()', () => {
    it('sends a resource-link TargetDatabase with every member', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', 'AWS::Glue::Database', {
        DatabaseInput: {
          Name: 'linkdb',
          TargetDatabase: {
            CatalogId: '123456789012',
            DatabaseName: 'sourcedb',
            Region: 'us-west-2',
          },
        },
      });

      const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateDatabaseCommand);
      expect(call).toBeDefined();
      expect(databaseInputOf(call![0])).toEqual({
        Name: 'linkdb',
        TargetDatabase: {
          CatalogId: '123456789012',
          DatabaseName: 'sourcedb',
          Region: 'us-west-2',
        },
      });
    });

    it('sends a FederatedDatabase with every member', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', 'AWS::Glue::Database', {
        DatabaseInput: {
          Name: 'feddb',
          FederatedDatabase: {
            ConnectionName: 'my-connection',
            Identifier: 'arn:aws:glue:us-east-1:123456789012:database/external',
          },
        },
      });

      const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateDatabaseCommand);
      expect(databaseInputOf(call![0])).toEqual({
        Name: 'feddb',
        FederatedDatabase: {
          ConnectionName: 'my-connection',
          Identifier: 'arn:aws:glue:us-east-1:123456789012:database/external',
        },
      });
    });

    it('sends CreateTableDefaultPermissions including the nested Principal', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', 'AWS::Glue::Database', {
        DatabaseInput: {
          Name: 'lfdb',
          CreateTableDefaultPermissions: [
            {
              Permissions: ['SELECT', 'ALTER'],
              Principal: { DataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' },
            },
            {
              Permissions: ['ALL'],
              Principal: {
                DataLakePrincipalIdentifier: 'arn:aws:iam::123456789012:role/analyst',
              },
            },
          ],
        },
      });

      const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateDatabaseCommand);
      expect(databaseInputOf(call![0])).toEqual({
        Name: 'lfdb',
        CreateTableDefaultPermissions: [
          {
            Permissions: ['SELECT', 'ALTER'],
            Principal: { DataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' },
          },
          {
            Permissions: ['ALL'],
            Principal: { DataLakePrincipalIdentifier: 'arn:aws:iam::123456789012:role/analyst' },
          },
        ],
      });
    });

    it('carries all three blocks alongside the pre-existing members', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', 'AWS::Glue::Database', {
        DatabaseInput: {
          Name: 'everything',
          Description: 'a db',
          LocationUri: 's3://bucket/path',
          Parameters: { classification: 'parquet' },
          TargetDatabase: { DatabaseName: 'sourcedb' },
          FederatedDatabase: { Identifier: 'ext' },
          CreateTableDefaultPermissions: [{ Permissions: ['ALL'] }],
        },
      });

      const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateDatabaseCommand);
      expect(databaseInputOf(call![0])).toEqual({
        Name: 'everything',
        Description: 'a db',
        LocationUri: 's3://bucket/path',
        Parameters: { classification: 'parquet' },
        TargetDatabase: { DatabaseName: 'sourcedb' },
        FederatedDatabase: { Identifier: 'ext' },
        CreateTableDefaultPermissions: [{ Permissions: ['ALL'] }],
      });
    });

    it('omits an absent member instead of sending an empty block', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', 'AWS::Glue::Database', {
        DatabaseInput: { Name: 'plaindb', Description: 'plain' },
      });

      const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateDatabaseCommand);
      // Whole-payload compare: an `undefined`-valued key would still be a key
      // on the request object, and an empty `TargetDatabase: {}` is a shape
      // AWS rejects.
      expect(databaseInputOf(call![0])).toEqual({ Name: 'plaindb', Description: 'plain' });
    });

    it('sends only the members the template declared inside a block', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', 'AWS::Glue::Database', {
        DatabaseInput: {
          Name: 'partial',
          // No CatalogId / Region: a same-account, same-region resource link.
          TargetDatabase: { DatabaseName: 'sourcedb' },
          // A permission entry with no Principal at all.
          CreateTableDefaultPermissions: [{ Permissions: ['SELECT'] }],
        },
      });

      const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateDatabaseCommand);
      expect(databaseInputOf(call![0])).toEqual({
        Name: 'partial',
        TargetDatabase: { DatabaseName: 'sourcedb' },
        CreateTableDefaultPermissions: [{ Permissions: ['SELECT'] }],
      });
    });
  });

  describe('update()', () => {
    it('replays all three blocks through UpdateDatabase (shared builder)', async () => {
      // `updateDatabase` reads live Parameters first, then sends the update.
      mockSend.mockResolvedValueOnce({ Database: { Parameters: {} } });
      mockSend.mockResolvedValueOnce({});

      const properties = {
        DatabaseInput: {
          Name: 'mydb',
          TargetDatabase: { CatalogId: '123456789012', DatabaseName: 'sourcedb' },
          FederatedDatabase: { ConnectionName: 'conn', Identifier: 'ext' },
          CreateTableDefaultPermissions: [
            {
              Permissions: ['ALL'],
              Principal: { DataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' },
            },
          ],
        },
      };

      await provider.update('L', 'mydb', 'AWS::Glue::Database', properties, properties);

      const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateDatabaseCommand);
      expect(call).toBeDefined();
      expect(databaseInputOf(call![0])).toEqual({
        Name: 'mydb',
        TargetDatabase: { CatalogId: '123456789012', DatabaseName: 'sourcedb' },
        FederatedDatabase: { ConnectionName: 'conn', Identifier: 'ext' },
        CreateTableDefaultPermissions: [
          {
            Permissions: ['ALL'],
            Principal: { DataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' },
          },
        ],
      });
    });

    it('drops a block the template removed (UpdateDatabase replaces DatabaseInput wholesale)', async () => {
      mockSend.mockResolvedValueOnce({ Database: { Parameters: {} } });
      mockSend.mockResolvedValueOnce({});

      const previous = {
        DatabaseInput: { Name: 'mydb', TargetDatabase: { DatabaseName: 'sourcedb' } },
      };
      const desired = { DatabaseInput: { Name: 'mydb' } };

      await provider.update('L', 'mydb', 'AWS::Glue::Database', desired, previous);

      const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateDatabaseCommand);
      expect(databaseInputOf(call![0])).toEqual({ Name: 'mydb' });
    });
  });

  describe('readCurrentState()', () => {
    it('surfaces all three blocks so drift can see them', async () => {
      mockSend.mockResolvedValueOnce({
        Database: {
          Name: 'mydb',
          Description: 'a db',
          Parameters: {},
          TargetDatabase: {
            CatalogId: '123456789012',
            DatabaseName: 'sourcedb',
            Region: 'us-west-2',
          },
          FederatedDatabase: { ConnectionName: 'conn', Identifier: 'ext' },
          CreateTableDefaultPermissions: [
            {
              Permissions: ['ALL'],
              Principal: { DataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' },
            },
          ],
        },
      });

      const result = await provider.readCurrentState('mydb', 'L', 'AWS::Glue::Database');

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetDatabaseCommand);
      expect(result).toEqual({
        DatabaseInput: {
          Name: 'mydb',
          Description: 'a db',
          Parameters: {},
          TargetDatabase: {
            CatalogId: '123456789012',
            DatabaseName: 'sourcedb',
            Region: 'us-west-2',
          },
          FederatedDatabase: { ConnectionName: 'conn', Identifier: 'ext' },
          CreateTableDefaultPermissions: [
            {
              Permissions: ['ALL'],
              Principal: { DataLakePrincipalIdentifier: 'IAM_ALLOWED_PRINCIPALS' },
            },
          ],
        },
        DatabaseName: 'mydb',
      });
    });

    it('emits no placeholder for a database AWS reports none of them for', async () => {
      // EMIT-WHEN-PRESENT, unlike the always-emitted Description / Parameters:
      // AWS reports a Lake Formation DEFAULT `CreateTableDefaultPermissions`
      // for some catalogs and nothing for others, so a placeholder would have
      // to invent one of the two shapes and be wrong on the other population.
      mockSend.mockResolvedValueOnce({
        Database: { Name: 'plaindb', Description: '', Parameters: {} },
      });

      const result = await provider.readCurrentState('plaindb', 'L', 'AWS::Glue::Database');

      expect(result).toEqual({
        DatabaseInput: { Name: 'plaindb', Description: '', Parameters: {} },
        DatabaseName: 'plaindb',
      });
    });

    it('round-trips a resource link back through update() unchanged', async () => {
      // The `cdkd drift --revert` shape: the readback IS the desired bag, so a
      // member the read surfaces but the builder cannot send would be reported
      // as drift forever and re-issued on every revert.
      mockSend.mockResolvedValueOnce({
        Database: {
          Name: 'linkdb',
          Description: '',
          Parameters: {},
          TargetDatabase: { CatalogId: '123456789012', DatabaseName: 'sourcedb' },
        },
      });

      const observed = (await provider.readCurrentState(
        'linkdb',
        'L',
        'AWS::Glue::Database'
      )) as Record<string, unknown>;

      mockSend.mockResolvedValueOnce({ Database: { Parameters: {} } });
      mockSend.mockResolvedValueOnce({});
      await provider.update('L', 'linkdb', 'AWS::Glue::Database', observed, observed);

      const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateDatabaseCommand);
      expect(databaseInputOf(call![0])).toEqual(
        (observed['DatabaseInput'] as Record<string, unknown>) ?? {}
      );
    });
  });
});
