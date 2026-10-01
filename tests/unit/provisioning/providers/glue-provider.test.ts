import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockGlueSend = vi.hoisted(() => vi.fn());
const mockStsSend = vi.hoisted(() => vi.fn());
const mockLoggerWarn = vi.hoisted(() => vi.fn());
const mockLoggerDebug = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-glue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-glue')>();
  return {
    ...actual,
    GlueClient: vi.fn().mockImplementation(() => ({
      send: mockGlueSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({ send: mockStsSend })),
  };
});

vi.mock('../../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: mockLoggerDebug,
    info: vi.fn(),
    warn: mockLoggerWarn,
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
  UpdateDatabaseCommand,
  UpdateTableCommand,
  UpdateConnectionCommand,
  GetTableCommand,
  GetDatabaseCommand,
  GetConnectionCommand,
  CreateJobCommand,
  UpdateJobCommand,
  CreateWorkflowCommand,
  StopCrawlerCommand,
  CrawlerRunningException,
  EntityNotFoundException,
  AlreadyExistsException,
} from '@aws-sdk/client-glue';
import {
  GlueProvider,
  GlueJobProvider,
  GlueWorkflowProvider,
  GlueCrawlerProvider,
  GlueTriggerProvider,
  GlueConnectionProvider,
} from '../../../../src/provisioning/providers/glue-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../../src/utils/error-handler.js';
import {
  PASTE_PAYLOADS,
  expectNoCommandBesideDisplay,
  spansThatRun,
  withPasteDir,
} from '../../utils/paste-harness.js';
import {
  cfnRefValueFromPhysicalId,
  refStateLookupFromResource,
} from '../../../../src/deployment/intrinsic-function-resolver.js';
import {
  isMarkedNonRetryable,
  isNameCollisionErrorFrom,
} from '../../../../src/deployment/retryable-errors.js';

