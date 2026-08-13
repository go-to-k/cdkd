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
      // A create issues exactly ONE send; pinning the count is what catches the
      // code path changing which calls it makes (`.claude/rules/testing.md`).
      expect(mockSend).toHaveBeenCalledTimes(1);
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
      // `toStrictEqual`, not `toEqual`: the latter IGNORES an `undefined`-valued
      // key, so a regression that writes `TargetDatabase: undefined` onto the
      // request would slip past it. The shape that actually reaches AWS is what
      // matters here — an empty `TargetDatabase: {}` is rejected by Glue.
      expect(databaseInputOf(call![0])).toStrictEqual({ Name: 'plaindb', Description: 'plain' });
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
      // GetDatabase (the AWS-managed Parameters read) then UpdateDatabase.
      expect(mockSend).toHaveBeenCalledTimes(2);
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

  describe('malformed blocks (shape guards)', () => {
    // The three blocks are read off the DESIRED bag, so they take the repo's
    // standard split: REFUSE on a template-path create, WARN on update (which
    // cannot tell a template push from the state-borne bag `drift --revert` and
    // the rollback revert arm hand it). Before the guards a malformed value did
    // not fail - every member read yielded `undefined` and cdkd SENT an empty
    // `{}` block, or threw a raw TypeError from `.map` on a non-array.
    it.each([
      ['a string', 'linked'],
      ['a number', 7],
      ['null', null],
      ['an array', ['sourcedb']],
    ])('create() refuses a TargetDatabase that is %s, before any AWS call', async (_label, bad) => {
      await expect(
        provider.create('L', 'AWS::Glue::Database', {
          DatabaseInput: { Name: 'db', TargetDatabase: bad },
        })
      ).rejects.toThrow(/TargetDatabase must be an object/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([
      ['an unresolved intrinsic', { Ref: 'SomeDb' }],
      ['an empty block', {}],
    ])(
      'create() refuses a TargetDatabase that is a plain object but UNREADABLE (%s)',
      async (_label, bad) => {
        // A plain object passes the shape guard, so this is the second half of
        // the class: every member read yields `undefined` and the pre-guard code
        // put an empty `TargetDatabase: {}` on the wire.
        await expect(
          provider.create('L', 'AWS::Glue::Database', {
            DatabaseInput: { Name: 'db', TargetDatabase: bad },
          })
        ).rejects.toThrow(/declares no member cdkd can send/);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    it('create() refuses a non-array CreateTableDefaultPermissions, before any AWS call', async () => {
      await expect(
        provider.create('L', 'AWS::Glue::Database', {
          DatabaseInput: { Name: 'db', CreateTableDefaultPermissions: { Permissions: ['ALL'] } },
        })
      ).rejects.toThrow(/CreateTableDefaultPermissions must be an array/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('create() refuses a permission ENTRY it cannot read, rather than narrowing the grant list', async () => {
      // All-or-nothing on purpose: dropping the unreadable entries would send a
      // SILENTLY NARROWED Lake Formation grant list on one wholesale call.
      await expect(
        provider.create('L', 'AWS::Glue::Database', {
          DatabaseInput: {
            Name: 'db',
            CreateTableDefaultPermissions: [
              { Permissions: ['ALL'], Principal: { DataLakePrincipalIdentifier: 'x' } },
              'IAM_ALLOWED_PRINCIPALS',
            ],
          },
        })
      ).rejects.toThrow(/carries an entry cdkd cannot read/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('create() refuses a Permissions member that is not a list (the SDK would drop it)', async () => {
      await expect(
        provider.create('L', 'AWS::Glue::Database', {
          DatabaseInput: {
            Name: 'db',
            CreateTableDefaultPermissions: [{ Permissions: 'ALL' }],
          },
        })
      ).rejects.toThrow(/carries an entry cdkd cannot read/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('create() DOWNGRADES the refusal to a warning on a state replay', async () => {
      // A reverse-replacement re-create reads a STATE record, which the user
      // cannot edit from the template - refusing would leave the old resource
      // unrestorable (issue #1463).
      mockSend.mockResolvedValueOnce({});

      await provider.create(
        'L',
        'AWS::Glue::Database',
        { DatabaseInput: { Name: 'db', TargetDatabase: 'linked' } },
        { replayingState: true }
      );

      const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateDatabaseCommand);
      expect(databaseInputOf(call![0])).toStrictEqual({ Name: 'db' });
    });

    it('update() RETAINS the previous block instead of erasing a live resource link', async () => {
      // UpdateDatabase replaces DatabaseInput wholesale, so omitting the block
      // would DELETE the live link on a template whose only fault is one
      // unreadable value (the #1612 "UPDATE retains the previous value" row).
      mockSend.mockResolvedValueOnce({ Database: { Parameters: {} } });
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'L',
        'mydb',
        'AWS::Glue::Database',
        { DatabaseInput: { Name: 'mydb', TargetDatabase: 'linked' } },
        { DatabaseInput: { Name: 'mydb', TargetDatabase: { DatabaseName: 'sourcedb' } } }
      );

      const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateDatabaseCommand);
      expect(databaseInputOf(call![0])).toStrictEqual({
        Name: 'mydb',
        TargetDatabase: { DatabaseName: 'sourcedb' },
      });
    });

    it('update() DROPS the key when BOTH sides are unusable', async () => {
      mockSend.mockResolvedValueOnce({ Database: { Parameters: {} } });
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'L',
        'mydb',
        'AWS::Glue::Database',
        { DatabaseInput: { Name: 'mydb', CreateTableDefaultPermissions: 'ALL' } },
        { DatabaseInput: { Name: 'mydb', CreateTableDefaultPermissions: 'ALL' } }
      );

      const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateDatabaseCommand);
      expect(databaseInputOf(call![0])).toStrictEqual({ Name: 'mydb' });
    });

    it('sends an EXPLICIT empty permission list unchanged (a declaration, not a malformed value)', async () => {
      // `[]` disables the Lake Formation default set, so it must reach AWS.
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', 'AWS::Glue::Database', {
        DatabaseInput: { Name: 'db', CreateTableDefaultPermissions: [] },
      });

      const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateDatabaseCommand);
      expect(databaseInputOf(call![0])).toStrictEqual({
        Name: 'db',
        CreateTableDefaultPermissions: [],
      });
    });

    it('accepts a permission entry with no Principal and one with an empty Principal', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.create('L', 'AWS::Glue::Database', {
        DatabaseInput: {
          Name: 'db',
          CreateTableDefaultPermissions: [{ Permissions: ['SELECT'] }, { Principal: {} }],
        },
      });

      const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateDatabaseCommand);
      expect(databaseInputOf(call![0])).toStrictEqual({
        Name: 'db',
        CreateTableDefaultPermissions: [{ Permissions: ['SELECT'] }, { Principal: {} }],
      });
    });
  });

  describe('getDriftUnknownPaths()', () => {
    // AWS materializes a Lake Formation DEFAULT for a database that declared no
    // block, and the observedProperties baseline walks the key UNION - so a
    // record written before this member was read would report that default as
    // drift on EVERY existing database. Scoped out PER RESOURCE, the ELBv2
    // `Targets` shape.
    it('ignores CreateTableDefaultPermissions when the template declares none', () => {
      expect(
        provider.getDriftUnknownPaths('AWS::Glue::Database', {
          DatabaseInput: { Name: 'db' },
        })
      ).toEqual(['DatabaseInput.CreateTableDefaultPermissions']);
    });

    it('COMPARES it once the template declares it - including an empty list', () => {
      for (const declared of [[], [{ Permissions: ['ALL'] }]]) {
        expect(
          provider.getDriftUnknownPaths('AWS::Glue::Database', {
            DatabaseInput: { Name: 'db', CreateTableDefaultPermissions: declared },
          })
        ).toEqual([]);
      }
    });

    it('defaults to COMPARING when the properties bag is absent or unreadable', () => {
      // Hiding real drift is the worse failure of the two.
      expect(provider.getDriftUnknownPaths('AWS::Glue::Database')).toEqual([]);
      expect(
        provider.getDriftUnknownPaths('AWS::Glue::Database', { DatabaseInput: 'malformed' })
      ).toEqual([]);
    });

    it('leaves the Table entry untouched', () => {
      expect(provider.getDriftUnknownPaths('AWS::Glue::Table')).toEqual(['OpenTableFormatInput']);
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

      // Pin the READ side first. Without this the whole case is vacuous: pre-fix
      // the readback emitted no TargetDatabase and the builder sent none, so
      // read-side === write-side held trivially and the test would have passed
      // against the very bug it is named for.
      expect((observed['DatabaseInput'] as Record<string, unknown>)['TargetDatabase']).toEqual({
        CatalogId: '123456789012',
        DatabaseName: 'sourcedb',
      });

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
