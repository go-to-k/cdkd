import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  ConcurrentModificationException,
  CreateTableCommand,
  DeleteTableCommand,
  EntityNotFoundException,
  GetDatabaseCommand,
  GetTableCommand,
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
  // see `enforceIcebergTableInputAbsent` in the provider). The #1390 rename to
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

  // ─── #1463: CreateContext.replayingState downgrades the refusal ──────
  //
  // The create-side twin of the update asymmetry above. `rollback-executor`'s
  // reverse-replacement arm revives the OLD resource by calling `create()`
  // with `previousState.properties` — a cdkd STATE record, not a template — so
  // the refusal would fail that rollback operation and leave the old table
  // gone, with no template-side remedy. `CreateContext.replayingState` is how
  // the executor says so, and the pre-flight warns instead.

  /** The properties `create()` receives on a replay, under either spelling. */
  const replayTableProps = (key: string) => ({
    DatabaseName: 'mydb',
    OpenTableFormatInput: {
      IcebergInput: { MetadataOperation: 'CREATE', [key]: ICEBERG_TABLE_SPEC },
    },
    TableInput: { Name: 'events_iceberg', TableType: 'EXTERNAL_TABLE' },
  });

  /**
   * The replay warning's OWN content, beyond the shared body.
   *
   * Every clause here is load-bearing, and the reason is a review finding: a
   * reviewer rewrote the entire lead to one that falsely promises a clean
   * restore ("...so cdkd warns and proceeds and the old table is restored")
   * and the suite still passed 56/56, because the assertions only pinned the
   * shared body plus the phrase "REPLAYING a historical cdkd STATE record".
   * The whole point of warning instead of refusing is that the outcome is
   * DEGRADED, not clean — so the message must keep saying which spelling is
   * silently dropped (#1390), which one AWS rejects, and what the user does
   * next. Assert the substance, not just the topic.
   */
  const expectIcebergReplayWarning = (
    message: string,
    offendingKey: string,
    logicalId: string
  ): void => {
    expectIcebergMessageBody(message, offendingKey, logicalId);
    expect(message).toContain('REPLAYING a historical cdkd STATE record');
    expect(message).toContain('#1463');
    // The two-outcome honesty, clause by clause.
    expect(message).toContain('DEGRADED');
    expect(message).toContain('#1390'); // the CFn spelling is silently dropped
    expect(message).toContain('without its Iceberg metadata');
    expect(message).toContain('Glue rejects'); // the SDK spelling is not
    expect(message).toContain('cdkd deploy'); // the fix-forward
    // It is a WARNING, not the refusal text.
    expect(message).not.toContain('cdkd refuses it before calling Glue');
  };

  it.each([['IcebergTableInput'], ['CreateIcebergTableInput']])(
    'AWS::Glue::Table — create() WARNS instead of refusing when replaying a state record carrying %s, and the create goes through (#1463)',
    async (offendingKey) => {
      mockSend.mockResolvedValueOnce({});

      const result = await provider.create(
        'L',
        'AWS::Glue::Table',
        replayTableProps(offendingKey),
        { replayingState: true }
      );

      // The whole point: the rollback's re-create SUCCEEDS. Without the fix
      // this throws and the old table is never restored.
      expect(result.physicalId).toBe('mydb|events_iceberg');
      const createCall = mockSend.mock.calls.find((c) => c[0] instanceof CreateTableCommand);
      expect(createCall).toBeDefined();
      // UNLIKE the update path (whose command has no OpenTableFormatInput
      // member at all), the create DOES forward the blob verbatim — so the
      // re-created table is degraded in exactly the way the original was,
      // which is what the warning tells the user. Pinning this stops a future
      // "just strip the key on replay" edit from silently changing what AWS
      // receives.
      expect(
        (createCall![0].input as { OpenTableFormatInput?: unknown }).OpenTableFormatInput
      ).toStrictEqual({
        IcebergInput: { MetadataOperation: 'CREATE', [offendingKey]: ICEBERG_TABLE_SPEC },
      });

      const hit = warnMessages().find((m) => m.includes(offendingKey));
      expect(hit).toBeDefined();
      expectIcebergReplayWarning(hit!, offendingKey, 'L');
    }
  );

  it.each([
    ['no context at all (the deploy-engine CREATE)', undefined],
    ['an explicit replayingState: false', { replayingState: false } as const],
    ['a context that carries no replayingState', {} as const],
  ])(
    'AWS::Glue::Table — the template path still REFUSES with %s (#1463)',
    async (_label, context) => {
      // The refusal must survive the new parameter. Only a state replay earns
      // the downgrade; a template-driven create can be fixed by the user, so a
      // fast, actionable failure is still the right answer.
      const error = await captureRejection(
        provider.create('L', 'AWS::Glue::Table', replayTableProps('IcebergTableInput'), context)
      );
      expectIcebergRefusal(error, 'IcebergTableInput', 'L');
      expect(mockSend).not.toHaveBeenCalled();
      expect(warnMessages()).toEqual([]);
    }
  );

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
    // The Database answer is PER RESOURCE since issue #1807 and is exercised in
    // `glue-database-input-members.test.ts`. With no properties bag the type
    // cannot be shown to declare `CreateTableDefaultPermissions`, and AWS always
    // materializes a Lake Formation default there, so the path is ignored —
    // comparing it would report drift on every run of such a record.
    expect(provider.getDriftUnknownPaths('AWS::Glue::Database')).toEqual([
      'DatabaseInput.CreateTableDefaultPermissions',
    ]);
    expect(
      provider.getDriftUnknownPaths('AWS::Glue::Database', {
        DatabaseInput: { CreateTableDefaultPermissions: [] },
      })
    ).toEqual([]);
  });
});

