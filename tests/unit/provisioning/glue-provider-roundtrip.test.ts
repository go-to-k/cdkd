import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdateDatabaseCommand, UpdateTableCommand } from '@aws-sdk/client-glue';

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

const TABLE_PHYSICAL_ID = 'mydb|mytbl';

describe('GlueProvider read-update round-trip', () => {
  let provider: GlueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueProvider();
  });

  it('AWS::Glue::Database — update() round-trips full DatabaseInput via UpdateDatabaseCommand', async () => {
    // Round-trip path for `cdkd drift --revert`: AWS-current snapshot
    // is supplied as `properties`, the same shape `createDatabase`
    // would build from `DatabaseInput`. Full DatabaseInput is replayed
    // (Description / LocationUri / Parameters reach AWS via UpdateDatabase).
    mockSend.mockResolvedValueOnce({});

    const observed = {
      DatabaseInput: {
        Name: 'mydb',
        Description: 'updated desc',
        LocationUri: 's3://example/path',
        Parameters: { foo: 'bar' },
      },
    };

    const result = await provider.update('L', 'mydb', 'AWS::Glue::Database', observed, observed);

    expect(result).toEqual({ physicalId: 'mydb', wasReplaced: false });

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateDatabaseCommand);
    expect(updateCall).toBeDefined();
    const input = updateCall![0].input as {
      Name: string;
      DatabaseInput: Record<string, unknown>;
      CatalogId?: string;
    };
    expect(input.Name).toBe('mydb');
    expect(input.CatalogId).toBeUndefined();
    expect(input.DatabaseInput).toEqual({
      Name: 'mydb',
      Description: 'updated desc',
      LocationUri: 's3://example/path',
      Parameters: { foo: 'bar' },
    });
  });

  it('AWS::Glue::Database — empty-string Description and empty Parameters reach AWS (truthy-gate guard)', async () => {
    // `cdkd drift --revert` must clear console-side ADDs to optional
    // fields. An empty-string Description revert should reach
    // UpdateDatabase, not be dropped by a truthy gate. Same for an
    // empty Parameters map.
    mockSend.mockResolvedValueOnce({});

    const observed = {
      DatabaseInput: {
        Name: 'mydb',
        Description: '',
        Parameters: {},
      },
    };

    await provider.update('L', 'mydb', 'AWS::Glue::Database', observed, observed);

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateDatabaseCommand);
    expect(updateCall).toBeDefined();
    const input = updateCall![0].input as { DatabaseInput: Record<string, unknown> };
    expect(input.DatabaseInput.Description).toBe('');
    expect(input.DatabaseInput.Parameters).toEqual({});
    // LocationUri was not in the snapshot — must not appear in the
    // update payload (would be a Class 1 leak otherwise).
    expect(input.DatabaseInput.LocationUri).toBeUndefined();
  });

  it('AWS::Glue::Database — CatalogId is forwarded when present in properties', async () => {
    mockSend.mockResolvedValueOnce({});

    const observed = {
      CatalogId: '123456789012',
      DatabaseInput: {
        Name: 'mydb',
        Description: '',
      },
    };

    await provider.update('L', 'mydb', 'AWS::Glue::Database', observed, observed);

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateDatabaseCommand);
    expect(updateCall).toBeDefined();
    const input = updateCall![0].input as { CatalogId?: string };
    expect(input.CatalogId).toBe('123456789012');
  });

  it('AWS::Glue::Table — Class 2: empty placeholders (Parameters {}, PartitionKeys []) round-trip without AWS-rejection shape', async () => {
    // Mechanical guard for Class 2 placeholder regression. See
    // docs/provider-development.md § 3b. `readCurrentState` always-emits
    // `Parameters: {}` and `PartitionKeys: []` as placeholders so console
    // adds are detectable. Round-tripping those through update() must
    // produce a valid `UpdateTable` payload — empty `Parameters` /
    // `PartitionKeys` are AWS-documented as "no params / no partition
    // keys", so they MAY be sent but MUST NOT carry AWS-invalid shapes.
    mockSend.mockResolvedValueOnce({});

    const observed = {
      DatabaseName: 'mydb',
      TableInput: {
        Name: 'mytbl',
        Description: '',
        Parameters: {},
        PartitionKeys: [],
        // No StorageDescriptor / Owner / Retention / TableType /
        // ViewOriginalText / ViewExpandedText — matches what
        // `readCurrentState` produces when AWS returns a minimal Table.
      },
    };

    await provider.update('L', TABLE_PHYSICAL_ID, 'AWS::Glue::Table', observed, observed);

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateTableCommand);
    expect(updateCall).toBeDefined();
    const input = updateCall![0].input as {
      DatabaseName: string;
      TableInput: Record<string, unknown>;
    };
    expect(input.DatabaseName).toBe('mydb');
    expect(input.TableInput.Name).toBe('mytbl');
    // Empty placeholders survive intact (AWS valid shapes — no `'{}'`
    // string-encoding bug like SQS RedrivePolicy).
    expect(input.TableInput.Parameters).toEqual({});
    expect(input.TableInput.PartitionKeys).toEqual([]);
    // Description: '' must reach the API (truthy-gate guard — see
    // iam-role-provider.ts:270-276 for the canonical pattern).
    expect(input.TableInput.Description).toBe('');
    // ViewOriginalText / ViewExpandedText / StorageDescriptor were not
    // in the snapshot (Class 1 — only emitted by readCurrentState when
    // AWS returns them, which is gated by TableType discriminator on
    // the AWS side). They MUST NOT appear in the API call.
    expect(input.TableInput.ViewOriginalText).toBeUndefined();
    expect(input.TableInput.ViewExpandedText).toBeUndefined();
    expect(input.TableInput.StorageDescriptor).toBeUndefined();
  });

  it('AWS::Glue::Table — Class 1: VIRTUAL_VIEW snapshot round-trips ViewOriginalText/ViewExpandedText safely', async () => {
    // Class 1 complement: a VIRTUAL_VIEW table legitimately carries
    // ViewOriginalText / ViewExpandedText, and `readCurrentState`
    // emits them when AWS returns them. Round-tripping must preserve
    // the discriminator + view text together (no AWS-side rejection
    // for "view text on non-view table").
    mockSend.mockResolvedValueOnce({});

    const observed = {
      DatabaseName: 'mydb',
      TableInput: {
        Name: 'mytbl',
        Description: '',
        Parameters: {},
        PartitionKeys: [],
        TableType: 'VIRTUAL_VIEW',
        ViewOriginalText: '/* Presto View */ SELECT 1',
        ViewExpandedText: '/* Presto View */ SELECT 1',
      },
    };

    await provider.update('L', TABLE_PHYSICAL_ID, 'AWS::Glue::Table', observed, observed);

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateTableCommand);
    expect(updateCall).toBeDefined();
    const input = updateCall![0].input as { TableInput: Record<string, unknown> };
    expect(input.TableInput.TableType).toBe('VIRTUAL_VIEW');
    expect(input.TableInput.ViewOriginalText).toBe('/* Presto View */ SELECT 1');
    expect(input.TableInput.ViewExpandedText).toBe('/* Presto View */ SELECT 1');
  });

  it('AWS::Glue::Table — EXTERNAL_TABLE with full StorageDescriptor round-trips without empty-SerdeInfo.Parameters dropping', async () => {
    // Truthy-gate guard for the SerdeInfo.Parameters branch in
    // buildStorageDescriptor (`if (serde['Parameters'] !== undefined)`,
    // not truthy). An empty `Parameters: {}` placeholder must survive —
    // a truthy gate would skip the conversion entirely and leave the
    // raw object unconverted (functional difference is small here, but
    // the docs/provider-development.md § 3b rule applies uniformly).
    mockSend.mockResolvedValueOnce({});

    const observed = {
      DatabaseName: 'mydb',
      TableInput: {
        Name: 'mytbl',
        Description: '',
        Parameters: {},
        PartitionKeys: [],
        TableType: 'EXTERNAL_TABLE',
        StorageDescriptor: {
          Location: 's3://b/p',
          Columns: [{ Name: 'c', Type: 'string' }],
          SerdeInfo: {
            Name: 'serde',
            SerializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
            Parameters: {}, // empty placeholder — must reach AWS as `{}`, not be skipped
          },
        },
      },
    };

    await provider.update('L', TABLE_PHYSICAL_ID, 'AWS::Glue::Table', observed, observed);

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateTableCommand);
    expect(updateCall).toBeDefined();
    const input = updateCall![0].input as {
      TableInput: { StorageDescriptor: { SerdeInfo: { Parameters: Record<string, string> } } };
    };
    expect(input.TableInput.StorageDescriptor.SerdeInfo.Parameters).toEqual({});
  });
});
