/**
 * go-to-k/cdkd#6722: an `AWS::IAM::Policy` puts its inline policy on each
 * principal BY NAME (`Put{Role,Group,User}Policy`), and an
 * `AWS::IAM::ManagedPolicy` attaches to / detaches from its `Roles` /
 * `Groups` / `Users` by name. A same-named principal re-created out of band
 * would receive cdkd's policy: a GRANT to a principal cdkd did not create.
 * Each in-stack principal with a recorded identity id is read and compared
 * before any write; one this deploy itself created or replaced is not read
 * (its id is the one this run's create answered).
 *
 * Every case drives the provider's real `create()` / `update()` against a
 * mocked IAM client inside the stack-records scope a deploy / rollback binds.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { NoSuchEntityException } from '@aws-sdk/client-iam';

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
    child: vi.fn(function (this: unknown) { return this; }),
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

import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  RECORDED_IDENTITY_REREAD_DELAY_MS,
  RecordedIdentityError,
  reAdoptRemedy,
} from '../../../src/provisioning/recorded-identity.js';
import {
  deployStackRecordsView,
  destroyStackRecordsView,
  replayStackRecordsView,
  withStackRecords,
  type StackRecordsView,
} from '../../../src/deployment/stack-records-scope.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';
import { stateOrphanRecordRemedy } from '../../../src/provisioning/state-orphan-remedy.js';
import type { ResourceState } from '../../../src/types/state.js';
import { getLogger } from '../../../src/utils/logger.js';

type Handler = (input: Record<string, unknown>) => unknown;

let sent: Array<{ name: string; input: Record<string, unknown> }>;

function drive(handlers: Record<string, Handler>): void {
  mockSend.mockImplementation(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      sent.push({ name, input: command.input });
      const handler = handlers[name];
      return handler ? handler(command.input) : {};
    }
  );
}

const names = (): string[] => sent.map((s) => s.name);
const reads = (): string[] => names().filter((n) => /^Get(Role|Group|User)Command$/.test(n));
const writes = (): string[] =>
  names().filter((n) => /^(Put|Delete|Attach|Detach)(Role|Group|User)Policy/.test(n));

function record(
  resourceType: string,
  physicalId: string,
  attributes: Record<string, unknown> = {}
): ResourceState {
  return { resourceType, physicalId, properties: {}, attributes, dependencies: [] } as ResourceState;
}

const RECORDED = 'AROA-recorded';
const SUCCESSOR = 'AROA-successor';

/** Live ids by principal name, answered by every Get{Role,Group,User}. */
function liveIds(ids: Record<string, string | Error>): Record<string, Handler> {
  const answer = (name: unknown, wrap: (id: string) => unknown) => {
    const id = ids[String(name)];
    if (id === undefined) throw new NoSuchEntityException({ message: 'gone', $metadata: {} });
    if (id instanceof Error) throw id;
    return wrap(id);
  };
  return {
    GetRoleCommand: (i) => answer(i['RoleName'], (RoleId) => ({ Role: { RoleId } })),
    GetGroupCommand: (i) => answer(i['GroupName'], (GroupId) => ({ Group: { GroupId } })),
    GetUserCommand: (i) => answer(i['UserName'], (UserId) => ({ User: { UserId } })),
  };
}

/** A deploy's view in which no record was created or replaced by the deploy. */
const settledDeploy = (records: Record<string, ResourceState>): StackRecordsView =>
  deployStackRecordsView(records, records, new Set(), undefined, undefined, () => false);
/** A deploy's view in which `fresh` were created or replaced by the deploy. */
const freshDeploy = (records: Record<string, ResourceState>, fresh: string[]): StackRecordsView =>
  deployStackRecordsView(records, records, new Set(), undefined, undefined, (lid) =>
    fresh.includes(lid)
  );

async function settled(promise: Promise<unknown>): Promise<{ value?: unknown; error?: Error }> {
  const outcome = promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error: error as Error })
  );
  await vi.advanceTimersByTimeAsync(RECORDED_IDENTITY_REREAD_DELAY_MS);
  return outcome;
}