// ─── #1461: AWS-authored Parameters must survive a full-replace update ──
//
// `UpdateTable` / `UpdateDatabase` replace `TableInput` / `DatabaseInput`
// WHOLESALE, so a payload rebuilt purely from the template erased every
// `Parameters` entry AWS itself had written. Verified live 2026-08-10 in
// us-east-1: an Iceberg table's `table_type` + `metadata_location` went to
// `null` after a deploy that changed only `TableInput.Description`, silently
// de-Iceberging the table while the deploy reported success.
//
// The provider now reads the live resource and merges back only the keys
// present in NEITHER template side. A key the user REMOVED (absent from
// desired, present in previous) must still be removed — the mirror-image bug.
describe('GlueProvider — AWS-managed Parameters preservation (#1461)', () => {
  let provider: GlueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueProvider();
  });

  /** Await a call expected to reject, returning the thrown error for inspection. */
  const captureRejection = async (call: Promise<unknown>): Promise<ProvisioningError> => {
    try {
      await call;
    } catch (error) {
      return error as ProvisioningError;
    }
    throw new Error('expected the call to reject, but it resolved');
  };

  /** Queue the pre-update `GetTable` readback, then the `UpdateTable` reply. */
  // `versionId` takes an explicit `null` for "AWS returned none" — a JS default
  // parameter fires on an explicit `undefined`, so `mockLiveTable(p, undefined)`
  // would silently keep the default and the omit-VersionId test would be
  // vacuous. (It was, until the test caught it.)
  const mockLiveTable = (
    parameters: Record<string, string> | undefined,
    versionId: string | null = '3'
  ): void => {
    mockSend.mockResolvedValueOnce({
      Table: {
        Name: 'mytbl',
        Parameters: parameters,
        ...(versionId !== null && { VersionId: versionId }),
      },
    });
    mockSend.mockResolvedValueOnce({});
  };

  const sentUpdateTableInputRoot = (): Record<string, unknown> => {
    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateTableCommand);
    expect(call).toBeDefined();
    return call![0].input as Record<string, unknown>;
  };

  /** Queue the pre-update `GetDatabase` readback, then the `UpdateDatabase` reply. */
  const mockLiveDatabase = (parameters: Record<string, string> | undefined): void => {
    mockSend.mockResolvedValueOnce({ Database: { Name: 'mydb', Parameters: parameters } });
    mockSend.mockResolvedValueOnce({});
  };

  const sentTableInput = (): Record<string, unknown> => {
    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateTableCommand);
    expect(call).toBeDefined();
    return (call![0].input as { TableInput: Record<string, unknown> }).TableInput;
  };

  const sentDatabaseInput = (): Record<string, unknown> => {
    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateDatabaseCommand);
    expect(call).toBeDefined();
    return (call![0].input as { DatabaseInput: Record<string, unknown> }).DatabaseInput;
  };

  it('AWS::Glue::Table — AWS-authored Parameters survive an unrelated TableInput edit', async () => {
    // The exact live repro from the issue: only Description changes, and the
    // Iceberg markers AWS wrote at create time have no template representation.
    mockLiveTable({
      table_type: 'ICEBERG',
      metadata_location: 's3://b/iceberg/metadata/00000-abc.metadata.json',
      owner_team: 'analytics',
    });

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      {
        DatabaseName: 'mydb',
        TableInput: {
          Name: 'mytbl',
          Description: 'phase-2 update',
          Parameters: { owner_team: 'analytics' },
        },
      },
      {
        DatabaseName: 'mydb',
        TableInput: {
          Name: 'mytbl',
          Description: 'phase-1 create',
          Parameters: { owner_team: 'analytics' },
        },
      }
    );

    const tableInput = sentTableInput();
    expect(tableInput.Description).toBe('phase-2 update');
    // toStrictEqual, not toEqual: an `undefined`-valued key is what the SDK v3
    // serializer treats as absent, i.e. the wipe this test exists to fence.
    expect(tableInput.Parameters).toStrictEqual({
      table_type: 'ICEBERG',
      metadata_location: 's3://b/iceberg/metadata/00000-abc.metadata.json',
      owner_team: 'analytics',
    });
  });

  it('AWS::Glue::Table — a parameter the USER removed stays removed (per-key removal)', async () => {
    // Absent from desired but present in previous == a template-expressed
    // removal. Restoring it from the live readback would make user-authored
    // parameters unremovable — the mirror image of #1461.
    mockLiveTable({ table_type: 'ICEBERG', owner_team: 'analytics', keep_me: 'yes' });

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      {
        DatabaseName: 'mydb',
        TableInput: { Name: 'mytbl', Parameters: { keep_me: 'yes' } },
      },
      {
        DatabaseName: 'mydb',
        TableInput: { Name: 'mytbl', Parameters: { keep_me: 'yes', owner_team: 'analytics' } },
      }
    );

    expect(sentTableInput().Parameters).toStrictEqual({
      keep_me: 'yes',
      table_type: 'ICEBERG',
    });
  });

  it('AWS::Glue::Table — a WHOLE Parameters block the user removed stays removed', async () => {
    // A per-key removal test does NOT cover whole-block removal (the map
    // itself dropped from the template) — docs/provider-development.md §2a.
    mockLiveTable({ table_type: 'ICEBERG', owner_team: 'analytics' });

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl' } },
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Parameters: { owner_team: 'analytics' } } }
    );

    expect(sentTableInput().Parameters).toStrictEqual({ table_type: 'ICEBERG' });
  });

  it('AWS::Glue::Table — a user-CHANGED parameter takes the user value, not the live one', async () => {
    mockLiveTable({ classification: 'json', table_type: 'ICEBERG' });

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      {
        DatabaseName: 'mydb',
        TableInput: { Name: 'mytbl', Parameters: { classification: 'parquet' } },
      },
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Parameters: { classification: 'json' } } }
    );

    expect(sentTableInput().Parameters).toStrictEqual({
      classification: 'parquet',
      table_type: 'ICEBERG',
    });
  });

  it('AWS::Glue::Table — a template that never declared Parameters still keeps AWS-authored ones', async () => {
    // Neither side declares the key -> AWS-authored -> preserved, and the
    // payload gains a Parameters map it did not have before.
    mockLiveTable({ table_type: 'ICEBERG' });

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'b' } },
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'a' } }
    );

    expect(sentTableInput().Parameters).toStrictEqual({ table_type: 'ICEBERG' });
  });

  it('AWS::Glue::Table — an empty live Parameters map leaves the payload byte-identical (no spurious key)', async () => {
    mockLiveTable({});

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'b' } },
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'a' } }
    );

    // `'Parameters' in input` — not `toBeUndefined()`: an explicit
    // `Parameters: undefined` key would be a different wire shape.
    expect('Parameters' in sentTableInput()).toBe(false);
  });

  it('AWS::Glue::Table — drift --revert still CLEARS a console-added parameter', async () => {
    // `cdkd drift --revert` passes the AWS-CURRENT snapshot as
    // previousProperties (drift.ts `outcome.awsProperties`), so every live key
    // is in the previous side and the merge adds nothing back. Without this,
    // the #1461 fix would silently make console-side additions unrevertable.
    mockLiveTable({ table_type: 'ICEBERG', console_added: 'oops' });

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Parameters: { table_type: 'ICEBERG' } } },
      {
        DatabaseName: 'mydb',
        TableInput: {
          Name: 'mytbl',
          Parameters: { table_type: 'ICEBERG', console_added: 'oops' },
        },
      }
    );

    expect(sentTableInput().Parameters).toStrictEqual({ table_type: 'ICEBERG' });
  });

  it('AWS::Glue::Table — the pre-update read forwards CatalogId', async () => {
    mockLiveTable({ table_type: 'ICEBERG' });

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      {
        CatalogId: '123456789012',
        DatabaseName: 'mydb',
        TableInput: { Name: 'mytbl', Description: 'b' },
      },
      { CatalogId: '123456789012', DatabaseName: 'mydb', TableInput: { Name: 'mytbl' } }
    );

    const getCall = mockSend.mock.calls.find((c) => c[0] instanceof GetTableCommand);
    expect(getCall).toBeDefined();
    expect(getCall![0].input).toStrictEqual({
      CatalogId: '123456789012',
      DatabaseName: 'mydb',
      Name: 'mytbl',
    });
  });

  it('AWS::Glue::Table — the extra read is NOT issued when it cannot help (update refused pre-flight)', async () => {
    // A malformed physical id and a missing TableInput are both refused before
    // any AWS call; burning a GetTable on an update that will never be sent
    // is pure latency + a needless throttle contribution.
    await expect(
      provider.update('L', 'no-pipe-separator', 'AWS::Glue::Table', { TableInput: {} }, {})
    ).rejects.toThrow(ProvisioningError);
    await expect(
      provider.update('L', TABLE_PHYSICAL_ID, 'AWS::Glue::Table', { DatabaseName: 'mydb' }, {})
    ).rejects.toThrow(ProvisioningError);

    expect(mockSend.mock.calls.find((c) => c[0] instanceof GetTableCommand)).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('AWS::Glue::Table — a NOT-FOUND readback does not mask the real UpdateTable error', async () => {
    // The table is gone: UpdateTable is about to surface the actionable error,
    // so the readback must not pre-empt it with a less useful one.
    mockSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'Entity Not Found', $metadata: {} })
    );
    mockSend.mockRejectedValueOnce(new Error('Table not found.'));

    const error = await captureRejection(
      provider.update(
        'L',
        TABLE_PHYSICAL_ID,
        'AWS::Glue::Table',
        { DatabaseName: 'mydb', TableInput: { Name: 'mytbl' } },
        {}
      )
    );

    // The UpdateTable WAS attempted, and its error is the one reported.
    expect(mockSend.mock.calls.find((c) => c[0] instanceof UpdateTableCommand)).toBeDefined();
    expect(error.message).toContain('Failed to update Glue Table L');
    expect(error.message).toContain('Table not found.');
  });

  it('AWS::Glue::Table — a non-not-found readback failure fails CLOSED, unwrapped, before any UpdateTable', async () => {
    // Degrading to "skip the merge" on a read failure would silently reinstate
    // the wipe. The throw sits OUTSIDE the update try/catch, so the typed
    // error is not re-labelled by that wrapper (the #1454 placement rule).
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('User is not authorized to perform: glue:GetTable'), {
        name: 'AccessDeniedException',
      })
    );

    const error = await captureRejection(
      provider.update(
        'L',
        TABLE_PHYSICAL_ID,
        'AWS::Glue::Table',
        { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'b' } },
        { DatabaseName: 'mydb', TableInput: { Name: 'mytbl' } }
      )
    );

    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error.message.startsWith('Failed to read the current Glue Table L before update:')).toBe(
      true
    );
    expect(error.message).not.toContain('Failed to update Glue Table');
    expect(error.message).toContain('glue:GetTable');
    expect(error.message).toContain('table_type / metadata_location');
    // The original AWS error is preserved as `cause`, which is what keeps a
    // transient throttle retryable by the deploy engine's outer withRetry.
    expect(error.cause).toBeInstanceOf(Error);
    // Nothing was written to AWS.
    expect(mockSend.mock.calls.find((c) => c[0] instanceof UpdateTableCommand)).toBeUndefined();
  });

  it('AWS::Glue::Database — AWS-authored Parameters survive, user removals still reach AWS', async () => {
    // UpdateDatabase is the sibling full-replace API with the same
    // `DatabaseInput.Parameters` bag (Lake Formation / federated-catalog
    // markers are written into it out-of-band).
    mockLiveDatabase({
      'lakeformation.managed': 'true',
      owner_team: 'analytics',
      keep_me: 'yes',
    });

    await provider.update(
      'L',
      'mydb',
      'AWS::Glue::Database',
      { DatabaseInput: { Name: 'mydb', Description: 'phase-2', Parameters: { keep_me: 'yes' } } },
      {
        DatabaseInput: {
          Name: 'mydb',
          Description: 'phase-1',
          Parameters: { keep_me: 'yes', owner_team: 'analytics' },
        },
      }
    );

    expect(sentDatabaseInput().Parameters).toStrictEqual({
      keep_me: 'yes',
      'lakeformation.managed': 'true',
    });
  });

  it('AWS::Glue::Database — the pre-update read forwards CatalogId and fails CLOSED unwrapped', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('User is not authorized to perform: glue:GetDatabase'), {
        name: 'AccessDeniedException',
      })
    );

    const error = await captureRejection(
      provider.update(
        'L',
        'mydb',
        'AWS::Glue::Database',
        { CatalogId: '123456789012', DatabaseInput: { Name: 'mydb', Description: 'b' } },
        { CatalogId: '123456789012', DatabaseInput: { Name: 'mydb' } }
      )
    );

    const getCall = mockSend.mock.calls.find((c) => c[0] instanceof GetDatabaseCommand);
    expect(getCall).toBeDefined();
    expect(getCall![0].input).toStrictEqual({ CatalogId: '123456789012', Name: 'mydb' });
    expect(error.message).toContain('glue:GetDatabase');
    expect(error.message).not.toContain('Failed to update Glue Database');
    expect(mockSend.mock.calls.find((c) => c[0] instanceof UpdateDatabaseCommand)).toBeUndefined();
  });

  it('AWS::Glue::Database — the extra read is NOT issued when the update is refused pre-flight', async () => {
    await expect(
      provider.update('L', 'mydb', 'AWS::Glue::Database', {}, {})
    ).rejects.toThrow(ProvisioningError);
    expect(mockSend).not.toHaveBeenCalled();
  });

  // ─── Database parity with the Table arms above ─────────────────────

  it('AWS::Glue::Database — a NOT-FOUND readback does not mask the real UpdateDatabase error', async () => {
    // The Database twin of the Table not-found arm. Mutation-proved: without
    // the EntityNotFoundException branch in readLiveDatabaseParameters this
    // test fails, whereas the whole rest of the suite stays green.
    mockSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'Entity Not Found', $metadata: {} })
    );
    mockSend.mockRejectedValueOnce(new Error('Database not found.'));

    const error = await captureRejection(
      provider.update('L', 'mydb', 'AWS::Glue::Database', { DatabaseInput: { Name: 'mydb' } }, {})
    );

    expect(mockSend.mock.calls.find((c) => c[0] instanceof UpdateDatabaseCommand)).toBeDefined();
    expect(error.message).toContain('Failed to update Glue Database L');
    expect(error.message).toContain('Database not found.');
  });

  it('AWS::Glue::Database — a WHOLE Parameters block the user removed stays removed', async () => {
    mockLiveDatabase({ 'lakeformation.managed': 'true', owner_team: 'analytics' });

    await provider.update(
      'L',
      'mydb',
      'AWS::Glue::Database',
      { DatabaseInput: { Name: 'mydb' } },
      { DatabaseInput: { Name: 'mydb', Parameters: { owner_team: 'analytics' } } }
    );

    expect(sentDatabaseInput().Parameters).toStrictEqual({ 'lakeformation.managed': 'true' });
  });

  it('AWS::Glue::Database — a template that never declared Parameters still keeps AWS-authored ones', async () => {
    mockLiveDatabase({ 'lakeformation.managed': 'true' });

    await provider.update(
      'L',
      'mydb',
      'AWS::Glue::Database',
      { DatabaseInput: { Name: 'mydb', Description: 'b' } },
      { DatabaseInput: { Name: 'mydb', Description: 'a' } }
    );

    expect(sentDatabaseInput().Parameters).toStrictEqual({ 'lakeformation.managed': 'true' });
  });

  it('AWS::Glue::Database — an empty live Parameters map leaves the payload byte-identical', async () => {
    mockLiveDatabase({});

    await provider.update(
      'L',
      'mydb',
      'AWS::Glue::Database',
      { DatabaseInput: { Name: 'mydb', Description: 'b' } },
      { DatabaseInput: { Name: 'mydb', Description: 'a' } }
    );

    expect('Parameters' in sentDatabaseInput()).toBe(false);
  });

  it('AWS::Glue::Database — drift --revert still CLEARS a console-added parameter', async () => {
    mockLiveDatabase({ 'lakeformation.managed': 'true', console_added: 'oops' });

    await provider.update(
      'L',
      'mydb',
      'AWS::Glue::Database',
      { DatabaseInput: { Name: 'mydb', Parameters: { 'lakeformation.managed': 'true' } } },
      {
        DatabaseInput: {
          Name: 'mydb',
          Parameters: { 'lakeformation.managed': 'true', console_added: 'oops' },
        },
      }
    );

    expect(sentDatabaseInput().Parameters).toStrictEqual({ 'lakeformation.managed': 'true' });
  });

  it('AWS::Glue::Database — Parameters values are stringified like the Table builder does', async () => {
    // buildDatabaseInput used to forward the raw map while buildTableInput
    // stringified — a latent inconsistency, since the SDK member is
    // Record<string,string> and CDK can deliver booleans / numbers.
    mockLiveDatabase({});

    await provider.update(
      'L',
      'mydb',
      'AWS::Glue::Database',
      { DatabaseInput: { Name: 'mydb', Parameters: { enabled: true, count: 3 } } },
      { DatabaseInput: { Name: 'mydb' } }
    );

    expect(sentDatabaseInput().Parameters).toStrictEqual({ enabled: 'true', count: '3' });
  });

  // ─── TOCTOU: UpdateTable VersionId concurrency guard ───────────────

  it('AWS::Glue::Table — VersionId is sent when the merge writes back live values', async () => {
    // Reading Parameters here and writing them back next call opens a TOCTOU
    // window: an Iceberg commit from Spark / Athena landing in between would
    // be undone by writing back the metadata_location we read. VersionId makes
    // AWS reject that instead (ConcurrentModificationException).
    mockLiveTable({ table_type: 'ICEBERG', metadata_location: 's3://b/m.json' }, '7');

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'b' } },
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'a' } }
    );

    expect(sentUpdateTableInputRoot().VersionId).toBe('7');
  });

  it('AWS::Glue::Table — VersionId is sent on a pure template push too (drift --revert)', async () => {
    // Deliberately UNCONDITIONAL. An earlier cut scoped this to "only when the
    // merge wrote back live values", which was wrong twice over. Unsafe: the
    // merge also reports nothing-written-back when the LIVE READ WAS EMPTY,
    // and that update still ships a wholesale TableInput replace — so a commit
    // landing in the window would have been wiped with no guard at all.
    // And the premise was false: the pre-read runs milliseconds before the
    // send on EVERY update, so a pure template push carries a fresh version
    // too and cannot fail spuriously. It fails only when someone else really
    // wrote in between, which is exactly when a revert should stop rather than
    // clobber a change it never saw.
    mockLiveTable({ table_type: 'ICEBERG', console_added: 'oops' }, '7');

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Parameters: { table_type: 'ICEBERG' } } },
      {
        DatabaseName: 'mydb',
        TableInput: {
          Name: 'mytbl',
          Parameters: { table_type: 'ICEBERG', console_added: 'oops' },
        },
      }
    );

    expect(sentUpdateTableInputRoot().VersionId).toBe('7');
    // The revert still clears the console addition — guarding does not change
    // what is written, only whether the write is allowed to land.
    expect(sentTableInput().Parameters).toStrictEqual({ table_type: 'ICEBERG' });
  });

  it('AWS::Glue::Table — VersionId is sent even when the live Parameters map is EMPTY', async () => {
    // The hole the old scoping left: an empty live read means the merge adds
    // nothing, but the update is still a wholesale TableInput replace, so a
    // concurrent commit in the window is wiped. Unguarded, that was #1461
    // surviving its own fix.
    mockLiveTable({}, '9');

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'b' } },
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'a' } }
    );

    expect(sentUpdateTableInputRoot().VersionId).toBe('9');
  });

  it('AWS::Glue::Table — VersionId is omitted when AWS did not return one', async () => {
    mockLiveTable({ table_type: 'ICEBERG' }, null);

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'b' } },
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'a' } }
    );

    // `in`, not toBeUndefined: an explicit `VersionId: undefined` key would be
    // a different wire shape.
    expect('VersionId' in sentUpdateTableInputRoot()).toBe(false);
    // The merge still happened — no version to guard with must not skip the fix.
    expect(sentTableInput().Parameters).toStrictEqual({ table_type: 'ICEBERG' });
  });

  it('AWS::Glue::Table — a ConcurrentModificationException is explained, not passed through bare', async () => {
    mockSend.mockResolvedValueOnce({
      Table: { Name: 'mytbl', Parameters: { table_type: 'ICEBERG' }, VersionId: '7' },
    });
    mockSend.mockRejectedValueOnce(
      new ConcurrentModificationException({ message: 'Update table failed', $metadata: {} })
    );

    const error = await captureRejection(
      provider.update(
        'L',
        TABLE_PHYSICAL_ID,
        'AWS::Glue::Table',
        { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'b' } },
        { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'a' } }
      )
    );

    expect(error.message).toContain('Failed to update Glue Table L');
    expect(error.message).toContain('Another writer changed the table');
    expect(error.message).toContain('cdkd sent the version it read (7)');
    expect(error.message).toContain('metadata_location');
    expect(error.message).toContain('Re-run the deploy');
  });

  it('AWS::Glue::Table — the CME message does NOT claim a precondition cdkd never sent', async () => {
    // Wording is gated on whether a VersionId was actually attached. With none,
    // AWS raised this on its own, and claiming "cdkd sent the version it read"
    // would be a lie about our own behavior.
    mockSend.mockResolvedValueOnce({ Table: { Name: 'mytbl', Parameters: {} } });
    mockSend.mockRejectedValueOnce(
      new ConcurrentModificationException({ message: 'Update table failed', $metadata: {} })
    );

    const error = await captureRejection(
      provider.update(
        'L',
        TABLE_PHYSICAL_ID,
        'AWS::Glue::Table',
        { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'b' } },
        { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'a' } }
      )
    );

    expect(error.message).toContain('Another writer changed the table');
    expect(error.message).toContain('AWS returned no VersionId');
    expect(error.message).not.toContain('cdkd sent the version it read');
  });

  // ─── Build-time failures stay typed (the build is INSIDE the try) ──

  it('AWS::Glue::Table — a null Parameters value is tolerated and the AWS-authored merge still runs', async () => {
    // `Parameters: null` used to reach `Object.entries(null)` and throw a bare
    // TypeError with no resource context. It is now coerced to "no declared
    // parameters", which the full-replace semantics already mean — and the
    // AWS-authored merge still applies on top.
    //
    // The build + merge also moved back INSIDE the update `try` (only the
    // pre-read needs to be outside it, being the one thing that raises a typed
    // error the catch would re-label), so any FUTURE build-time throw surfaces
    // as a ProvisioningError carrying the resource context rather than raw.
    mockLiveTable({ table_type: 'ICEBERG' });

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Parameters: null } },
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl' } }
    );

    expect(sentTableInput().Parameters).toStrictEqual({ table_type: 'ICEBERG' });
  });

  // ─── parameterKeySet's non-object arms ─────────────────────────────

  it('AWS::Glue::Table — an ARRAY-valued Parameters side contributes no keys (unresolved intrinsic)', async () => {
    // parameterKeySet treats a non-object (or an array) as "declares nothing",
    // so an unresolved-intrinsic previous side can never be mistaken for a
    // user removal, and every live key stays preserved.
    mockLiveTable({ table_type: 'ICEBERG', owner_team: 'analytics' });

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'b' } },
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Parameters: ['Fn::If', 'a', 'b'] } }
    );

    expect(sentTableInput().Parameters).toStrictEqual({
      table_type: 'ICEBERG',
      owner_team: 'analytics',
    });
  });

  it('AWS::Glue::Table — an absent live Parameters field is treated as no live values', async () => {
    // AWS omits Table.Parameters entirely on a table that has none; the merge
    // must handle undefined the same as {} and leave the payload untouched.
    mockLiveTable(undefined);

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'b' } },
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'a' } }
    );

    expect('Parameters' in sentTableInput()).toBe(false);
    // The concurrency guard is independent of whether anything was merged —
    // the wholesale TableInput replace still needs it.
    expect(sentUpdateTableInputRoot().VersionId).toBe('3');
  });

  // ─── readCurrentState CatalogId parity (same call, same catalog) ───

  it('readCurrentState forwards CatalogId to GetTable and GetDatabase', async () => {
    // The pre-update readers forwarded CatalogId while the drift readers did
    // not — same file, same API. On a cross-account catalog the drift read
    // hit the account-default catalog and reported the resource gone.
    mockSend.mockResolvedValueOnce({ Table: { Name: 'mytbl' } });
    await provider.readCurrentState('mydb|mytbl', 'L', 'AWS::Glue::Table', {
      CatalogId: '123456789012',
    });
    expect(
      (mockSend.mock.calls.find((c) => c[0] instanceof GetTableCommand)![0].input as {
        CatalogId?: string;
      }).CatalogId
    ).toBe('123456789012');

    mockSend.mockResolvedValueOnce({ Database: { Name: 'mydb' } });
    await provider.readCurrentState('mydb', 'L', 'AWS::Glue::Database', {
      CatalogId: '123456789012',
    });
    expect(
      (mockSend.mock.calls.find((c) => c[0] instanceof GetDatabaseCommand)![0].input as {
        CatalogId?: string;
      }).CatalogId
    ).toBe('123456789012');
  });

  it('readCurrentState omits CatalogId when the template does not set one', async () => {
    mockSend.mockResolvedValueOnce({ Table: { Name: 'mytbl' } });
    await provider.readCurrentState('mydb|mytbl', 'L', 'AWS::Glue::Table');
    const input = mockSend.mock.calls.find((c) => c[0] instanceof GetTableCommand)![0].input as
      Record<string, unknown>;
    expect('CatalogId' in input).toBe(false);
  });
});

