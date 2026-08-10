import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateTableCommand,
  DeleteTableCommand,
  UpdateDatabaseCommand,
  UpdateTableCommand,
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
import { getLogger } from '../../../src/utils/logger.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

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

  it('AWS::Glue::Table — create() sends OpenTableFormatInput as a top-level sibling of TableInput (#609 Iceberg backfill)', async () => {
    // OpenTableFormatInput (Apache Iceberg) is a top-level CreateTableCommand
    // param, NOT nested inside TableInput. The CFn shape maps 1:1 to the SDK
    // OpenTableFormatInput type. MetadataOperation: 'CREATE' is the create-time
    // directive that writes Iceberg metadata under the S3 location.
    mockSend.mockResolvedValueOnce({});

    const properties = {
      CatalogId: '123456789012',
      DatabaseName: 'mydb',
      OpenTableFormatInput: {
        IcebergInput: { MetadataOperation: 'CREATE', Version: '2' },
      },
      TableInput: {
        Name: 'events_iceberg',
        TableType: 'EXTERNAL_TABLE',
        StorageDescriptor: {
          Columns: [{ Name: 'event_id', Type: 'string' }],
          Location: 's3://b/iceberg/',
        },
      },
    };

    const result = await provider.create('L', 'AWS::Glue::Table', properties);
    expect(result).toEqual({ physicalId: 'mydb|events_iceberg', attributes: {} });

    const createCall = mockSend.mock.calls.find((c) => c[0] instanceof CreateTableCommand);
    expect(createCall).toBeDefined();
    const input = createCall![0].input as {
      DatabaseName: string;
      TableInput: Record<string, unknown>;
      OpenTableFormatInput?: Record<string, unknown>;
    };
    // Top-level sibling of TableInput — must NOT be nested inside TableInput.
    // toStrictEqual, not toEqual: toEqual ignores undefined-valued keys, so a
    // forward yielding { MetadataOperation: undefined } would pass — and
    // undefined is exactly what the SDK v3 serializer treats as absent, i.e.
    // the #1390 silent-drop failure mode this test is meant to fence.
    expect(input.OpenTableFormatInput).toStrictEqual({
      IcebergInput: { MetadataOperation: 'CREATE', Version: '2' },
    });
    expect(input.TableInput.OpenTableFormatInput).toBeUndefined();
    expect(input.TableInput.Name).toBe('events_iceberg');
  });

  // ─── #1454: IcebergTableInput pre-flight refusal ────────────────────
  //
  // The live probe on #1408 (2026-08-09, us-east-1) proved the Iceberg table
  // spec is undeployable on BOTH the raw `glue:CreateTable` path cdkd takes and
  // the CloudFormation path, in every shape. cdkd therefore refuses it BEFORE
  // the AWS call instead of forwarding it (a deliberate parity divergence —
  // see `assertIcebergTableInputAbsent` in the provider). The #1390 rename to
  // the SDK's `CreateIcebergTableInput` became unreachable and was removed.

  const ICEBERG_TABLE_SPEC = {
    Location: 's3://b/iceberg/events/',
    Schema: {
      Fields: [{ Id: 1, Name: 'event_id', Type: 'string', Required: true }],
      IdentifierFieldIds: [1],
    },
    PartitionSpec: {
      Fields: [{ SourceId: 1, Transform: 'identity', Name: 'event_id' }],
    },
    Properties: { 'write.format.default': 'parquet' },
  };

  /** Await a call expected to reject, returning the thrown error for inspection. */
  const captureRejection = async (call: Promise<unknown>): Promise<ProvisioningError> => {
    try {
      await call;
    } catch (error) {
      return error as ProvisioningError;
    }
    throw new Error('expected the call to reject, but it resolved');
  };

  /**
   * Warn lines the provider emitted through the mocked logger. The mock's
   * `child()` ignores its argument and returns one closed-over object, so this
   * is the SAME `vi.fn()` the provider writes to (and `vi.clearAllMocks()` in
   * `beforeEach` isolates it per test) — the assertion is not vacuous.
   */
  const warnMessages = (): string[] => {
    const warn = (getLogger().child('x') as unknown as { warn: { mock: { calls: unknown[][] } } })
      .warn;
    return warn.mock.calls.map((c) => String(c[0]));
  };

  /**
   * Assertions every #1454 CREATE refusal must satisfy.
   *
   * `error` (not just its message) is taken deliberately. The refusal's whole
   * point is that it fires BEFORE the `try`, so the provider's catch wrapper
   * never sees it — and a `toContain`-only helper cannot tell the difference,
   * because that wrapper EMBEDS the original message
   * (`Failed to create Glue Table L: <original>`) and re-supplies
   * resourceType / logicalId / physicalId. Moving the assert inside the `try`
   * would therefore have passed every content assertion below, and
   * `expect(mockSend).not.toHaveBeenCalled()` too. The prefix + absent-`cause`
   * checks are what actually pin the placement.
   */
  const expectIcebergRefusal = (
    error: ProvisioningError,
    offendingKey: string,
    logicalId: string
  ): void => {
    const message = error.message;
    // PLACEMENT: the raw refusal, not a wrapper-relabelled one. The catch
    // wrappers prepend 'Failed to create/update Glue Table <id>: ' and attach
    // the original as `cause`; an unwrapped throw has neither.
    expect(message.startsWith(`AWS::Glue::Table ${logicalId}:`)).toBe(true);
    expect(message).not.toContain('Failed to create Glue Table');
    expect(message).not.toContain('Failed to update Glue Table');
    expect(error.cause).toBeUndefined();
    expect(message).toContain('cdkd refuses it before calling Glue');
    expectIcebergMessageBody(message, offendingKey, logicalId);
  };

  /** The shared body both the create refusal and the update warning must carry. */
  function expectIcebergMessageBody(
    message: string,
    offendingKey: string,
    logicalId: string
  ): void {
    expect(message.startsWith(`AWS::Glue::Table ${logicalId}:`)).toBe(true);
    // Names the offending property PATH, not just the resource.
    expect(message).toContain(`OpenTableFormatInput.IcebergInput.${offendingKey}`);
    // Explains that AWS — CloudFormation included — rejects every shape.
    expect(message).toContain('cannot be deployed by AWS in any shape');
    expect(message).toContain('CloudFormation');
    expect(message).toContain(
      'Table metadata is expected only via TableInput or via IcebergTableInputProperties'
    );
    // Names the WORKING shape concretely enough to copy.
    expect(message).toContain("TableType: 'EXTERNAL_TABLE'");
    expect(message).toContain('StorageDescriptor');
    expect(message).toContain("MetadataOperation: 'CREATE'");
    // Cites the decision + the probe transcript.
    expect(message).toContain('#1454');
    expect(message).toContain('#1408');
  }

  it('AWS::Glue::Table — create() refuses IcebergInput.IcebergTableInput pre-flight, before any AWS call (#1454)', async () => {
    await expect(
      provider.create('L', 'AWS::Glue::Table', {
        DatabaseName: 'mydb',
        OpenTableFormatInput: {
          IcebergInput: {
            MetadataOperation: 'CREATE',
            Version: '2',
            IcebergTableInput: ICEBERG_TABLE_SPEC,
          },
        },
        TableInput: { Name: 'events_iceberg', TableType: 'EXTERNAL_TABLE' },
      })
    ).rejects.toThrow(ProvisioningError);

    // PRE-flight: the refusal must happen before CreateTable is ever sent.
    expect(mockSend).not.toHaveBeenCalled();

    const error = await captureRejection(
      provider.create('L', 'AWS::Glue::Table', {
        DatabaseName: 'mydb',
        OpenTableFormatInput: {
          IcebergInput: { MetadataOperation: 'CREATE', IcebergTableInput: ICEBERG_TABLE_SPEC },
        },
        TableInput: { Name: 'events_iceberg', TableType: 'EXTERNAL_TABLE' },
      })
    );
    expectIcebergRefusal(error, 'IcebergTableInput', 'L');
    expect(error.resourceType).toBe('AWS::Glue::Table');
    expect(error.logicalId).toBe('L');
  });

  it('AWS::Glue::Table — update() WARNS about IcebergInput.IcebergTableInput but still succeeds (#1454)', async () => {
    // Deliberately asymmetric with create. Rollback replays from cdkd STATE
    // (rollback-executor calls update with previousState.properties), and a
    // table created by a pre-#1390 build carries the key in its state record —
    // so refusing here would make such a table unrollbackable with no
    // template-side remedy. UpdateTableCommandInput has no OpenTableFormatInput
    // member, so nothing is forwarded and warning loses no protection.
    mockSend.mockResolvedValueOnce({});

    const result = await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      {
        DatabaseName: 'mydb',
        OpenTableFormatInput: {
          IcebergInput: { MetadataOperation: 'CREATE', IcebergTableInput: ICEBERG_TABLE_SPEC },
        },
        TableInput: { Name: 'mytbl', TableType: 'EXTERNAL_TABLE' },
      },
      {}
    );

    // The update MUST go through — this is the rollback path.
    expect(result).toEqual({ physicalId: TABLE_PHYSICAL_ID, wasReplaced: false });
    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateTableCommand);
    expect(updateCall).toBeDefined();
    // ...and must NOT forward the offending blob.
    expect('OpenTableFormatInput' in (updateCall![0].input as object)).toBe(false);

    // The user is still told, with the same actionable body as the create refusal.
    const warn = warnMessages();
    const hit = warn.find((m) => m.includes('IcebergTableInput'));
    expect(hit).toBeDefined();
    expectIcebergMessageBody(hit!, 'IcebergTableInput', 'L');
    expect(hit).toContain('IGNORED on update');
    expect(hit).toContain('A CREATE of this table would be refused outright');
  });

  it('AWS::Glue::Table — the refusal also covers the SDK spelling CreateIcebergTableInput (#1454)', async () => {
    // A hand-written template can carry either spelling; neither deploys.
    const error = await captureRejection(
      provider.create('L', 'AWS::Glue::Table', {
        DatabaseName: 'mydb',
        OpenTableFormatInput: {
          IcebergInput: {
            MetadataOperation: 'CREATE',
            CreateIcebergTableInput: ICEBERG_TABLE_SPEC,
          },
        },
        TableInput: { Name: 'events_iceberg', TableType: 'EXTERNAL_TABLE' },
      })
    );

    expect(error).toBeInstanceOf(ProvisioningError);
    expectIcebergRefusal(error, 'CreateIcebergTableInput', 'L');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('AWS::Glue::Table — the WORKING shape (IcebergInput.MetadataOperation only) still deploys and reaches the SDK (#1454)', async () => {
    // The P9/P10 shape from the #1408 probe: table metadata in TableInput,
    // IcebergInput carrying only the create-time directive. Must NOT throw, and
    // MetadataOperation must still be forwarded verbatim.
    mockSend.mockResolvedValueOnce({});

    const result = await provider.create('L', 'AWS::Glue::Table', {
      DatabaseName: 'mydb',
      OpenTableFormatInput: { IcebergInput: { MetadataOperation: 'CREATE', Version: '2' } },
      TableInput: {
        Name: 'events_iceberg',
        TableType: 'EXTERNAL_TABLE',
        StorageDescriptor: {
          Location: 's3://b/iceberg/',
          Columns: [{ Name: 'event_id', Type: 'string' }],
        },
      },
    });
    expect(result.physicalId).toBe('mydb|events_iceberg');

    const createCall = mockSend.mock.calls.find((c) => c[0] instanceof CreateTableCommand);
    const input = createCall![0].input as { OpenTableFormatInput: Record<string, unknown> };
    // toStrictEqual, not toEqual: toEqual ignores undefined-valued keys, so a
    // forward yielding { MetadataOperation: undefined } would pass — and
    // undefined is exactly what the SDK v3 serializer treats as absent, i.e.
    // the #1390 silent-drop failure mode this test is meant to fence.
    expect(input.OpenTableFormatInput).toStrictEqual({
      IcebergInput: { MetadataOperation: 'CREATE', Version: '2' },
    });
  });

  it('AWS::Glue::Table — update() accepts the WORKING shape unchanged (#1454)', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      {
        DatabaseName: 'mydb',
        OpenTableFormatInput: { IcebergInput: { MetadataOperation: 'CREATE' } },
        TableInput: { Name: 'mytbl', TableType: 'EXTERNAL_TABLE' },
      },
      {}
    );

    // UpdateTableCommandInput has no OpenTableFormatInput member — the working
    // shape is accepted and simply not forwarded (pre-existing behavior).
    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateTableCommand);
    expect(updateCall).toBeDefined();
    expect('OpenTableFormatInput' in (updateCall![0].input as object)).toBe(false);
  });

  // A non-object shape at EITHER level means cdkd cannot tell what is inside;
  // surfacing AWS's real validation error beats a misleading Iceberg-specific
  // refusal. Both levels are covered because they are separate guards in
  // `findIcebergTableInputKey`, and the INNER one (IcebergInput itself
  // unresolved) is the likelier real-world shape.
  it.each([
    ['outer: OpenTableFormatInput is a string', 'unresolved'],
    ['outer: OpenTableFormatInput is null', null],
    ['outer: OpenTableFormatInput is an array', [{ IcebergInput: {} }]],
    ['inner: IcebergInput is a string', { IcebergInput: 'unresolved' }],
    ['inner: IcebergInput is null', { IcebergInput: null }],
    ['inner: IcebergInput is an array', { IcebergInput: [{ IcebergTableInput: {} }] }],
  ])(
    'AWS::Glue::Table — a non-object OpenTableFormatInput (%s) is forwarded to AWS, not refused (#1454)',
    async (_label, openTableFormatInput) => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', 'AWS::Glue::Table', {
        DatabaseName: 'mydb',
        OpenTableFormatInput: openTableFormatInput,
        TableInput: { Name: 'events_iceberg' },
      });

      const createCall = mockSend.mock.calls.find((c) => c[0] instanceof CreateTableCommand);
      expect(createCall).toBeDefined();
      // Not merely "no refusal" — the blob must reach AWS VERBATIM. Dropping it
      // would also produce a passing "did not throw" assertion while silently
      // discarding the property, which is the #1390 failure mode one level up.
      const input = createCall![0].input as { OpenTableFormatInput?: unknown };
      expect(input.OpenTableFormatInput).toStrictEqual(openTableFormatInput);
    }
  );

  it('AWS::Glue::Table — delete() does NOT refuse a table whose template carries IcebergTableInput (#1454)', async () => {
    // The refusal is a CREATE/UPDATE pre-flight only. Destroy must stay
    // possible for a resource that somehow reached AWS carrying the key
    // (imported state, a pre-refusal cdkd version, cc-api routing). Hoisting
    // the assert into the shared `delete` dispatcher would break destroy, and
    // nothing else in the suite would notice.
    mockSend.mockResolvedValueOnce({});

    await provider.delete('L', TABLE_PHYSICAL_ID, 'AWS::Glue::Table', {
      DatabaseName: 'mydb',
      OpenTableFormatInput: {
        IcebergInput: { MetadataOperation: 'CREATE', IcebergTableInput: ICEBERG_TABLE_SPEC },
      },
      TableInput: { Name: 'mytbl' },
    });

    expect(mockSend.mock.calls.find((c) => c[0] instanceof DeleteTableCommand)).toBeDefined();
  });

  it('AWS::Glue::Table — create() omits OpenTableFormatInput when absent (omit-when-absent)', async () => {
    mockSend.mockResolvedValueOnce({});

    const properties = {
      DatabaseName: 'mydb',
      TableInput: {
        Name: 'plain_tbl',
        TableType: 'EXTERNAL_TABLE',
      },
    };

    await provider.create('L', 'AWS::Glue::Table', properties);

    const createCall = mockSend.mock.calls.find((c) => c[0] instanceof CreateTableCommand);
    expect(createCall).toBeDefined();
    const input = createCall![0].input as { OpenTableFormatInput?: unknown };
    // Absent prop must not leak an `OpenTableFormatInput: undefined` key.
    expect('OpenTableFormatInput' in input).toBe(false);
  });

  it('AWS::Glue::Table — getDriftUnknownPaths excludes OpenTableFormatInput (create-only, no clean readback)', () => {
    expect(provider.getDriftUnknownPaths('AWS::Glue::Table')).toEqual(['OpenTableFormatInput']);
    expect(provider.getDriftUnknownPaths('AWS::Glue::Database')).toEqual([]);
  });
});