async function thrownBy(promise: Promise<unknown>): Promise<Error> {
  const { error } = await settled(promise);
  if (error === undefined) throw new Error('expected a refusal');
  return error;
}

const DOC = { Version: '2012-10-17', Statement: [] };
const role = record('AWS::IAM::Role', 'my-role', { RoleId: RECORDED });

function create(view: StackRecordsView | undefined, properties: Record<string, unknown>) {
  const run = () =>
    new IAMPolicyProvider().create('P', 'AWS::IAM::Policy', {
      PolicyName: 'inline',
      PolicyDocument: DOC,
      ...properties,
    });
  return view === undefined ? run() : withStackRecords(view, run);
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

describe('AWS::IAM::Policy create compares the principals it puts on (go-to-k/cdkd#6722)', () => {
  it('a pre-existing in-stack role carrying its RoleId: read once, then put', async () => {
    drive(liveIds({ 'my-role': RECORDED }));
    const { error } = await settled(create(settledDeploy({ R: role }), { Roles: ['my-role'] }));
    expect(error).toBeUndefined();
    expect(names()).toEqual(['GetRoleCommand', 'PutRolePolicyCommand']);
  });

  it('another RoleId under the name: refused before any put, non-retryably, no values', async () => {
    drive(liveIds({ 'my-role': SUCCESSOR, other: 'AROA-other' }));
    const error = await thrownBy(
      create(settledDeploy({ R: role }), { Roles: ['other', 'my-role'] })
    );
    expect(writes()).toEqual([]);
    expect(error).toBeInstanceOf(RecordedIdentityError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(isMarkedNotGone(error)).toBe(true);
    expect(error.message).toContain(
      'Cannot attach IAM policy P to IAM role R (its RoleId differs)'
    );
    expect(error.message).toContain('granting nothing');
    expect(error.message).toContain(reAdoptRemedy('R'));
    expect(error.message).toContain(stateOrphanRecordRemedy(undefined, 'R'));
    expect(error.message).not.toContain(RECORDED);
    expect(error.message).not.toContain(SUCCESSOR);
    expect(error.message).not.toContain('my-role');
  });

  it('a group and a user compare their GroupId / UserId', async () => {
    drive(liveIds({ g: 'AGPA-other', u: 'AIDA-rec' }));
    const error = await thrownBy(
      create(
        settledDeploy({
          G: record('AWS::IAM::Group', 'g', { GroupId: 'AGPA-rec' }),
          U: record('AWS::IAM::User', 'u', { UserId: 'AIDA-rec' }),
        }),
        { Groups: ['g'], Users: ['u'] }
      )
    );
    expect(writes()).toEqual([]);
    expect(error.message).toContain('IAM group G (its GroupId differs)');
    expect(error.message).not.toContain('IAM user U');
  });

  it('a principal outside the stack: no read, put by name as before', async () => {
    drive({});
    const { error } = await settled(create(settledDeploy({ R: role }), { Roles: ['external'] }));
    expect(error).toBeUndefined();
    expect(names()).toEqual(['PutRolePolicyCommand']);
  });

  it('a legacy record without the id, or a masked one: no read', async () => {
    drive({});
    const { error } = await settled(
      create(
        settledDeploy({
          L: record('AWS::IAM::Role', 'legacy'),
          M: record('AWS::IAM::Role', 'masked', { RoleId: '***' }),
        }),
        { Roles: ['legacy', 'masked'] }
      )
    );
    expect(error).toBeUndefined();
    expect(names()).toEqual(['PutRolePolicyCommand', 'PutRolePolicyCommand']);
  });

  it('a role this deploy created or replaced (the engine says so): no read', async () => {
    drive({});
    const { error } = await settled(create(freshDeploy({ R: role }, ['R']), { Roles: ['my-role'] }));
    expect(error).toBeUndefined();
    expect(names()).toEqual(['PutRolePolicyCommand']);
  });

  it('an in-place role update this run (not fresh, the recorded id kept) with a stranger holder: refused', async () => {
    // The role's in-place update acted by name; its record keeps the recorded
    // RoleId (`keepRecordedIdentity`), and the engine does not report it
    // fresh, so the attach reads and finds the stranger.
    drive(liveIds({ 'my-role': SUCCESSOR }));
    const before = { R: record('AWS::IAM::Role', 'my-role', { RoleId: RECORDED }) };
    const error = await thrownBy(
      create(deployStackRecordsView({ R: role }, before, new Set(), undefined, undefined, () => false), {
        Roles: ['my-role'],
      })
    );
    expect(writes()).toEqual([]);
    expect(error.message).toContain('its RoleId differs');
  });

  it('a recorded id differing from the pre-run one is NOT fresh by itself: read', async () => {
    // Freshness comes from what the engine dispatched, never from the ids.
    drive(liveIds({ 'my-role': SUCCESSOR }));
    const stranger = record('AWS::IAM::Role', 'my-role', { RoleId: SUCCESSOR });
    const before = { R: record('AWS::IAM::Role', 'my-role', { RoleId: 'AROA-old' }) };
    const { error } = await settled(
      create(deployStackRecordsView({ R: stranger }, before, new Set(), undefined, undefined, () => false), {
        Roles: ['my-role'],
      })
    );
    expect(error).toBeUndefined();
    expect(reads()).toEqual(['GetRoleCommand']);
  });

  it('a legacy record that acquired its first id this run: read (trust on first use is no proof)', async () => {
    drive(liveIds({ 'my-role': SUCCESSOR }));
    const before = { R: record('AWS::IAM::Role', 'my-role') };
    const error = await thrownBy(
      create(deployStackRecordsView({ R: role }, before, new Set(), undefined, undefined, () => false), {
        Roles: ['my-role'],
      })
    );
    expect(reads().length).toBeGreaterThan(0);
    expect(writes()).toEqual([]);
    expect(error.message).toContain('its RoleId differs');
  });

  it('a fresh record beside a stale duplicate of the name: read, and the fresh id is accepted', async () => {
    drive(liveIds({ 'my-role': 'AROA-fresh' }));
    const { error } = await settled(
      create(
        freshDeploy(
          {
            R: record('AWS::IAM::Role', 'my-role', { RoleId: 'AROA-fresh' }),
            Stale: record('AWS::IAM::Role', 'my-role', { RoleId: 'AROA-stale' }),
          },
          ['R']
        ),
        { Roles: ['my-role'] }
      )
    );
    expect(error).toBeUndefined();
    expect(names()).toEqual(['GetRoleCommand', 'PutRolePolicyCommand']);
  });

  it('a destroy-shaped or replay view (no pre-run records): every in-stack principal is read', async () => {
    drive(liveIds({ 'my-role': RECORDED }));
    await settled(create(destroyStackRecordsView({ R: role }), { Roles: ['my-role'] }));
    expect(names()).toEqual(['GetRoleCommand', 'PutRolePolicyCommand']);
  });

  it('an unreadable principal: thrown to the retry classifiers, nothing put', async () => {
    const throttle = Object.assign(new Error('Rate exceeded'), {
      name: 'Throttling',
      $metadata: { httpStatusCode: 400 },
    });
    drive(liveIds({ 'my-role': throttle }));
    const error = await thrownBy(create(settledDeploy({ R: role }), { Roles: ['my-role'] }));
    expect(writes()).toEqual([]);
    expect(isMarkedNonRetryable(error)).toBe(false);
  });

  it('a denied read: a non-retryable refusal naming iam:GetRole, without AWS’s text', async () => {
    const denied = Object.assign(new Error('User arn:aws:iam::123:user/me is not authorized'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });
    drive(liveIds({ 'my-role': denied }));
    const error = await thrownBy(create(settledDeploy({ R: role }), { Roles: ['my-role'] }));
    expect(writes()).toEqual([]);
    expect(error).toBeInstanceOf(RecordedIdentityError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(error.message).toContain('Cannot attach IAM policy P to IAM role R');
    expect(error.message).toContain('iam:GetRole');
    expect(error.message).toContain('(AccessDenied)');
    expect(error.message).not.toContain('not authorized');
    expect(error.cause).toBeUndefined();
  });

  it('the role already gone: left to the put, which answers NoSuchEntity as before', async () => {
    drive({
      ...liveIds({}),
      PutRolePolicyCommand: () => {
        throw new NoSuchEntityException({ message: 'no role', $metadata: {} });
      },
    });
    const { error } = await settled(create(settledDeploy({ R: role }), { Roles: ['my-role'] }));
    expect(names()).toEqual(['GetRoleCommand', 'PutRolePolicyCommand']);
    expect(error?.message).toContain('Failed to create IAM policy P');
  });
});

describe('AWS::IAM::Policy update compares the principals it puts on (go-to-k/cdkd#6722)', () => {
  const upd = (
    view: StackRecordsView,
    previous: Record<string, unknown>,
    desired: Record<string, unknown>
  ) =>
    withStackRecords(view, () =>
      new IAMPolicyProvider().update(
        'P',
        'inline',
        'AWS::IAM::Policy',
        { PolicyName: 'inline', PolicyDocument: DOC, ...desired },
        { PolicyName: 'inline', PolicyDocument: DOC, ...previous }
      )
    );

  it('a staying in-stack role carrying its RoleId: read, then put', async () => {
    drive(liveIds({ 'my-role': RECORDED }));
    const { error } = await settled(
      upd(settledDeploy({ R: role }), { Roles: ['my-role'] }, { Roles: ['my-role'] })
    );
    expect(error).toBeUndefined();
    expect(names()).toEqual(['GetRoleCommand', 'PutRolePolicyCommand']);
  });

  it('a desired role held by another RoleId: refused before any write', async () => {
    drive(liveIds({ 'my-role': SUCCESSOR }));
    const error = await thrownBy(
      upd(
        settledDeploy({ R: role }),
        { Roles: ['my-role', 'leaver'] },
        { Roles: ['my-role'] }
      )
    );
    expect(writes()).toEqual([]);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(error.message).toContain('Cannot attach IAM policy P to IAM role R');
  });

  it('a rollback replaying the update backwards refuses to re-add a re-created principal', async () => {
    // The forward update removed `my-role` (skipping it as a mismatch); the
    // replay restores the recorded lists, re-adding it: no put may reach the
    // stranger now holding the name.
    drive(liveIds({ 'my-role': SUCCESSOR, stays: 'AROA-stays' }));
    const error = await thrownBy(
      upd(
        replayStackRecordsView({
          R: role,
          S: record('AWS::IAM::Role', 'stays', { RoleId: 'AROA-stays' }),
        }),
        { Roles: ['stays'] },
        { Roles: ['stays', 'my-role'] }
      )
    );
    expect(writes()).toEqual([]);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(error.message).toContain('IAM role R (its RoleId differs)');
  });
});

describe('AWS::IAM::ManagedPolicy compares the principals it attaches / detaches (go-to-k/cdkd#6722)', () => {
  const ARN = 'arn:aws:iam::123456789012:policy/mp';
  const DOC2 = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:*', Resource: '*' }] };
  const policyAnswer = () => ({
    Policy: { Arn: ARN, PolicyName: 'mp', PolicyId: 'ANPA-mp', DefaultVersionId: 'v1' },
  });
  const managed = (ids: Record<string, string | Error>): Record<string, Handler> => ({
    ...liveIds(ids),
    CreatePolicyCommand: policyAnswer,
    GetPolicyCommand: policyAnswer,
    ListPolicyVersionsCommand: () => ({ Versions: [] }),
    CreatePolicyVersionCommand: () => ({ PolicyVersion: { VersionId: 'v2' } }),
    ListEntitiesForPolicyCommand: () => ({}),
  });
  const policyWrites = (): string[] =>
    names().filter((n) => /^(CreatePolicy|CreatePolicyVersion|DeletePolicy\w*|SetDefault\w*)Command$/.test(n));
  const create = (view: StackRecordsView, properties: Record<string, unknown>) =>
    withStackRecords(view, () =>
      new IAMManagedPolicyProvider().create('MP', 'AWS::IAM::ManagedPolicy', {
        ManagedPolicyName: 'mp',
        PolicyDocument: DOC,
        ...properties,
      })
    );
  const update = (
    view: StackRecordsView,
    previous: Record<string, unknown>,
    desired: Record<string, unknown>
  ) =>
    withStackRecords(view, () =>
      new IAMManagedPolicyProvider().update(
        'MP',
        ARN,
        'AWS::IAM::ManagedPolicy',
        { ManagedPolicyName: 'mp', PolicyDocument: DOC2, ...desired },
        { ManagedPolicyName: 'mp', PolicyDocument: DOC, ...previous },
        { recordedAttributes: { PolicyId: 'ANPA-mp' } }
      )
    );
  const warn = () => getLogger().child('x').warn as unknown as ReturnType<typeof vi.fn>;

  it('create: a pre-existing in-stack role carrying its RoleId is read, then attached', async () => {
    drive(managed({ 'my-role': RECORDED }));
    const { error } = await settled(create(settledDeploy({ R: role }), { Roles: ['my-role'] }));
    expect(error).toBeUndefined();
    expect(names().slice(0, 3)).toEqual([
      'GetRoleCommand',
      'CreatePolicyCommand',
      'AttachRolePolicyCommand',
    ]);
  });

  it('create: another RoleId refuses before CreatePolicy, unwrapped, nothing created', async () => {
    drive(managed({ 'my-role': SUCCESSOR }));
    const error = await thrownBy(create(settledDeploy({ R: role }), { Roles: ['my-role'] }));
    expect(writes()).toEqual([]);
    expect(policyWrites()).toEqual([]);
    expect(error).toBeInstanceOf(RecordedIdentityError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(error.message.startsWith('Cannot attach IAM managed policy MP to IAM role R (its RoleId differs)')).toBe(true);
    expect((error as RecordedIdentityError).resourceType).toBe('AWS::IAM::ManagedPolicy');
    expect(error.message).not.toContain(SUCCESSOR);
  });

  it('create: a role this deploy created is not read', async () => {
    drive(managed({}));
    await settled(
      create(freshDeploy({ R: role }, ['R']), { Roles: ['my-role'] })
    );
    expect(reads()).toEqual([]);
    expect(names()).toContain('AttachRolePolicyCommand');
  });

  it('update: an added stranger refuses before any version or attachment write, unwrapped', async () => {
    drive(managed({ 'my-role': SUCCESSOR }));
    const error = await thrownBy(
      update(settledDeploy({ R: role }), { Groups: ['g'] }, { Roles: ['my-role'] })
    );
    expect(writes()).toEqual([]);
    expect(policyWrites()).toEqual([]);
    expect(error).toBeInstanceOf(RecordedIdentityError);
    expect(error.message.startsWith('Cannot attach IAM managed policy MP to IAM role R')).toBe(true);
  });

  it('update: a leaving stranger is sent no detach and warned; the rest proceeds', async () => {
    drive(managed({ 'my-role': SUCCESSOR }));
    warn().mockClear();
    const { error } = await settled(
      update(settledDeploy({ R: role }), { Roles: ['my-role'] }, { Roles: ['new'] })
    );
    expect(error).toBeUndefined();
    expect(writes()).toEqual(['AttachRolePolicyCommand']);
    expect(sent.find((s) => s.name === 'AttachRolePolicyCommand')?.input['RoleName']).toBe('new');
    const line = warn().mock.calls.map((c) => String(c[0])).find((l) => l.includes('leaving'));
    expect(line).toContain('IAM role R leaving its principals is not the one cdkd created');
    expect(line).not.toContain(SUCCESSOR);
  });

  it('update: a leaving role carrying its RoleId is read, then detached', async () => {
    drive(managed({ 'my-role': RECORDED }));
    const { error } = await settled(
      update(settledDeploy({ R: role }), { Roles: ['my-role'] }, {})
    );
    expect(error).toBeUndefined();
    expect(reads()).toEqual(['GetRoleCommand']);
    expect(writes()).toEqual(['DetachRolePolicyCommand']);
  });

  it('update: an unchanged principal is neither read nor written', async () => {
    drive(managed({}));
    await settled(update(settledDeploy({ R: role }), { Roles: ['my-role'] }, { Roles: ['my-role'] }));
    expect(reads()).toEqual([]);
    expect(writes()).toEqual([]);
  });

  it('a rollback replaying an update backwards refuses to re-attach a re-created principal', async () => {
    drive(managed({ 'my-role': SUCCESSOR }));
    const error = await thrownBy(
      update(replayStackRecordsView({ R: role }), {}, { Roles: ['my-role'] })
    );
    expect(writes()).toEqual([]);
    expect(policyWrites()).toEqual([]);
    expect(isMarkedNonRetryable(error)).toBe(true);
  });
});

describe('a denied principal read on the #6655 removal paths (go-to-k/cdkd#6722)', () => {
  const denied = () =>
    Object.assign(new Error('User arn:aws:iam::123:user/me is not authorized'), {
      name: 'AccessDenied',
      $metadata: { httpStatusCode: 403 },
    });

  it('delete: refused non-retryably naming iam:GetRole, nothing removed, no AWS text', async () => {
    drive(liveIds({ 'my-role': denied() }));
    const error = await thrownBy(
      withStackRecords(destroyStackRecordsView({ R: role }), () =>
        new IAMPolicyProvider().delete('P', 'inline', 'AWS::IAM::Policy', {
          PolicyName: 'inline',
          Roles: ['my-role'],
        })
      )
    );
    expect(writes()).toEqual([]);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(isMarkedNotGone(error)).toBe(true);
    expect(error.message).toContain('Cannot delete IAM policy P from IAM role R');
    expect(error.message).toContain('iam:GetRole');
    expect(error.message).not.toContain('not authorized');
  });

  it('update under a destroy-shaped view: a leaving principal’s denied read refuses before any write', async () => {
    drive(liveIds({ 'my-role': denied(), stays: 'AROA-stays' }));
    const error = await thrownBy(
      withStackRecords(
        destroyStackRecordsView({
          R: role,
          S: record('AWS::IAM::Role', 'stays', { RoleId: 'AROA-stays' }),
        }),
        () =>
          new IAMPolicyProvider().update(
            'P',
            'inline',
            'AWS::IAM::Policy',
            { PolicyName: 'inline', PolicyDocument: DOC, Roles: ['stays'] },
            { PolicyName: 'inline', PolicyDocument: DOC, Roles: ['stays', 'my-role'] }
          )
      )
    );
    expect(writes()).toEqual([]);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(error.message).toContain('Cannot remove IAM policy P from IAM role R during an update');
    expect(error.message).toContain('iam:GetRole');
    expect(error.message).not.toContain('not authorized');
  });
});

describe('each in-stack principal is verified at most once per run (go-to-k/cdkd#6722)', () => {
  const put = (view: StackRecordsView, logicalId: string) =>
    withStackRecords(view, () =>
      new IAMPolicyProvider().create(logicalId, 'AWS::IAM::Policy', {
        PolicyName: `inline-${logicalId}`,
        PolicyDocument: DOC,
        Roles: ['my-role'],
      })
    );

  it('N policies on one role in one run: one GetRole', async () => {
    drive(liveIds({ 'my-role': RECORDED }));
    const view = settledDeploy({ R: role });
    for (const id of ['P1', 'P2', 'P3']) {
      const { error } = await settled(put(view, id));
      expect(error).toBeUndefined();
    }
    expect(reads()).toEqual(['GetRoleCommand']);
    expect(names().filter((n) => n === 'PutRolePolicyCommand')).toHaveLength(3);
  });

  it('concurrent first compares of one role share one in-flight read', async () => {
    drive(liveIds({ 'my-role': RECORDED }));
    const view = settledDeploy({ R: role });
    const outcomes = await settled(Promise.all(['P1', 'P2', 'P3'].map((id) => put(view, id))));
    expect(outcomes.error).toBeUndefined();
    expect(reads()).toEqual(['GetRoleCommand']);
  });

  it('the cache spans the views of one run (one records bag), e.g. a destroy’s per-delete views', async () => {
    drive(liveIds({ 'my-role': RECORDED }));
    const records = { R: role };
    await settled(put(destroyStackRecordsView(records), 'P1'));
    await settled(put(destroyStackRecordsView(records), 'P2'));
    expect(reads()).toEqual(['GetRoleCommand']);
  });

  it('a removal path shares it too: a delete after an attach of the same run reads nothing new', async () => {
    drive(liveIds({ 'my-role': RECORDED }));
    const view = settledDeploy({ R: role });
    await settled(put(view, 'P1'));
    await settled(
      withStackRecords(view, () =>
        new IAMPolicyProvider().delete('P2', 'inline-P2', 'AWS::IAM::Policy', {
          PolicyName: 'inline-P2',
          Roles: ['my-role'],
        })
      )
    );
    expect(reads()).toEqual(['GetRoleCommand']);
  });

  it('a mismatch is not cached: every attempt reads again, and still refuses', async () => {
    drive(liveIds({ 'my-role': SUCCESSOR }));
    const view = settledDeploy({ R: role });
    await thrownBy(put(view, 'P1'));
    const first = reads().length;
    const error = await thrownBy(put(view, 'P1'));
    expect(reads().length).toBe(first * 2);
    expect(error.message).toContain('its RoleId differs');
    expect(writes()).toEqual([]);
  });

  it('an unreadable compare is not cached: the retry reads again and can then match', async () => {
    let n = 0;
    drive({
      GetRoleCommand: () => {
        if (++n === 1) {
          throw Object.assign(new Error('Rate exceeded'), {
            name: 'Throttling',
            $metadata: { httpStatusCode: 400 },
          });
        }
        return { Role: { RoleId: RECORDED } };
      },
    });
    const view = settledDeploy({ R: role });
    await thrownBy(put(view, 'P1'));
    const { error } = await settled(put(view, 'P1'));
    expect(error).toBeUndefined();
    expect(reads()).toEqual(['GetRoleCommand', 'GetRoleCommand']);
  });

  it('separate runs (separate records bags) do not share a match', async () => {
    drive(liveIds({ 'my-role': RECORDED }));
    await settled(put(settledDeploy({ R: role }), 'P1'));
    await settled(put(settledDeploy({ R: role }), 'P1'));
    expect(reads()).toEqual(['GetRoleCommand', 'GetRoleCommand']);
  });

  it('a different recorded id under the same logical id is a different entry', async () => {
    drive(liveIds({ 'my-role': RECORDED }));
    const records: Record<string, ResourceState> = { R: role };
    const view = settledDeploy(records);
    await settled(put(view, 'P1'));
    records['R'] = record('AWS::IAM::Role', 'my-role', { RoleId: 'AROA-new' });
    const error = await thrownBy(put(view, 'P2'));
    expect(error.message).toContain('its RoleId differs');
  });
});

describe('a deploy’s matches do not carry into its auto-rollback (go-to-k/cdkd#6722)', () => {
  it('the replay over the deploy’s own records bag reads again', async () => {
    drive(liveIds({ 'my-role': RECORDED }));
    const records = { R: role };
    const put = (view: StackRecordsView) =>
      withStackRecords(view, () =>
        new IAMPolicyProvider().create('P', 'AWS::IAM::Policy', {
          PolicyName: 'inline',
          PolicyDocument: DOC,
          Roles: ['my-role'],
        })
      );
    await settled(put(settledDeploy(records)));
    await settled(put(replayStackRecordsView(records)));
    await settled(put(replayStackRecordsView(records)));
    // One read for the deploy, one for the rollback (its two replay views share it).
    expect(reads()).toEqual(['GetRoleCommand', 'GetRoleCommand']);
  });
});