// ─── #1479: out-of-band-authored StorageDescriptor members must survive ──
//
// Live probes (2026-08-10, recorded on the issue) showed a Glue crawler
// authors Columns / InputFormat / OutputFormat / SerdeInfo (incl. its
// Parameters bag) / StorageDescriptor.Parameters, and Glue re-derives an
// Iceberg table's catalog Columns from table metadata — while UpdateTable is
// a full replace, so an update restating only the template wiped all of them
// (Columns -> [], SerdeInfo gone) and reported success. The merge applies the
// #1461 "present in NEITHER template side" rule per SD member, with the two
// nested bags getting the per-key rule.
describe('GlueProvider — out-of-band StorageDescriptor preservation (#1479)', () => {
  let provider: GlueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueProvider();
  });

  /** Queue the pre-update `GetTable` readback (full Table), then the UpdateTable reply. */
  const mockLiveTableFull = (table: Record<string, unknown>): void => {
    mockSend.mockResolvedValueOnce({ Table: { Name: 'mytbl', VersionId: '3', ...table } });
    mockSend.mockResolvedValueOnce({});
  };

  const sentTableInput = (): Record<string, unknown> => {
    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateTableCommand);
    expect(call).toBeDefined();
    return (call![0].input as { TableInput: Record<string, unknown> }).TableInput;
  };

  const CRAWLER_SD = {
    Columns: [
      { Name: 'id', Type: 'bigint' },
      { Name: 'name', Type: 'string' },
    ],
    Location: 's3://b/crawl/',
    InputFormat: 'org.apache.hadoop.mapred.TextInputFormat',
    OutputFormat: 'org.apache.hadoop.hive.ql.io.HiveIgnoreKeyTextOutputFormat',
    SerdeInfo: {
      SerializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
      Parameters: { 'field.delim': ',' },
    },
    Parameters: { UPDATED_BY_CRAWLER: 'my-crawler', recordCount: '3' },
  };

  it('crawler-authored SD members survive an unrelated update that declares only Location', async () => {
    mockLiveTableFull({ StorageDescriptor: CRAWLER_SD });

    const templateSide = (description: string) => ({
      DatabaseName: 'mydb',
      TableInput: {
        Name: 'mytbl',
        Description: description,
        StorageDescriptor: { Location: 's3://b/crawl/' },
      },
    });
    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      templateSide('v2'),
      templateSide('v1')
    );

    const sd = sentTableInput().StorageDescriptor as Record<string, unknown>;
    expect(sd.Location).toBe('s3://b/crawl/');
    expect(sd.Columns).toStrictEqual(CRAWLER_SD.Columns);
    expect(sd.InputFormat).toBe(CRAWLER_SD.InputFormat);
    expect(sd.OutputFormat).toBe(CRAWLER_SD.OutputFormat);
    expect(sd.SerdeInfo).toStrictEqual(CRAWLER_SD.SerdeInfo);
    expect(sd.Parameters).toStrictEqual(CRAWLER_SD.Parameters);
  });

  it('a template that never declared StorageDescriptor carries the WHOLE live block forward', async () => {
    mockLiveTableFull({ StorageDescriptor: CRAWLER_SD });

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'v2' } },
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl', Description: 'v1' } }
    );

    expect(sentTableInput().StorageDescriptor).toStrictEqual(CRAWLER_SD);
  });

  it('the Iceberg headline case: catalog Columns the template never declared survive', async () => {
    // Glue derives an Iceberg table's catalog Columns from table metadata;
    // the raw full-replace wiped them to [] (probed live on the issue).
    mockLiveTableFull({
      StorageDescriptor: {
        Columns: [{ Name: 'id', Type: 'int' }],
        Location: 's3://b/iceberg_t/',
      },
      Parameters: { table_type: 'ICEBERG', metadata_location: 's3://b/iceberg_t/metadata/0.json' },
    });

    const templateSide = (description: string) => ({
      DatabaseName: 'mydb',
      TableInput: {
        Name: 'mytbl',
        Description: description,
        TableType: 'EXTERNAL_TABLE',
        StorageDescriptor: { Location: 's3://b/iceberg_t/' },
      },
    });
    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      templateSide('v2'),
      templateSide('v1')
    );

    const sent = sentTableInput();
    const sd = sent.StorageDescriptor as Record<string, unknown>;
    expect(sd.Columns).toStrictEqual([{ Name: 'id', Type: 'int' }]);
    // The #1461 half still holds alongside the SD merge.
    expect(sent.Parameters).toStrictEqual({
      table_type: 'ICEBERG',
      metadata_location: 's3://b/iceberg_t/metadata/0.json',
    });
  });

  it('an SD member the USER removed stays removed (previous declared it, desired does not)', async () => {
    mockLiveTableFull({
      StorageDescriptor: {
        Columns: [{ Name: 'id', Type: 'int' }],
        Location: 's3://b/t/',
      },
    });

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      {
        DatabaseName: 'mydb',
        TableInput: { Name: 'mytbl', StorageDescriptor: { Location: 's3://b/t/' } },
      },
      {
        DatabaseName: 'mydb',
        TableInput: {
          Name: 'mytbl',
          StorageDescriptor: {
            Location: 's3://b/t/',
            Columns: [{ Name: 'id', Type: 'int' }],
          },
        },
      }
    );

    expect('Columns' in (sentTableInput().StorageDescriptor as Record<string, unknown>)).toBe(
      false
    );
  });

  it('drift --revert still clears a console-side change to a template-declared member', async () => {
    // Live Columns diverge from the template (console edit); the template
    // DECLARES Columns, so the template value must win — a blanket merge here
    // would make drift --revert a no-op, the exact trap the issue warns about.
    mockLiveTableFull({
      StorageDescriptor: {
        Columns: [{ Name: 'added_in_console', Type: 'string' }],
        Location: 's3://b/t/',
      },
    });

    const templateSide = () => ({
      DatabaseName: 'mydb',
      TableInput: {
        Name: 'mytbl',
        StorageDescriptor: {
          Location: 's3://b/t/',
          Columns: [{ Name: 'id', Type: 'int' }],
        },
      },
    });
    await provider.update('L', TABLE_PHYSICAL_ID, 'AWS::Glue::Table', templateSide(), templateSide());

    expect((sentTableInput().StorageDescriptor as Record<string, unknown>).Columns).toStrictEqual([
      { Name: 'id', Type: 'int' },
    ]);
  });

  it('SD.Parameters gets the per-KEY bag rule when the template declares the bag', async () => {
    mockLiveTableFull({
      StorageDescriptor: {
        Location: 's3://b/t/',
        Parameters: { UPDATED_BY_CRAWLER: 'my-crawler', user_key: 'v1', removed_key: 'x' },
      },
    });

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      {
        DatabaseName: 'mydb',
        TableInput: {
          Name: 'mytbl',
          StorageDescriptor: { Location: 's3://b/t/', Parameters: { user_key: 'v2' } },
        },
      },
      {
        DatabaseName: 'mydb',
        TableInput: {
          Name: 'mytbl',
          StorageDescriptor: {
            Location: 's3://b/t/',
            Parameters: { user_key: 'v1', removed_key: 'x' },
          },
        },
      }
    );

    expect((sentTableInput().StorageDescriptor as Record<string, unknown>).Parameters).toStrictEqual(
      {
        UPDATED_BY_CRAWLER: 'my-crawler', // authored by neither side -> preserved
        user_key: 'v2', // template wins
        // removed_key: user removed it -> stays removed
      }
    );
  });

  it('SerdeInfo merges per member, with its Parameters bag per key', async () => {
    mockLiveTableFull({
      StorageDescriptor: {
        Location: 's3://b/t/',
        SerdeInfo: {
          SerializationLibrary: 'org.live.Serde',
          Parameters: { 'field.delim': ',', 'crawler.added': 'yes' },
        },
      },
    });

    const templateSide = (lib: string) => ({
      DatabaseName: 'mydb',
      TableInput: {
        Name: 'mytbl',
        StorageDescriptor: {
          Location: 's3://b/t/',
          SerdeInfo: {
            SerializationLibrary: lib,
            Parameters: { 'field.delim': ',' },
          },
        },
      },
    });
    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      templateSide('org.user.SerdeV2'),
      templateSide('org.user.SerdeV1')
    );

    const serde = (sentTableInput().StorageDescriptor as Record<string, unknown>)
      .SerdeInfo as Record<string, unknown>;
    expect(serde.SerializationLibrary).toBe('org.user.SerdeV2'); // template wins
    expect(serde.Parameters).toStrictEqual({
      'field.delim': ',', // template-declared key, template value
      'crawler.added': 'yes', // authored by neither side -> preserved
    });
  });

  it('a live table with no StorageDescriptor leaves the payload untouched', async () => {
    mockLiveTableFull({});

    const templateSide = (description: string) => ({
      DatabaseName: 'mydb',
      TableInput: {
        Name: 'mytbl',
        Description: description,
        StorageDescriptor: { Location: 's3://b/t/' },
      },
    });
    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      templateSide('v2'),
      templateSide('v1')
    );

    expect(sentTableInput().StorageDescriptor).toStrictEqual({ Location: 's3://b/t/' });
  });

  it('a whole SD.Parameters bag the user removed keeps its AWS-authored keys (per-key, like #1461)', async () => {
    // Removing the whole bag while keeping StorageDescriptor is the same user
    // action the top-level #1461 helper handles per key: user keys removed,
    // AWS-authored keys survive. A desired-side-only gate would wipe the
    // crawler keys here — the review-caught divergence this test pins.
    mockLiveTableFull({
      StorageDescriptor: {
        Location: 's3://b/t/',
        Parameters: { UPDATED_BY_CRAWLER: 'my-crawler', user_key: 'v1' },
      },
    });

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      {
        DatabaseName: 'mydb',
        TableInput: { Name: 'mytbl', StorageDescriptor: { Location: 's3://b/t/' } },
      },
      {
        DatabaseName: 'mydb',
        TableInput: {
          Name: 'mytbl',
          StorageDescriptor: { Location: 's3://b/t/', Parameters: { user_key: 'v1' } },
        },
      }
    );

    expect((sentTableInput().StorageDescriptor as Record<string, unknown>).Parameters).toStrictEqual(
      { UPDATED_BY_CRAWLER: 'my-crawler' }
    );
  });

  it('a whole SerdeInfo.Parameters bag the user removed keeps its AWS-authored keys', async () => {
    mockLiveTableFull({
      StorageDescriptor: {
        Location: 's3://b/t/',
        SerdeInfo: {
          SerializationLibrary: 'org.user.Serde',
          Parameters: { 'crawler.added': 'yes', 'user.key': 'v1' },
        },
      },
    });

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      {
        DatabaseName: 'mydb',
        TableInput: {
          Name: 'mytbl',
          StorageDescriptor: {
            Location: 's3://b/t/',
            SerdeInfo: { SerializationLibrary: 'org.user.Serde' },
          },
        },
      },
      {
        DatabaseName: 'mydb',
        TableInput: {
          Name: 'mytbl',
          StorageDescriptor: {
            Location: 's3://b/t/',
            SerdeInfo: {
              SerializationLibrary: 'org.user.Serde',
              Parameters: { 'user.key': 'v1' },
            },
          },
        },
      }
    );

    const serde = (sentTableInput().StorageDescriptor as Record<string, unknown>)
      .SerdeInfo as Record<string, unknown>;
    expect(serde.Parameters).toStrictEqual({ 'crawler.added': 'yes' });
  });

  it('a whole SerdeInfo block the user removed stays removed (structural member, not a bag)', async () => {
    // Unlike the Parameters bags, SerdeInfo's members are user-authored in
    // every template shape — resurrecting a partial SerdeInfo carrying only
    // crawler keys would leave an incoherent serde, so whole-member removal
    // is honored.
    mockLiveTableFull({
      StorageDescriptor: {
        Location: 's3://b/t/',
        SerdeInfo: {
          SerializationLibrary: 'org.user.Serde',
          Parameters: { 'crawler.added': 'yes' },
        },
      },
    });

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      {
        DatabaseName: 'mydb',
        TableInput: { Name: 'mytbl', StorageDescriptor: { Location: 's3://b/t/' } },
      },
      {
        DatabaseName: 'mydb',
        TableInput: {
          Name: 'mytbl',
          StorageDescriptor: {
            Location: 's3://b/t/',
            SerdeInfo: { SerializationLibrary: 'org.user.Serde' },
          },
        },
      }
    );

    expect(
      'SerdeInfo' in (sentTableInput().StorageDescriptor as Record<string, unknown>)
    ).toBe(false);
  });

  it('a whole StorageDescriptor the user removed: authored members go, out-of-band members survive', async () => {
    // The per-member rule extends to the block's own removal: members the
    // user declared before are removed; members no template side ever
    // authored (a crawler's SD.Parameters bag) are still carried.
    mockLiveTableFull({
      StorageDescriptor: {
        Location: 's3://b/t/',
        Columns: [{ Name: 'id', Type: 'int' }],
        Parameters: { UPDATED_BY_CRAWLER: 'my-crawler' },
      },
    });

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl' } },
      {
        DatabaseName: 'mydb',
        TableInput: {
          Name: 'mytbl',
          StorageDescriptor: {
            Location: 's3://b/t/',
            Columns: [{ Name: 'id', Type: 'int' }],
          },
        },
      }
    );

    expect(sentTableInput().StorageDescriptor).toStrictEqual({
      Parameters: { UPDATED_BY_CRAWLER: 'my-crawler' },
    });
  });

  it('a declared-but-empty StorageDescriptor {} on both sides still carries live members', async () => {
    // Pins the declaration test: `undefined`, not key-set emptiness. An empty
    // declared block means "I author nothing here", so every live member is
    // out-of-band and carried.
    mockLiveTableFull({ StorageDescriptor: CRAWLER_SD });

    const templateSide = () => ({
      DatabaseName: 'mydb',
      TableInput: { Name: 'mytbl', StorageDescriptor: {} },
    });
    await provider.update('L', TABLE_PHYSICAL_ID, 'AWS::Glue::Table', templateSide(), templateSide());

    expect(sentTableInput().StorageDescriptor).toStrictEqual(CRAWLER_SD);
  });

  it('a malformed (string-valued) desired StorageDescriptor does not crash the merge', async () => {
    // asRecord tolerance: a malformed container contributes no keys, so live
    // members are carried and AWS surfaces the real validation error.
    mockLiveTableFull({
      StorageDescriptor: { Location: 's3://b/t/', Columns: [{ Name: 'id', Type: 'int' }] },
    });

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      {
        DatabaseName: 'mydb',
        TableInput: { Name: 'mytbl', StorageDescriptor: 'not-an-object' },
      },
      { DatabaseName: 'mydb', TableInput: { Name: 'mytbl' } }
    );

    const sd = sentTableInput().StorageDescriptor as Record<string, unknown>;
    expect(sd.Columns).toStrictEqual([{ Name: 'id', Type: 'int' }]);
    expect(sd.Location).toBe('s3://b/t/');
  });
});