describe('GlueProvider import', () => {
  let provider: GlueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` does NOT drain the `mockResolvedValueOnce` queue, so a
    // test that fails before consuming its primed response would shift it into
    // the next one — the leak class issue #1618's detector exists to catch.
    // Every test in this block primes its own response, so resetting is safe
    // here (no persistent implementation to lose) and keeps them order-independent.
    mockGlueSend.mockReset();
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
    provider = new GlueProvider();
  });

  function makeDatabaseInput(overrides: Record<string, unknown> = {}) {
    return {
      logicalId: 'MyDB',
      resourceType: 'AWS::Glue::Database',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {},
      ...overrides,
    };
  }

  it('Database explicit override (knownPhysicalId): GetDatabase verifies', async () => {
    mockGlueSend.mockResolvedValueOnce({ Database: { Name: 'adopted_db' } });

    const result = await provider.import(makeDatabaseInput({ knownPhysicalId: 'adopted_db' }));

    expect(result).toEqual({ physicalId: 'adopted_db', attributes: {} });
    const call = mockGlueSend.mock.calls[0][0];
    expect(call.constructor.name).toBe('GetDatabaseCommand');
    expect(call.input).toEqual({ Name: 'adopted_db' });
  });

  // No `aws:cdk:path` tag walk (issue #1134): AWS rejects `aws:`-prefixed
  // tag writes, so the tag never exists on a real resource. Without an
  // explicit override or a template name the provider returns null without
  // any AWS call.
  it('Database returns null without any AWS call when nothing identifies it', async () => {
    const result = await provider.import(makeDatabaseInput());

    expect(result).toBeNull();
    expect(mockGlueSend).not.toHaveBeenCalled();
  });

  it('Table returns null without any AWS call when nothing identifies it', async () => {
    const result = await provider.import({
      logicalId: 'MyTable',
      resourceType: 'AWS::Glue::Table',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: { DatabaseName: 'mydb' },
    });

    expect(result).toBeNull();
    expect(mockGlueSend).not.toHaveBeenCalled();
  });

  function makeTableInput(overrides: Record<string, unknown> = {}) {
    return {
      logicalId: 'MyTable',
      resourceType: 'AWS::Glue::Table',
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: {},
      ...overrides,
    };
  }

  // Issue #1651. CloudFormation's physicalId for AWS::Glue::Table is the TABLE
  // NAME ALONE (`Ref` returns it; it never contains `|`), and auto-mode import
  // merges CFn-derived ids into the overrides before the loop. cdkd's own
  // physicalId is the composite `<db>|<table>`. Both shapes must resolve —
  // before the fix the bare form hit `if (!dbName || !tName) return null` and
  // every `cdk deploy`-managed table reported `skipped-not-found` with no AWS
  // call, while the error text pointed the user at exactly that id.
  it('Table accepts a BARE CloudFormation physicalId and pairs it with the template DatabaseName', async () => {
    mockGlueSend.mockResolvedValueOnce({ Table: { Name: 'my_table' } });

    const result = await provider.import(
      makeTableInput({
        knownPhysicalId: 'my_table',
        properties: { DatabaseName: 'mydb' },
      })
    );

    // Normalized to cdkd's composite form: update / delete / getAttribute /
    // readCurrentState all split the stored id on `|`, so recording the bare
    // CFn name would adopt the table into an unusable state record.
    expect(result).toEqual({ physicalId: 'mydb|my_table', attributes: {} });
    const call = mockGlueSend.mock.calls[0][0];
    expect(call.constructor.name).toBe('GetTableCommand');
    expect(call.input).toEqual({ DatabaseName: 'mydb', Name: 'my_table' });
  });

  it("Table accepts cdkd's composite physicalId unchanged", async () => {
    mockGlueSend.mockResolvedValueOnce({ Table: { Name: 'my_table' } });

    const result = await provider.import(
      makeTableInput({
        knownPhysicalId: 'mydb|my_table',
        // Deliberately absent from the template: the composite carries both
        // segments itself, so it must not depend on the template's DatabaseName.
        properties: {},
      })
    );

    expect(result).toEqual({ physicalId: 'mydb|my_table', attributes: {} });
    expect(mockGlueSend.mock.calls[0][0].input).toEqual({
      DatabaseName: 'mydb',
      Name: 'my_table',
    });
  });

  it('Table falls back to the template DatabaseName + TableInput.Name when no override is given', async () => {
    mockGlueSend.mockResolvedValueOnce({ Table: { Name: 'my_table' } });

    const result = await provider.import(
      makeTableInput({
        properties: { DatabaseName: 'mydb', TableInput: { Name: 'my_table' } },
      })
    );

    expect(result).toEqual({ physicalId: 'mydb|my_table', attributes: {} });
    expect(mockGlueSend.mock.calls[0][0].input).toEqual({
      DatabaseName: 'mydb',
      Name: 'my_table',
    });
  });

  it('Table returns null without any AWS call when a bare id has no template DatabaseName to pair with', async () => {
    const result = await provider.import(
      makeTableInput({ knownPhysicalId: 'my_table', properties: {} })
    );

    expect(result).toBeNull();
    expect(mockGlueSend).not.toHaveBeenCalled();
  });

  // The generic caller-side hint tells the user to pass
  // `--resource <LogicalId>=<physicalId>` — and passing CloudFormation's bare
  // table name again fails identically. Naming the composite is the only thing
  // that gets them out of that loop, which is the dead end #1651 is about.
  it('Table names the composite form in the warning when it cannot pair a bare id', async () => {
    await provider.import(makeTableInput({ knownPhysicalId: 'my_table', properties: {} }));

    const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('<databaseName>|<tableName>');
    expect(warned).toContain('my_table');
  });

  // An explicit override names a SPECIFIC resource to adopt. If the template's
  // TableInput.Name won that race, cdkd would silently adopt a different table
  // than the user asked for. Without disagreeing values this is unpinned:
  // swapping the precedence passes every other test in this file.
  it('Table prefers an explicit bare override over a DIFFERENT template TableInput.Name', async () => {
    mockGlueSend.mockResolvedValueOnce({ Table: { Name: 'overridden_table' } });

    const result = await provider.import(
      makeTableInput({
        knownPhysicalId: 'overridden_table',
        properties: { DatabaseName: 'mydb', TableInput: { Name: 'template_table' } },
      })
    );

    expect(result).toEqual({ physicalId: 'mydb|overridden_table', attributes: {} });
    expect(mockGlueSend.mock.calls[0][0].input).toEqual({
      DatabaseName: 'mydb',
      Name: 'overridden_table',
    });
  });

  // Same question on the composite branch: the composite's own database
  // segment must win over a template DatabaseName that disagrees.
  it("Table prefers a composite override's database segment over a DIFFERENT template DatabaseName", async () => {
    // Since #1672 the id is also probed as a bare table name in the template's
    // database (`template_db`, `overridden_db|my_table`); that one is absent.
    mockGlueSend
      .mockResolvedValueOnce({ Table: { Name: 'my_table' } })
      .mockRejectedValueOnce(new EntityNotFoundException({ message: 'nf', $metadata: {} }));

    const result = await provider.import(
      makeTableInput({
        knownPhysicalId: 'overridden_db|my_table',
        properties: { DatabaseName: 'template_db', TableInput: { Name: 'my_table' } },
      })
    );

    expect(result).toEqual({ physicalId: 'overridden_db|my_table', attributes: {} });
    expect(mockGlueSend.mock.calls[0][0].input).toEqual({
      DatabaseName: 'overridden_db',
      Name: 'my_table',
    });
  });

  it('Table returns null when a composite id names a table AWS does not have', async () => {
    mockGlueSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'Entity Not Found', $metadata: {} })
    );

    const result = await provider.import(
      makeTableInput({ knownPhysicalId: 'mydb|gone', properties: {} })
    );

    expect(result).toBeNull();
    // Without this the assertion is satisfied by "declined before calling AWS"
    // — which is exactly the pre-fix behavior — so it would not show that the
    // EntityNotFoundException arm ran at all.
    expect(mockGlueSend).toHaveBeenCalledTimes(1);
  });

  // A non-not-found error must NOT be treated as "absent": a throttle or an
  // authorization failure means the answer is UNKNOWN, and reporting a live
  // table as not-found would send the user chasing a resource that exists.
  it('Table rethrows a non-not-found error instead of reporting not-found', async () => {
    mockGlueSend.mockRejectedValueOnce(new Error('ThrottlingException: Rate exceeded'));

    await expect(
      provider.import(makeTableInput({ knownPhysicalId: 'mydb|my_table' }))
    ).rejects.toThrow('Rate exceeded');
    expect(mockGlueSend).toHaveBeenCalledTimes(1);
  });

  // AWS accepts a Glue table literally named `a|b` — verified by live probe in
  // us-east-1 on 2026-08-12; `glue:CreateTable` with `TableInput.Name: 'a|b'`
  // succeeded — and CloudFormation manages it. Since issue #1672 such a table
  // is adoptable: the recorded `<db>|a|b` is decoded by anchoring on the
  // recorded `DatabaseName` (the template's, which import records), by the
  // provider and by the `Ref` resolver alike. The condition is that pairing:
  // a `|` table name is accepted only with the template's own DatabaseName.
  describe('Table names containing the separator (issue #1672)', () => {
    function probes(): { DatabaseName: string; Name: string }[] {
      return mockGlueSend.mock.calls.map(
        ([c]) => (c as { input: { DatabaseName: string; Name: string } }).input
      );
    }

    it('adopts a template-named `a|b` table as <db>|a|b', async () => {
      mockGlueSend.mockResolvedValueOnce({ Table: { Name: 'a|b' } });

      const result = await provider.import(
        makeTableInput({ properties: { DatabaseName: 'mydb', TableInput: { Name: 'a|b' } } })
      );

      expect(result).toEqual({ physicalId: 'mydb|a|b', attributes: { DatabaseName: 'mydb' } });
      expect(probes()).toEqual([{ DatabaseName: 'mydb', Name: 'a|b' }]);
    });

    // The shape the old refusal warning INVITED (`<databaseName>|<tableName>`
    // for a table named `a|b`). Destructuring the first two segments would
    // read it as table `a` — a DIFFERENT table; the anchor reads `a|b`.
    it('reads a composite id anchored on the template DatabaseName as the whole remainder', async () => {
      mockGlueSend
        .mockResolvedValueOnce({ Table: { Name: 'a|b' } })
        .mockRejectedValueOnce(new EntityNotFoundException({ message: 'nf', $metadata: {} }));

      const result = await provider.import(
        makeTableInput({ knownPhysicalId: 'mydb|a|b', properties: { DatabaseName: 'mydb' } })
      );

      expect(result).toEqual({ physicalId: 'mydb|a|b', attributes: { DatabaseName: 'mydb' } });
      expect(probes()).toEqual([
        { DatabaseName: 'mydb', Name: 'a|b' },
        { DatabaseName: 'mydb', Name: 'mydb|a|b' },
      ]);
    });

    // CloudFormation's own id for a table named `a|b` is the bare `a|b` — the
    // CFn-migration (auto-mode) path. It reads as the established two-segment
    // composite AND as the bare name in the template's database; every reading
    // is probed, and the one that exists is adopted.
    it('adopts the bare CloudFormation reading when the two-segment composite is not found', async () => {
      mockGlueSend
        .mockRejectedValueOnce(new EntityNotFoundException({ message: 'nf', $metadata: {} }))
        .mockResolvedValueOnce({ Table: { Name: 'a|b' } });

      const result = await provider.import(
        makeTableInput({ knownPhysicalId: 'a|b', properties: { DatabaseName: 'mydb' } })
      );

      expect(result).toEqual({ physicalId: 'mydb|a|b', attributes: { DatabaseName: 'mydb' } });
      expect(probes()).toEqual([
        { DatabaseName: 'a', Name: 'b' },
        { DatabaseName: 'mydb', Name: 'a|b' },
      ]);
    });

    it('adopts the two-segment composite when the bare reading is not found', async () => {
      mockGlueSend
        .mockResolvedValueOnce({ Table: { Name: 'b' } })
        .mockRejectedValueOnce(new EntityNotFoundException({ message: 'nf', $metadata: {} }));

      const result = await provider.import(
        makeTableInput({ knownPhysicalId: 'a|b', properties: { DatabaseName: 'mydb' } })
      );

      expect(result).toEqual({ physicalId: 'a|b', attributes: {} });
      expect(probes()).toEqual([
        { DatabaseName: 'a', Name: 'b' },
        { DatabaseName: 'mydb', Name: 'a|b' },
      ]);
    });

    // Both readings exist: a table `b` in a database `a`, and a table `a|b` in
    // `mydb`. Adopting the first found could record the wrong one, which
    // `cdkd destroy` would then delete. The template's own TableInput.Name
    // settles which one this resource is. (A template name equal to the id
    // itself takes the bare-only arm instead; see the test below.)
    it('lets the template TableInput.Name choose when both readings exist', async () => {
      mockGlueSend
        .mockResolvedValueOnce({ Table: { Name: 'b' } })
        .mockResolvedValueOnce({ Table: { Name: 'a|b' } });

      const result = await provider.import(
        makeTableInput({
          knownPhysicalId: 'a|b',
          properties: { DatabaseName: 'mydb', TableInput: { Name: 'b' } },
        })
      );

      expect(result).toEqual({ physicalId: 'a|b', attributes: {} });
      expect(mockGlueSend).toHaveBeenCalledTimes(2);
    });

    // A reading already found does not license adopting it while another
    // reading's answer is UNKNOWN: that other table might exist too.
    it('rethrows a non-not-found error on a later reading even after one was found', async () => {
      mockGlueSend
        .mockResolvedValueOnce({ Table: { Name: 'b' } })
        .mockRejectedValueOnce(new Error('ThrottlingException: Rate exceeded'));

      const refused = provider.import(
        makeTableInput({ knownPhysicalId: 'a|b', properties: { DatabaseName: 'mydb' } })
      );
      await expect(refused).rejects.toThrow(
        /could not check whether table a\|b exists in database mydb \(the bare reading/
      );
      await expect(refused).rejects.toMatchObject({
        cause: { message: expect.stringContaining('Rate exceeded') },
      });
      expect(mockGlueSend).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['no template TableInput.Name', { DatabaseName: 'mydb' }],
      ['a template name neither reading carries', { DatabaseName: 'mydb', TableInput: { Name: 'other' } }],
    ])('refuses as ambiguous when both readings exist and %s', async (_n, properties) => {
      mockGlueSend
        .mockResolvedValueOnce({ Table: { Name: 'b' } })
        .mockResolvedValueOnce({ Table: { Name: 'a|b' } });

      const result = await provider.import(makeTableInput({ knownPhysicalId: 'a|b', properties }));

      expect(result).toBeNull();
      expect(mockGlueSend).toHaveBeenCalledTimes(2);
      const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('names more than one existing table');
    });

    // CloudFormation's bare id that IS the template's table name is read only
    // as that name. Split, `a|b` anchors on a template DatabaseName `a` as
    // table `b` — an unrelated table the template does not declare.
    it.each([
      ['anchoring', { DatabaseName: 'a', TableInput: { Name: 'a|b' } }, { DatabaseName: 'a', Name: 'a|b' }],
      ['two-segment', { DatabaseName: 'x', TableInput: { Name: 'a|b' } }, { DatabaseName: 'x', Name: 'a|b' }],
    ])('reads an id equal to the template table name only as that name (%s)', async (_n, properties, only) => {
      mockGlueSend.mockRejectedValueOnce(
        new EntityNotFoundException({ message: 'nf', $metadata: {} })
      );

      const result = await provider.import(makeTableInput({ knownPhysicalId: 'a|b', properties }));

      expect(result).toBeNull();
      expect(probes()).toEqual([only]);
    });

    // The bare-only arm pairs the name with the template's DatabaseName and
    // nothing else: without a usable one it does NOT fall back to splitting
    // the id (which is what it did before this arm existed).
    // The `unpairable` remedy (`--resource '<db>|a|b'`) would itself be refused
    // as unanchored, so this names the one that works: set DatabaseName.
    it('refuses an id equal to the template name as unplaceable when the template DatabaseName is unresolved', async () => {
      const result = await provider.import(
        makeTableInput({
          knownPhysicalId: 'a|b',
          properties: { DatabaseName: { Ref: 'Db' }, TableInput: { Name: 'a|b' } },
        })
      );

      expect(result).toBeNull();
      expect(mockGlueSend).not.toHaveBeenCalled();
      const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain("the '|' in a name cannot be placed");
      expect(warned).toContain("Set the template's DatabaseName");
      expect(warned).not.toContain('Pass the composite form');
    });

    it('adopts an id equal to the template name as <templateDb>|<name>', async () => {
      mockGlueSend.mockResolvedValueOnce({ Table: { Name: 'a|b' } });

      const result = await provider.import(
        makeTableInput({
          knownPhysicalId: 'a|b',
          properties: { DatabaseName: 'mydb', TableInput: { Name: 'a|b' } },
        })
      );

      expect(result).toEqual({ physicalId: 'mydb|a|b', attributes: { DatabaseName: 'mydb' } });
      expect(probes()).toEqual([{ DatabaseName: 'mydb', Name: 'a|b' }]);
    });

    // An anchored id is ALSO read as a bare table name in the template's
    // database (#3891 security review): CloudFormation's id for a table named
    // `mydb|a` is `mydb|a`, and the anchored reading alone would adopt an
    // unrelated table `a` that `cdkd destroy` then deletes. Never the
    // two-segment composite as well: the anchor already says where the
    // database ends.
    describe('an id the template DatabaseName anchors', () => {
      const ID = 'mydb|a';
      const PROPS = { DatabaseName: 'mydb' };

      it('probes the anchored and the bare reading, and returns null when neither exists', async () => {
        mockGlueSend.mockRejectedValueOnce(new EntityNotFoundException({ message: 'nf', $metadata: {} })).mockRejectedValueOnce(new EntityNotFoundException({ message: 'nf', $metadata: {} }));

        const result = await provider.import(
          makeTableInput({ knownPhysicalId: ID, properties: PROPS })
        );

        expect(result).toBeNull();
        expect(probes()).toEqual([
          { DatabaseName: 'mydb', Name: 'a' },
          { DatabaseName: 'mydb', Name: 'mydb|a' },
        ]);
      });

      it('adopts the bare table when only it exists', async () => {
        mockGlueSend
          .mockRejectedValueOnce(new EntityNotFoundException({ message: 'nf', $metadata: {} }))
          .mockResolvedValueOnce({ Table: { Name: 'mydb|a' } });

        const result = await provider.import(
          makeTableInput({ knownPhysicalId: ID, properties: PROPS })
        );

        expect(result).toEqual({ physicalId: 'mydb|mydb|a', attributes: { DatabaseName: 'mydb' } });
      });

      it('adopts the anchored table when only it exists', async () => {
        mockGlueSend
          .mockResolvedValueOnce({ Table: { Name: 'a' } })
          .mockRejectedValueOnce(new EntityNotFoundException({ message: 'nf', $metadata: {} }));

        const result = await provider.import(
          makeTableInput({ knownPhysicalId: ID, properties: PROPS })
        );

        expect(result).toEqual({ physicalId: 'mydb|a', attributes: {} });
      });

      it('refuses when both exist and the template names neither', async () => {
        mockGlueSend
          .mockResolvedValueOnce({ Table: { Name: 'a' } })
          .mockResolvedValueOnce({ Table: { Name: 'mydb|a' } });

        const result = await provider.import(
          makeTableInput({ knownPhysicalId: ID, properties: PROPS })
        );

        expect(result).toBeNull();
        const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned).toContain('names more than one existing table');
        expect(warned).toContain("'a' in mydb, 'mydb|a' in mydb");
        expect(warned).toContain("Set the template's TableInput.Name");
        expect(warned).toContain("--resource 'MyTable=<databaseName>|<databaseName>|<rest of the name>'");
        // The #1651 shape: never a remedy that re-spells the same ambiguous id.
        expect(warned).not.toContain('with the database spelled out');
      });

      // Each remedy the refusal names, fed back in with BOTH tables still
      // present, must adopt exactly one — not refuse again.
      it.each([
        ['TableInput.Name set to the anchored table', ID, { ...PROPS, TableInput: { Name: 'a' } }, 'mydb|a'],
        ['TableInput.Name set to the bare table', ID, { ...PROPS, TableInput: { Name: 'mydb|a' } }, 'mydb|mydb|a'],
        ['the id with the database doubled', 'mydb|mydb|a', PROPS, 'mydb|mydb|a'],
      ])('adopts one table after the suggested remedy: %s', async (_n, id, properties, expected) => {
        // Both tables exist; a third name is absent.
        mockGlueSend.mockImplementation(async (command: { input: { Name: string } }) => {
          if (command.input.Name === 'a' || command.input.Name === 'mydb|a') {
            return { Table: { Name: command.input.Name } };
          }
          throw new EntityNotFoundException({ message: 'nf', $metadata: {} });
        });

        const result = await provider.import(makeTableInput({ knownPhysicalId: id, properties }));

        expect(result?.physicalId).toBe(expected);
        // An id with more than one `|` carries the anchor attribute (#3892).
        expect(result?.attributes).toEqual(
          expected.split('|').length > 2 ? { DatabaseName: 'mydb' } : {}
        );
        mockGlueSend.mockReset();
      });

      // The label is the one the refusal prints; each reading must carry its own.
      it('names the anchored reading when its probe cannot answer', async () => {
        mockGlueSend.mockRejectedValueOnce(new Error('ThrottlingException: Rate exceeded'));

        await expect(
          provider.import(makeTableInput({ knownPhysicalId: ID, properties: PROPS }))
        ).rejects.toThrow(/could not check whether table a exists in database mydb \(the anchored reading/);
      });

      // Glue caps a table name at 255 characters, so an id longer than that
      // cannot be a bare table name: probing it could only fail an import that
      // used to work (#3891 code review).
      it('skips the bare reading for an id longer than a Glue table name can be', async () => {
        const table = 't'.repeat(251);
        mockGlueSend.mockResolvedValueOnce({ Table: { Name: table } });

        const result = await provider.import(
          makeTableInput({ knownPhysicalId: `mydb|${table}`, properties: PROPS })
        );

        expect(`mydb|${table}`).toHaveLength(256);
        expect(result).toEqual({ physicalId: `mydb|${table}`, attributes: {} });
        expect(probes()).toEqual([{ DatabaseName: 'mydb', Name: table }]);
      });

      it('keeps the bare reading for an id of exactly the limit', async () => {
        const table = 't'.repeat(250);
        mockGlueSend.mockResolvedValueOnce({ Table: { Name: table } }).mockRejectedValueOnce(new EntityNotFoundException({ message: 'nf', $metadata: {} }));

        await provider.import(makeTableInput({ knownPhysicalId: `mydb|${table}`, properties: PROPS }));

        expect(`mydb|${table}`).toHaveLength(255);
        expect(probes()).toHaveLength(2);
      });

      // A lone reading's error is left as AWS raised it.
      it('rethrows a lone reading error unchanged', async () => {
        mockGlueSend.mockRejectedValueOnce(new Error('ThrottlingException: Rate exceeded'));

        await expect(
          provider.import(makeTableInput({ knownPhysicalId: 'mydb|a', properties: {} }))
        ).rejects.toThrow(/^ThrottlingException: Rate exceeded$/);
      });
    });

    // A throttle or an authorization failure is an UNKNOWN answer. Moving on to
    // the next reading could adopt a different table than the one that exists.
    it('stops at a non-not-found error, naming the reading, instead of trying the next one', async () => {
      mockGlueSend.mockRejectedValueOnce(new Error('ThrottlingException: Rate exceeded'));

      const refused = provider.import(
        makeTableInput({ knownPhysicalId: 'a|b', properties: { DatabaseName: 'mydb' } })
      );
      await expect(refused).rejects.toThrow(
        /could not check whether table b exists in database a \(the composite reading/
      );
      await expect(refused).rejects.toThrow(/Grant glue:GetTable on that table and database/);
      // A re-spelled id would be read the same ways again, so none is offered.
      await expect(refused).rejects.not.toThrow(/--resource/);
      expect(mockGlueSend).toHaveBeenCalledTimes(1);
    });

    // The error CLASS is named; AWS's message (which can quote the account and
    // role) is not, and rides only as `cause`.
    it('names the probe error by class, never by its message', async () => {
      const denied = Object.assign(
        new Error('User: arn:aws:iam::123456789012:role/x is not authorized'),
        { name: 'AccessDeniedException' }
      );
      mockGlueSend.mockRejectedValueOnce(denied);

      const refused = provider.import(
        makeTableInput({ knownPhysicalId: 'a|b', properties: { DatabaseName: 'mydb' } })
      );
      await expect(refused).rejects.toThrow(/AccessDeniedException/);
      await expect(refused).rejects.not.toThrow(/123456789012/);
      await expect(refused).rejects.toMatchObject({ cause: denied });
    });

    // CatalogId goes on EVERY reading's probe, not just the first.
    it('sends the template CatalogId on every reading it probes', async () => {
      mockGlueSend.mockRejectedValueOnce(new EntityNotFoundException({ message: 'nf', $metadata: {} })).mockRejectedValueOnce(new EntityNotFoundException({ message: 'nf', $metadata: {} }));

      await provider.import(
        makeTableInput({
          knownPhysicalId: 'a|b',
          properties: { DatabaseName: 'mydb', CatalogId: '123456789012' },
        })
      );

      expect(probes()).toEqual([
        { DatabaseName: 'a', Name: 'b', CatalogId: '123456789012' },
        { DatabaseName: 'mydb', Name: 'a|b', CatalogId: '123456789012' },
      ]);
    });

    it('returns null when no reading exists', async () => {
      const nf = () => new EntityNotFoundException({ message: 'nf', $metadata: {} });
      mockGlueSend.mockRejectedValueOnce(nf()).mockRejectedValueOnce(nf());

      const result = await provider.import(
        makeTableInput({ knownPhysicalId: 'a|b', properties: { DatabaseName: 'mydb' } })
      );

      expect(result).toBeNull();
      expect(mockGlueSend).toHaveBeenCalledTimes(2);
    });

    // Three segments the template's DatabaseName does not anchor: the only
    // reading kept is the bare name in the template's database. The
    // first-`|` composite (`other`, `a|b`) is NOT probed — it would record a
    // `|` table name beside a DatabaseName that does not anchor it.
    it('probes only the bare reading for an unanchored id of three segments', async () => {
      mockGlueSend.mockRejectedValueOnce(
        new EntityNotFoundException({ message: 'nf', $metadata: {} })
      );

      const result = await provider.import(
        makeTableInput({ knownPhysicalId: 'other|a|b', properties: { DatabaseName: 'mydb' } })
      );

      expect(result).toBeNull();
      expect(probes()).toEqual([{ DatabaseName: 'mydb', Name: 'other|a|b' }]);
    });

    // Nothing anchors or pairs it: `x|a|b` could be table `a|b` in `x` or
    // table `b` in a database `x|a`.
    it('refuses an unanchored id of three segments when the template has no DatabaseName', async () => {
      const result = await provider.import(
        makeTableInput({ knownPhysicalId: 'x|a|b', properties: {} })
      );

      expect(result).toBeNull();
      expect(mockGlueSend).not.toHaveBeenCalled();
      const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain("the '|' in a name cannot be placed");
      expect(warned).toContain('separator');
    });

    // An unresolved template DatabaseName is no anchor and no pairing: the
    // unanchored three-segment id is refused as unplaceable, not probed.
    it('refuses a three-segment id when the template DatabaseName is an unresolved intrinsic', async () => {
      const result = await provider.import(
        makeTableInput({
          knownPhysicalId: 'mydb|a|b',
          properties: { DatabaseName: { Ref: 'Db' }, TableInput: { Name: 'a|b' } },
        })
      );

      expect(result).toBeNull();
      expect(mockGlueSend).not.toHaveBeenCalled();
      const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain("the '|' in a name cannot be placed");
    });

    // Issue #3892: Glue accepts `|` in a DATABASE name too (live probe through
    // the glue-update-hardening fixture). Such a database is only ever the
    // template's own DatabaseName — the anchor later readers use — so the
    // readings below all pair it with that value, and the record carries it
    // as an attribute too.
    describe('a template database name containing the separator (issue #3892)', () => {
      const PROPS = { DatabaseName: 'my|db' };

      it('adopts a template-named table in it as <db>|<table>', async () => {
        mockGlueSend.mockResolvedValueOnce({ Table: { Name: 'orders' } });

        const result = await provider.import(
          makeTableInput({ properties: { ...PROPS, TableInput: { Name: 'orders' } } })
        );

        expect(result).toEqual({
          physicalId: 'my|db|orders',
          attributes: { DatabaseName: 'my|db' },
        });
        expect(probes()).toEqual([{ DatabaseName: 'my|db', Name: 'orders' }]);
      });

      it('anchors a composite id on it, beside the bare reading', async () => {
        mockGlueSend
          .mockResolvedValueOnce({ Table: { Name: 'orders' } })
          .mockRejectedValueOnce(new EntityNotFoundException({ message: 'nf', $metadata: {} }));

        const result = await provider.import(
          makeTableInput({ knownPhysicalId: 'my|db|orders', properties: PROPS })
        );

        expect(result).toEqual({
          physicalId: 'my|db|orders',
          attributes: { DatabaseName: 'my|db' },
        });
        expect(probes()).toEqual([
          { DatabaseName: 'my|db', Name: 'orders' },
          { DatabaseName: 'my|db', Name: 'my|db|orders' },
        ]);
      });

      // An id the database does not anchor is read only as a bare name in it:
      // splitting `x|a|b` would guess where some OTHER database ends.
      it('reads an id it does not anchor only as a bare name in it', async () => {
        mockGlueSend.mockRejectedValueOnce(new EntityNotFoundException({ message: 'nf', $metadata: {} }));

        const result = await provider.import(
          makeTableInput({ knownPhysicalId: 'x|a|b', properties: PROPS })
        );

        expect(result).toBeNull();
        expect(probes()).toEqual([{ DatabaseName: 'my|db', Name: 'x|a|b' }]);
      });

      // The adopted record must address the probed table at every later
      // reader, including when the recorded DatabaseName is an unresolved
      // intrinsic: the attribute is what the Ref resolver then anchors on.
      it('records an anchor the Ref reads even when the recorded property is unresolved', async () => {
        mockGlueSend.mockResolvedValueOnce({ Table: { Name: 'orders' } });

        const result = await provider.import(
          makeTableInput({ properties: { ...PROPS, TableInput: { Name: 'orders' } } })
        );

        expect(
          cfnRefValueFromPhysicalId(
            'AWS::Glue::Table',
            result!.physicalId,
            refStateLookupFromResource({
              properties: { DatabaseName: { Ref: 'Db' } },
              attributes: result!.attributes,
            })
          )
        ).toBe('orders');
      });
    });

    // An ordinary two-segment id needs no anchor, so it records no attribute.
    it('records no anchor attribute for an id with a single separator', async () => {
      mockGlueSend.mockResolvedValueOnce({ Table: { Name: 'orders' } });

      const result = await provider.import(
        makeTableInput({ properties: { DatabaseName: 'mydb', TableInput: { Name: 'orders' } } })
      );

      expect(result).toEqual({ physicalId: 'mydb|orders', attributes: {} });
    });

    // `db|` is a composite missing its table, not a table named `db|`: the bare
    // reading must not swallow it and turn the guidance into a silent not-found.
    it.each(['mydb|', '|mydb'])('keeps an id with an empty segment unpairable (%s)', async (id) => {
      const result = await provider.import(
        makeTableInput({ knownPhysicalId: id, properties: { DatabaseName: 'mydb' } })
      );

      expect(result).toBeNull();
      expect(mockGlueSend).not.toHaveBeenCalled();
      const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('cannot resolve a database for physical id');
    });

    // The whole point of the pairing condition: the adopted record — its id AND
    // the template bag import records beside it — must address the probed table
    // at every later reader. Driven through the REAL decode (`delete`) and the
    // REAL `Ref` extraction rather than a restated split.
    it.each([
      ['template name', { properties: { DatabaseName: 'mydb', TableInput: { Name: 'a|b' } } }],
      ['anchored composite', { knownPhysicalId: 'mydb|a|b', properties: { DatabaseName: 'mydb' } }],
    ])('records an id the delete and the Ref resolve back to the probed table (%s)', async (_n, over) => {
      mockGlueSend.mockResolvedValueOnce({ Table: { Name: 'a|b' } }).mockRejectedValueOnce(new EntityNotFoundException({ message: 'nf', $metadata: {} }));
      const input = makeTableInput(over);
      const result = await provider.import(input);
      expect(result).not.toBeNull();
      const probed = probes()[0]!;

      mockGlueSend.mockReset();
      mockGlueSend.mockResolvedValue({});
      await provider.delete('MyTable', result!.physicalId, 'AWS::Glue::Table', input.properties);
      expect(probes()).toEqual([{ DatabaseName: probed.DatabaseName, Name: probed.Name }]);

      expect(
        cfnRefValueFromPhysicalId(
          'AWS::Glue::Table',
          result!.physicalId,
          refStateLookupFromResource({ properties: input.properties })
        )
      ).toBe(probed.Name);
    });
  });

  // Round-trip fence: whatever id import records must decode back to the pair
  // that was probed, or the adopted resource is unusable by every other method
  // on the provider. Asserting the recorded id has exactly two segments is the
  // property that #1658 shows matters, independent of which branch produced it.
  it.each([
    ['bare CFn id', { knownPhysicalId: 'my_table', properties: { DatabaseName: 'mydb' } }],
    ['composite id', { knownPhysicalId: 'mydb|my_table', properties: {} }],
    [
      'template only',
      { properties: { DatabaseName: 'mydb', TableInput: { Name: 'my_table' } } },
    ],
  ])('Table records a 2-segment id that decodes back to the probed pair (%s)', async (_n, over) => {
    mockGlueSend.mockResolvedValueOnce({ Table: { Name: 'my_table' } });

    const result = await provider.import(makeTableInput(over));

    // Guard the destructures below: without these, a regression that REFUSES
    // the branch fails with `Cannot read properties of undefined` instead of
    // naming what went wrong.
    expect(mockGlueSend).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();

    const probed = mockGlueSend.mock.calls[0][0].input as {
      DatabaseName: string;
      Name: string;
    };
    const recorded = result!.physicalId;
    expect(recorded.split('|')).toHaveLength(2);
    // The exact decode every consumer performs.
    const [decodedDb, decodedName] = recorded.split('|');
    expect(decodedDb).toBe(probed.DatabaseName);
    expect(decodedName).toBe(probed.Name);
  });

  // `--resource` rejects an empty value, but `--resource-mapping` /
  // `--resource-mapping-inline` go through `parseMappingJson`, which does not.
  // An empty name must stay not-found rather than reaching GetTable, whose
  // InvalidInputException is NOT EntityNotFoundException and would abort the
  // entire import run.
  it('Table treats an empty-string override as not-found without calling AWS', async () => {
    const result = await provider.import(
      makeTableInput({
        knownPhysicalId: '',
        // A template name is present ON PURPOSE. Without it this test cannot
        // tell "refused as empty" from "fell through to the template branch and
        // found nothing" — and the fall-through is the dangerous reading, since
        // it would adopt a DIFFERENT table than the (empty) id named.
        properties: { DatabaseName: 'mydb', TableInput: { Name: 'template_table' } },
      })
    );

    expect(result).toBeNull();
    expect(mockGlueSend).not.toHaveBeenCalled();
  });

  // Issue #1651, second defect. `@aws-cdk/aws-glue-alpha` sets
  // `catalogId: Stack.of(this).account`, which renders as
  // `{"Ref": "AWS::AccountId"}` for an environment-agnostic stack. A pseudo
  // parameter is never in the overrides map, so `substituteOverrideRefs`
  // leaves the intrinsic in place and the old `as string` cast forwarded the
  // OBJECT to GetTable as if it were a catalog id. Dropping it matches the
  // API default (the caller's own account) — which is what the intrinsic
  // would have resolved to anyway.
  it('Table does not forward an unresolved CatalogId intrinsic to GetTable', async () => {
    mockGlueSend.mockResolvedValueOnce({ Table: { Name: 'my_table' } });

    await provider.import(
      makeTableInput({
        knownPhysicalId: 'mydb|my_table',
        properties: { CatalogId: { Ref: 'AWS::AccountId' } },
      })
    );

    const input = mockGlueSend.mock.calls[0][0].input as Record<string, unknown>;
    expect(input).not.toHaveProperty('CatalogId');
    expect(input).toEqual({ DatabaseName: 'mydb', Name: 'my_table' });
  });

  it('Table still forwards a literal CatalogId', async () => {
    mockGlueSend.mockResolvedValueOnce({ Table: { Name: 'my_table' } });

    await provider.import(
      makeTableInput({
        knownPhysicalId: 'mydb|my_table',
        properties: { CatalogId: '123456789012' },
      })
    );

    expect(mockGlueSend.mock.calls[0][0].input).toEqual({
      DatabaseName: 'mydb',
      Name: 'my_table',
      CatalogId: '123456789012',
    });
  });

  it('Database does not forward an unresolved CatalogId intrinsic to GetDatabase', async () => {
    mockGlueSend.mockResolvedValueOnce({ Database: { Name: 'mydb' } });

    await provider.import(
      makeDatabaseInput({
        knownPhysicalId: 'mydb',
        properties: { CatalogId: { Ref: 'AWS::AccountId' } },
      })
    );

    const input = mockGlueSend.mock.calls[0][0].input as Record<string, unknown>;
    expect(input).not.toHaveProperty('CatalogId');
    expect(input).toEqual({ Name: 'mydb' });
  });

  it('Database ignores an unresolved DatabaseInput.Name intrinsic instead of probing with it', async () => {
    const result = await provider.import(
      makeDatabaseInput({
        properties: { DatabaseInput: { Name: { Ref: 'SomeUnresolvedRef' } } },
      })
    );

    expect(result).toBeNull();
    expect(mockGlueSend).not.toHaveBeenCalled();
  });

  it('does not let a comma in a database name split the ambiguity list (go-to-k/cdkd#4273)', async () => {
    mockGlueSend
      .mockResolvedValueOnce({ Table: { Name: 'b' } })
      .mockResolvedValueOnce({ Table: { Name: 'a|b' } });
    mockLoggerWarn.mockClear();
    await provider.import(makeTableInput({ knownPhysicalId: 'a|b', properties: { DatabaseName: 'x,y' } }));
    const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain("'a|b' in (not shown: it is not a plain identifier)");
    expect(warned).not.toContain('in x,y');
  });

  it('still shows a separator-bearing supplied id inside its quotes (go-to-k/cdkd#4273)', async () => {
    // `|` is literal inside cdkd's `'...'`, and an empty-segment composite is
    // the case whose message exists to show which half is missing.
    for (const id of ['mydb|', '|mydb']) {
      mockLoggerWarn.mockClear();
      await provider.import(makeTableInput({ knownPhysicalId: id, properties: { DatabaseName: 'mydb' } }));
      const warned = mockLoggerWarn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain(`cannot resolve a database for physical id '${id}'.`);
    }
  });

  it('shows no payload logical id or supplied id beside the --resource remedies (go-to-k/cdkd#4273)', async () => {
    // The unpairable and ambiguous Table warnings end in a `--resource`
    // remedy. Pre-fix they printed the logical id raw at the head and inside
    // the fragment's own `'...'`, and the supplied id inside cdkd's `'...'`,
    // so a `'` closed the quote and the rest of a pasted line ran.
    const warned = async (input: Record<string, unknown>, found: number): Promise<string> => {
      mockLoggerWarn.mockClear();
      if (found === 2) {
        mockGlueSend
          .mockResolvedValueOnce({ Table: { Name: 'b' } })
          .mockResolvedValueOnce({ Table: { Name: 'a|b' } });
      }
      await expect(provider.import(makeTableInput(input))).resolves.toBeNull();
      const lines = mockLoggerWarn.mock.calls.map((c) => String(c[0]));
      expect(lines, JSON.stringify(input)).toHaveLength(1);
      return lines[0]!;
    };
    for (const { value } of PASTE_PAYLOADS) {
      const unpairedById = await warned({ logicalId: value, knownPhysicalId: 'orders' }, 0);
      const unpairedBySupplied = await warned({ knownPhysicalId: value }, 0);
      const ambiguousById = await warned(
        { logicalId: value, knownPhysicalId: 'a|b', properties: { DatabaseName: 'mydb' } },
        2
      );
      expect(unpairedById, value).toContain(
        "AWS::Glue::Table a logical id that is not a plain identifier: cannot resolve a database for physical id 'orders'."
      );
      expect(unpairedById, value).toContain("--resource '<logicalId>=<databaseName>|<tableName>'");
      expect(unpairedBySupplied, value).toContain(
        'for physical id (not shown: it is not a plain identifier).'
      );
      expect(ambiguousById, value).toContain(
        'AWS::Glue::Table a logical id that is not a plain identifier: cannot be imported'
      );
      expect(ambiguousById, value).toContain(
        "--resource '<logicalId>=<databaseName>|<databaseName>|<rest of the name>'"
      );
      // The ambiguous warning lists the readings it found; a payload in the
      // supplied id reaches that list as a table name, a payload DatabaseName
      // as a database name.
      const ambiguousByTable = await warned(
        { knownPhysicalId: `a|${value}`, properties: { DatabaseName: 'mydb' } },
        2
      );
      const ambiguousByDatabase = await warned(
        { knownPhysicalId: 'a|b', properties: { DatabaseName: value } },
        2
      );
      for (const message of [ambiguousByTable, ambiguousByDatabase]) {
        expect(message, value).toContain('names more than one existing table (');
        expect(message, value).toContain('(not shown: it is not a plain identifier)');
      }
      withPasteDir((dir) => {
        for (const message of [
          unpairedById,
          unpairedBySupplied,
          ambiguousById,
          ambiguousByTable,
          ambiguousByDatabase,
        ]) {
          expectNoCommandBesideDisplay(message, value);
          expect(spansThatRun(message, dir), `${value}: ${message}`).toEqual([]);
        }
      });
    }
  }, 120_000);
});

