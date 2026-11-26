/**
 * go-to-k/cdkd#6734: `cdkd drift --revert` sends `provider.update()` under a
 * view of the stack's IAM principal records, so an `AWS::IAM::Policy` /
 * `AWS::IAM::ManagedPolicy` revert compares each in-stack principal's
 * recorded id before it puts, attaches, removes or detaches by name (the
 * #6703 / #6722 checks). Without the view every principal read as outside the
 * stack: a revert re-adding a dropped `Roles` entry put the policy on a
 * same-named stranger.
 *
 * The view holds the principal records ALONE, so the security group and S3
 * bucket policy readers of the scope keep their unbound behavior on a revert.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this;
    }),
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

import { applyRevertUpdate } from '../../../src/cli/commands/drift/revert-apply.js';
import type { ApplyRevertUpdateArgs } from '../../../src/cli/commands/drift/revert-outcome.js';
import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { getLogger } from '../../../src/utils/logger.js';
import { INLINE_POLICY_PRINCIPAL_SPECS } from '../../../src/provisioning/providers/iam-policy/principal-identity.js';
import { RECORDED_IDENTITY_REREAD_DELAY_MS } from '../../../src/provisioning/recorded-identity.js';
import {
  REVERT_VIEW_RECORD_TYPES,
  getStackRecords,
  revertStackRecordsView,
  verifiedIdentityCache,
  type StackRecordsView,
} from '../../../src/deployment/stack-records-scope.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

let sent: Array<{ name: string; input: Record<string, unknown> }>;

const ARN = 'arn:aws:iam::123456789012:policy/mp';
const policyAnswer = () => ({
  Policy: { Arn: ARN, PolicyName: 'mp', PolicyId: 'ANPA-mp', DefaultVersionId: 'v1' },
});
/** The managed policy's own calls, answered as its update needs them. */
const MANAGED: Record<string, () => unknown> = {
  GetPolicyCommand: policyAnswer,
  ListPolicyVersionsCommand: () => ({ Versions: [] }),
  CreatePolicyVersionCommand: () => ({ PolicyVersion: { VersionId: 'v2' } }),
  ListEntitiesForPolicyCommand: () => ({}),
};

/** Answer each `GetRole` with `liveRoleIds[RoleName]`, `extra` by name, every other call `{}`. */
function drive(liveRoleIds: Record<string, string>, extra: Record<string, () => unknown> = {}): void {
  mockSend.mockImplementation(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      sent.push({ name, input: command.input });
      if (name === 'GetRoleCommand') {
        return { Role: { RoleId: liveRoleIds[String(command.input['RoleName'])] } };
      }
      return extra[name]?.() ?? {};
    }
  );
}
const names = (): string[] => sent.map((s) => s.name);
const providerWarn = () => getLogger().child('x').warn as unknown as ReturnType<typeof vi.fn>;

function record(
  resourceType: string,
  physicalId: string,
  attributes: Record<string, unknown> = {},
  properties: Record<string, unknown> = {}
): ResourceState {
  return { resourceType, physicalId, properties, attributes, dependencies: [] } as ResourceState;
}

const DOC = { Version: '2012-10-17', Statement: [] };
const RECORDED = 'AROA-recorded';

/**
 * One drifted resource's revert: `previous` is what AWS holds, `desired` the
 * recorded baseline the revert sends.
 */
function revertOf(
  resources: Record<string, ResourceState>,
  logicalId: string,
  provider: ResourceProvider,
  previous: Record<string, unknown>,
  desired: Record<string, unknown>
) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const tally = { totalFailed: 0, totalUnsupported: 0, totalSucceeded: 0, totalUnresolvable: 0, reverted: [] };
  const stateResource = resources[logicalId]!;
  const args = {
    logger,
    tally,
    report: { stackName: 'MyStack', region: 'us-east-1', state: { resources } },
    narrowedByLogicalId: new Map(),
    reRecordedByLogicalId: new Map(),
    settledByRevert: new Map(),
    outcome: {
      kind: 'drifted',
      logicalId,
      resourceType: stateResource.resourceType,
      changes: [],
      awsProperties: previous,
      uncertifiedPaths: [],
    },
    stateResource,
    provider,
    secrets: new Map<string, string>(),
    revertBaseline: desired,
    newProperties: desired,
  } as unknown as ApplyRevertUpdateArgs;
  return { args, logger, tally };
}

/** A drifted `AWS::IAM::Policy` whose revert puts it back on `Roles: [my-role]`. */
function policyRevert(
  resources: Record<string, ResourceState>,
  logicalId: string,
  provider: ResourceProvider
) {
  const name = resources[logicalId]!.physicalId;
  // The copy on the role was deleted out of band.
  return revertOf(
    resources,
    logicalId,
    provider,
    { PolicyName: name, PolicyDocument: DOC, Roles: [] },
    { PolicyName: name, PolicyDocument: DOC, Roles: ['my-role'] }
  );
}