// ─── #1505: the StorageDescriptor allow-list dropped declared members ───
//
// `buildStorageDescriptor` was an explicit allow-list of 11 members, so the
// CFn `StorageDescriptor` members outside it were never sent. The live CFn
// registry schema declares exactly 13 members with `additionalProperties:
// false`, so the two missing ones are `SkewedInfo` and `SchemaReference`
// (the issue also named `AdditionalLocations`, which the registry does NOT
// declare — it exists only in the SDK model, so no template can carry it).
//
// The #1479 merge made the drop worse than a plain silent drop: its key sets
// come from the RAW template, so a template DECLARING one of these suppressed
// the live carry-forward (the member counts as user-authored) while the
// builder never produced a value — erasing the live value with nothing
// replacing it. That is the `erases the live value` case below.
describe('GlueProvider — StorageDescriptor declared-member coverage (#1505)', () => {
  let provider: GlueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueProvider();
  });

  const SKEWED_INFO = {
    SkewedColumnNames: ['country'],
    SkewedColumnValues: ['US'],
    SkewedColumnValueLocationMaps: { US: 's3://b/skew/us/' },
  };

  const SCHEMA_REFERENCE = {
    SchemaId: { RegistryName: 'my-registry', SchemaName: 'my-schema' },
    SchemaVersionNumber: 2,
  };

  const createdTableInput = (): Record<string, unknown> => {
    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateTableCommand);
    expect(call).toBeDefined();
    return (call![0].input as { TableInput: Record<string, unknown> }).TableInput;
  };

  const sentTableInput = (): Record<string, unknown> => {
    const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateTableCommand);
    expect(call).toBeDefined();
    return (call![0].input as { TableInput: Record<string, unknown> }).TableInput;
  };

  it('create() sends SkewedInfo and SchemaReference instead of dropping them', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.create('L', 'AWS::Glue::Table', {
      DatabaseName: 'mydb',
      TableInput: {
        Name: 'mytbl',
        StorageDescriptor: {
          Location: 's3://b/t/',
          SkewedInfo: SKEWED_INFO,
          SchemaReference: SCHEMA_REFERENCE,
        },
      },
    });

    const sd = createdTableInput().StorageDescriptor as Record<string, unknown>;
    // toStrictEqual, not toEqual: an `{ X: undefined }` forward would pass
    // toEqual while the SDK v3 serializer treats undefined as absent — the
    // silent-drop failure mode these assertions exist to fence.
    expect(sd.SkewedInfo).toStrictEqual(SKEWED_INFO);
    expect(sd.SchemaReference).toStrictEqual(SCHEMA_REFERENCE);
  });

  it('create() stringifies SkewedColumnValueLocationMaps values (CFn free-form object -> SDK Record<string,string>)', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.create('L', 'AWS::Glue::Table', {
      DatabaseName: 'mydb',
      TableInput: {
        Name: 'mytbl',
        StorageDescriptor: {
          Location: 's3://b/t/',
          SkewedInfo: {
            SkewedColumnNames: ['n'],
            SkewedColumnValueLocationMaps: { a: 1, b: true },
          },
        },
      },
    });

    const sd = createdTableInput().StorageDescriptor as Record<string, unknown>;
    expect(sd.SkewedInfo).toStrictEqual({
      SkewedColumnNames: ['n'],
      SkewedColumnValueLocationMaps: { a: '1', b: 'true' },
    });
  });

  it('a DECLARED SkewedInfo no longer erases the live value (the #1479 interaction)', async () => {
    // Live table carries a SkewedInfo; the template declares its own. Before
    // the fix the declaration suppressed the carry-forward AND the builder
    // sent nothing, so UpdateTable's full replace wiped the member entirely.
    mockSend.mockResolvedValueOnce({
      Table: {
        Name: 'mytbl',
        VersionId: '3',
        StorageDescriptor: {
          Location: 's3://b/t/',
          SkewedInfo: { SkewedColumnNames: ['stale'] },
        },
      },
    });
    mockSend.mockResolvedValueOnce({});

    const side = (names: string[]) => ({
      DatabaseName: 'mydb',
      TableInput: {
        Name: 'mytbl',
        StorageDescriptor: {
          Location: 's3://b/t/',
          SkewedInfo: { SkewedColumnNames: names },
        },
      },
    });

    await provider.update(
      'L',
      TABLE_PHYSICAL_ID,
      'AWS::Glue::Table',
      side(['country']),
      side(['region'])
    );

    const sd = sentTableInput().StorageDescriptor as Record<string, unknown>;
    expect(sd.SkewedInfo).toStrictEqual({ SkewedColumnNames: ['country'] });
  });

  it('an UNDECLARED SkewedInfo is still carried forward by the #1479 merge', async () => {
    mockSend.mockResolvedValueOnce({
      Table: {
        Name: 'mytbl',
        VersionId: '3',
        StorageDescriptor: { Location: 's3://b/t/', SkewedInfo: SKEWED_INFO },
      },
    });
    mockSend.mockResolvedValueOnce({});

    const side = (description: string) => ({
      DatabaseName: 'mydb',
      TableInput: {
        Name: 'mytbl',
        Description: description,
        StorageDescriptor: { Location: 's3://b/t/' },
      },
    });

    await provider.update('L', TABLE_PHYSICAL_ID, 'AWS::Glue::Table', side('v2'), side('v1'));

    const sd = sentTableInput().StorageDescriptor as Record<string, unknown>;
    expect(sd.SkewedInfo).toStrictEqual(SKEWED_INFO);
  });

  it('SerdeInfo.Parameters stringification copies rather than mutating the caller template', async () => {
    mockSend.mockResolvedValueOnce({});

    const serdeInfo = {
      SerializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
      Parameters: { 'skip.header.line.count': 1 },
    };
    const properties = {
      DatabaseName: 'mydb',
      TableInput: {
        Name: 'mytbl',
        StorageDescriptor: { Location: 's3://b/t/', SerdeInfo: serdeInfo },
      },
    };

    await provider.create('L', 'AWS::Glue::Table', properties);

    const sd = createdTableInput().StorageDescriptor as Record<string, unknown>;
    expect(sd.SerdeInfo).toStrictEqual({
      SerializationLibrary: 'org.apache.hadoop.hive.serde2.lazy.LazySimpleSerDe',
      Parameters: { 'skip.header.line.count': '1' },
    });
    // The caller's object is untouched — the #1479 merge re-reads the RAW
    // template for its key sets, so mutating it in place would leak the
    // builder's coercion into that walk.
    expect(serdeInfo.Parameters).toStrictEqual({ 'skip.header.line.count': 1 });
  });
});

