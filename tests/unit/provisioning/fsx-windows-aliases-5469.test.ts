import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  AssociateFileSystemAliasesCommand,
  DescribeFileSystemAliasesCommand,
  DescribeFileSystemsCommand,
  DisassociateFileSystemAliasesCommand,
  UpdateFileSystemCommand,
} from '@aws-sdk/client-fsx';

// go-to-k/cdkd#5469: a Windows `Aliases` change (CFn "Update requires: No
// interruption", not createOnly in the registry schema) was refused with a
// --replace pointer. It now changes in place through
// Associate/DisassociateFileSystemAliases. ActiveDirectoryId and
// PreferredSubnetId stay refused: no FSx API changes either.

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-fsx', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-fsx')>();
  return {
    ...actual,
    FSxClient: vi.fn().mockImplementation(() => ({
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
  return { getLogger: () => ({ child: () => childLogger }) };
});

import {
  FSxFileSystemProvider,
  aliasDelta,
} from '../../../src/provisioning/providers/fsx-filesystem-provider.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

const TYPE = 'AWS::FSx::FileSystem';
const FS_ID = 'fs-0123456789abcdef0';

const windows = (config: Record<string, unknown>): Record<string, unknown> => ({
  FileSystemType: 'WINDOWS',
  SubnetIds: ['subnet-1'],
  StorageCapacity: 32,
  WindowsConfiguration: {
    ActiveDirectoryId: 'd-1234567890',
    DeploymentType: 'SINGLE_AZ_1',
    ThroughputCapacity: 8,
    WeeklyMaintenanceStartTime: '1:05:00',
    ...config,
  },
});

type AliasRead = Array<{ Name: string; Lifecycle: string }>;

/**
 * Answer every call. The alias store starts as `live` (name -> Lifecycle) and
 * tracks the associate / disassociate calls, each settling at once; as on AWS
 * (the SDK's DisassociateFileSystemAliases doc), disassociating a name that is
 * not associated is a 400 BadRequest. `aliasReads`, when given, scripts the
 * DescribeFileSystemAliases answers instead (the last one repeats).
 */
function arm(
  live: Record<string, string> = {},
  aliasReads?: AliasRead[],
  describeError?: { name: string; times: number }
): void {
  const store = new Map<string, string>(Object.entries(live));
  let read = 0;
  let errors = 0;
  mockSend.mockImplementation(async (command: unknown) => {
    if (command instanceof AssociateFileSystemAliasesCommand) {
      command.input.Aliases!.forEach((n) => store.set(n, 'AVAILABLE'));
      return {};
    }
    if (command instanceof DisassociateFileSystemAliasesCommand) {
      const absent = command.input.Aliases!.filter((n) => !store.has(n));
      if (absent.length > 0 && !aliasReads) {
        throw Object.assign(new Error(`not associated: ${absent.join(', ')}`), {
          name: 'BadRequest',
        });
      }
      command.input.Aliases!.forEach((n) => store.delete(n));
      return {};
    }
    if (command instanceof DescribeFileSystemAliasesCommand) {
      if (describeError && read > 0 && errors < describeError.times) {
        errors += 1;
        throw Object.assign(new Error(`${describeError.name} from the mock`), {
          name: describeError.name,
        });
      }
      if (aliasReads) {
        const answer = aliasReads[Math.min(read, aliasReads.length - 1)]!;
        read += 1;
        return { Aliases: answer };
      }
      read += 1;
      return { Aliases: [...store].map(([Name, Lifecycle]) => ({ Name, Lifecycle })) };
    }
    if (command instanceof DescribeFileSystemsCommand) {
      return {
        FileSystems: [{ FileSystemId: FS_ID, Lifecycle: 'AVAILABLE', AdministrativeActions: [] }],
      };
    }
    if (command instanceof UpdateFileSystemCommand) {
      return { FileSystem: { FileSystemId: FS_ID, AdministrativeActions: [] } };
    }
    return {};
  });
}

/** The mutating calls update() sent, in order, with their inputs. */
const mutatingCalls = (): Array<{ name: string; input: Record<string, unknown> }> =>
  mockSend.mock.calls
    .map(([c]) => c as { constructor: { name: string }; input: Record<string, unknown> })
    .filter((c) => !/^Describe/.test(c.constructor.name))
    .map((c) => ({ name: c.constructor.name, input: c.input }));

const update = (next: Record<string, unknown>, prev: Record<string, unknown>) =>
  new FSxFileSystemProvider({ pollIntervalMs: 0 }).update('Fs', FS_ID, TYPE, next, prev);

describe('aliasDelta (go-to-k/cdkd#5469)', () => {
  it('diffs case-insensitively and ignores order', () => {
    expect(aliasDelta(['B.example.com', 'a.example.com'], ['a.example.com', 'b.example.com'])).toEqual({
      add: [],
      remove: [],
    });
  });
  it('sends names lowercased, as FSx stores them', () => {
    expect(aliasDelta(['New.Example.com'], [])).toEqual({ add: ['new.example.com'], remove: [] });
  });
  it('reads a removed list as "no aliases"', () => {
    expect(aliasDelta(undefined, ['a.example.com'])).toEqual({ add: [], remove: ['a.example.com'] });
  });
});

describe('FSx Windows Aliases update (go-to-k/cdkd#5469)', () => {
  beforeEach(() => mockSend.mockReset());

  const available = (...names: string[]): Record<string, string> =>
    Object.fromEntries(names.map((n) => [n, 'AVAILABLE']));
  const aliasReads = (): number =>
    mockSend.mock.calls.filter(([c]) => c instanceof DescribeFileSystemAliasesCommand).length;

  it('associates an added alias in place and sends no UpdateFileSystem', async () => {
    arm(available('a.example.com'));
    const result = await update(
      windows({ Aliases: ['a.example.com', 'b.example.com'] }),
      windows({ Aliases: ['a.example.com'] })
    );
    expect(result).toMatchObject({ physicalId: FS_ID, wasReplaced: false });
    expect(mutatingCalls()).toEqual([
      {
        name: 'AssociateFileSystemAliasesCommand',
        input: { FileSystemId: FS_ID, Aliases: ['b.example.com'] },
      },
    ]);
  });

  it('associates every alias when the property is added', async () => {
    arm();
    await update(windows({ Aliases: ['a.example.com'] }), windows({}));
    expect(mutatingCalls()).toEqual([
      {
        name: 'AssociateFileSystemAliasesCommand',
        input: { FileSystemId: FS_ID, Aliases: ['a.example.com'] },
      },
    ]);
  });

  it('disassociates a dropped alias', async () => {
    arm(available('a.example.com', 'b.example.com'));
    await update(
      windows({ Aliases: ['a.example.com'] }),
      windows({ Aliases: ['a.example.com', 'b.example.com'] })
    );
    expect(mutatingCalls()).toEqual([
      {
        name: 'DisassociateFileSystemAliasesCommand',
        input: { FileSystemId: FS_ID, Aliases: ['b.example.com'] },
      },
    ]);
  });

  it('disassociates every alias when the property is removed', async () => {
    arm(available('a.example.com', 'b.example.com'));
    await update(windows({}), windows({ Aliases: ['a.example.com', 'b.example.com'] }));
    expect(mutatingCalls()).toEqual([
      {
        name: 'DisassociateFileSystemAliasesCommand',
        input: { FileSystemId: FS_ID, Aliases: ['a.example.com', 'b.example.com'] },
      },
    ]);
  });

  it('disassociates before it associates on a swap', async () => {
    arm(available('old.example.com'));
    await update(windows({ Aliases: ['new.example.com'] }), windows({ Aliases: ['old.example.com'] }));
    expect(mutatingCalls().map((c) => c.name)).toEqual([
      'DisassociateFileSystemAliasesCommand',
      'AssociateFileSystemAliasesCommand',
    ]);
  });

  it('sends nothing for a reorder or a case-only edit', async () => {
    arm(available('a.example.com', 'b.example.com'));
    await update(
      windows({ Aliases: ['B.example.com', 'a.example.com'] }),
      windows({ Aliases: ['a.example.com', 'b.example.com'] })
    );
    expect(mutatingCalls()).toEqual([]);
    expect(aliasReads()).toBe(0);
  });

  it('runs the UpdateFileSystem change first and keeps Aliases out of it', async () => {
    arm();
    await update(
      windows({ Aliases: ['a.example.com'], WeeklyMaintenanceStartTime: '2:06:00' }),
      windows({})
    );
    const calls = mutatingCalls();
    expect(calls.map((c) => c.name)).toEqual([
      'UpdateFileSystemCommand',
      'AssociateFileSystemAliasesCommand',
    ]);
    expect(calls[0]!.input).toEqual({
      FileSystemId: FS_ID,
      WindowsConfiguration: { WeeklyMaintenanceStartTime: '2:06:00' },
    });
  });

  // A retry after a partial failure reads the live aliases first, so it
  // converges: a 400 on an already-gone name would fail every later deploy.
  it('does not re-send a Disassociate for a name already gone (retry after a partial failure)', async () => {
    arm();
    await update(windows({ Aliases: ['add.example.com'] }), windows({ Aliases: ['drop.example.com'] }));
    expect(mutatingCalls()).toEqual([
      {
        name: 'AssociateFileSystemAliasesCommand',
        input: { FileSystemId: FS_ID, Aliases: ['add.example.com'] },
      },
    ]);
  });

  it('does not re-send a Disassociate for a name already DELETING, and waits for it', async () => {
    arm({}, [[{ Name: 'a.example.com', Lifecycle: 'DELETING' }], [{ Name: 'a.example.com', Lifecycle: 'DELETING' }], []]);
    await update(windows({}), windows({ Aliases: ['a.example.com'] }));
    expect(mutatingCalls()).toEqual([]);
    expect(aliasReads()).toBe(3);
  });

  it('does not re-send an Associate for a name already AVAILABLE', async () => {
    arm(available('a.example.com'));
    await update(windows({ Aliases: ['a.example.com'] }), windows({}));
    expect(mutatingCalls()).toEqual([]);
  });

  it('disassociates a CREATE_FAILED name before associating it afresh', async () => {
    arm({ 'a.example.com': 'CREATE_FAILED' });
    await update(windows({ Aliases: ['a.example.com'] }), windows({}));
    expect(mutatingCalls()).toEqual([
      {
        name: 'DisassociateFileSystemAliasesCommand',
        input: { FileSystemId: FS_ID, Aliases: ['a.example.com'] },
      },
      {
        name: 'AssociateFileSystemAliasesCommand',
        input: { FileSystemId: FS_ID, Aliases: ['a.example.com'] },
      },
    ]);
  });

  it('re-clears a DELETE_FAILED name before associating it, instead of waiting out maxWaitMs', async () => {
    arm({ 'a.example.com': 'DELETE_FAILED' });
    await update(windows({ Aliases: ['a.example.com'] }), windows({}));
    expect(mutatingCalls().map((c) => c.name)).toEqual([
      'DisassociateFileSystemAliasesCommand',
      'AssociateFileSystemAliasesCommand',
    ]);
  });

  it('waits out a DELETING name (no Disassociate re-sent) before associating it', async () => {
    arm({}, [
      [{ Name: 'a.example.com', Lifecycle: 'DELETING' }],
      [],
      [{ Name: 'a.example.com', Lifecycle: 'AVAILABLE' }],
    ]);
    await update(windows({ Aliases: ['a.example.com'] }), windows({}));
    expect(mutatingCalls()).toEqual([
      {
        name: 'AssociateFileSystemAliasesCommand',
        input: { FileSystemId: FS_ID, Aliases: ['a.example.com'] },
      },
    ]);
    // AWS ignores an Associate for a still-associated (DELETING) name, so the
    // Associate must come only after a read shows the name gone: the reconcile
    // read plus the gone-wait's read precede it.
    const sent = mockSend.mock.calls.map(([c]) => c);
    const associateAt = sent.findIndex((c) => c instanceof AssociateFileSystemAliasesCommand);
    expect(
      sent.slice(0, associateAt).filter((c) => c instanceof DescribeFileSystemAliasesCommand)
    ).toHaveLength(2);
  });

  it('waits until an associated alias reads AVAILABLE', async () => {
    arm({}, [
      [],
      [],
      [{ Name: 'a.example.com', Lifecycle: 'CREATING' }],
      [{ Name: 'a.example.com', Lifecycle: 'AVAILABLE' }],
    ]);
    await update(windows({ Aliases: ['a.example.com'] }), windows({}));
    // One reconcile read, then three polls.
    expect(aliasReads()).toBe(4);
  });

  it('waits until a disassociated alias is gone', async () => {
    arm({}, [
      [{ Name: 'a.example.com', Lifecycle: 'AVAILABLE' }],
      [{ Name: 'a.example.com', Lifecycle: 'DELETING' }],
      [],
    ]);
    await update(windows({}), windows({ Aliases: ['a.example.com'] }));
    expect(mutatingCalls().map((c) => c.name)).toEqual(['DisassociateFileSystemAliasesCommand']);
    expect(aliasReads()).toBe(3);
  });

  it('fails the update on an alias that reads CREATE_FAILED after the Associate', async () => {
    arm({}, [[], [{ Name: 'a.example.com', Lifecycle: 'CREATE_FAILED' }]]);
    const err = await update(windows({ Aliases: ['a.example.com'] }), windows({})).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ProvisioningError);
    expect((err as Error).message).toContain('a.example.com entered CREATE_FAILED');
  });

  it('polls on through a transient DescribeFileSystemAliases error', async () => {
    arm({}, undefined, { name: 'ThrottlingException', times: 2 });
    await update(windows({ Aliases: ['a.example.com'] }), windows({}));
    expect(mutatingCalls().map((c) => c.name)).toEqual(['AssociateFileSystemAliasesCommand']);
  });

  it('fails on a non-transient DescribeFileSystemAliases error during the wait', async () => {
    arm({}, undefined, { name: 'FileSystemNotFound', times: 1 });
    const err = await update(windows({ Aliases: ['a.example.com'] }), windows({})).catch(
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(ProvisioningError);
  });

  it('reads every DescribeFileSystemAliases page, following NextToken', async () => {
    const tokens: Array<string | undefined> = [];
    mockSend.mockImplementation(async (command: unknown) => {
      if (command instanceof DescribeFileSystemAliasesCommand) {
        tokens.push(command.input.NextToken);
        return command.input.NextToken === 't'
          ? { Aliases: [{ Name: 'a.example.com', Lifecycle: 'AVAILABLE' }] }
          : { Aliases: [{ Name: 'other.example.com', Lifecycle: 'AVAILABLE' }], NextToken: 't' };
      }
      if (command instanceof DescribeFileSystemsCommand) {
        return { FileSystems: [{ FileSystemId: FS_ID, Lifecycle: 'AVAILABLE' }] };
      }
      return {};
    });
    await update(windows({ Aliases: ['a.example.com'] }), windows({}));
    // The reconcile read finds a.example.com on page two, so nothing is sent
    // and the wait settles on its first two-page read.
    expect(tokens).toEqual([undefined, 't', undefined, 't']);
    expect(mutatingCalls()).toEqual([]);
  });

  it('reads a stale DELETE_FAILED after a fresh Disassociate as not yet the outcome', async () => {
    arm({}, [
      [{ Name: 'a.example.com', Lifecycle: 'DELETE_FAILED' }],
      [{ Name: 'a.example.com', Lifecycle: 'DELETE_FAILED' }],
      [{ Name: 'a.example.com', Lifecycle: 'DELETING' }],
      [],
    ]);
    await update(windows({}), windows({ Aliases: ['a.example.com'] }));
    expect(mutatingCalls().map((c) => c.name)).toEqual(['DisassociateFileSystemAliasesCommand']);
    expect(aliasReads()).toBe(4);
  });

  it('fails at once on DELETE_FAILED read after the name was seen DELETING', async () => {
    arm({}, [
      [{ Name: 'a.example.com', Lifecycle: 'AVAILABLE' }],
      [{ Name: 'a.example.com', Lifecycle: 'DELETING' }],
      [{ Name: 'a.example.com', Lifecycle: 'DELETE_FAILED' }],
    ]);
    const err = await update(windows({}), windows({ Aliases: ['a.example.com'] })).catch(
      (e: unknown) => e
    );
    expect((err as Error).message).toContain('a.example.com entered DELETE_FAILED');
    expect(aliasReads()).toBe(3);
  });

  it('fails on a DELETE_FAILED that never moves, after three reads', async () => {
    arm({}, [[{ Name: 'a.example.com', Lifecycle: 'DELETE_FAILED' }]]);
    const err = await update(windows({}), windows({ Aliases: ['a.example.com'] })).catch(
      (e: unknown) => e
    );
    expect((err as Error).message).toContain('a.example.com entered DELETE_FAILED');
    // The reconcile read, then three failed reads.
    expect(aliasReads()).toBe(4);
  });

  describe('beside a StorageCapacity increase (an optimization running)', () => {
    const fsWith = (actions: Array<{ type: string; status: string }>) => ({
      FileSystems: [
        {
          FileSystemId: FS_ID,
          Lifecycle: 'AVAILABLE',
          AdministrativeActions: actions.map((a) => ({
            AdministrativeActionType: a.type,
            Status: a.status,
            RequestTime: new Date(Date.now() + 60_000),
          })),
        },
      ],
    });
    /** FILE_SYSTEM_UPDATE done but optimizing, STORAGE_OPTIMIZATION running for good. */
    const OPTIMIZING = [
      { type: 'FILE_SYSTEM_UPDATE', status: 'UPDATED_OPTIMIZING' },
      { type: 'STORAGE_OPTIMIZATION', status: 'IN_PROGRESS' },
    ];
    /**
     * `refusals` Associate calls answer a BadRequest naming an administrative
     * action in progress before one is accepted; `fsActions` is what every
     * DescribeFileSystems reports.
     */
    const armOptimizing = (refusals: number, fsActions = OPTIMIZING): void => {
      let refused = 0;
      let associated = false;
      mockSend.mockImplementation(async (command: unknown) => {
        if (command instanceof AssociateFileSystemAliasesCommand) {
          if (refused < refusals) {
            refused += 1;
            throw Object.assign(
              new Error('Unable to perform the operation because an administrative action is in progress.'),
              { name: 'BadRequest' }
            );
          }
          associated = true;
          return {};
        }
        if (command instanceof UpdateFileSystemCommand) {
          return {
            FileSystem: {
              FileSystemId: FS_ID,
              AdministrativeActions: [
                {
                  AdministrativeActionType: 'FILE_SYSTEM_UPDATE',
                  Status: 'IN_PROGRESS',
                  RequestTime: new Date(),
                },
              ],
            },
          };
        }
        if (command instanceof DescribeFileSystemsCommand) return fsWith(fsActions);
        if (command instanceof DescribeFileSystemAliasesCommand) {
          return { Aliases: associated ? [{ Name: 'a.example.com', Lifecycle: 'AVAILABLE' }] : [] };
        }
        return {};
      });
    };
    const capacityAndAlias = (maxWaitMs?: number) =>
      new FSxFileSystemProvider({ pollIntervalMs: 0, ...(maxWaitMs !== undefined && { maxWaitMs }) })
        .update('Fs', FS_ID, TYPE, windows({ Aliases: ['a.example.com'] }), {
          ...windows({}),
          StorageCapacity: 16,
        });

    it('changes the aliases while the storage optimization runs on', async () => {
      armOptimizing(0);
      await capacityAndAlias();
      expect(mutatingCalls().map((c) => c.name)).toEqual([
        'UpdateFileSystemCommand',
        'AssociateFileSystemAliasesCommand',
      ]);
    });

    it('re-sends an Associate FSx refused with an administrative action in progress', async () => {
      armOptimizing(2);
      await capacityAndAlias();
      expect(mutatingCalls().map((c) => c.name)).toEqual([
        'UpdateFileSystemCommand',
        'AssociateFileSystemAliasesCommand',
        'AssociateFileSystemAliasesCommand',
        'AssociateFileSystemAliasesCommand',
      ]);
    });

    it('fails on the deadline naming the running action when FSx keeps refusing', async () => {
      armOptimizing(Number.POSITIVE_INFINITY);
      const err = await capacityAndAlias(50).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProvisioningError);
      expect((err as Error).message).toContain('STORAGE_OPTIMIZATION');
      expect((err as Error).message).toContain('kept refusing');
    });

    it('still waits out another administrative action before an alias call', async () => {
      armOptimizing(0, [{ type: 'FILE_SYSTEM_ALIAS_DISASSOCIATION', status: 'IN_PROGRESS' }]);
      const err = await new FSxFileSystemProvider({ pollIntervalMs: 0, maxWaitMs: 50 })
        .update('Fs', FS_ID, TYPE, windows({ Aliases: ['a.example.com'] }), windows({}))
        .catch((e: unknown) => e);
      expect((err as Error).message).toContain('FILE_SYSTEM_ALIAS_DISASSOCIATION');
      expect(mutatingCalls()).toEqual([]);
    });

    it('does not re-send on any other BadRequest', async () => {
      mockSend.mockImplementation(async (command: unknown) => {
        if (command instanceof AssociateFileSystemAliasesCommand) {
          throw Object.assign(new Error('Invalid alias name'), { name: 'BadRequest' });
        }
        if (command instanceof DescribeFileSystemsCommand) return fsWith([]);
        if (command instanceof DescribeFileSystemAliasesCommand) return { Aliases: [] };
        return {};
      });
      const err = await update(windows({ Aliases: ['a.example.com'] }), windows({})).catch(
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(ProvisioningError);
      expect(mutatingCalls().map((c) => c.name)).toEqual(['AssociateFileSystemAliasesCommand']);
    });
  });

  it('gives the update-action wait and the alias waits one maxWaitMs deadline', async () => {
    // A fake clock each describe advances: the FILE_SYSTEM_UPDATE action runs
    // until t=60 of a 100 deadline, so the alias wait (never AVAILABLE) has
    // what is left, ~4 reads at 10 each, not a fresh 100.
    let clock = 1_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const start = clock;
    let aliasReadsSeen = 0;
    try {
      mockSend.mockImplementation(async (command: unknown) => {
        if (command instanceof UpdateFileSystemCommand) {
          return {
            FileSystem: {
              FileSystemId: FS_ID,
              AdministrativeActions: [
                {
                  AdministrativeActionType: 'FILE_SYSTEM_UPDATE',
                  Status: 'IN_PROGRESS',
                  RequestTime: new Date(clock),
                },
              ],
            },
          };
        }
        if (command instanceof DescribeFileSystemsCommand) {
          clock += 30;
          return {
            FileSystems: [
              {
                FileSystemId: FS_ID,
                Lifecycle: 'AVAILABLE',
                AdministrativeActions: [
                  {
                    AdministrativeActionType: 'FILE_SYSTEM_UPDATE',
                    Status: clock - start >= 60 ? 'COMPLETED' : 'IN_PROGRESS',
                    RequestTime: new Date(start),
                  },
                ],
              },
            ],
          };
        }
        if (command instanceof DescribeFileSystemAliasesCommand) {
          clock += 10;
          aliasReadsSeen += 1;
          return { Aliases: [] };
        }
        return {};
      });
      const err = await new FSxFileSystemProvider({ pollIntervalMs: 0, maxWaitMs: 100 })
        .update(
          'Fs',
          FS_ID,
          TYPE,
          windows({ Aliases: ['a.example.com'], WeeklyMaintenanceStartTime: '2:06:00' }),
          windows({})
        )
        .catch((e: unknown) => e);
      expect((err as Error).message).toContain('Timed out');
      expect(aliasReadsSeen).toBeLessThanOrEqual(5);
    } finally {
      now.mockRestore();
    }
  });

  it('counts the deadline from the start of update(), the UpdateFileSystem call included', async () => {
    // UpdateFileSystem itself takes 80 of a 100 deadline; its action would
    // complete at t=140, so the FILE_SYSTEM_UPDATE wait must time out rather
    // than start a fresh 100 of its own.
    let clock = 2_000_000;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    const start = clock;
    try {
      mockSend.mockImplementation(async (command: unknown) => {
        if (command instanceof UpdateFileSystemCommand) {
          clock += 80;
          return { FileSystem: { FileSystemId: FS_ID, AdministrativeActions: [] } };
        }
        if (command instanceof DescribeFileSystemsCommand) {
          clock += 30;
          return {
            FileSystems: [
              {
                FileSystemId: FS_ID,
                Lifecycle: 'AVAILABLE',
                AdministrativeActions: [
                  {
                    AdministrativeActionType: 'FILE_SYSTEM_UPDATE',
                    Status: clock - start >= 140 ? 'COMPLETED' : 'IN_PROGRESS',
                    RequestTime: new Date(start),
                  },
                ],
              },
            ],
          };
        }
        if (command instanceof DescribeFileSystemAliasesCommand) {
          return { Aliases: [{ Name: 'a.example.com', Lifecycle: 'AVAILABLE' }] };
        }
        return {};
      });
      const err = await new FSxFileSystemProvider({ pollIntervalMs: 0, maxWaitMs: 100 })
        .update(
          'Fs',
          FS_ID,
          TYPE,
          windows({ Aliases: ['a.example.com'], WeeklyMaintenanceStartTime: '2:06:00' }),
          windows({})
        )
        .catch((e: unknown) => e);
      expect((err as Error).message).toContain('update to complete');
    } finally {
      now.mockRestore();
    }
  });

  it.each(['ActiveDirectoryId', 'PreferredSubnetId'])(
    'still refuses a %s change before any call: no FSx API changes it',
    async (key) => {
      arm();
      const err = await update(windows({ [key]: 'changed' }), windows({})).catch(
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );
});

describe('FSx Windows Aliases drift (go-to-k/cdkd#5469)', () => {
  const provider = new FSxFileSystemProvider({ pollIntervalMs: 0 });
  it('lowercases alias names on a comparison side, as FSx stores them', () => {
    expect(
      provider.canonicalizeDriftProperties(TYPE, windows({ Aliases: ['Keep.Example.com'] }))
    ).toEqual(windows({ Aliases: ['keep.example.com'] }));
  });
  it('returns an already-lowercase side by identity', () => {
    const side = windows({ Aliases: ['keep.example.com'] });
    expect(provider.canonicalizeDriftProperties(TYPE, side)).toBe(side);
  });
});