describe('GlueProvider update', () => {
  let provider: GlueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueProvider();
  });

  it('updates Database via UpdateDatabaseCommand with full DatabaseInput', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    const properties = {
      DatabaseInput: {
        Name: 'mydb',
        Description: 'updated',
        Parameters: { foo: 'bar' },
      },
    };

    await provider.update('MyDb', 'mydb', 'AWS::Glue::Database', properties, properties);

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof UpdateDatabaseCommand);
    expect(call).toBeDefined();
    const input = call![0].input as { Name: string; DatabaseInput: { Description?: string } };
    expect(input.Name).toBe('mydb');
    expect(input.DatabaseInput.Description).toBe('updated');
  });
});

// Issue #3724: a nested-Name change diffs as an in-place UPDATE (only the
// top-level name is createOnly), and `UpdateTable` addresses the table BY
// `TableInput.Name` — so the update wrote to whichever table held the NEW
// name while state kept the old id. The refusal must fire before ANY Glue
// call, including the pre-read whose `VersionId` would ride the write.
describe('Glue nested-Name rename refusal (issue #3724)', () => {
  let provider: GlueProvider;
  let connectionProvider: GlueConnectionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGlueSend.mockReset();
    mockGlueSend.mockImplementation((command: unknown) => {
      if (command instanceof GetTableCommand) {
        return Promise.resolve({ Table: { Name: 'old_t', VersionId: '7' } });
      }
      if (command instanceof GetDatabaseCommand) {
        return Promise.resolve({ Database: { Name: 'olddb' } });
      }
      return Promise.resolve({});
    });
    provider = new GlueProvider();
    connectionProvider = new GlueConnectionProvider();
  });

  const tableProps = (name: string) => ({
    DatabaseName: 'mydb',
    TableInput: { Name: name, TableType: 'EXTERNAL_TABLE' },
  });

  it('refuses a TableInput.Name rename with no Glue call, naming both tables and the remedy', async () => {
    const error = await provider
      .update('MyTable', 'mydb|old_t', 'AWS::Glue::Table', tableProps('new_t'), tableProps('old_t'))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    const message = (error as Error).message;
    expect(message).toContain("TableInput.Name changed from 'old_t' to 'new_t'");
    expect(message).toContain("write to the table named 'new_t' in database 'mydb'");
    expect(message).toContain('--replace --force-stateful-recreation');
    expect(message).toContain('UpdateReplacePolicy: Retain');
    expect(message).toContain("check that table before re-deploying");
    expect(mockGlueSend).not.toHaveBeenCalled();
  });

  it('updates the recorded table when TableInput.Name is unchanged', async () => {
    await provider.update(
      'MyTable',
      'mydb|old_t',
      'AWS::Glue::Table',
      tableProps('old_t'),
      tableProps('old_t')
    );

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof UpdateTableCommand);
    expect(call![0].input).toMatchObject({
      DatabaseName: 'mydb',
      TableInput: { Name: 'old_t' },
      VersionId: '7',
    });
  });

  it('lets a case-only TableInput.Name difference through (Glue folds table names)', async () => {
    await provider.update(
      'MyTable',
      'mydb|old_t',
      'AWS::Glue::Table',
      tableProps('OLD_T'),
      tableProps('old_t')
    );

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof UpdateTableCommand);
    expect(call![0].input).toMatchObject({ DatabaseName: 'mydb', TableInput: { Name: 'OLD_T' } });
  });

  it('folds ASCII only: a non-ASCII case difference is refused', async () => {
    await expect(
      provider.update(
        'MyTable',
        'mydb|caf\u00e9',
        'AWS::Glue::Table',
        tableProps('CAF\u00c9'),
        tableProps('caf\u00e9')
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockGlueSend).not.toHaveBeenCalled();
  });

  it('refuses a non-string, non-number TableInput.Name with no Glue call', async () => {
    const error = await provider
      .update(
        'MyTable',
        'mydb|old_t',
        'AWS::Glue::Table',
        { DatabaseName: 'mydb', TableInput: { Name: { 'Fn::Join': ['', ['s3cr3t-leaf']] } } },
        tableProps('old_t')
      )
      .catch((e: unknown) => e);
    // Untyped on purpose: `--replace` reacts to ResourceUpdateNotSupportedError.
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    const message = (error as Error).message;
    expect(message).toContain('TableInput.Name is not a resolved name (an object with keys [Fn::Join])');
    expect(message).not.toContain('--replace');
    // Shape only: a leaf value (possibly a resolved secret) never reaches the text.
    expect(message).not.toContain('s3cr3t-leaf');
    expect(mockGlueSend).not.toHaveBeenCalled();
  });

  it.each([
    [['a'], 'an array'],
    [{}, 'an empty object'],
    [true, 'a boolean'],
  ])('describes an unresolved %j name by shape (%s)', async (name, shape) => {
    await expect(
      provider.update(
        'MyTable',
        'mydb|old_t',
        'AWS::Glue::Table',
        { DatabaseName: 'mydb', TableInput: { Name: name } },
        tableProps('old_t')
      )
    ).rejects.toThrow(`TableInput.Name is not a resolved name (${shape})`);
    expect(mockGlueSend).not.toHaveBeenCalled();
  });

  it('compares a numeric TableInput.Name by its string form', async () => {
    await expect(
      provider.update(
        'MyTable',
        'mydb|123',
        'AWS::Glue::Table',
        { DatabaseName: 'mydb', TableInput: { Name: 124 } },
        tableProps('123')
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    // Exponent-form numbers are refused: JS and Java spell them differently.
    await expect(
      provider.update(
        'MyTable',
        'mydb|1e-7',
        'AWS::Glue::Table',
        { DatabaseName: 'mydb', TableInput: { Name: 1e-7 } },
        tableProps('1e-7')
      )
    ).rejects.toThrow('is not a resolved name (a number that is not a safe integer)');
    expect(mockGlueSend).not.toHaveBeenCalled();

    await provider.update(
      'MyTable',
      'mydb|123',
      'AWS::Glue::Table',
      { DatabaseName: 'mydb', TableInput: { Name: 123 } },
      tableProps('123')
    );
    expect(mockGlueSend.mock.calls.some((c) => c[0] instanceof UpdateTableCommand)).toBe(true);
  });

  it('updates the recorded entity when the nested Name is ABSENT (all three types)', async () => {
    await provider.update(
      'MyTable',
      'mydb|old_t',
      'AWS::Glue::Table',
      { DatabaseName: 'mydb', TableInput: { TableType: 'EXTERNAL_TABLE' } },
      tableProps('old_t')
    );
    await provider.update(
      'MyDb',
      'olddb',
      'AWS::Glue::Database',
      { DatabaseInput: { Description: 'd' } },
      { DatabaseInput: { Name: 'olddb' } }
    );
    await connectionProvider.update(
      'MyConn',
      'recorded_conn',
      'AWS::Glue::Connection',
      { ConnectionInput: { ConnectionType: 'JDBC', ConnectionProperties: {} } },
      { ConnectionInput: { ConnectionType: 'JDBC', ConnectionProperties: {} } }
    );

    const table = mockGlueSend.mock.calls.find((c) => c[0] instanceof UpdateTableCommand);
    expect(table![0].input).toMatchObject({ TableInput: { Name: 'old_t' } });
    const db = mockGlueSend.mock.calls.find((c) => c[0] instanceof UpdateDatabaseCommand);
    expect(db![0].input).toMatchObject({ Name: 'olddb', DatabaseInput: { Name: 'olddb' } });
    const conn = mockGlueSend.mock.calls.find((c) => c[0] instanceof UpdateConnectionCommand);
    expect(conn![0].input).toMatchObject({
      Name: 'recorded_conn',
      ConnectionInput: { Name: 'recorded_conn' },
    });
  });

  it('refuses a DatabaseInput.Name rename with no Glue call', async () => {
    const error = await provider
      .update(
        'MyDb',
        'olddb',
        'AWS::Glue::Database',
        { DatabaseInput: { Name: 'newdb' } },
        { DatabaseInput: { Name: 'olddb' } }
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    const message = (error as Error).message;
    expect(message).toContain("DatabaseInput.Name changed from 'olddb' to 'newdb'");
    expect(message).toContain("UpdateDatabase would address 'olddb'");
    expect(message).toContain('--replace --force-stateful-recreation');
    expect(mockGlueSend).not.toHaveBeenCalled();
  });

  it('lets a case-only DatabaseInput.Name difference through (Glue folds database names)', async () => {
    await provider.update(
      'MyDb',
      'olddb',
      'AWS::Glue::Database',
      { DatabaseInput: { Name: 'OldDb' } },
      { DatabaseInput: { Name: 'olddb' } }
    );

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof UpdateDatabaseCommand);
    expect((call![0].input as { Name: string }).Name).toBe('olddb');
  });

  const connectionProps = (name: string) => ({
    ConnectionInput: { Name: name, ConnectionType: 'JDBC', ConnectionProperties: {} },
  });

  it('refuses a ConnectionInput.Name rename with no Glue call, naming --replace alone', async () => {
    const error = await connectionProvider
      .update(
        'MyConn',
        'oldconn',
        'AWS::Glue::Connection',
        connectionProps('newconn'),
        connectionProps('oldconn')
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    const message = (error as Error).message;
    expect(message).toContain("ConnectionInput.Name changed from 'oldconn' to 'newconn'");
    expect(message).toContain("UpdateConnection would address 'oldconn'");
    expect(message).toContain('with --replace, which');
    expect(message).not.toContain('--force-stateful-recreation');
    expect(mockGlueSend).not.toHaveBeenCalled();
  });

  it('refuses a case-only ConnectionInput.Name difference (no documented folding)', async () => {
    await expect(
      connectionProvider.update(
        'MyConn',
        'oldconn',
        'AWS::Glue::Connection',
        connectionProps('OldConn'),
        connectionProps('oldconn')
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockGlueSend).not.toHaveBeenCalled();
  });

  it('updates the recorded connection when ConnectionInput.Name is unchanged', async () => {
    await connectionProvider.update(
      'MyConn',
      'oldconn',
      'AWS::Glue::Connection',
      connectionProps('oldconn'),
      connectionProps('oldconn')
    );

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof UpdateConnectionCommand);
    expect(call![0].input).toMatchObject({
      Name: 'oldconn',
      ConnectionInput: { Name: 'oldconn' },
    });
  });
});

// Issue #3756: every Glue update sends the DESIRED CatalogId while the state
// record names only the entity, so a changed catalog addressed the same-named
// entity in ANOTHER catalog. The refusal must fire before any Glue call, and
// must treat absent / the account-id pseudo parameter / the caller's own
// account id as ONE catalog (asking STS only in that mixed case).
describe('Glue CatalogId move refusal (issue #3756)', () => {
  let provider: GlueProvider;
  let connectionProvider: GlueConnectionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGlueSend.mockReset();
    mockStsSend.mockReset();
    mockStsSend.mockResolvedValue({ Account: '111111111111' });
    mockGlueSend.mockImplementation((command: unknown) => {
      if (command instanceof GetTableCommand) {
        return Promise.resolve({ Table: { Name: 't', VersionId: '1' } });
      }
      if (command instanceof GetDatabaseCommand) {
        return Promise.resolve({ Database: { Name: 'mydb' } });
      }
      return Promise.resolve({});
    });
    provider = new GlueProvider();
    connectionProvider = new GlueConnectionProvider();
  });

  // This block primes STS itself (beforeEach); OLDER blocks further down rely
  // on the answer the import block primed, so put that back afterwards.
  afterEach(() => {
    mockStsSend.mockReset();
    mockStsSend.mockResolvedValue({ Account: '123456789012' });
  });

  const db = (catalogId?: unknown) => ({
    ...(catalogId !== undefined && { CatalogId: catalogId }),
    DatabaseInput: { Name: 'mydb' },
  });
  const table = (catalogId?: unknown) => ({
    ...(catalogId !== undefined && { CatalogId: catalogId }),
    DatabaseName: 'mydb',
    TableInput: { Name: 't' },
  });
  const conn = (catalogId?: unknown) => ({
    ...(catalogId !== undefined && { CatalogId: catalogId }),
    ConnectionInput: { Name: 'c', ConnectionType: 'JDBC', ConnectionProperties: {} },
  });

  it('refuses a Database CatalogId change between two literals, with no Glue or STS call', async () => {
    const error = await provider
      .update('MyDb', 'mydb', 'AWS::Glue::Database', db('222222222222'), db('111111111111'))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    const message = (error as Error).message;
    expect(message).toContain(
      "CatalogId moves the database 'mydb' from Data Catalog 111111111111 to Data Catalog 222222222222"
    );
    expect(message).toContain('--replace --force-stateful-recreation');
    expect(mockGlueSend).not.toHaveBeenCalled();
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('refuses a Table CatalogId move from the default catalog to a foreign one', async () => {
    const error = await provider
      .update('MyTable', 'mydb|t', 'AWS::Glue::Table', table('222222222222'), table())
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect((error as Error).message).toContain(
      "the table 'mydb.t' from this account's default Data Catalog to Data Catalog 222222222222"
    );
    expect(mockGlueSend).not.toHaveBeenCalled();
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it('refuses a Connection CatalogId move, naming --replace alone', async () => {
    const error = await connectionProvider
      .update('MyConn', 'c', 'AWS::Glue::Connection', conn(), conn('222222222222'))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    const message = (error as Error).message;
    expect(message).toContain('from Data Catalog 222222222222 to this account');
    expect(message).toContain('re-deploy with --replace, which');
    expect(message).not.toContain('--force-stateful-recreation');
    expect(mockGlueSend).not.toHaveBeenCalled();
  });

  it('treats the account-id pseudo parameter an import recorded as the caller account', async () => {
    await provider.update(
      'MyDb',
      'mydb',
      'AWS::Glue::Database',
      db('111111111111'),
      db({ Ref: 'AWS::AccountId' })
    );

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof UpdateDatabaseCommand);
    expect(call![0].input).toMatchObject({ CatalogId: '111111111111', Name: 'mydb' });
    expect(mockStsSend).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('refuses a move from the recorded pseudo parameter to another account', async () => {
    await expect(
      provider.update(
        'MyDb',
        'mydb',
        'AWS::Glue::Database',
        db('222222222222'),
        db({ Ref: 'AWS::AccountId' })
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(mockGlueSend).not.toHaveBeenCalled();
  });

  it('leaves an unplaceable DESIRED CatalogId to the wire, with no STS call', async () => {
    await provider.update('MyDb', 'mydb', 'AWS::Glue::Database', db({ Ref: 'CatalogParam' }), db());

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof UpdateDatabaseCommand);
    expect(call![0].input).toMatchObject({ CatalogId: { Ref: 'CatalogParam' } });
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('treats an absent CatalogId and the caller account id as the same catalog, both directions', async () => {
    await provider.update('MyTable', 'mydb|t', 'AWS::Glue::Table', table('111111111111'), table());
    await provider.update('MyTable', 'mydb|t', 'AWS::Glue::Table', table(), table('111111111111'));

    expect(mockGlueSend.mock.calls.filter((c) => c[0] instanceof UpdateTableCommand)).toHaveLength(2);
    // Memoized per provider instance.
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it('needs no STS call when both sides are default or both are the same literal', async () => {
    await provider.update('MyDb', 'mydb', 'AWS::Glue::Database', db(), db());
    await provider.update(
      'MyDb',
      'mydb',
      'AWS::Glue::Database',
      db('222222222222'),
      db('222222222222')
    );
    await connectionProvider.update('MyConn', 'c', 'AWS::Glue::Connection', conn(), conn());

    expect(mockGlueSend.mock.calls.filter((c) => c[0] instanceof UpdateDatabaseCommand)).toHaveLength(2);
    expect(mockGlueSend.mock.calls.some((c) => c[0] instanceof UpdateConnectionCommand)).toBe(true);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('warns and proceeds when the RECORDED CatalogId is an unplaceable intrinsic', async () => {
    await provider.update(
      'MyDb',
      'mydb',
      'AWS::Glue::Database',
      db('222222222222'),
      db({ Ref: 'CatalogParam' })
    );

    expect(mockGlueSend.mock.calls.some((c) => c[0] instanceof UpdateDatabaseCommand)).toBe(true);
    expect(mockLoggerWarn.mock.calls.some((c) => String(c[0]).includes('recorded CatalogId is not a usable value'))).toBe(true);
    expect(mockLoggerWarn.mock.calls.some((c) => String(c[0]).includes('it proceeds against Data Catalog 222222222222'))).toBe(true);
    expect(mockStsSend).not.toHaveBeenCalled();
  });

  it('fails without a Glue call when STS cannot answer the mixed case', async () => {
    mockStsSend.mockReset();
    mockStsSend.mockRejectedValueOnce(new Error('sts down'));

    await expect(
      provider.update('MyTable', 'mydb|t', 'AWS::Glue::Table', table('111111111111'), table())
    ).rejects.toThrow("Could not resolve the caller's account id (sts:GetCallerIdentity)");
    expect(mockGlueSend).not.toHaveBeenCalled();

    // The failure is not memoized: the next mixed-case update asks STS again.
    mockStsSend.mockResolvedValueOnce({ Account: '111111111111' });
    await provider.update('MyTable', 'mydb|t', 'AWS::Glue::Table', table('111111111111'), table());
    expect(mockStsSend).toHaveBeenCalledTimes(2);
    expect(mockGlueSend.mock.calls.some((c) => c[0] instanceof UpdateTableCommand)).toBe(true);
  });

  it('readCurrentState carries a usable recorded CatalogId back, and omits an unusable one', async () => {
    mockGlueSend.mockImplementation((command: unknown) => {
      if (command instanceof GetDatabaseCommand) {
        return Promise.resolve({ Database: { Name: 'mydb' } });
      }
      if (command instanceof GetConnectionCommand) {
        return Promise.resolve({ Connection: { Name: 'c', ConnectionType: 'JDBC' } });
      }
      return Promise.resolve({});
    });

    const literal = await provider.readCurrentState('mydb', 'MyDb', 'AWS::Glue::Database', {
      CatalogId: '222222222222',
    });
    expect(literal?.['CatalogId']).toBe('222222222222');
    const connRead = await connectionProvider.readCurrentState('c', 'MyConn', 'AWS::Glue::Connection', {
      CatalogId: '222222222222',
    });
    expect(connRead?.['CatalogId']).toBe('222222222222');
    mockGlueSend.mockImplementation((command: unknown) =>
      Promise.resolve(
        command instanceof GetTableCommand
          ? { Table: { Name: 't', DatabaseName: 'mydb' } }
          : command instanceof GetDatabaseCommand
            ? { Database: { Name: 'mydb' } }
            : {}
      )
    );
    const tableRead = await provider.readCurrentState('mydb|t', 'MyTable', 'AWS::Glue::Table', {
      DatabaseName: 'mydb',
      CatalogId: '222222222222',
    });
    expect(tableRead?.['CatalogId']).toBe('222222222222');
    const pseudo = await provider.readCurrentState('mydb', 'MyDb', 'AWS::Glue::Database', {
      CatalogId: { Ref: 'AWS::AccountId' },
    });
    expect(pseudo).not.toHaveProperty('CatalogId');
  });

  it('stringifies a numeric CatalogId on the update wire', async () => {
    await provider.update('MyDb', 'mydb', 'AWS::Glue::Database', db(222222222222), db(222222222222));

    await provider.update('MyTable', 'mydb|t', 'AWS::Glue::Table', table(222222222222), table(222222222222));
    await connectionProvider.update('MyConn', 'c', 'AWS::Glue::Connection', conn(222222222222), conn(222222222222));

    for (const Command of [UpdateDatabaseCommand, UpdateTableCommand, UpdateConnectionCommand]) {
      const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof Command);
      expect((call![0].input as { CatalogId: unknown }).CatalogId).toBe('222222222222');
    }
  });

  it('passes a non-finite numeric CatalogId through rather than defaulting the catalog', async () => {
    await provider.update('MyDb', 'mydb', 'AWS::Glue::Database', db(Number.NaN), db());
    await provider.update('MyTable', 'mydb|t', 'AWS::Glue::Table', table(Number.NaN), table());
    await connectionProvider.update('MyConn', 'c', 'AWS::Glue::Connection', conn(Number.NaN), conn());

    for (const Command of [UpdateDatabaseCommand, UpdateTableCommand, UpdateConnectionCommand]) {
      const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof Command);
      expect((call![0].input as { CatalogId: unknown }).CatalogId).toBeNaN();
    }
  });

  it('a drift --revert shaped update (both bags from readCurrentState) targets the recorded catalog', async () => {
    const readback = { DatabaseName: 'mydb', CatalogId: '222222222222', TableInput: { Name: 't' } };
    await provider.update(
      'MyTable',
      'mydb|t',
      'AWS::Glue::Table',
      { ...readback, TableInput: { Name: 't', Description: 'reverted' } },
      readback
    );

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof UpdateTableCommand);
    expect(call![0].input).toMatchObject({ CatalogId: '222222222222', DatabaseName: 'mydb' });
    expect(mockStsSend).not.toHaveBeenCalled();
  });
});

// Issue #3750: a Table rename is now a create-first REPLACEMENT, so a table
// already holding the new name surfaces as a CreateTable AlreadyExistsException.
// It must NOT read as a name collision to the engine, whose remedy (`--replace`)
// would delete the managed table first and then collide with the holder again.
describe('Glue CreateTable name collision (issue #3750)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGlueSend.mockReset();
  });

  it('reports an occupied table name without the collision signal the engine reads', async () => {
    const aws = new AlreadyExistsException({ message: 'Table already exists.', $metadata: {} });
    mockGlueSend.mockRejectedValueOnce(aws);

    const error = await new GlueProvider()
      .create('MyTable', 'AWS::Glue::Table', {
        DatabaseName: 'mydb',
        TableInput: { Name: 'taken' },
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("a table named 'taken' is present in database 'mydb'");
    expect(message).toContain('revert the change that planned it');
    // The engine never takes its delete-first path for this error, so a
    // --replace remedy would loop: none is offered.
    expect(message).not.toContain('--replace');
    expect(isNameCollisionErrorFrom(error, 'MyTable')).toBe(false);
    // The AWS error stays in the chain for the retry classifiers; the
    // collision classifier credits its prose only when the top level relays it.
    expect((error as Error).cause).toBe(aws);
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('keeps any other CreateTable failure wrapped with its cause', async () => {
    const aws = new Error('Access denied');
    mockGlueSend.mockRejectedValueOnce(aws);

    const error = await new GlueProvider()
      .create('MyTable', 'AWS::Glue::Table', { DatabaseName: 'mydb', TableInput: { Name: 't' } })
      .catch((e: unknown) => e);

    expect((error as Error).message).toContain('Failed to create Glue Table MyTable: Access denied');
    expect((error as Error).cause).toBe(aws);
  });
});

// Issue #1675: every Glue DELETE whose API accepts `CatalogId` must forward it
// out of the properties bag. Omitting it silently targets this account's
// DEFAULT Data Catalog, so a resource in a non-default catalog answers
// `EntityNotFoundException`, the warn-and-continue idempotency arm reports
// success, and `cdkd destroy` LEAKS the resource.
describe('Glue delete CatalogId scoping (issue #1675)', () => {
  let provider: GlueProvider;
  let connectionProvider: GlueConnectionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGlueSend.mockReset();
    provider = new GlueProvider();
    connectionProvider = new GlueConnectionProvider();
  });

  it('deleteTable forwards a literal CatalogId to DeleteTableCommand', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    await provider.delete('MyTable', 'mydb|my_table', 'AWS::Glue::Table', {
      CatalogId: '210987654321',
      DatabaseName: 'mydb',
    });

    expect(mockGlueSend).toHaveBeenCalledTimes(1);
    expect(mockGlueSend.mock.calls[0][0].input).toEqual({
      CatalogId: '210987654321',
      DatabaseName: 'mydb',
      Name: 'my_table',
    });
  });

  // `cdkd import` records the RAW template value, so `CatalogId:
  // {Ref: AWS::AccountId}` (what @aws-cdk/aws-glue-alpha renders for an
  // environment-agnostic stack) reaches delete() as an OBJECT. Sending it would
  // hand the Glue API `[object Object]` as a catalog id; dropping it matches the
  // API default, which is what the intrinsic would have resolved to.
  it('deleteTable DROPS an unresolved CatalogId intrinsic instead of sending the object', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    await provider.delete('MyTable', 'mydb|my_table', 'AWS::Glue::Table', {
      CatalogId: { Ref: 'AWS::AccountId' },
    });

    const input = mockGlueSend.mock.calls[0][0].input as Record<string, unknown>;
    expect(input).not.toHaveProperty('CatalogId');
    expect(input).toEqual({ DatabaseName: 'mydb', Name: 'my_table' });
  });

  it('deleteTable sends NO CatalogId key when the template declared none', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    await provider.delete('MyTable', 'mydb|my_table', 'AWS::Glue::Table', {
      DatabaseName: 'mydb',
    });

    const input = mockGlueSend.mock.calls[0][0].input as Record<string, unknown>;
    expect(input).not.toHaveProperty('CatalogId');
    expect(input).toEqual({ DatabaseName: 'mydb', Name: 'my_table' });
  });

  it('deleteTable sends no CatalogId key when delete() receives no properties at all', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    await provider.delete('MyTable', 'mydb|my_table', 'AWS::Glue::Table');

    expect(mockGlueSend.mock.calls[0][0].input).toEqual({
      DatabaseName: 'mydb',
      Name: 'my_table',
    });
  });

  // A NotFound after a CORRECTLY-targeted delete is ordinary idempotency, so it
  // stays at debug: warning on every already-gone resource would be noise.
  it('deleteTable stays silent on NotFound when the catalog was addressable', async () => {
    mockGlueSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'Entity Not Found', $metadata: {} })
    );

    await expect(
      provider.delete('MyTable', 'mydb|my_table', 'AWS::Glue::Table', {
        CatalogId: '210987654321',
      })
    ).resolves.toBeUndefined();

    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  // A numeric `CatalogId` reaches a provider from a numeric literal in the
  // synth template (`new CfnResource({...})` / `addPropertyOverride`) or from
  // the macro-expanded deploy template (`macro-expander.ts`'s
  // `GetTemplate(TemplateStage: 'Processed')`), and on DELETE from the
  // recorded state row that `destroy-runner.ts` replays into
  // `provider.delete`. Rejecting it as "not a string" would silently retarget
  // the DELETE at the default catalog, where a same-named table can exist and
  // be destroyed instead. (This comment used to credit
  // `--migrate-from-cloudformation` reading the stack's ORIGINAL template.
  // That was never true of any command -- see the note on
  // `catalogIdForApi` in the provider.)
  it('deleteTable coerces a YAML-numeric CatalogId to the string the API wants', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    await provider.delete('MyTable', 'mydb|my_table', 'AWS::Glue::Table', {
      CatalogId: 210987654321,
    });

    expect(mockGlueSend.mock.calls[0][0].input).toEqual({
      CatalogId: '210987654321',
      DatabaseName: 'mydb',
      Name: 'my_table',
    });
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('deleteTable treats a non-finite numeric CatalogId as unusable rather than sending NaN', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    await provider.delete('MyTable', 'mydb|my_table', 'AWS::Glue::Table', {
      CatalogId: Number.NaN,
    });

    const input = mockGlueSend.mock.calls[0][0].input as Record<string, unknown>;
    expect(input).not.toHaveProperty('CatalogId');
  });

  // ── the two polarities of the account-id carve-out ────────────────────────
  //
  // Dropping `{Ref: AWS::AccountId}` is PROVABLY harmless — the API's default
  // for an omitted CatalogId IS the caller's own account — so a NotFound after
  // it is ordinary idempotency. Warning there would fire a leak alarm on every
  // destroy of an environment-agnostic CDK stack (and on every destroy re-run
  // after `DeleteDatabase` cascaded its tables).
  it.each([
    ['Ref form', { Ref: 'AWS::AccountId' }],
    ['Fn::Sub 1-arg form', { 'Fn::Sub': '${AWS::AccountId}' }],
    ['Fn::Sub 2-arg form', { 'Fn::Sub': ['${AWS::AccountId}', {}] }],
  ])(
    'deleteTable stays silent on NotFound when the dropped CatalogId was the account-id pseudo parameter (%s)',
    async (_label, catalogId) => {
      mockGlueSend.mockRejectedValueOnce(
        new EntityNotFoundException({ message: 'Entity Not Found', $metadata: {} })
      );

      await expect(
        provider.delete('MyTable', 'mydb|my_table', 'AWS::Glue::Table', { CatalogId: catalogId })
      ).resolves.toBeUndefined();

      expect(mockLoggerWarn).not.toHaveBeenCalled();
    }
  );

  // ...but every OTHER unresolved intrinsic could resolve to any catalog at
  // all, so a NotFound after dropping one is not evidence the resource is gone.
  // This is the discrimination the silent leak needed: same skip, loud about
  // why it may be wrong.
  it.each([
    ['a template parameter Ref', { Ref: 'CatalogIdParam' }],
    ['an Fn::ImportValue', { 'Fn::ImportValue': 'SharedCatalogId' }],
    ['an Fn::Sub of something else', { 'Fn::Sub': '${SomeOtherParam}' }],
    ['an empty string', ''],
  ])(
    'deleteTable WARNS on NotFound when the declared CatalogId was unusable (%s)',
    async (_label, catalogId) => {
      mockGlueSend.mockRejectedValueOnce(
        new EntityNotFoundException({ message: 'Entity Not Found', $metadata: {} })
      );

      await expect(
        provider.delete('MyTable', 'mydb|my_table', 'AWS::Glue::Table', { CatalogId: catalogId })
      ).resolves.toBeUndefined();

      expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
      const message = mockLoggerWarn.mock.calls[0][0] as string;
      expect(message).toContain('mydb|my_table');
      expect(message).toContain("this account's default Data Catalog");
      // "re-run" is NOT the remedy: on `cdkd destroy` the state record is gone
      // by the time the user reads this, so the message must name the manual
      // action instead.
      expect(message).not.toContain('re-run');
      expect(message).toContain('by hand');
    }
  );

  // An explicit `null` is CFn's "absent", not a declared-but-broken value.
  it('deleteTable treats an explicit null CatalogId as absent, not unusable', async () => {
    mockGlueSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'Entity Not Found', $metadata: {} })
    );

    await expect(
      provider.delete('MyTable', 'mydb|my_table', 'AWS::Glue::Table', { CatalogId: null })
    ).resolves.toBeUndefined();

    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  // A LITERAL-but-wrong CatalogId (a typo, a stale account id) takes the debug
  // arm, so the log is the only place the mis-targeting is visible. Naming the
  // catalog is what makes it diagnosable at all.
  it('deleteTable names the catalog it addressed in the skip debug line', async () => {
    mockGlueSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'Entity Not Found', $metadata: {} })
    );

    await provider.delete('MyTable', 'mydb|my_table', 'AWS::Glue::Table', {
      CatalogId: '999999999999',
    });

    expect(
      mockLoggerDebug.mock.calls.some(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('Glue Table mydb|my_table does not exist in Data Catalog 999999999999')
      )
    ).toBe(true);
  });

  // Issue #3136: the warning's `aws glue get-*` synopsis quotes its `<id>`
  // placeholder — bare, `<id>` is two shell redirections.
  it('the unusable-CatalogId skip warning quotes its <id> placeholder', async () => {
    mockGlueSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'Entity Not Found', $metadata: {} })
    );

    // An unresolved non-pseudo intrinsic: declared, but unusable.
    await provider.delete('MyTable', 'mydb|my_table', 'AWS::Glue::Table', {
      CatalogId: { Ref: 'SomeParam' },
    });

    const warned = mockLoggerWarn.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('aws glue get-table'))!;
    expect(warned).toContain(`--catalog-id '<id>'`);
    expect(warned).not.toContain('--catalog-id <id>');
  });

  it('deleteDatabase forwards a literal CatalogId to DeleteDatabaseCommand', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    await provider.delete('MyDb', 'mydb', 'AWS::Glue::Database', {
      CatalogId: '210987654321',
    });

    expect(mockGlueSend.mock.calls[0][0].input).toEqual({
      CatalogId: '210987654321',
      Name: 'mydb',
    });
  });

  it('deleteDatabase DROPS an unresolved CatalogId intrinsic instead of sending the object', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    await provider.delete('MyDb', 'mydb', 'AWS::Glue::Database', {
      CatalogId: { Ref: 'AWS::AccountId' },
    });

    const input = mockGlueSend.mock.calls[0][0].input as Record<string, unknown>;
    expect(input).not.toHaveProperty('CatalogId');
    expect(input).toEqual({ Name: 'mydb' });
  });

  // Pins the Database call site of the shared skip helper: deleting the call,
  // or pasting the Table/Connection `kind` literal into it, fails here.
  it('deleteDatabase reports its NotFound skip with the Database kind and the catalog', async () => {
    mockGlueSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'Entity Not Found', $metadata: {} })
    );

    await provider.delete('MyDb', 'mydb', 'AWS::Glue::Database', { CatalogId: '999999999999' });

    expect(
      mockLoggerDebug.mock.calls.some(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('Glue Database mydb does not exist in Data Catalog 999999999999')
      )
    ).toBe(true);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('deleteDatabase WARNS on NotFound when the declared CatalogId was unusable', async () => {
    mockGlueSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'Entity Not Found', $metadata: {} })
    );

    await provider.delete('MyDb', 'mydb', 'AWS::Glue::Database', {
      CatalogId: { Ref: 'CatalogIdParam' },
    });

    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn.mock.calls[0][0]).toContain('Glue Database MyDb (mydb)');
  });

  it('deleteConnection DROPS an unresolved CatalogId intrinsic instead of sending the object', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    await connectionProvider.delete('MyConn', 'myconn', 'AWS::Glue::Connection', {
      CatalogId: { Ref: 'AWS::AccountId' },
    });

    const input = mockGlueSend.mock.calls[0][0].input as Record<string, unknown>;
    expect(input).not.toHaveProperty('CatalogId');
    expect(input).toEqual({ ConnectionName: 'myconn' });
  });

  it('deleteConnection forwards a literal CatalogId to DeleteConnectionCommand', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    await connectionProvider.delete('MyConn', 'myconn', 'AWS::Glue::Connection', {
      CatalogId: '210987654321',
    });

    expect(mockGlueSend.mock.calls[0][0].input).toEqual({
      ConnectionName: 'myconn',
      CatalogId: '210987654321',
    });
  });

  // Pins the Connection call site of the shared skip helper (see the Database
  // twin above).
  it('deleteConnection reports its NotFound skip with the Connection kind and the catalog', async () => {
    mockGlueSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'Entity Not Found', $metadata: {} })
    );

    await connectionProvider.delete('MyConn', 'myconn', 'AWS::Glue::Connection', {
      CatalogId: '999999999999',
    });

    expect(
      mockLoggerDebug.mock.calls.some(
        (call) =>
          typeof call[0] === 'string' &&
          call[0].includes('Glue Connection myconn does not exist in Data Catalog 999999999999')
      )
    ).toBe(true);
    expect(mockLoggerWarn).not.toHaveBeenCalled();
  });

  it('deleteConnection WARNS on NotFound when the declared CatalogId was unusable', async () => {
    mockGlueSend.mockRejectedValueOnce(
      new EntityNotFoundException({ message: 'Entity Not Found', $metadata: {} })
    );

    await connectionProvider.delete('MyConn', 'myconn', 'AWS::Glue::Connection', {
      CatalogId: { Ref: 'CatalogIdParam' },
    });

    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn.mock.calls[0][0]).toContain('Glue Connection MyConn (myconn)');
  });
});

