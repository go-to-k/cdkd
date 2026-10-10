import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * Issue #4018: `cdkd deploy` derives a user-supplied physical name inside
 * `withSkipPrefix(<resolved flag>)`, but `cdkd rollback` replayed its journal
 * inside `withStackName` alone, so a provider that rewrites even an explicit
 * name (`generateResourceNameWithFallback`: IAM Role / User / Group /
 * InstanceProfile / ManagedPolicy, ELBv2 LB / TG) re-created the old resource
 * under `<stack>-<name>` although the deploy had created `<name>`.
 *
 * Driven through the REAL `rollbackCommand`, the REAL `replayRollback` and the
 * REAL `IAMRoleProvider`; only the IAM client's `send` (an in-memory account)
 * and the state backend are stubbed. The discriminator is the `RoleName` the
 * re-create SENDS, read off the fake account.
 */

const logger = vi.hoisted(() => {
  const l = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: (): unknown => l,
  };
  return l;
});
vi.mock('../../../../src/utils/logger.js', () => ({ getLogger: () => logger }));

vi.mock('../../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));

const iamSend = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ iam: { send: iamSend, config: { region: async () => 'us-east-1' } } }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn().mockImplementation(() => ({ destroy: vi.fn() })),
}));

// The registry routes every type to ONE real IAMRoleProvider, built lazily so
// it picks up the mocked client above.
const registry = vi.hoisted(() => ({ provider: undefined as unknown }));
vi.mock('../../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    getProviderFor: () => ({ provider: registry.provider, provisionedBy: 'sdk' }),
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));

vi.mock('../../../../src/cli/commands/deployment-events-run.js', () => ({
  startRunRecorder: () => ({ record: vi.fn(), finalize: vi.fn().mockResolvedValue(undefined) }),
}));

// `cdkd rollback` asks only without --force; T4's case answers it here so the
// order of the legacy warning and the prompt can be read.
const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../../../src/cli/commands/confirm-prompt.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/cli/commands/confirm-prompt.js')>()),
  confirmOrRefuse: confirmMock,
}));

const setupMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/cli/commands/state.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../src/cli/commands/state.js')>(
    '../../../../src/cli/commands/state.js'
  );
  return { ...actual, setupStateBackend: (...args: unknown[]) => setupMock(...args) };
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoSuchEntityException } from '@aws-sdk/client-iam';
import { rollbackCommand } from '../../../../src/cli/commands/rollback.js';
import { IAMManagedPolicyProvider } from '../../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { IAMRoleProvider } from '../../../../src/provisioning/providers/iam-role-provider.js';
import type { RollbackJournalSegment } from '../../../../src/types/rollback-journal.js';
import { awsSdkError } from '../../_aws-sdk-error.js';

const STACK = 'S';
const ROLE = 'AWS::IAM::Role';
const TRUST = { Version: '2012-10-17', Statement: [] };

/** An in-memory IAM account: the role names that exist, and every CreateRole's name. */
function fakeIam(existing: string[]): { roles: Set<string>; created: string[] } {
  const roles = new Set(existing);
  const created: string[] = [];
  iamSend.mockImplementation(async (command: unknown) => {
    const c = command as {
      constructor: { name: string };
      input?: { RoleName?: string; PolicyName?: string };
    };
    const name = String(c.input?.RoleName);
    switch (c.constructor.name) {
      case 'CreatePolicyCommand':
        created.push(String(c.input?.PolicyName));
        return { Policy: { Arn: `arn:aws:iam::123456789012:policy/${c.input?.PolicyName}` } };
      case 'CreateRoleCommand':
        created.push(name);
        if (roles.has(name)) {
          throw awsSdkError(`Role with name ${name} already exists.`, 'EntityAlreadyExistsException');
        }
        roles.add(name);
        return { Role: { Arn: `arn:aws:iam::123456789012:role/${name}`, RoleId: 'AROAX' } };
      case 'GetRoleCommand':
        if (!roles.has(name)) {
          throw new NoSuchEntityException({ message: `Role ${name} not found`, $metadata: {} });
        }
        return { Role: { RoleName: name, Arn: `arn:aws:iam::123456789012:role/${name}` } };
      case 'DeleteRoleCommand':
        roles.delete(name);
        return {};
      default:
        // List* for the delete's detach sweep: nothing attached.
        return { AttachedPolicies: [], PolicyNames: [], InstanceProfiles: [], Versions: [] };
    }
  });
  return { roles, created };
}

