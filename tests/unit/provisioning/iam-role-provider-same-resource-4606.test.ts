import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#4606: the live identity read a successful deploy asks before
// deleting a fix-forward's earlier IAM role (only `'different'` lets it
// delete), and the `RoleId` a failed CREATE journals beside the orphan's role
// name for the settle to compare, so a role re-created under the name is
// never deleted as the orphan.

const mockSend = vi.hoisted(() => vi.fn());
const clientRegion = vi.hoisted(() => ({ value: 'us-east-1' }));
const providerLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...providerLogger, child: () => providerLogger }),
}));

// Not an `IAMClient`, so `IamCreateClientCache` sends CreateRole through this
// same double.
const sharedClient = vi.hoisted(() => ({
  send: mockSend,
  config: { region: () => Promise.resolve(clientRegion.value) },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ iam: sharedClient }),
}));

import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  EntityAlreadyExistsException,
  GetRoleCommand,
  ListAttachedRolePoliciesCommand,
  ListRolePoliciesCommand,
  NoSuchEntityException,
  PutRolePolicyCommand,
} from '@aws-sdk/client-iam';
import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import {
  createdBeforeFailure,
  createdResourceIdentityBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { withRetry } from '../../../src/deployment/retry.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { settleJournaledOrphansOnSuccess } from '../../../src/deployment/rollback-executor/journaled-orphans.js';
import type { RollbackExecutorContext } from '../../../src/deployment/rollback-executor.js';
import { withPrintingSecrets } from '../../../src/deployment/resource-secrets-scope.js';
import { recordLogOnlyValue, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';

const TYPE = 'AWS::IAM::Role';
const CTX = { expectedRegion: 'us-east-1' };
const ID_A = 'AROAAAAAAAAAAAAAAAAA1';
const ID_A2 = 'AROAAAAAAAAAAAAAAAAA2';
const ID_B = 'AROABBBBBBBBBBBBBBBB1';

const notFound = (name: string): Error =>
  new NoSuchEntityException({
    message: `The role with name ${name} cannot be found.`,
    $metadata: {},
  });

const denied = (op: string): Error =>
  Object.assign(new Error(`User is not authorized to perform: iam:${op}`), {
    name: 'AccessDenied',
  });

/**
 * One role name's GetRole answer: its `RoleId`, gone, an error, a response
 * naming another role, or one naming no `RoleId`.
 */
type Entry = string | 'gone' | Error | { answeredAs: string } | 'no-id';

/** GetRole answers per role name, exactly as asked. */
function live(entries: Record<string, Entry>): void {
  mockSend.mockImplementation(async (cmd: unknown) => {
    if (!(cmd instanceof GetRoleCommand)) throw new Error('unexpected command');
    const asked = cmd.input.RoleName!;
    const entry = entries[asked];
    if (entry === undefined || entry === 'gone') throw notFound(asked);
    if (entry instanceof Error) throw entry;
    if (entry === 'no-id') return { Role: { RoleName: asked, Arn: `arn:aws:iam::1:role/${asked}` } };
    if (typeof entry === 'object') {
      return { Role: { RoleName: entry.answeredAs, RoleId: ID_B } };
    }
    return { Role: { RoleName: asked, Arn: `arn:aws:iam::1:role/${asked}`, RoleId: entry } };
  });
}

const askedNames = (): Array<string | undefined> =>
  mockSend.mock.calls.map(([cmd]) =>
    cmd instanceof GetRoleCommand ? cmd.input.RoleName : `<${String(cmd)}>`
  );

describe('IAMRoleProvider.isSameResource (go-to-k/cdkd#4606)', () => {
  let provider: IAMRoleProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    provider = new IAMRoleProvider();
  });

  it('another live role under another name is different', async () => {
    live({ 'role-a': ID_A, 'role-b': ID_B });
    await expect(provider.isSameResource('role-a', { physicalId: 'role-b' }, TYPE, CTX)).resolves.toBe(
      'different'
    );
    // The record's role is read first: it must exist for any verdict.
    expect(askedNames()).toEqual(['role-b', 'role-a']);
  });

  it('a journaled role IAM reports gone is different once the record reads back', async () => {
    live({ 'role-b': ID_B });
    await expect(provider.isSameResource('role-a', { physicalId: 'role-b' }, TYPE, CTX)).resolves.toBe(
      'different'
    );
  });

  it('two names reading back under one RoleId are the same (the verdict rests on AWS)', async () => {
    live({ 'role-a': ID_B, 'role-b': ID_B });
    await expect(provider.isSameResource('role-a', { physicalId: 'role-b' }, TYPE, CTX)).resolves.toBe(
      'same'
    );
  });

  it("the record's role gone is unknown, not different, whatever the journaled one reads", async () => {
    for (const journaled of [ID_A, 'gone'] as const) {
      mockSend.mockReset();
      live({ 'role-a': journaled });
      await expect(
        provider.isSameResource('role-a', { physicalId: 'role-b' }, TYPE, CTX)
      ).resolves.toBe('unknown');
      // Nothing proves anything once the record's own role is missing.
      expect(askedNames()).toEqual(['role-b']);
    }
  });

  it('equal names are the same without a read, even from a client in another region', async () => {
    clientRegion.value = 'eu-west-1';
    await expect(provider.isSameResource('role-a', { physicalId: 'role-a' }, TYPE, CTX)).resolves.toBe(
      'same'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  // IAM role names are unique regardless of case: `Role-A` and `role-a` would
  // be one role, and this check does not decide on IAM's case rules.
  it('names differing only in case are unknown, with no read', async () => {
    await expect(provider.isSameResource('Role-A', { physicalId: 'role-a' }, TYPE, CTX)).resolves.toBe(
      'unknown'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a read failing other than with NoSuchEntityException throws (the caller reads it as unknown)', async () => {
    live({ 'role-a': denied('GetRole'), 'role-b': ID_B });
    await expect(
      provider.isSameResource('role-a', { physicalId: 'role-b' }, TYPE, CTX)
    ).rejects.toThrow(/not authorized/);
  });

  it("the record's read failing throws before the journaled one is read", async () => {
    live({ 'role-a': ID_A, 'role-b': denied('GetRole') });
    await expect(
      provider.isSameResource('role-a', { physicalId: 'role-b' }, TYPE, CTX)
    ).rejects.toThrow(/not authorized/);
    expect(askedNames()).toEqual(['role-b']);
  });

  it('"cannot be found" in the message of another error class never reads as gone', async () => {
    const lookalike = Object.assign(new Error('The role with name role-a cannot be found.'), {
      name: 'ServiceFailure',
    });
    live({ 'role-a': lookalike, 'role-b': ID_B });
    await expect(
      provider.isSameResource('role-a', { physicalId: 'role-b' }, TYPE, CTX)
    ).rejects.toThrow(/cannot be found/);
  });

  it('a response naming another role, or no RoleId, throws rather than comparing it', async () => {
    live({ 'role-a': { answeredAs: 'role-x' }, 'role-b': ID_B });
    await expect(
      provider.isSameResource('role-a', { physicalId: 'role-b' }, TYPE, CTX)
    ).rejects.toThrow(/another role/);
    mockSend.mockReset();
    live({ 'role-a': 'no-id', 'role-b': ID_B });
    await expect(
      provider.isSameResource('role-a', { physicalId: 'role-b' }, TYPE, CTX)
    ).rejects.toThrow(/no RoleId/);
    mockSend.mockReset();
    live({ 'role-a': ID_A, 'role-b': 'no-id' });
    await expect(
      provider.isSameResource('role-a', { physicalId: 'role-b' }, TYPE, CTX)
    ).rejects.toThrow(/no RoleId/);
  });

  it('a client in another region is unknown, with no read', async () => {
    clientRegion.value = 'eu-west-1';
    live({ 'role-a': ID_A, 'role-b': ID_B });
    await expect(provider.isSameResource('role-a', { physicalId: 'role-b' }, TYPE, CTX)).resolves.toBe(
      'unknown'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each([
    ['an ARN', 'arn:aws:iam::123456789012:role/role-a'],
    ['a path-qualified name', 'svc/role-a'],
    ['an empty id', ''],
    ['a 65-character name', 'r'.repeat(65)],
    ['a name with a space', 'role a'],
  ])('%s on either side is unknown, with no read', async (_label, id) => {
    await expect(provider.isSameResource(id, { physicalId: 'role-b' }, TYPE, CTX)).resolves.toBe(
      'unknown'
    );
    await expect(provider.isSameResource('role-a', { physicalId: id }, TYPE, CTX)).resolves.toBe(
      'unknown'
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('another type is unknown, with no read', async () => {
    await expect(
      provider.isSameResource('role-a', { physicalId: 'role-b' }, 'AWS::IAM::User', CTX)
    ).resolves.toBe('unknown');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('the longest legal name, and one using every legal character class, are read', async () => {
    const longest = 'r'.repeat(64);
    const every = 'Ab9+=,.@_-';
    live({ [longest]: ID_A, [every]: ID_B });
    await expect(provider.isSameResource(longest, { physicalId: every }, TYPE, CTX)).resolves.toBe(
      'different'
    );
    expect(askedNames()).toEqual([every, longest]);
  });
});

describe('IAMRoleProvider.resourceIdentity (go-to-k/cdkd#4606)', () => {
  let provider: IAMRoleProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
    provider = new IAMRoleProvider();
  });

  it('is the live RoleId, read under the name as written', async () => {
    live({ 'role-a': ID_A });
    await expect(provider.resourceIdentity('role-a', TYPE, CTX)).resolves.toBe(ID_A);
    expect(askedNames()).toEqual(['role-a']);
  });

  it('a role re-created under the name (another RoleId) reads another token', async () => {
    live({ 'role-a': ID_A2 });
    const token = await provider.resourceIdentity('role-a', TYPE, CTX);
    expect(token).toBe(ID_A2);
    expect(token).not.toBe(ID_A);
  });

  it('is RESOURCE_NOT_FOUND on NoSuchEntityException', async () => {
    live({});
    await expect(provider.resourceIdentity('role-a', TYPE, CTX)).resolves.toBe(RESOURCE_NOT_FOUND);
  });

  it('throws on any other failure, "cannot be found" in the message included (never gone)', async () => {
    live({ 'role-a': denied('GetRole') });
    await expect(provider.resourceIdentity('role-a', TYPE, CTX)).rejects.toThrow(/not authorized/);
    mockSend.mockReset();
    live({
      'role-a': Object.assign(new Error('The role cannot be found.'), { name: 'ServiceFailure' }),
    });
    await expect(provider.resourceIdentity('role-a', TYPE, CTX)).rejects.toThrow(/cannot be found/);
  });

  it('throws on a response naming no RoleId, or another role', async () => {
    live({ 'role-a': 'no-id' });
    await expect(provider.resourceIdentity('role-a', TYPE, CTX)).rejects.toThrow(/no RoleId/);
    mockSend.mockReset();
    live({ 'role-a': { answeredAs: 'Role-A' } });
    await expect(provider.resourceIdentity('role-a', TYPE, CTX)).rejects.toThrow(/another role/);
  });

  it('is undefined, with no read, for a client in another region', async () => {
    clientRegion.value = 'eu-west-1';
    live({ 'role-a': ID_A });
    await expect(provider.resourceIdentity('role-a', TYPE, CTX)).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('is undefined, with no read, for an id that is not a role name, or another type', async () => {
    live({ 'role-a': ID_A });
    await expect(
      provider.resourceIdentity('arn:aws:iam::1:role/role-a', TYPE, CTX)
    ).resolves.toBeUndefined();
    await expect(provider.resourceIdentity('', TYPE, CTX)).resolves.toBeUndefined();
    await expect(provider.resourceIdentity('role-a', 'AWS::IAM::User', CTX)).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe("the created-before-failure mark carries CreateRole's RoleId (go-to-k/cdkd#4606)", () => {
  const ASSUME = {
    Version: '2012-10-17',
    Statement: [
      { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
    ],
  };
  const PROPS = {
    RoleName: 'role-a',
    AssumeRolePolicyDocument: ASSUME,
    Policies: [
      { PolicyName: 'inline', PolicyDocument: { Version: '2012-10-17', Statement: [] } },
      { PolicyName: 'second', PolicyDocument: { Version: '2012-10-17', Statement: [] } },
    ],
    Tags: [{ Key: 'k', Value: 'v' }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  /**
   * CreateRole answers `roleId` on the first call (a later one
   * EntityAlreadyExists); the first PutRolePolicy succeeds, the second is
   * denied, and so is the cleanup's DeleteRolePolicy unless `cleanupSucceeds`.
   * (The tags ride on CreateRole, go-to-k/cdkd#4971, so no TagRole is sent.)
   */
  function aws(opts: { roleId: string | undefined; cleanupSucceeds?: boolean }): void {
    let creates = 0;
    mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      if (cmd instanceof CreateRoleCommand) {
        if (creates++ > 0) {
          throw new EntityAlreadyExistsException({
            message: 'Role with name role-a already exists.',
            $metadata: {},
          });
        }
        return {
          Role: { RoleName: 'role-a', Arn: 'arn:aws:iam::1:role/role-a', RoleId: opts.roleId },
        };
      }
      if (cmd instanceof PutRolePolicyCommand) {
        if (cmd.input.PolicyName === 'inline') return {};
        throw denied('PutRolePolicy');
      }
      if (cmd instanceof ListAttachedRolePoliciesCommand) return { AttachedPolicies: [] };
      if (cmd instanceof ListRolePoliciesCommand) return { PolicyNames: ['inline'] };
      if (cmd instanceof DeleteRolePolicyCommand) {
        if (opts.cleanupSucceeds === true) return {};
        throw denied('DeleteRolePolicy');
      }
      if (cmd instanceof DeleteRoleCommand) {
        if (opts.cleanupSucceeds === true) return {};
        throw denied('DeleteRole');
      }
      throw new Error(`unexpected command ${cmd.constructor.name}`);
    });
  }

  const failureOf = async (p: Promise<unknown>): Promise<unknown> =>
    p.then(
      () => {
        throw new Error('the create succeeded');
      },
      (e: unknown) => e
    );

  it("a wiring failure after a successful PutRolePolicy whose cleanup fails marks the name and CreateRole's RoleId", async () => {
    aws({ roleId: ID_A });
    const error = await failureOf(new IAMRoleProvider().create('Orphan', TYPE, PROPS));
    expect(createdBeforeFailure(error, 'Orphan', TYPE)).toBe('role-a');
    // The create response's RoleId, never a later read's (none is sent).
    expect(createdResourceIdentityBeforeFailure(error, 'Orphan', TYPE)).toBe(ID_A);
    expect(mockSend.mock.calls.some(([c]) => c instanceof GetRoleCommand)).toBe(false);
    expect(mockSend.mock.calls.some(([c]) => c instanceof PutRolePolicyCommand)).toBe(true);
  });

  // The token the mark carries and the one `resourceIdentity` reads back must
  // be one spelling, or the settle never proves its own orphan.
  it('the marked token equals the live read of the same role', async () => {
    aws({ roleId: ID_A });
    const provider = new IAMRoleProvider();
    const error = await failureOf(provider.create('Orphan', TYPE, PROPS));
    mockSend.mockReset();
    live({ 'role-a': ID_A });
    await expect(provider.resourceIdentity('role-a', TYPE, CTX)).resolves.toBe(
      createdResourceIdentityBeforeFailure(error, 'Orphan', TYPE)
    );
  });

  // The retry the failure may trigger replays the create, which fails with
  // EntityAlreadyExists: the error finally thrown keeps the FIRST attempt's
  // mark, identity included.
  it("a replay failing with EntityAlreadyExists keeps the first attempt's RoleId", async () => {
    aws({ roleId: ID_A });
    const provider = new IAMRoleProvider();
    let attempts = 0;
    const error = await failureOf(
      withRetry(
        () => {
          attempts++;
          return provider.create('Orphan', TYPE, PROPS);
        },
        'Orphan',
        { sleep: async () => {}, maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1 }
      )
    );
    expect(createdBeforeFailure(error, 'Orphan', TYPE)).toBe('role-a');
    expect(createdResourceIdentityBeforeFailure(error, 'Orphan', TYPE)).toBe(ID_A);
    expect(attempts).toBeGreaterThan(1);
  });

  it.each([
    ['no RoleId', undefined],
    ['an empty RoleId', ''],
  ])('a CreateRole response with %s marks the name alone', async (_label, roleId) => {
    aws({ roleId });
    const error = await failureOf(new IAMRoleProvider().create('Orphan', TYPE, PROPS));
    expect(createdBeforeFailure(error, 'Orphan', TYPE)).toBe('role-a');
    expect(createdResourceIdentityBeforeFailure(error, 'Orphan', TYPE)).toBeUndefined();
  });

  it('a cleanup that deleted the role marks nothing, identity included', async () => {
    aws({ roleId: ID_A, cleanupSucceeds: true });
    const error = await failureOf(new IAMRoleProvider().create('Orphan', TYPE, PROPS));
    expect(createdBeforeFailure(error, 'Orphan', TYPE)).toBeUndefined();
    expect(createdResourceIdentityBeforeFailure(error, 'Orphan', TYPE)).toBeUndefined();
  });
});

describe('IAMRoleProvider.delete of a journaled role already gone (go-to-k/cdkd#4606)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  const skipDebugLines = (): number =>
    providerLogger.debug.mock.calls.filter(([m]) => String(m).includes('does not exist, skipping'))
      .length;

  it('names it once at info when GetRole answers not found, since the settle then exits 0', async () => {
    mockSend.mockImplementation(async () => {
      throw notFound('orphan-role');
    });
    const provider = new IAMRoleProvider();
    await provider.delete('Orphan', 'orphan-role', TYPE, {}, {
      expectedRegion: 'us-east-1',
      failedCreateOrphan: true,
    });
    const infos = providerLogger.info.mock.calls.map(([m]) => String(m));
    expect(infos).toHaveLength(1);
    expect(infos[0]).toContain('IAM role orphan-role (Orphan)');
    expect(infos[0]).toContain('already gone');
    expect(skipDebugLines()).toBe(0);
    expect(mockSend.mock.calls.some(([c]) => c instanceof DeleteRoleCommand)).toBe(false);

    // A record's own delete keeps the quiet debug line, the flag absent or false.
    for (const context of [
      { expectedRegion: 'us-east-1' },
      { expectedRegion: 'us-east-1', failedCreateOrphan: false },
    ]) {
      providerLogger.info.mockClear();
      providerLogger.debug.mockClear();
      await provider.delete('Orphan', 'orphan-role', TYPE, {}, context);
      expect(providerLogger.info).not.toHaveBeenCalled();
      expect(skipDebugLines()).toBe(1);
    }
  });

  // go-to-k/cdkd#3869: the settle, `cdkd rollback` and `cdkd destroy` bind a
  // printing bag holding a secret-derived name around this delete; the line
  // carries the name verbatim, so the logger's line masker removes it.
  it('the info line names a secret-derived role only where the bound printing bag masks it', async () => {
    const DERIVED = 'role-from-secret-x9';
    mockSend.mockImplementation(async () => {
      throw notFound(DERIVED);
    });
    const bag = new Map<string, string>();
    recordLogOnlyValue(bag, DERIVED);
    let masked = '<not masked>';
    await withPrintingSecrets(bag, async () => {
      await new IAMRoleProvider().delete('Orphan', DERIVED, TYPE, {}, {
        expectedRegion: 'us-east-1',
        failedCreateOrphan: true,
      });
      const mask = currentLogLineMasker();
      const line = String(providerLogger.info.mock.calls[0]?.[0]);
      expect(line).toContain(DERIVED);
      masked = mask === undefined ? '<no masker bound>' : mask(line);
    });
    expect(masked).not.toContain(DERIVED);
    expect(masked).toContain(SECRET_MASK);
    expect(masked).toContain('already gone');
  });
});

// The settle end to end with the real provider: the journaled orphan `role-a`
// carries its CreateRole response's RoleId (ID_A).
describe('the success settle with IAMRoleProvider (go-to-k/cdkd#4606)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    clientRegion.value = 'us-east-1';
  });

  /**
   * `fixForward`: the fix-forward's record under the orphan's logical id holds
   * `role-b` (this deploy's CREATE), read live as `recordEntry`.
   */
  async function settle(
    liveEntry: Entry,
    fixForward?: { recordEntry: Entry },
    opts: { journaledIdentity: boolean } = { journaledIdentity: true }
  ) {
    const provider = new IAMRoleProvider();
    const del = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);
    live({
      'role-a': liveEntry,
      ...(fixForward !== undefined && { 'role-b': fixForward.recordEntry }),
    });
    const journal = {
      journalVersion: 1,
      stackName: 'S',
      region: 'us-east-1',
      segments: [
        {
          timestamp: 1,
          reason: 'no-rollback-failure',
          initialDeploy: false,
          operations: [],
          failedOperations: [
            {
              logicalId: 'Orphan',
              changeType: 'CREATE',
              resourceType: TYPE,
              physicalId: 'role-a',
              provisionedBy: 'sdk',
              physicalIdRecoveredFromError: true,
              deletionPolicy: 'Delete',
              ...(opts.journaledIdentity && { createdResourceIdentity: ID_A }),
              attemptedProperties: {},
            },
          ],
        },
      ],
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx = {
      providerRegistry: {
        getProviderFor: vi.fn(() => ({ provider, provisionedBy: 'sdk' })),
        getProvider: vi.fn(() => provider),
      },
      region: 'us-east-1',
      logger,
    } as unknown as RollbackExecutorContext;
    const backend = {
      loadRollbackJournal: vi.fn(async () => structuredClone(journal)),
      reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
      markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
      dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
    };
    const out = await settleJournaledOrphansOnSuccess({
      stateBackend: backend as never,
      stackName: 'S',
      region: 'us-east-1',
      stateResources: (fixForward === undefined
        ? {}
        : {
            Orphan: {
              physicalId: 'role-b',
              resourceType: TYPE,
              provisionedBy: 'sdk',
              properties: {},
              attributes: {},
            },
          }) as never,
      rollbackOrphans: undefined,
      newerOperations: (fixForward === undefined
        ? []
        : [
            { logicalId: 'Orphan', changeType: 'CREATE', resourceType: TYPE, physicalId: 'role-b' },
          ]) as never,
      foreignHolder: vi.fn(async () => undefined),
      ctx,
      logger: logger as never,
    });
    return {
      out,
      del,
      backend,
      warned: logger.warn.mock.calls.map((m) => String(m[0])).join('\n'),
      infos: logger.info.mock.calls.map((m) => String(m[0])).join('\n'),
    };
  }

  it('the fix-forward: deletes `role-a` when the record `role-b` reads back', async () => {
    const r = await settle(ID_A, { recordEntry: ID_B });
    expect(r.del).toHaveBeenCalledTimes(1);
    expect(r.del.mock.calls[0]?.[1]).toBe('role-a');
    // The delete is told it acts on a failed CREATE's orphan (the info line
    // for one already gone rests on it).
    expect(r.del.mock.calls[0]?.[4]).toMatchObject({ failedCreateOrphan: true });
    expect(r.out.unaddressed).toBe(0);
    // Nothing is left to keep: the journal goes, with no entry reduced into it.
    expect(r.out.keepJournal).toBe(false);
    expect(r.backend.reduceRollbackJournalToFailedOperations).not.toHaveBeenCalled();
    expect(r.backend.dropRollbackJournalFailedOperations).not.toHaveBeenCalled();
  });

  it('the fix-forward: keeps it when `role-a` was re-created (another RoleId) before the settle', async () => {
    const r = await settle(ID_A2, { recordEntry: ID_B });
    expect(r.del).not.toHaveBeenCalled();
    expect(r.warned).toContain('the resource now under its physical id is another one');
    expect(r.out.unaddressed).toBe(1);
  });

  it('the fix-forward: an earlier role already gone is named, not deleted, and settles', async () => {
    const r = await settle('gone', { recordEntry: ID_B });
    expect(r.del).not.toHaveBeenCalled();
    expect(r.out.unaddressed).toBe(0);
    expect(r.infos).toContain('Orphan (AWS::IAM::Role)');
    expect(r.infos).toContain('is already gone: nothing to delete');
    expect(r.warned).toBe('');
  });

  // A read that cannot answer never reads as `'different'` or gone: the
  // provider throws, the settle reads the throw as unproven, and the orphan is
  // kept with a warning (exit 2), no DeleteRole sent.
  it.each([
    ['a throttle', () => Object.assign(new Error('Rate exceeded'), { name: 'Throttling' })],
    ['AccessDenied', () => denied('GetRole')],
  ])('the fix-forward: keeps it when the identity read fails with %s', async (_label, failure) => {
    const r = await settle(failure(), { recordEntry: ID_B });
    expect(r.del).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalled();
    expect(mockSend.mock.calls.every(([cmd]) => cmd instanceof GetRoleCommand)).toBe(true);
    expect(r.out.unaddressed).toBe(1);
    expect(r.warned).toContain('Orphan (AWS::IAM::Role)');
    expect(r.infos).not.toContain('already gone');
  });

  it("the fix-forward: keeps it when the record's own read fails, whatever the journaled one reads", async () => {
    const r = await settle(ID_A, { recordEntry: denied('GetRole') });
    expect(r.del).not.toHaveBeenCalled();
    expect(r.out.unaddressed).toBe(1);
    expect(r.warned).toContain('Orphan (AWS::IAM::Role)');
  });

  it("the fix-forward: keeps it when the record's role is gone", async () => {
    const r = await settle(ID_A, { recordEntry: 'gone' });
    expect(r.del).not.toHaveBeenCalled();
    expect(r.out.unaddressed).toBe(1);
  });

  // A journal an older cdkd wrote carries no identity: whatever the live reads
  // answer, nothing proves the role under the name is the one its CREATE made,
  // so it is kept with a warning and no DeleteRole is sent.
  it.each([
    ['the fix-forward', { recordEntry: ID_B }],
    ['with no record under the id', undefined],
  ] as const)(
    '%s: an entry with no journaled identity (an older journal) is kept',
    async (_label, fixForward) => {
      const r = await settle(ID_A, fixForward, { journaledIdentity: false });
      expect(r.del).not.toHaveBeenCalled();
      expect(mockSend.mock.calls.some(([c]) => c instanceof DeleteRoleCommand)).toBe(false);
      expect(r.out.unaddressed).toBe(1);
      expect(r.warned).toContain('Orphan (AWS::IAM::Role)');
    }
  );

  it('with no record under the id: deletes it when the name still reads back under the journaled RoleId (control)', async () => {
    const r = await settle(ID_A);
    expect(r.del).toHaveBeenCalledTimes(1);
    expect(r.out.unaddressed).toBe(0);
  });

  it('with no record under the id: keeps it when the name now reads back under another RoleId', async () => {
    const r = await settle(ID_A2);
    expect(r.del).not.toHaveBeenCalled();
    expect(r.warned).toContain('the resource now under its physical id is another one');
    expect(r.out.unaddressed).toBe(1);
  });
});