// The arm issue #1675 quotes as the leak surface. It is only reachable from a
// hand-edited state record today (every id cdkd writes is a well-formed
// 2-segment composite), but it must stay a LOUD skip with no AWS call rather
// than a delete aimed at a half-decoded id.
describe('deleteTable malformed-physicalId skip arm (issue #1675)', () => {
  let provider: GlueProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGlueSend.mockReset();
    provider = new GlueProvider();
  });

  it.each([
    ['a bare table name with no separator', 'my_table'],
    ['an empty table segment', 'mydb|'],
    ['an empty database segment', '|my_table'],
    ['an empty id', ''],
  ])('warns and issues NO Glue call for %s', async (_label, physicalId) => {
    // Issue #1752: this used to resolve to `undefined`, which the destroy
    // runner could not tell apart from a completed delete — so the table was
    // printed and counted as `deleted` and its state record dropped. The arm
    // now REPORTS the skip.
    await expect(
      provider.delete('MyTable', physicalId, 'AWS::Glue::Table', { DatabaseName: 'mydb' })
    ).resolves.toEqual({
      outcome: 'skipped',
      reason: 'malformed physicalId in state — no delete issued',
    });

    expect(mockGlueSend).not.toHaveBeenCalled();
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    // Issue #1657: the warning now names the EXPECTED shape (it is the user's
    // only route to the format) and says the AWS resource is left behind.
    const warned = mockLoggerWarn.mock.calls[0][0] as string;
    expect(warned).toContain('Invalid physicalId format for Glue Table');
    expect(warned).toContain('expected "<databaseName>|<tableName>"');
    expect(warned).toContain('LEFT IN PLACE');
  });
});