// ─── #1505 review: the same silent-drop class one level up + shape guards ────
//
// Diffing the WHOLE `TableInput` blob (not just the reported StorageDescriptor)
// against the live CFn registry schema found two more dropped members. That is
// WORSE than the StorageDescriptor case: the #1479 read-merge-write only covers
// the `StorageDescriptor` subtree and `Parameters`, so nothing carries these
// forward and UpdateTable's full replace erased a live value unconditionally.
describe('GlueProvider — TableInput member coverage + shape guards (#1505 review)', () => {
  let provider: GlueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueProvider();
  });

  const createdTableInput = (): Record<string, unknown> => {
    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateTableCommand);
    expect(call).toBeDefined();
    return (call![0].input as { TableInput: Record<string, unknown> }).TableInput;
  };

  const createWith = async (tableInput: Record<string, unknown>): Promise<void> => {
    mockSend.mockResolvedValueOnce({});
    await provider.create('L', 'AWS::Glue::Table', {
      DatabaseName: 'mydb',
      TableInput: { Name: 'mytbl', ...tableInput },
    });
  };

  it('create() sends TargetTable (resource-link table) instead of dropping it', async () => {
    const targetTable = {
      CatalogId: '111122223333',
      DatabaseName: 'shared-db',
      Name: 'shared-table',
      Region: 'us-west-2',
    };
    await createWith({ TargetTable: targetTable });
    expect(createdTableInput().TargetTable).toStrictEqual(targetTable);
  });

  it('create() sends ViewDefinition instead of dropping it', async () => {
    const viewDefinition = {
      IsProtected: true,
      Definer: 'arn:aws:iam::111122223333:role/definer',
      SubObjects: ['arn:aws:glue:us-east-1:111122223333:table/mydb/base'],
      Representations: [
        {
          Dialect: 'ATHENA',
          DialectVersion: '3',
          ViewOriginalText: 'SELECT 1',
          ViewExpandedText: 'SELECT 1',
          ValidationConnection: 'my-conn',
        },
      ],
    };
    await createWith({ ViewDefinition: viewDefinition });
    expect(createdTableInput().ViewDefinition).toStrictEqual(viewDefinition);
  });

  it('coerces a stringly-typed SchemaReference.SchemaVersionNumber to a number', async () => {
    // CFn types it as an integer, but a hand-authored template (or a Ref to a
    // Number parameter) can deliver "2", which the SDK number field rejects.
    await createWith({
      StorageDescriptor: {
        Location: 's3://b/t/',
        SchemaReference: { SchemaVersionId: 'abc', SchemaVersionNumber: '2' },
      },
    });
    const sd = createdTableInput().StorageDescriptor as Record<string, unknown>;
    expect(sd.SchemaReference).toStrictEqual({ SchemaVersionId: 'abc', SchemaVersionNumber: 2 });
  });

  it('a malformed SkewedColumnValueLocationMaps contributes NO keys instead of index garbage', async () => {
    // `Object.entries('s3://x')` yields {'0':'s','1':'3',...}; before the guard
    // that index garbage was written to AWS as a real location map.
    await createWith({
      StorageDescriptor: {
        Location: 's3://b/t/',
        SkewedInfo: { SkewedColumnNames: ['c'], SkewedColumnValueLocationMaps: 's3://b/x/' },
      },
    });
    const sd = createdTableInput().StorageDescriptor as Record<string, unknown>;
    expect(sd.SkewedInfo).toStrictEqual({
      SkewedColumnNames: ['c'],
      SkewedColumnValueLocationMaps: {},
    });
  });

  it('a malformed Parameters block contributes NO keys (same guard, shared helper)', async () => {
    await createWith({ Parameters: 'not-an-object' });
    expect(createdTableInput().Parameters).toStrictEqual({});
  });

  it('a null SkewedInfo does not throw a raw TypeError', async () => {
    await expect(
      createWith({ StorageDescriptor: { Location: 's3://b/t/', SkewedInfo: null } })
    ).resolves.not.toThrow();
    const sd = createdTableInput().StorageDescriptor as Record<string, unknown>;
    expect(sd.SkewedInfo).toStrictEqual({});
  });
});