const joined = (fn: ReturnType<typeof vi.fn>): string =>
  fn.mock.calls.map((c) => String(c[0])).join('\n');

async function settled(promise: Promise<void>): Promise<void> {
  const done = promise.then(() => undefined);
  await vi.advanceTimersByTimeAsync(RECORDED_IDENTITY_REREAD_DELAY_MS);
  await done;
}

function stack(): Record<string, ResourceState> {
  return {
    AppRole: record('AWS::IAM::Role', 'my-role', { RoleId: RECORDED }),
    PolicyA: record('AWS::IAM::Policy', 'policy-a', {}, { Roles: ['my-role'] }),
    PolicyB: record('AWS::IAM::Policy', 'policy-b', {}, { Roles: ['my-role'] }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
  sent = [];
  vi.useFakeTimers({ toFake: ['setTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('drift --revert binds the IAM principal records (go-to-k/cdkd#6734)', () => {
  it('a stranger holding the recorded role name: refused, nothing put, counted failed', async () => {
    drive({ 'my-role': 'AROA-stranger' });
    const h = policyRevert(stack(), 'PolicyA', new IAMPolicyProvider());
    await settled(applyRevertUpdate(h.args));
    expect(names()).toContain('GetRoleCommand');
    expect(names().filter((n) => n.startsWith('Put'))).toEqual([]);
    expect(h.tally.totalFailed).toBe(1);
    expect(h.tally.totalSucceeded).toBe(0);
    const errors = joined(h.logger.error);
    expect(errors).toContain('Cannot attach IAM policy PolicyA to IAM role AppRole');
    expect(errors).not.toContain('AROA-stranger');
    expect(errors).not.toContain(RECORDED);
  });

  it('our own role: read once, then put back, reverted', async () => {
    drive({ 'my-role': RECORDED });
    const h = policyRevert(stack(), 'PolicyA', new IAMPolicyProvider());
    await settled(applyRevertUpdate(h.args));
    expect(names().filter((n) => n === 'GetRoleCommand')).toHaveLength(1);
    expect(sent.filter((s) => s.name === 'PutRolePolicyCommand').map((s) => s.input)).toEqual([
      expect.objectContaining({ RoleName: 'my-role', PolicyName: 'policy-a' }),
    ]);
    expect(h.tally.totalSucceeded).toBe(1);
    expect(h.tally.totalFailed).toBe(0);
  });

  it('two policies on one role in the same revert run read it once', async () => {
    drive({ 'my-role': RECORDED });
    const resources = stack();
    for (const lid of ['PolicyA', 'PolicyB']) {
      const h = policyRevert(resources, lid, new IAMPolicyProvider());
      await settled(applyRevertUpdate(h.args));
      expect(h.tally.totalSucceeded).toBe(1);
    }
    expect(names().filter((n) => n === 'GetRoleCommand')).toHaveLength(1);
    expect(names().filter((n) => n === 'PutRolePolicyCommand')).toHaveLength(2);
  });

  it('a new revert run (a new state read) reads again', async () => {
    drive({ 'my-role': RECORDED });
    for (const resources of [stack(), stack()]) {
      await settled(
        applyRevertUpdate(policyRevert(resources, 'PolicyA', new IAMPolicyProvider()).args)
      );
    }
    expect(names().filter((n) => n === 'GetRoleCommand')).toHaveLength(2);
  });

  // A revert never sends this today: an inline policy's read echoes only its
  // recorded principals (a principal added out of band is not caught), so the
  // AWS side holds no principal the baseline lacks. Pinned for the day it does.
  it('an in-stack stranger leaving an inline policy: no removal sent to it, warned, reverted', async () => {
    drive({ 'my-role': RECORDED, 'other-role': 'AROA-stranger' });
    const resources: Record<string, ResourceState> = {
      ...stack(),
      OtherRole: record('AWS::IAM::Role', 'other-role', { RoleId: 'AROA-other' }),
    };
    const h = revertOf(
      resources,
      'PolicyA',
      new IAMPolicyProvider(),
      { PolicyName: 'policy-a', PolicyDocument: DOC, Roles: ['my-role', 'other-role'] },
      { PolicyName: 'policy-a', PolicyDocument: DOC, Roles: ['my-role'] }
    );
    await settled(applyRevertUpdate(h.args));
    expect(
      sent.filter((s) => s.name === 'DeleteRolePolicyCommand').map((s) => s.input['RoleName'])
    ).toEqual([]);
    expect(joined(providerWarn())).toContain(
      'the IAM role OtherRole leaving its principals is not the one cdkd created'
    );
    expect(h.tally.totalSucceeded).toBe(1);
  });

  it('a managed policy re-attached to a stranger holding the role name: refused, nothing attached', async () => {
    drive({ 'my-role': 'AROA-stranger' }, MANAGED);
    const resources: Record<string, ResourceState> = {
      AppRole: record('AWS::IAM::Role', 'my-role', { RoleId: RECORDED }),
      MP: record('AWS::IAM::ManagedPolicy', ARN, { PolicyId: 'ANPA-mp' }),
    };
    const h = revertOf(
      resources,
      'MP',
      new IAMManagedPolicyProvider(),
      { ManagedPolicyName: 'mp', PolicyDocument: DOC, Roles: [] },
      { ManagedPolicyName: 'mp', PolicyDocument: DOC, Roles: ['my-role'] }
    );
    await settled(applyRevertUpdate(h.args));
    expect(names()).toContain('GetRoleCommand');
    expect(names().filter((n) => /^(Attach|Detach)\w+PolicyCommand$/.test(n))).toEqual([]);
    expect(h.tally.totalFailed).toBe(1);
    const errors = joined(h.logger.error);
    expect(errors).toContain('Cannot attach IAM managed policy MP to IAM role AppRole');
    expect(errors).not.toContain('AROA-stranger');
  });

  it('a managed policy attached out of band to a stranger holding an in-stack role name: no detach sent to it, warned', async () => {
    drive({ 'my-role': 'AROA-stranger' }, MANAGED);
    const resources: Record<string, ResourceState> = {
      AppRole: record('AWS::IAM::Role', 'my-role', { RoleId: RECORDED }),
      MP: record('AWS::IAM::ManagedPolicy', ARN, { PolicyId: 'ANPA-mp' }),
    };
    const h = revertOf(
      resources,
      'MP',
      new IAMManagedPolicyProvider(),
      { ManagedPolicyName: 'mp', PolicyDocument: DOC, Roles: ['my-role'] },
      { ManagedPolicyName: 'mp', PolicyDocument: DOC }
    );
    await settled(applyRevertUpdate(h.args));
    expect(names()).toContain('GetRoleCommand');
    expect(names().filter((n) => /^(Attach|Detach)\w+PolicyCommand$/.test(n))).toEqual([]);
    expect(joined(providerWarn())).toContain(
      'IAM managed policy MP: the IAM role AppRole leaving its principals is not the one cdkd created'
    );
    expect(h.tally.totalSucceeded).toBe(1);
  });

  it('the bound view holds the principal records alone, no deploy-only signal, and the run bag as key', async () => {
    const resources: Record<string, ResourceState> = {
      ...stack(),
      AppUser: record('AWS::IAM::User', 'my-user', { UserId: 'AIDA-u' }),
      AppGroup: record('AWS::IAM::Group', 'my-group', { GroupId: 'AGPA-g' }),
      Ingress: record('AWS::EC2::SecurityGroupIngress', 'sg-1|tcp|443', { Id: 'sgr-1' }),
      Group: record('AWS::EC2::SecurityGroup', 'sg-1', {}, { SecurityGroupIngress: [] }),
      BucketPolicy: record('AWS::S3::BucketPolicy', 'my-bucket'),
      Oai: record('AWS::CloudFront::CloudFrontOriginAccessIdentity', 'E123'),
    };
    let seen: StackRecordsView | undefined;
    const provider = {
      create: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(() => {
        seen = getStackRecords();
        return Promise.resolve({ physicalId: 'policy-a', wasReplaced: false });
      }),
    } as unknown as ResourceProvider;
    const h = policyRevert(resources, 'PolicyA', provider);
    await settled(applyRevertUpdate(h.args));
    expect(seen).toBeDefined();
    const lids = (it: Iterable<readonly [string, ResourceState]>) => [...it].map(([l]) => l).sort();
    expect(lids(seen!.live())).toEqual(['AppGroup', 'AppRole', 'AppUser']);
    expect(lids(seen!.survivors())).toEqual(['AppGroup', 'AppRole', 'AppUser']);
    expect(seen!.writtenFreshThisRun).toBeUndefined();
    expect(seen!.inFlight).toBeUndefined();
    expect(seen!.runKey).toBe(resources);
    // Outside the revert's call, nothing is bound.
    expect(getStackRecords()).toBeUndefined();
  });
});

describe('revertStackRecordsView (go-to-k/cdkd#6734)', () => {
  it('names exactly the principal types the IAM policy compare reads', () => {
    expect([...REVERT_VIEW_RECORD_TYPES].sort()).toEqual(
      Object.values(INLINE_POLICY_PRINCIPAL_SPECS)
        .map((spec) => spec.resourceType)
        .sort()
    );
  });

  it('reads the bag when called, and one bag shares one verified-identity cache', () => {
    const resources: Record<string, ResourceState> = {};
    const view = revertStackRecordsView(resources);
    expect([...view.live()]).toEqual([]);
    resources['Late'] = record('AWS::IAM::Role', 'late', { RoleId: 'AROA-late' });
    expect([...view.live()].map(([l]) => l)).toEqual(['Late']);
    expect(verifiedIdentityCache(view)).toBe(
      verifiedIdentityCache(revertStackRecordsView(resources))
    );
    expect(verifiedIdentityCache(view)).not.toBe(verifiedIdentityCache(revertStackRecordsView({})));
  });
});