// Issue #1675 item C: `readCurrentState` and the Connection `import()` probe
// read the same `CatalogId` off the same bag shapes as the deletes. Before the
// shared guard they used a bare `as string | undefined` cast, so for exactly
// the import-written state records this PR's rationale is about, `cdkd drift`
// handed `GetTable` / `GetConnection` an unresolved intrinsic OBJECT.
describe('Glue read-path CatalogId scoping (issue #1675)', () => {
  let provider: GlueProvider;
  let connectionProvider: GlueConnectionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockGlueSend.mockReset();
    provider = new GlueProvider();
    connectionProvider = new GlueConnectionProvider();
  });

  it('readCurrentState(Table) DROPS an unresolved CatalogId intrinsic', async () => {
    mockGlueSend.mockResolvedValueOnce({ Table: { Name: 'my_table' } });

    await provider.readCurrentState('mydb|my_table', 'MyTable', 'AWS::Glue::Table', {
      CatalogId: { Ref: 'AWS::AccountId' },
    });

    const input = mockGlueSend.mock.calls[0][0].input as Record<string, unknown>;
    expect(input).not.toHaveProperty('CatalogId');
    expect(input).toEqual({ DatabaseName: 'mydb', Name: 'my_table' });
  });

  it('readCurrentState(Table) coerces a YAML-numeric CatalogId', async () => {
    mockGlueSend.mockResolvedValueOnce({ Table: { Name: 'my_table' } });

    await provider.readCurrentState('mydb|my_table', 'MyTable', 'AWS::Glue::Table', {
      CatalogId: 210987654321,
    });

    expect(mockGlueSend.mock.calls[0][0].input).toEqual({
      CatalogId: '210987654321',
      DatabaseName: 'mydb',
      Name: 'my_table',
    });
  });

  it('readCurrentState(Database) DROPS an unresolved CatalogId intrinsic', async () => {
    mockGlueSend.mockResolvedValueOnce({ Database: { Name: 'mydb' } });

    await provider.readCurrentState('mydb', 'MyDb', 'AWS::Glue::Database', {
      CatalogId: { Ref: 'AWS::AccountId' },
    });

    const input = mockGlueSend.mock.calls[0][0].input as Record<string, unknown>;
    expect(input).not.toHaveProperty('CatalogId');
    expect(input).toEqual({ Name: 'mydb' });
  });

  it('GlueConnectionProvider.readCurrentState DROPS an unresolved CatalogId intrinsic', async () => {
    mockGlueSend.mockResolvedValueOnce({ Connection: { Name: 'myconn' } });

    await connectionProvider.readCurrentState('myconn', 'MyConn', 'AWS::Glue::Connection', {
      CatalogId: { Ref: 'AWS::AccountId' },
    });

    const input = mockGlueSend.mock.calls[0][0].input as Record<string, unknown>;
    expect(input).not.toHaveProperty('CatalogId');
    expect(input).toEqual({ Name: 'myconn' });
  });

  it('GlueConnectionProvider.import DROPS an unresolved CatalogId intrinsic', async () => {
    mockGlueSend.mockResolvedValueOnce({ Connection: { Name: 'myconn' } });

    await connectionProvider.import({
      logicalId: 'MyConn',
      resourceType: 'AWS::Glue::Connection',
      stackName: 'MyStack',
      region: 'us-east-1',
      knownPhysicalId: 'myconn',
      properties: { CatalogId: { Ref: 'AWS::AccountId' } },
    });

    const input = mockGlueSend.mock.calls[0][0].input as Record<string, unknown>;
    expect(input).not.toHaveProperty('CatalogId');
    expect(input).toEqual({ Name: 'myconn' });
  });

  it('GlueConnectionProvider.import still forwards a literal CatalogId', async () => {
    mockGlueSend.mockResolvedValueOnce({ Connection: { Name: 'myconn' } });

    await connectionProvider.import({
      logicalId: 'MyConn',
      resourceType: 'AWS::Glue::Connection',
      stackName: 'MyStack',
      region: 'us-east-1',
      knownPhysicalId: 'myconn',
      properties: { CatalogId: '210987654321' },
    });

    expect(mockGlueSend.mock.calls[0][0].input).toEqual({
      Name: 'myconn',
      CatalogId: '210987654321',
    });
  });
});

