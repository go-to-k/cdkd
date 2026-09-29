import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * Issue #4024: a rollback replays each journal segment under the prefix flag
 * the FAILED deploy ran with (#4018). A provider that rewrites even an
 * explicit name (`generateResourceNameWithFallback`: IAM Role / User / Group /
 * InstanceProfile / ManagedPolicy, ELBv2 LB / TG) derives the old resource's
 * name from that flag, yet an EARLIER deploy under the OTHER flag may have
 * created it — so the restored resource came back under a name it never had.
 * The replay now picks the flag whose derived name reproduces the old
 * physical id, runs the re-create AND the name-holder proof under it, and
 * keeps the recorded flag (with one warning) when neither does.
 *
 * Driven through the REAL `replayRollback` / `replayFailedOperations` and the
 * REAL IAM providers; only the IAM client's `send` (an in-memory account) is
 * stubbed. The discriminator is the name each create SENDS.
 */

vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return { getLogger: () => logger };
});

const iamSend = vi.fn();
/**
 * A role NAME held in Secrets Manager. `@` and `.` are outside the provider's
 * charset, so every name it derives is a spelling the literal masker misses.
 */
const SECRET_NAME = 'alice@example.com';
const SECRET_NAME_EXPR = '{{resolve:secretsmanager:role-name:SecretString:name::}}';
/** A secret `displayIdent` escapes (`\"`): a mask applied after it misses. */
const QUOTED_SECRET = 'tok"en';
const QUOTED_SECRET_EXPR = '{{resolve:secretsmanager:quoted:SecretString:name::}}';
const smSend = vi.fn(async (cmd?: { input?: { SecretId?: string } }) => ({
  SecretString: JSON.stringify({
    name: cmd?.input?.SecretId === 'quoted' ? QUOTED_SECRET : SECRET_NAME,
  }),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ iam: { send: iamSend }, secretsManager: { send: smSend } }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

import { NoSuchEntityException } from '@aws-sdk/client-iam';

import {
  replayFailedOperations,
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { replayPrefixChoice } from '../../../src/deployment/replacement-name-holder.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import {
  generateResourceNameWithFallback,
  withSkipPrefix,
  withStackName,
} from '../../../src/provisioning/resource-name.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';
import { awsSdkError } from '../_aws-sdk-error.js';

const STACK = 'MyStack';
const ROLE = 'AWS::IAM::Role';
const POLICY = 'AWS::IAM::ManagedPolicy';
const TRUST = { Version: '2012-10-17', Statement: [] };
const ACCOUNT = 'arn:aws:iam::123456789012';

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => log,
} as unknown as RollbackExecutorContext['logger'];

function ctxFor(
  provider: ResourceProvider,
  provisionedBy: 'sdk' | 'cc-api' = 'sdk'
): RollbackExecutorContext {
  return {
    region: 'us-east-1',
    logger: log,
    providerRegistry: {
      getProviderFor: () => ({ provider, provisionedBy }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
  };
}

/** An in-memory IAM account: the names that exist, and every create's name. */
function fakeIam(existing: string[]): { names: Set<string>; created: string[]; deleted: string[] } {
  const names = new Set(existing);
  const created: string[] = [];
  const deleted: string[] = [];
  iamSend.mockImplementation(async (command: unknown) => {
    const c = command as {
      constructor: { name: string };
      input?: { RoleName?: string; PolicyName?: string; PolicyArn?: string };
    };
    const role = String(c.input?.RoleName);
    switch (c.constructor.name) {
      case 'CreateRoleCommand':
        created.push(role);
        // IAM refuses a second spelling of a name that differs only in case.
        if ([...names].some((n) => n.toLowerCase() === role.toLowerCase())) {
          throw awsSdkError(`Role with name ${role} already exists.`, 'EntityAlreadyExistsException');
        }
        names.add(role);
        return { Role: { Arn: `${ACCOUNT}:role/${role}`, RoleId: 'AROAX' } };
      case 'CreatePolicyCommand': {
        const policy = String(c.input?.PolicyName);
        created.push(policy);
        names.add(policy);
        return { Policy: { Arn: `${ACCOUNT}:policy/${policy}` } };
      }
      case 'GetRoleCommand':
        if (!names.has(role)) {
          throw new NoSuchEntityException({ message: `Role ${role} not found`, $metadata: {} });
        }
        return { Role: { RoleName: role, Arn: `${ACCOUNT}:role/${role}` } };
      case 'DeleteRoleCommand':
        deleted.push(role);
        names.delete(role);
        return {};
      case 'DeletePolicyCommand':
        deleted.push(String(c.input?.PolicyArn));
        return {};
      default:
        // List* for a delete's detach sweep: nothing attached.
        return { AttachedPolicies: [], PolicyNames: [], InstanceProfiles: [], Versions: [] };
    }
  });
  return { names, created, deleted };
}

function roleRow(physicalId: string, extra: Record<string, unknown> = {}): ResourceState {
  return {
    physicalId,
    resourceType: ROLE,
    properties: { RoleName: 'a', AssumeRolePolicyDocument: TRUST, ...extra },
    attributes: {},
    dependencies: [],
  };
}

/**
 * The replacement a failed deploy journaled: role `oldId` (template name `a`,
 * Path `/old/`) was replaced by `newId` (Path `/new/`, create-only, so a
 * replacement that keeps the template name).
 */
function replaceRole(oldId: string, newId: string): {
  op: CompletedOperation;
  state: Record<string, ResourceState>;
} {
  return {
    op: {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: ROLE,
      physicalId: newId,
      previousState: roleRow(oldId, { Path: '/old/' }),
    },
    state: { R: roleRow(newId, { Path: '/new/' }) },
  };
}

/** The replay, inside the scope a segment recorded with `skipPrefix` gets. */
function replayIn<T>(skipPrefix: boolean, fn: () => Promise<T>): Promise<T> {
  return withSkipPrefix(skipPrefix, () => withStackName(STACK, fn));
}

function lines(level: 'info' | 'warn'): string[] {
  return vi.mocked(log[level]).mock.calls.map((c) => String(c[0]));
}

const unreproduced = (): string[] =>
  lines('warn').filter((l) => l.includes('cannot tell which user-supplied-name prefix setting'));
const chose = (): string[] =>
  lines('info').filter((l) => l.includes('under the user-supplied-name prefix setting that created'));

beforeEach(() => {
  vi.clearAllMocks();
  iamSend.mockReset();
  vi.stubEnv('AWS_REGION', 'us-east-1');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('a reverse-replacement re-creates the old role under the name it had (#4024)', () => {
  it('created with the prefix KEPT, rolled back from a deploy that SKIPPED it: comes back as `MyStack-a`', async () => {
    const aws = fakeIam(['a']);
    const { op, state } = replaceRole('MyStack-a', 'a');

    const result = await replayIn(true, () =>
      replayRollback([op], state, STACK, ctxFor(new IAMRoleProvider()))
    );

    // THE DISCRIMINATOR: under the failed deploy's flag the provider sent `a`,
    // which collided with the live new role.
    expect(aws.created).toEqual(['MyStack-a']);
    expect(aws.deleted).toEqual(['a']);
    expect([...aws.names]).toEqual(['MyStack-a']);
    expect(state['R']?.physicalId).toBe('MyStack-a');
    expect(result.failures).toBe(0);
    expect(result.warnings).toBe(0);
    expect(unreproduced()).toEqual([]);
    const said = chose();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('R (AWS::IAM::Role)');
    expect(said[0]).toContain('stack-name prefix KEPT');
    expect(said[0]).toContain('the failed deploy ran with it SKIPPED');
  });

  it('the reverse flip: created with the prefix SKIPPED, rolled back from a deploy that KEPT it: `a`', async () => {
    const aws = fakeIam(['MyStack-a']);
    const { op, state } = replaceRole('a', 'MyStack-a');

    const result = await replayIn(false, () =>
      replayRollback([op], state, STACK, ctxFor(new IAMRoleProvider()))
    );

    expect(aws.created).toEqual(['a']);
    expect(aws.deleted).toEqual(['MyStack-a']);
    expect(state['R']?.physicalId).toBe('a');
    expect(result.failures).toBe(0);
    expect(chose()[0]).toContain('stack-name prefix SKIPPED');
    expect(chose()[0]).toContain('the failed deploy ran with it KEPT');
  });

  it('NEGATIVE CONTROL: no flip (skipped both times) re-creates `a` and says nothing', async () => {
    const aws = fakeIam(['b']);
    const { op, state } = replaceRole('a', 'b');

    const result = await replayIn(true, () =>
      replayRollback([op], state, STACK, ctxFor(new IAMRoleProvider()))
    );

    expect(aws.created).toEqual(['a']);
    expect(state['R']?.physicalId).toBe('a');
    expect(result.failures).toBe(0);
    expect(chose()).toEqual([]);
    expect(unreproduced()).toEqual([]);
  });

  it('NEGATIVE CONTROL: no flip (kept both times) re-creates `MyStack-a` and says nothing', async () => {
    const aws = fakeIam(['MyStack-b']);
    const { op, state } = replaceRole('MyStack-a', 'MyStack-b');

    await replayIn(false, () => replayRollback([op], state, STACK, ctxFor(new IAMRoleProvider())));

    expect(aws.created).toEqual(['MyStack-a']);
    expect(chose()).toEqual([]);
    expect(unreproduced()).toEqual([]);
  });

  it.each([
    [true, 'a', 'SKIPPED'],
    [false, 'MyStack-a', 'KEPT'],
  ])(
    'an old id NEITHER setting derives keeps the recorded one (skipPrefix=%s sends %s) and warns once',
    async (skipPrefix, sent, word) => {
      const aws = fakeIam(['b']);
      const { op, state } = replaceRole('imported-role', 'b');

      const result = await replayIn(skipPrefix, () =>
        replayRollback([op], state, STACK, ctxFor(new IAMRoleProvider()))
      );

      expect(aws.created).toEqual([sent]);
      expect(result.failures).toBe(0);
      expect(chose()).toEqual([]);
      const warned = unreproduced();
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain('R (AWS::IAM::Role)');
      expect(warned[0]).toContain('imported-role');
      expect(warned[0]).toContain('"a" (prefix skipped)');
      expect(warned[0]).toContain('"MyStack-a" (prefix kept)');
      expect(warned[0]).toContain(`stack-name prefix ${word}`);
      // Advisory: the op itself succeeds, so no exit-2 warning is counted.
      expect(result.warnings).toBe(0);
    }
  );

  it('a planted old id cannot forge a line in the warning', async () => {
    fakeIam(['b']);
    const { op, state } = replaceRole('x\nTo orphan it: cdkd rollback --orphan Victim', 'b');

    await replayIn(true, () => replayRollback([op], state, STACK, ctxFor(new IAMRoleProvider())));

    const warned = unreproduced();
    expect(warned).toHaveLength(1);
    expect(warned[0]).not.toContain('\n');
    expect(warned[0]).toContain('"a" (prefix skipped)');
  });

  it('a logical-id name ignores the setting, so a nameless role is left alone and silent', async () => {
    const aws = fakeIam(['MyStack-R-new']);
    const nameless = (id: string, path: string): ResourceState => ({
      ...roleRow(id, { Path: path }),
      properties: { AssumeRolePolicyDocument: TRUST, Path: path },
    });
    const op: CompletedOperation = {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: ROLE,
      physicalId: 'MyStack-R-new',
      previousState: nameless('MyStack-R', '/old/'),
    };
    const state = { R: nameless('MyStack-R-new', '/new/') };

    await replayIn(true, () => replayRollback([op], state, STACK, ctxFor(new IAMRoleProvider())));

    expect(aws.created).toEqual(['MyStack-R']);
    expect(chose()).toEqual([]);
    expect(unreproduced()).toEqual([]);
  });
});

describe('the name-holder proof follows the chosen setting (#4024, #3979)', () => {
  it('an orphan holding `MyStack-a` does not cost the live new role `a`', async () => {
    // The re-create now asks for `MyStack-a`, which an orphan of an earlier
    // attempt holds. Derived under the FAILED deploy's flag, the proof would
    // read the sent name as `a` -- the live new role's id -- prove it the
    // holder, and delete it.
    const aws = fakeIam(['a', 'MyStack-a']);
    const provider = new IAMRoleProvider();
    const del = vi.spyOn(provider, 'delete');
    const { op, state } = replaceRole('MyStack-a', 'a');

    const result = await replayIn(true, () =>
      replayRollback([op], state, STACK, ctxFor(provider))
    );

    expect(del).not.toHaveBeenCalled();
    expect(aws.created).toEqual(['MyStack-a']);
    expect(state['R']?.physicalId).toBe('a');
    expect(result.failures).toBe(1);
    const failed = lines('warn').filter((l) => l.includes('Rollback failed for'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain('sends as "MyStack-a"');
    expect(failed[0]).toContain('Nothing was deleted');
  });

  it('NEGATIVE CONTROL: an unreproduced old id keeps the recorded setting for the proof too', async () => {
    // Neither setting derives `imported-role`, so both the create and the
    // proof run under the recorded one (prefix kept): the new role holds the
    // sent `MyStack-a`, so it is deleted first and the create retried.
    const aws = fakeIam(['MyStack-a']);
    const provider = new IAMRoleProvider();
    const del = vi.spyOn(provider, 'delete');
    const { op, state } = replaceRole('imported-role', 'MyStack-a');

    const result = await replayIn(false, () =>
      replayRollback([op], state, STACK, ctxFor(provider))
    );

    expect(result.failures).toBe(0);
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0]?.[1]).toBe('MyStack-a');
    expect(aws.created).toEqual(['MyStack-a', 'MyStack-a']);
    expect(unreproduced()).toHaveLength(1);
  });
  it('the retry after deleting a proven holder re-creates under the chosen setting too', async () => {
    // IAM names ignore case, so a new role `mystack-a` holds `MyStack-a`: the
    // re-create collides, the proof (kept) holds, the new role is deleted and
    // the create retried -- still as `MyStack-a`, not the failed deploy's `a`.
    const aws = fakeIam(['mystack-a']);
    const provider = new IAMRoleProvider();
    const { op, state } = replaceRole('MyStack-a', 'mystack-a');

    const result = await replayIn(true, () =>
      replayRollback([op], state, STACK, ctxFor(provider))
    );

    expect(result.failures).toBe(0);
    expect(aws.deleted).toEqual(['mystack-a']);
    expect(aws.created).toEqual(['MyStack-a', 'MyStack-a']);
    expect(state['R']?.physicalId).toBe('MyStack-a');
  });
});

describe('a managed policy is matched on the name segment of its ARN (#4024)', () => {
  it.each([
    ['', 'arn:aws:iam::123456789012:policy/MyStack-p'],
    ['with a path', 'arn:aws:iam::123456789012:policy/team/MyStack-p'],
  ])('%s: created with the prefix KEPT, re-created as `MyStack-p`', async (_label, oldArn) => {
    const aws = fakeIam([]);
    const doc = { Version: '2012-10-17', Statement: [] };
    const row = (id: string, props: Record<string, unknown>): ResourceState => ({
      physicalId: id,
      resourceType: POLICY,
      properties: { ManagedPolicyName: 'p', PolicyDocument: doc, ...props },
      attributes: {},
      dependencies: [],
    });
    const path = oldArn.includes('/team/') ? { Path: '/team/' } : {};
    const op: CompletedOperation = {
      logicalId: 'P',
      changeType: 'UPDATE',
      resourceType: POLICY,
      physicalId: `${ACCOUNT}:policy/p`,
      previousState: row(oldArn, path),
    };
    const state = { P: row(`${ACCOUNT}:policy/p`, { Description: 'new' }) };

    const result = await replayIn(true, () =>
      replayRollback([op], state, STACK, ctxFor(new IAMManagedPolicyProvider()))
    );

    expect(aws.created).toEqual(['MyStack-p']);
    expect(result.failures).toBe(0);
    expect(unreproduced()).toEqual([]);
  });
});

const ELB = 'arn:aws:elasticloadbalancing:us-east-1:123456789012';

describe('replayPrefixChoice reads the name each type records in its physical id (#4024)', () => {
  // [type, name property, old physical id created with the prefix KEPT,
  //  the same created with it SKIPPED]
  const cases: Array<[string, string, string, string]> = [
    ['AWS::IAM::Role', 'RoleName', 'MyStack-n', 'n'],
    ['AWS::IAM::User', 'UserName', 'MyStack-n', 'n'],
    ['AWS::IAM::Group', 'GroupName', 'MyStack-n', 'n'],
    ['AWS::IAM::InstanceProfile', 'InstanceProfileName', 'MyStack-n', 'n'],
    ['AWS::IAM::ManagedPolicy', 'ManagedPolicyName', `${ACCOUNT}:policy/p/MyStack-n`, `${ACCOUNT}:policy/n`],
    [
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      'Name',
      `${ELB}:loadbalancer/app/MyStack-n/50dc6c495c0c9188`,
      `${ELB}:loadbalancer/net/n/50dc6c495c0c9188`,
    ],
    [
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      'Name',
      `${ELB}:targetgroup/MyStack-n/73e2d6bc24d8a067`,
      `${ELB}:targetgroup/n/73e2d6bc24d8a067`,
    ],
  ];
  const choose = (
    skip: boolean,
    resourceType: string,
    properties: Record<string, unknown> | undefined,
    physicalId: unknown,
    via: 'sdk' | 'cc-api' | undefined = 'sdk'
  ): ReturnType<typeof replayPrefixChoice> =>
    withSkipPrefix(skip, () =>
      withStackName(STACK, () =>
        replayPrefixChoice({ resourceType, properties, logicalId: 'L', physicalId, via })
      )
    );

  it.each(cases)('%s: each flip picks the setting that created the id', (type, prop, kept, skipped) => {
    expect(choose(true, type, { [prop]: 'n' }, kept)).toMatchObject({
      kind: 'reproduced',
      skipPrefix: false,
      recorded: true,
    });
    expect(choose(false, type, { [prop]: 'n' }, skipped)).toMatchObject({
      kind: 'reproduced',
      skipPrefix: true,
      recorded: false,
    });
    // No flip: the recorded setting, unchanged.
    expect(choose(true, type, { [prop]: 'n' }, skipped)).toMatchObject({ skipPrefix: true });
    expect(choose(false, type, { [prop]: 'n' }, kept)).toMatchObject({ skipPrefix: false });
    // A different name altogether: neither setting.
    expect(choose(true, type, { [prop]: 'other' }, kept)).toMatchObject({
      kind: 'unreproduced',
      skipPrefix: true,
      names: { skipped: 'other', kept: 'MyStack-other' },
    });
  });

  it('a suffix match is not a name: `a` is not reproduced by `xa` or `MyStack-xa`', () => {
    expect(choose(true, ROLE, { RoleName: 'a' }, 'MyStack-xa')).toMatchObject({
      kind: 'unreproduced',
    });
    expect(choose(true, POLICY, { ManagedPolicyName: 'a' }, `${ACCOUNT}:policy/MyStack-xa`)).toMatchObject({
      kind: 'unreproduced',
    });
  });

  it('IAM names compare case-insensitively; the rewrite is still the provider’s', () => {
    expect(choose(true, ROLE, { RoleName: 'n' }, 'mystack-N')).toMatchObject({
      kind: 'reproduced',
      skipPrefix: false,
    });
  });

  it.each([
    ['a type whose provider does not rewrite the name', 'AWS::SQS::Queue', { QueueName: 'n' }, 'sdk'],
    ['a Cloud Control route (the bag is sent verbatim)', ROLE, { RoleName: 'n' }, 'cc-api'],
    ['no explicit name (the logical-id name is prefixed either way)', ROLE, {}, 'sdk'],
    ['an empty explicit name (read as none, like the generator)', ROLE, { RoleName: '' }, 'sdk'],
    ['no bag at all', ROLE, undefined, 'sdk'],
  ] as const)('not applicable: %s', (_label, type, props, via) => {
    expect(choose(true, type, props as Record<string, unknown> | undefined, 'MyStack-n', via)).toEqual({
      kind: 'not-applicable',
    });
  });

  it.each([
    ['a redacted name', { RoleName: '***' }, 'MyStack-n'],
    ['an unresolved reference', { RoleName: '{{resolve:ssm:/x}}' }, 'MyStack-n'],
    ['a non-string name', { RoleName: 7 }, 'MyStack-n'],
    ['no old physical id', { RoleName: 'n' }, undefined],
    ['an empty old physical id', { RoleName: 'n' }, ''],
    // The generator does not read `null` as "no name" (it passes it on).
    ['a null name', { RoleName: null }, 'MyStack-n'],
  ])('undecided keeps the recorded setting: %s', (_label, props, physicalId) => {
    expect(choose(true, ROLE, props, physicalId)).toMatchObject({
      kind: 'unreproduced',
      skipPrefix: true,
      property: 'RoleName',
      names: undefined,
    });
  });

  it('a name past maxLength is matched through its truncated, hashed spelling', () => {
    // An ELBv2 name caps at 32: with the stack prefix a real name overflows it,
    // and only the provider's own truncation reproduces the id.
    const long = 'orders-api-internal-load-balancer';
    const kept = withStackName(STACK, () =>
      generateResourceNameWithFallback(long, 'L', { maxLength: 32 })
    );
    expect(kept.length).toBeLessThanOrEqual(32);
    expect(kept).toMatch(/-[0-9a-f]{8}$/);
    for (const [type, arn] of [
      ['AWS::ElasticLoadBalancingV2::LoadBalancer', `${ELB}:loadbalancer/gwy/${kept}/50dc6c495c0c9188`],
      ['AWS::ElasticLoadBalancingV2::TargetGroup', `${ELB}:targetgroup/${kept}/73e2d6bc24d8a067`],
    ] as const) {
      expect(choose(true, type, { Name: long }, arn)).toMatchObject({
        kind: 'reproduced',
        skipPrefix: false,
      });
    }
  });

  it('with no stack name in scope both settings derive one name, and the recorded one stands', () => {
    const noStack = (skip: boolean) =>
      withSkipPrefix(skip, () =>
        replayPrefixChoice({
          resourceType: ROLE,
          properties: { RoleName: 'n' },
          logicalId: 'L',
          physicalId: 'n',
          via: 'sdk',
        })
      );
    expect(noStack(true)).toMatchObject({ kind: 'reproduced', skipPrefix: true, recorded: true });
    expect(noStack(false)).toMatchObject({ kind: 'reproduced', skipPrefix: false, recorded: false });
  });
});

describe('an in-place revert re-derives the name under the same choice (#4024)', () => {
  // The role provider's `update()` re-derives the name and REPLACES the role
  // when it differs from the physical id, so under the failed deploy's flag an
  // in-place revert of `MyStack-a` created `a` and deleted `MyStack-a`.
  it('a completed UPDATE of `MyStack-a` reverts in place under a deploy that SKIPPED the prefix', async () => {
    const aws = fakeIam(['MyStack-a']);
    const op: CompletedOperation = {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: ROLE,
      physicalId: 'MyStack-a',
      previousState: roleRow('MyStack-a', { Description: 'old' }),
    };
    const state = { R: roleRow('MyStack-a', { Description: 'new' }) };

    const result = await replayIn(true, () =>
      replayRollback([op], state, STACK, ctxFor(new IAMRoleProvider()))
    );

    expect(aws.created).toEqual([]);
    expect(aws.deleted).toEqual([]);
    expect(state['R']?.physicalId).toBe('MyStack-a');
    expect(result.failures).toBe(0);
  });

  it('--revert-failed: a failed UPDATE of `MyStack-a` reverts in place under a deploy that SKIPPED it', async () => {
    const aws = fakeIam(['MyStack-a']);
    const state = { R: roleRow('MyStack-a', { Description: 'new' }) };

    const result = await replayIn(true, () =>
      replayFailedOperations(
        [
          {
            logicalId: 'R',
            changeType: 'UPDATE',
            resourceType: ROLE,
            physicalId: 'MyStack-a',
            previousState: roleRow('MyStack-a', { Description: 'old' }),
            attemptedProperties: roleRow('MyStack-a', { Description: 'new' }).properties,
          },
        ],
        state,
        STACK,
        ctxFor(new IAMRoleProvider())
      )
    );

    expect(aws.created).toEqual([]);
    expect(aws.deleted).toEqual([]);
    expect(state['R']?.physicalId).toBe('MyStack-a');
    expect(result.failures).toBe(0);
  });

  it('an in-place revert of an id neither setting derives stays silent (nothing is re-created)', async () => {
    fakeIam(['imported-role']);
    const op: CompletedOperation = {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: ROLE,
      physicalId: 'imported-role',
      previousState: roleRow('imported-role', { Description: 'old' }),
    };
    const state = { R: roleRow('imported-role', { Description: 'new' }) };

    await replayIn(true, () => replayRollback([op], state, STACK, ctxFor(new IAMRoleProvider())));

    expect(unreproduced()).toEqual([]);
    expect(chose()).toEqual([]);
  });

  it('NEGATIVE CONTROL: an in-place revert of `a` under a deploy that SKIPPED it stays `a`', async () => {
    const aws = fakeIam(['a']);
    const op: CompletedOperation = {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: ROLE,
      physicalId: 'a',
      previousState: roleRow('a', { Description: 'old' }),
    };
    const state = { R: roleRow('a', { Description: 'new' }) };

    await replayIn(true, () => replayRollback([op], state, STACK, ctxFor(new IAMRoleProvider())));

    expect(aws.created).toEqual([]);
    expect(aws.deleted).toEqual([]);
  });
});

describe('the in-place arms and the route (#4024 review)', () => {
  it('--revert-failed of an id neither setting derives stays silent too', async () => {
    fakeIam(['imported-role']);
    const state = { R: roleRow('imported-role', { Description: 'new' }) };

    await replayIn(true, () =>
      replayFailedOperations(
        [
          {
            logicalId: 'R',
            changeType: 'UPDATE',
            resourceType: ROLE,
            physicalId: 'imported-role',
            previousState: roleRow('imported-role', { Description: 'old' }),
            attemptedProperties: roleRow('imported-role', { Description: 'new' }).properties,
          },
        ],
        state,
        STACK,
        ctxFor(new IAMRoleProvider())
      )
    );

    expect(unreproduced()).toEqual([]);
    expect(chose()).toEqual([]);
  });

  it('a managed policy created with the prefix KEPT reverts in place under a deploy that SKIPPED it', async () => {
    const aws = fakeIam([]);
    const arn = `${ACCOUNT}:policy/MyStack-p`;
    const row = (sid: string): ResourceState => ({
      physicalId: arn,
      resourceType: POLICY,
      properties: {
        ManagedPolicyName: 'p',
        PolicyDocument: { Version: '2012-10-17', Statement: [{ Sid: sid }] },
      },
      attributes: {},
      dependencies: [],
    });
    const op: CompletedOperation = {
      logicalId: 'P',
      changeType: 'UPDATE',
      resourceType: POLICY,
      physicalId: arn,
      previousState: row('old'),
    };
    const state = { P: row('new') };

    const result = await replayIn(true, () =>
      replayRollback([op], state, STACK, ctxFor(new IAMManagedPolicyProvider()))
    );

    // Under the failed deploy's flag `update()` derived `p` and replaced it.
    expect(aws.created).toEqual([]);
    expect(aws.deleted).toEqual([]);
    expect(state['P']?.physicalId).toBe(arn);
    expect(result.failures).toBe(0);
    expect(chose()[0]).toContain('reverting P (AWS::IAM::ManagedPolicy)');
  });

  it('a Cloud Control route says nothing: the flag does not reach what it sends', async () => {
    fakeIam(['a']);
    const { op, state } = replaceRole('MyStack-a', 'a');

    await replayIn(true, () =>
      replayRollback([op], state, STACK, ctxFor(new IAMRoleProvider(), 'cc-api'))
    );
    const { op: op2, state: state2 } = replaceRole('imported-role', 'b');
    await replayIn(true, () =>
      replayRollback([op2], state2, STACK, ctxFor(new IAMRoleProvider(), 'cc-api'))
    );

    expect(chose()).toEqual([]);
    expect(unreproduced()).toEqual([]);
  });
});

describe('a secret-derived name never reaches the log in a derived spelling (#4024 review)', () => {
  function secretRole(oldId: string, newId: string, expr = SECRET_NAME_EXPR) {
    const row = (id: string, path: string): ResourceState => ({
      ...roleRow(id, { Path: path }),
      properties: { RoleName: expr, AssumeRolePolicyDocument: TRUST, Path: path },
    });
    return {
      op: {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: ROLE,
        physicalId: newId,
        previousState: row(oldId, '/old/'),
      } as CompletedOperation,
      state: { R: row(newId, '/new/') },
    };
  }
  // The two lines this change adds. The executor's other lines are pinned by
  // `rollback-executor-derived-name-mask.test.ts` (#4037).
  const logged = (): string[] => [...chose(), ...unreproduced()];

  it('an unreproduced id: the warning names neither derivation', async () => {
    fakeIam(['b']);
    const { op, state } = secretRole('imported-role', 'b');

    await replayIn(true, () => replayRollback([op], state, STACK, ctxFor(new IAMRoleProvider())));

    const warned = unreproduced();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('its RoleName is secret-derived');
    for (const line of logged()) {
      expect(line).not.toContain('alice');
      expect(line).not.toContain('example-com');
    }
  });

  it('a flip: the chosen setting line withholds the physical id', async () => {
    const aws = fakeIam(['alice-example-com']);
    const { op, state } = secretRole('MyStack-alice-example-com', 'alice-example-com');

    await replayIn(true, () => replayRollback([op], state, STACK, ctxFor(new IAMRoleProvider())));

    // The choice itself still ran: the old name came back.
    expect(aws.created).toEqual(['MyStack-alice-example-com']);
    const said = chose();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(
      'that created it (its physical id is withheld, as its name is secret-derived): stack-name prefix KEPT; the failed deploy ran with it SKIPPED'
    );
    for (const line of logged()) expect(line).not.toContain('alice');
  });

  it.each([
    ['another stack prefixed it', 'OtherStack-alice-example-com'],
    ['IAM folded its case', 'mystack-alice-example-com-old'],
    ['another truncation hashed it', 'MyStack-alice-example-com-0a1b2c3d'],
  ])(
    'an unreproduced id spelling the secret another way (%s) is withheld',
    async (_label, oldId) => {
      fakeIam(['b']);
      const { op, state } = secretRole(oldId, 'b');

      await replayIn(true, () =>
        replayRollback([op], state, STACK, ctxFor(new IAMRoleProvider()))
      );

      const warned = unreproduced();
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain('its physical id is withheld');
      for (const line of logged()) {
        expect(line).not.toContain('alice');
        expect(line).not.toContain('example');
      }
    }
  );

  it('a declared name cdkd cannot read withholds the physical id too', async () => {
    // A leftover mask: the name may be a secret this op never resolved.
    fakeIam(['b']);
    const row = (id: string, path: string): ResourceState => ({
      ...roleRow(id, { Path: path }),
      properties: { RoleName: 7, AssumeRolePolicyDocument: TRUST, Path: path },
    });
    const op: CompletedOperation = {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: ROLE,
      physicalId: 'b',
      previousState: row('MyStack-hidden-name', '/old/'),
    };
    const state = { R: row('b', '/new/') };

    await replayIn(true, () => replayRollback([op], state, STACK, ctxFor(new IAMRoleProvider())));

    const warned = unreproduced();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('its physical id is withheld, as its name is secret-derived or unreadable');
    expect(warned[0]).not.toContain('hidden-name');
    // Only the NAME is unreadable, so only the name is named (#4035 review).
    expect(warned[0]).toContain('cdkd cannot read its RoleName to compare;');
  });

  it('an old physical id cdkd cannot read is the only thing named as unreadable', async () => {
    fakeIam(['b']);
    const { op, state } = replaceRole('', 'b');

    await replayIn(true, () => replayRollback([op], state, STACK, ctxFor(new IAMRoleProvider())));

    const warned = unreproduced();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('cdkd cannot read its physical id to compare;');
    expect(warned[0]).not.toContain('its RoleName or');
  });

  it('a logical id that is not a string: nothing is unreadable, but no name can be derived', async () => {
    fakeIam(['b']);
    const { op, state } = replaceRole('MyStack-a', 'b');
    const numeric = { ...op, logicalId: 7 as unknown as string };

    await replayIn(true, () =>
      replayRollback([numeric], { 7: state['R']! }, STACK, ctxFor(new IAMRoleProvider()))
    );

    const warned = unreproduced();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('cdkd cannot derive the names its RoleName takes to compare;');
  });

  it('both unreadable: the warning names both', async () => {
    fakeIam(['b']);
    const row = (id: string, path: string): ResourceState => ({
      ...roleRow(id, { Path: path }),
      properties: { RoleName: 7, AssumeRolePolicyDocument: TRUST, Path: path },
    });
    const op: CompletedOperation = {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: ROLE,
      physicalId: 'b',
      previousState: row('', '/old/'),
    };

    await replayIn(true, () =>
      replayRollback([op], { R: row('b', '/new/') }, STACK, ctxFor(new IAMRoleProvider()))
    );

    const warned = unreproduced();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('cdkd cannot read its RoleName or its physical id to compare;');
  });

  it('a plaintext the display escapes is masked BEFORE it is rendered', async () => {
    // The NAME is plain, so the id is shown -- but another property of the op
    // resolves a secret that the id happens to spell. `displayIdent` escapes
    // its `"`, so a mask applied after the rendering misses it.
    fakeIam(['b']);
    const row = (id: string, path: string): ResourceState => ({
      ...roleRow(id, { Path: path, Description: QUOTED_SECRET_EXPR }),
    });
    const op: CompletedOperation = {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: ROLE,
      physicalId: 'b',
      previousState: row(`x-${QUOTED_SECRET}`, '/old/'),
    };
    const state = { R: row('b', '/new/') };

    await replayIn(true, () => replayRollback([op], state, STACK, ctxFor(new IAMRoleProvider())));

    const warned = unreproduced();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('"a" (prefix skipped)');
    expect(warned[0]).toContain('x-***');
    expect(warned[0]).not.toContain('tok');
  });
});