function roleRow(physicalId: string, roleName: string): Record<string, unknown> {
  return {
    physicalId,
    resourceType: ROLE,
    properties: { RoleName: roleName, AssumeRolePolicyDocument: TRUST },
    attributes: {},
    dependencies: [],
  };
}

/**
 * The journal a `--no-rollback` deploy leaves after replacing `MyRole` (its
 * create-only `RoleName` changed from `my-role` to `my-role-v2`): the new
 * role is live, the old one was deleted by the forward replacement.
 */
function installRollback(opts: {
  oldPhysicalId: string;
  newPhysicalId: string;
  segment?: Partial<RollbackJournalSegment>;
  /** Replaces the single segment; OLDEST first, as the journal stores them. */
  segments?: Array<Record<string, unknown>>;
  resources?: Record<string, unknown>;
}): { saveState: ReturnType<typeof vi.fn>; popSegment: ReturnType<typeof vi.fn> } {
  const saveState = vi.fn().mockResolvedValue('etag-2');
  const popSegment = vi.fn().mockResolvedValue(0);
  const segment = {
    timestamp: 1,
    reason: 'no-rollback-failure',
    initialDeploy: false,
    operations: [
      {
        logicalId: 'MyRole',
        changeType: 'UPDATE',
        resourceType: ROLE,
        physicalId: opts.newPhysicalId,
        previousState: roleRow(opts.oldPhysicalId, 'my-role'),
      },
    ],
    ...opts.segment,
  };
  setupMock.mockResolvedValue({
    stateBackend: {
      listTopLevelPrefixes: vi.fn().mockResolvedValue([]),
      getRegistryMarker: vi.fn().mockResolvedValue(null),
      claimRegistryMarker: vi.fn().mockResolvedValue('claimed'),
      listStacks: vi.fn().mockResolvedValue([{ stackName: STACK, region: 'us-east-1' }]),
      listRawKeys: vi.fn().mockResolvedValue([]),
      getState: vi.fn().mockResolvedValue({
        state: {
          version: 10,
          stackName: STACK,
          region: 'us-east-1',
          resources: opts.resources ?? { MyRole: roleRow(opts.newPhysicalId, 'my-role-v2') },
          outputs: {},
          lastModified: 1,
        },
        etag: 'etag-1',
      }),
      loadRollbackJournal: vi.fn().mockResolvedValue({
        journalVersion: 1,
        stackName: STACK,
        region: 'us-east-1',
        segments: opts.segments ?? [segment],
      }),
      saveState,
      popRollbackJournalSegment: popSegment,
      setRollbackJournalFailedOperations: vi.fn().mockResolvedValue(undefined),
      deleteState: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    },
    lockManager: {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
      getLockInfo: vi.fn().mockResolvedValue(null),
    },
    awsClients: {},
    region: 'us-east-1',
    bucket: 'b',
    prefix: 'cdkd',
    exportIndexStore: {},
    dispose: vi.fn(),
  });
  return { saveState, popSegment };
}

/** The `MyRole` row of the LAST state save. */
function savedRole(saveState: ReturnType<typeof vi.fn>): { physicalId?: string } | undefined {
  const last = saveState.mock.calls.at(-1);
  return (last?.[2] as { resources: Record<string, { physicalId?: string }> } | undefined)
    ?.resources['MyRole'];
}

function legacyWarnings(): string[] {
  return logger.warn.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.includes('did not record the user-supplied-name prefix setting'));
}

const opts = { statePrefix: 'cdkd', verbose: false, force: true };

/** One replacement op of `logicalId`: role `oldId` (named `name`) replaced by `newId`. */
function replaceOp(logicalId: string, oldId: string, newId: string, name: string): Record<string, unknown> {
  return {
    logicalId,
    changeType: 'UPDATE',
    resourceType: ROLE,
    physicalId: newId,
    previousState: roleRow(oldId, name),
  };
}