// Bug 1: Glue Job stringly-typed numeric coercion.
describe('GlueJobProvider numeric coercion', () => {
  let provider: GlueJobProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueJobProvider();
  });

  it('create: coerces string numerics to numbers at the SDK boundary', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    // CFn delivers these as STRINGS (CDK synths e.g. "10").
    const properties = {
      Name: 'myjob',
      Role: 'arn:aws:iam::123456789012:role/glue',
      Command: { Name: 'glueetl', ScriptLocation: 's3://bucket/script.py' },
      MaxRetries: '2',
      AllocatedCapacity: '5',
      Timeout: '60',
      MaxCapacity: '10',
      NumberOfWorkers: '4',
      ExecutionProperty: { MaxConcurrentRuns: '3' },
      NotificationProperty: { NotifyDelayAfter: '7' },
    };

    await provider.create('MyJob', 'AWS::Glue::Job', properties);

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof CreateJobCommand);
    expect(call).toBeDefined();
    const input = call![0].input as Record<string, unknown>;
    expect(input['MaxRetries']).toBe(2);
    expect(input['AllocatedCapacity']).toBe(5);
    expect(input['Timeout']).toBe(60);
    expect(input['MaxCapacity']).toBe(10);
    expect(input['NumberOfWorkers']).toBe(4);
    expect((input['ExecutionProperty'] as { MaxConcurrentRuns: number }).MaxConcurrentRuns).toBe(3);
    expect((input['NotificationProperty'] as { NotifyDelayAfter: number }).NotifyDelayAfter).toBe(7);
    // Every coerced value must be a real number, not a string.
    for (const key of ['MaxRetries', 'AllocatedCapacity', 'Timeout', 'MaxCapacity', 'NumberOfWorkers']) {
      expect(typeof input[key]).toBe('number');
    }
  });

  it('update: coerces string numerics inside JobUpdate', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    const properties = {
      Name: 'myjob',
      Role: 'arn:aws:iam::123456789012:role/glue',
      Command: { Name: 'glueetl', ScriptLocation: 's3://bucket/script.py' },
      Timeout: '120',
      NumberOfWorkers: '8',
    };

    await provider.update('MyJob', 'myjob', 'AWS::Glue::Job', properties, properties);

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof UpdateJobCommand);
    expect(call).toBeDefined();
    const jobUpdate = (call![0].input as { JobUpdate: Record<string, unknown> }).JobUpdate;
    expect(jobUpdate['Timeout']).toBe(120);
    expect(jobUpdate['NumberOfWorkers']).toBe(8);
    expect(typeof jobUpdate['Timeout']).toBe('number');
  });

  it('create: leaves already-numeric values untouched', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    await provider.create('MyJob', 'AWS::Glue::Job', {
      Name: 'myjob',
      Role: 'arn:aws:iam::123456789012:role/glue',
      Command: { Name: 'glueetl' },
      Timeout: 30,
    });

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof CreateJobCommand);
    expect((call![0].input as Record<string, unknown>)['Timeout']).toBe(30);
  });

  it('create: leaves a non-finite / unparseable numeric value unchanged (so AWS surfaces a clear validation error, not NaN)', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    await provider.create('MyJob', 'AWS::Glue::Job', {
      Name: 'myjob',
      Role: 'arn:aws:iam::123456789012:role/glue',
      Command: { Name: 'glueetl' },
      Timeout: 'not-a-number',
    });

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof CreateJobCommand);
    const timeout = (call![0].input as Record<string, unknown>)['Timeout'];
    // coerceNumber must NOT turn an unparseable string into NaN — it leaves the
    // original value so AWS rejects it with a real validation error.
    expect(timeout).toBe('not-a-number');
  });
});

// Bug 4: Glue Workflow Tags map shape + MaxConcurrentRuns coercion.
describe('GlueWorkflowProvider tags + numeric', () => {
  let provider: GlueWorkflowProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueWorkflowProvider();
  });

  it('create: tags from a MAP shape reach the SDK (not silently dropped)', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    await provider.create('MyWf', 'AWS::Glue::Workflow', {
      Name: 'mywf',
      Tags: { env: 'prod', team: 'data' },
      MaxConcurrentRuns: '5',
    });

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof CreateWorkflowCommand);
    expect(call).toBeDefined();
    const input = call![0].input as Record<string, unknown>;
    expect(input['Tags']).toEqual({ env: 'prod', team: 'data' });
    expect(input['MaxConcurrentRuns']).toBe(5);
    expect(typeof input['MaxConcurrentRuns']).toBe('number');
  });

  it('create: tags from a {Key,Value}[] list shape also reach the SDK', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    await provider.create('MyWf', 'AWS::Glue::Workflow', {
      Name: 'mywf',
      Tags: [{ Key: 'env', Value: 'prod' }],
    });

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof CreateWorkflowCommand);
    expect((call![0].input as Record<string, unknown>)['Tags']).toEqual({ env: 'prod' });
  });

  it('create: no Tags key when there are no tags', async () => {
    mockGlueSend.mockResolvedValueOnce({});

    await provider.create('MyWf', 'AWS::Glue::Workflow', { Name: 'mywf' });

    const call = mockGlueSend.mock.calls.find((c) => c[0] instanceof CreateWorkflowCommand);
    expect((call![0].input as Record<string, unknown>)['Tags']).toBeUndefined();
  });
});