function segmentOf(ops: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}) {
  return { timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: ops, ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  iamSend.mockReset();
  registry.provider = new IAMRoleProvider();
  vi.stubEnv('AWS_REGION', 'us-east-1');
  vi.stubEnv('CDKD_PREFIX_USER_SUPPLIED_NAMES', '');
  vi.stubEnv('CDKD_NO_PREFIX_USER_SUPPLIED_NAMES', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('cdkd rollback re-creates under the name the deploy used (#4018)', () => {
  it('a deploy recorded with the prefix SKIPPED: the old role comes back as `my-role`', async () => {
    const aws = fakeIam(['my-role-v2']);
    const { saveState, popSegment } = installRollback({
      oldPhysicalId: 'my-role',
      newPhysicalId: 'my-role-v2',
      segment: { skipPrefix: true },
    });

    await rollbackCommand(STACK, { ...opts });

    // THE DISCRIMINATOR: without the deploy's scope the provider sent
    // `S-my-role`, a role the stack never had.
    expect(aws.created).toEqual(['my-role']);
    expect([...aws.roles]).toEqual(['my-role']);
    expect(savedRole(saveState)?.physicalId).toBe('my-role');
    expect(popSegment).toHaveBeenCalledTimes(1);
    expect(legacyWarnings()).toEqual([]);
  });

  it('NEGATIVE CONTROL: a deploy recorded with the prefix KEPT re-creates `S-my-role`', async () => {
    // The ambient resolution (no env, no cdk.json) would skip the prefix, so
    // this case reds a fix that ignores the recorded flag.
    const aws = fakeIam(['S-my-role-v2']);
    const { saveState } = installRollback({
      oldPhysicalId: 'S-my-role',
      newPhysicalId: 'S-my-role-v2',
      segment: { skipPrefix: false },
    });

    await rollbackCommand(STACK, { ...opts });

    expect(aws.created).toEqual(['S-my-role']);
    expect([...aws.roles]).toEqual(['S-my-role']);
    expect(savedRole(saveState)?.physicalId).toBe('S-my-role');
    expect(legacyWarnings()).toEqual([]);
  });

  it('a segment an older cdkd wrote falls back to the default (prefix skipped) and warns', async () => {
    const aws = fakeIam(['my-role-v2']);
    installRollback({ oldPhysicalId: 'my-role', newPhysicalId: 'my-role-v2' });

    await rollbackCommand(STACK, { ...opts });

    expect(aws.created).toEqual(['my-role']);
    const warned = legacyWarnings();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('stack-name prefix SKIPPED');
    expect(warned[0]).toContain('CDKD_PREFIX_USER_SUPPLIED_NAMES=true');
  });

  it('the old-journal fallback does not repeat the deploy-time deprecation warning', async () => {
    vi.stubEnv('CDKD_NO_PREFIX_USER_SUPPLIED_NAMES', 'true');
    fakeIam(['my-role-v2']);
    installRollback({ oldPhysicalId: 'my-role', newPhysicalId: 'my-role-v2' });

    await rollbackCommand(STACK, { ...opts });

    expect(legacyWarnings()).toHaveLength(1);
    const deprecation = logger.warn.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.includes('is deprecated since v0.94.0'));
    expect(deprecation).toEqual([]);
  });

  it('a segment an older cdkd wrote honours CDKD_PREFIX_USER_SUPPLIED_NAMES=true', async () => {
    vi.stubEnv('CDKD_PREFIX_USER_SUPPLIED_NAMES', 'true');
    const aws = fakeIam(['S-my-role-v2']);
    installRollback({ oldPhysicalId: 'S-my-role', newPhysicalId: 'S-my-role-v2' });

    await rollbackCommand(STACK, { ...opts });

    expect(aws.created).toEqual(['S-my-role']);
    const warned = legacyWarnings();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('stack-name prefix KEPT');
  });

  // The in-place arm has the same defect in a worse shape: the provider's
  // `update()` re-derives the name, so under the wrong flag a plain revert of
  // `my-role` became a REPLACEMENT to `S-my-role` that deleted `my-role`.
  it('an in-place UPDATE revert of `my-role` stays in place (no create, no delete)', async () => {
    const aws = fakeIam(['my-role']);
    const withDescription = (description: string): Record<string, unknown> => ({
      ...roleRow('my-role', 'my-role'),
      properties: { RoleName: 'my-role', AssumeRolePolicyDocument: TRUST, Description: description },
    });
    const { saveState } = installRollback({
      oldPhysicalId: 'my-role',
      newPhysicalId: 'my-role',
      segment: {
        skipPrefix: true,
        operations: [
          {
            logicalId: 'MyRole',
            changeType: 'UPDATE',
            resourceType: ROLE,
            physicalId: 'my-role',
            previousState: withDescription('old') as never,
          },
        ],
      },
    });

    await rollbackCommand(STACK, { ...opts });

    expect(aws.created).toEqual([]);
    expect([...aws.roles]).toEqual(['my-role']);
    const sent = iamSend.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name);
    expect(sent).not.toContain('DeleteRoleCommand');
    expect(sent).toContain('UpdateRoleCommand');
    expect(savedRole(saveState)?.physicalId).toBe('my-role');
  });

  // T2: every segment carries its OWN deploy's flag. Replayed newest-first:
  // the newer segment (B, prefix skipped) first, then the older (A, prefix kept).
  it('two segments recorded under DIFFERENT flags each replay under their own', async () => {
    const aws = fakeIam(['S-a-v2', 'b-v2']);
    installRollback({
      oldPhysicalId: '',
      newPhysicalId: '',
      resources: { A: roleRow('S-a-v2', 'a-v2'), B: roleRow('b-v2', 'b-v2') },
      segments: [
        segmentOf([replaceOp('A', 'S-a', 'S-a-v2', 'a')], { skipPrefix: false }),
        segmentOf([replaceOp('B', 'b', 'b-v2', 'b')], { skipPrefix: true }),
      ],
    });

    await rollbackCommand(STACK, { ...opts });

    expect(aws.created).toEqual(['b', 'S-a']);
    expect(legacyWarnings()).toEqual([]);
  });

  it('a legacy segment beside a recorded one: the fallback reaches only the legacy one, and warns once', async () => {
    // No env and no cdk.json: the fallback skips the prefix, the recorded
    // segment keeps it -- so a fallback that overrode it would send `b`.
    const aws = fakeIam(['a-v2', 'S-b-v2']);
    installRollback({
      oldPhysicalId: '',
      newPhysicalId: '',
      resources: { A: roleRow('a-v2', 'a-v2'), B: roleRow('S-b-v2', 'b-v2') },
      segments: [
        segmentOf([replaceOp('A', 'a', 'a-v2', 'a')]),
        segmentOf([replaceOp('B', 'S-b', 'S-b-v2', 'b')], { skipPrefix: false }),
      ],
    });

    await rollbackCommand(STACK, { ...opts });

    expect(aws.created).toEqual(['S-b', 'a']);
    const warned = legacyWarnings();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('1 of 2 rollback journal segment(s)');
  });

  it('two legacy segments warn ONCE', async () => {
    fakeIam(['a-v2', 'b-v2']);
    installRollback({
      oldPhysicalId: '',
      newPhysicalId: '',
      resources: { A: roleRow('a-v2', 'a-v2'), B: roleRow('b-v2', 'b-v2') },
      segments: [
        segmentOf([replaceOp('A', 'a', 'a-v2', 'a')]),
        segmentOf([replaceOp('B', 'b', 'b-v2', 'b')]),
      ],
    });

    await rollbackCommand(STACK, { ...opts });

    const warned = legacyWarnings();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('2 of 2 rollback journal segment(s)');
  });

  // T3: a failed UPDATE's revert re-derives the name in `update()` exactly as
  // a completed one does, so it must run inside the segment's scope too.
  it('--revert-failed reverts a failed UPDATE of `my-role` in place under the recorded flag', async () => {
    const aws = fakeIam(['my-role']);
    installRollback({
      oldPhysicalId: 'my-role',
      newPhysicalId: 'my-role',
      segment: {
        skipPrefix: true,
        operations: [],
        failedOperations: [
          {
            logicalId: 'MyRole',
            changeType: 'UPDATE',
            resourceType: ROLE,
            physicalId: 'my-role',
            previousState: {
              ...roleRow('my-role', 'my-role'),
              properties: { RoleName: 'my-role', AssumeRolePolicyDocument: TRUST, Description: 'old' },
            },
            attemptedProperties: { RoleName: 'my-role', AssumeRolePolicyDocument: TRUST, Description: 'new' },
          },
        ] as never,
      },
    });

    await rollbackCommand(STACK, { ...opts, revertFailed: true });

    expect(aws.created).toEqual([]);
    expect([...aws.roles]).toEqual(['my-role']);
    const sent = iamSend.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name);
    expect(sent).not.toContain('DeleteRoleCommand');
    expect(sent).toContain('UpdateRoleCommand');
  });

  // T4: the warning is the user's only chance to decline a rollback that
  // would pick the wrong names, so it must come BEFORE the prompt.
  it('warns about a legacy journal BEFORE asking for confirmation', async () => {
    fakeIam(['my-role-v2']);
    installRollback({ oldPhysicalId: 'my-role', newPhysicalId: 'my-role-v2' });

    await rollbackCommand(STACK, { ...opts, force: false });

    expect(confirmMock).toHaveBeenCalledTimes(1);
    const warnAt = logger.warn.mock.calls.findIndex((c) =>
      String(c[0]).includes('did not record the user-supplied-name prefix setting')
    );
    expect(warnAt).toBeGreaterThanOrEqual(0);
    expect(logger.warn.mock.invocationCallOrder[warnAt]!).toBeLessThan(
      confirmMock.mock.invocationCallOrder[0]!
    );
  });

  // T5: the cdk.json tier of the fallback, read from the CURRENT directory.
  it('a legacy segment honours context.cdkd.prefixUserSuppliedNames in ./cdk.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-4018-'));
    try {
      writeFileSync(
        join(dir, 'cdk.json'),
        JSON.stringify({ context: { cdkd: { prefixUserSuppliedNames: true } } })
      );
      vi.spyOn(process, 'cwd').mockReturnValue(dir);
      const aws = fakeIam(['S-my-role-v2']);
      installRollback({ oldPhysicalId: 'S-my-role', newPhysicalId: 'S-my-role-v2' });

      await rollbackCommand(STACK, { ...opts });

      expect(aws.created).toEqual(['S-my-role']);
      expect(legacyWarnings()[0]).toContain('stack-name prefix KEPT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // T7: the managed policy provider's `update()` re-derives its name the same
  // way the role's does, so an in-place revert under the wrong flag replaced it.
  it('an in-place UPDATE revert of managed policy `my-policy` stays in place', async () => {
    registry.provider = new IAMManagedPolicyProvider();
    const aws = fakeIam([]);
    const ARN = 'arn:aws:iam::123456789012:policy/my-policy';
    const policy = (statement: string): Record<string, unknown> => ({
      physicalId: ARN,
      resourceType: 'AWS::IAM::ManagedPolicy',
      properties: {
        ManagedPolicyName: 'my-policy',
        PolicyDocument: { Version: '2012-10-17', Statement: [{ Sid: statement }] },
      },
      attributes: {},
      dependencies: [],
    });
    installRollback({
      oldPhysicalId: ARN,
      newPhysicalId: ARN,
      resources: { MyPolicy: policy('new') },
      segment: {
        skipPrefix: true,
        operations: [
          {
            logicalId: 'MyPolicy',
            changeType: 'UPDATE',
            resourceType: 'AWS::IAM::ManagedPolicy',
            physicalId: ARN,
            previousState: policy('old') as never,
          },
        ],
      },
    });

    await rollbackCommand(STACK, { ...opts });

    expect(aws.created).toEqual([]);
    const sent = iamSend.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name);
    expect(sent).toContain('CreatePolicyVersionCommand');
    expect(sent).not.toContain('DeletePolicyCommand');
  });

  // Issue #4024: an old physical id one setting derives is re-created under
  // THAT setting, so the cases above no longer tell the recorded flag apart
  // from the id. An id NEITHER derives is where the segment's flag still
  // decides the name -- with the environment set the other way, so a
  // rollback reading the env instead reds too.
  it.each([
    [false, '', 'S-my-role'],
    [true, 'true', 'my-role'],
  ] as const)(
    'an old id neither setting derives: segment skipPrefix=%s (env CDKD_PREFIX_USER_SUPPLIED_NAMES="%s") sends %s',
    async (skipPrefix, envPrefix, sent) => {
      vi.stubEnv('CDKD_PREFIX_USER_SUPPLIED_NAMES', envPrefix);
      const aws = fakeIam(['my-role-v2']);
      installRollback({
        oldPhysicalId: 'imported-role',
        newPhysicalId: 'my-role-v2',
        segment: { skipPrefix },
      });

      await rollbackCommand(STACK, { ...opts });

      expect(aws.created).toEqual([sent]);
      expect(legacyWarnings()).toEqual([]);
    }
  );

  it('the recorded flag wins over the environment', async () => {
    vi.stubEnv('CDKD_PREFIX_USER_SUPPLIED_NAMES', 'true');
    const aws = fakeIam(['my-role-v2']);
    installRollback({
      oldPhysicalId: 'my-role',
      newPhysicalId: 'my-role-v2',
      segment: { skipPrefix: true },
    });

    await rollbackCommand(STACK, { ...opts });

    expect(aws.created).toEqual(['my-role']);
    expect(legacyWarnings()).toEqual([]);
  });
});