// Bug 2: Glue Crawler CrawlerRunningException handling.
describe('GlueCrawlerProvider running-state handling', () => {
  let provider: GlueCrawlerProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueCrawlerProvider();
  });

  function runningError(): CrawlerRunningException {
    return new CrawlerRunningException({
      $metadata: {},
      message: 'Crawler is running',
    });
  }

  it('delete: stops a running crawler and retries DeleteCrawler', async () => {
    // 1st DeleteCrawler -> CrawlerRunningException
    mockGlueSend.mockRejectedValueOnce(runningError());
    // StopCrawler
    mockGlueSend.mockResolvedValueOnce({});
    // GetCrawler poll -> READY (loop exits without sleeping)
    mockGlueSend.mockResolvedValueOnce({ Crawler: { State: 'READY' } });
    // 2nd DeleteCrawler -> success
    mockGlueSend.mockResolvedValueOnce({});

    await provider.delete('MyCrawler', 'mycrawler', 'AWS::Glue::Crawler', {}, undefined);

    const types = mockGlueSend.mock.calls.map((c) => c[0].constructor.name);
    expect(types).toContain('StopCrawlerCommand');
    expect(types.filter((t) => t === 'DeleteCrawlerCommand')).toHaveLength(2);
    const stopCall = mockGlueSend.mock.calls.find((c) => c[0] instanceof StopCrawlerCommand);
    expect((stopCall![0].input as { Name: string }).Name).toBe('mycrawler');
  });

  it('update: stops a running crawler and retries UpdateCrawler', async () => {
    // 1st UpdateCrawler -> CrawlerRunningException
    mockGlueSend.mockRejectedValueOnce(runningError());
    // StopCrawler
    mockGlueSend.mockResolvedValueOnce({});
    // GetCrawler poll -> READY
    mockGlueSend.mockResolvedValueOnce({ Crawler: { State: 'READY' } });
    // 2nd UpdateCrawler -> success
    mockGlueSend.mockResolvedValueOnce({});
    // applyTagDiff GetTags (no-op when tags empty) — provider only calls when diff non-empty
    const props = { Role: 'arn:aws:iam::123456789012:role/glue', Targets: { S3Targets: [] } };

    await provider.update('MyCrawler', 'mycrawler', 'AWS::Glue::Crawler', props, props);

    const types = mockGlueSend.mock.calls.map((c) => c[0].constructor.name);
    expect(types).toContain('StopCrawlerCommand');
    expect(types.filter((t) => t === 'UpdateCrawlerCommand')).toHaveLength(2);
  });

  it('delete: tolerates a StopCrawler rejection (already-stopping race) and still retries the delete', async () => {
    // 1st DeleteCrawler -> CrawlerRunningException
    mockGlueSend.mockRejectedValueOnce(runningError());
    // StopCrawler -> rejects because the crawler is ALREADY stopping. The
    // provider must swallow this (nothing to do but wait it out), not abort.
    mockGlueSend.mockRejectedValueOnce(new Error('CrawlerStoppingException: already stopping'));
    // GetCrawler poll -> READY (it finished stopping)
    mockGlueSend.mockResolvedValueOnce({ Crawler: { State: 'READY' } });
    // 2nd DeleteCrawler -> success
    mockGlueSend.mockResolvedValueOnce({});

    await provider.delete('MyCrawler', 'mycrawler', 'AWS::Glue::Crawler', {}, undefined);

    const types = mockGlueSend.mock.calls.map((c) => c[0].constructor.name);
    expect(types).toContain('StopCrawlerCommand');
    expect(types).toContain('GetCrawlerCommand');
    expect(types.filter((t) => t === 'DeleteCrawlerCommand')).toHaveLength(2);
  });
});

// Bug 3: Glue Trigger update state-machine (wait + restore-on-failure + stop-before-delete).
describe('GlueTriggerProvider state-machine', () => {
  let provider: GlueTriggerProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new GlueTriggerProvider();
  });

  it('update: restores ACTIVATED via StartTrigger even when UpdateTrigger throws', async () => {
    // GetTrigger pre-check -> ACTIVATED
    mockGlueSend.mockResolvedValueOnce({ Trigger: { State: 'ACTIVATED' } });
    // StopTrigger
    mockGlueSend.mockResolvedValueOnce({});
    // waitForTriggerDeactivated: GetTrigger -> DEACTIVATED (exits without sleep)
    mockGlueSend.mockResolvedValueOnce({ Trigger: { State: 'DEACTIVATED' } });
    // UpdateTrigger -> throws
    mockGlueSend.mockRejectedValueOnce(new Error('update boom'));
    // StartTrigger (in finally) -> success
    mockGlueSend.mockResolvedValueOnce({});

    const props = { Schedule: 'cron(0 12 * * ? *)' };
    await expect(
      provider.update('MyTrig', 'mytrig', 'AWS::Glue::Trigger', props, props)
    ).rejects.toThrow(/Failed to update Glue Trigger/);

    const types = mockGlueSend.mock.calls.map((c) => c[0].constructor.name);
    // The finally block must have run StartTrigger to re-activate the trigger.
    expect(types).toContain('StartTriggerCommand');
    expect(types.filter((t) => t === 'UpdateTriggerCommand')).toHaveLength(1);
  });

  it('update: waits for DEACTIVATED between StopTrigger and UpdateTrigger', async () => {
    // GetTrigger pre-check -> ACTIVATED
    mockGlueSend.mockResolvedValueOnce({ Trigger: { State: 'ACTIVATED' } });
    // StopTrigger
    mockGlueSend.mockResolvedValueOnce({});
    // waitForTriggerDeactivated: GetTrigger -> DEACTIVATED
    mockGlueSend.mockResolvedValueOnce({ Trigger: { State: 'DEACTIVATED' } });
    // UpdateTrigger -> success
    mockGlueSend.mockResolvedValueOnce({});
    // StartTrigger -> success
    mockGlueSend.mockResolvedValueOnce({});

    const props = { Schedule: 'cron(0 1 * * ? *)' };
    await provider.update('MyTrig', 'mytrig', 'AWS::Glue::Trigger', props, props);

    const types = mockGlueSend.mock.calls.map((c) => c[0].constructor.name);
    const stopIdx = types.indexOf('StopTriggerCommand');
    const updateIdx = types.indexOf('UpdateTriggerCommand');
    const getBetween = types
      .slice(stopIdx + 1, updateIdx)
      .filter((t) => t === 'GetTriggerCommand');
    // At least one GetTrigger poll happened between Stop and Update.
    expect(getBetween.length).toBeGreaterThanOrEqual(1);
    expect(types).toContain('StartTriggerCommand');
  });

  it('update: does not stop/restart a trigger that is already DEACTIVATED', async () => {
    // GetTrigger pre-check -> DEACTIVATED
    mockGlueSend.mockResolvedValueOnce({ Trigger: { State: 'DEACTIVATED' } });
    // UpdateTrigger -> success
    mockGlueSend.mockResolvedValueOnce({});

    const props = { Schedule: 'cron(0 2 * * ? *)' };
    await provider.update('MyTrig', 'mytrig', 'AWS::Glue::Trigger', props, props);

    const types = mockGlueSend.mock.calls.map((c) => c[0].constructor.name);
    expect(types).not.toContain('StopTriggerCommand');
    expect(types).not.toContain('StartTriggerCommand');
  });

  it('delete: stops an ACTIVATED trigger before DeleteTrigger', async () => {
    // GetTrigger pre-delete check -> ACTIVATED
    mockGlueSend.mockResolvedValueOnce({ Trigger: { State: 'ACTIVATED' } });
    // StopTrigger
    mockGlueSend.mockResolvedValueOnce({});
    // waitForTriggerDeactivated: GetTrigger -> DEACTIVATED
    mockGlueSend.mockResolvedValueOnce({ Trigger: { State: 'DEACTIVATED' } });
    // DeleteTrigger -> success
    mockGlueSend.mockResolvedValueOnce({});

    await provider.delete('MyTrig', 'mytrig', 'AWS::Glue::Trigger', {}, undefined);

    const types = mockGlueSend.mock.calls.map((c) => c[0].constructor.name);
    const stopIdx = types.indexOf('StopTriggerCommand');
    const deleteIdx = types.indexOf('DeleteTriggerCommand');
    expect(stopIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeGreaterThan(stopIdx);
  });

  it('delete: does not stop a trigger that is not ACTIVATED', async () => {
    // GetTrigger pre-delete check -> DEACTIVATED
    mockGlueSend.mockResolvedValueOnce({ Trigger: { State: 'DEACTIVATED' } });
    // DeleteTrigger -> success
    mockGlueSend.mockResolvedValueOnce({});

    await provider.delete('MyTrig', 'mytrig', 'AWS::Glue::Trigger', {}, undefined);

    const types = mockGlueSend.mock.calls.map((c) => c[0].constructor.name);
    expect(types).not.toContain('StopTriggerCommand');
    expect(types).toContain('DeleteTriggerCommand');
  });
});
