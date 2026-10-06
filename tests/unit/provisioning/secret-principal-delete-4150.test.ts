import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#4150: an `AWS::IAM::Policy` / `AWS::IAM::UserToGroupAddition`
 * record whose principal list is a secret reference was skipped on every
 * delete. On a caller that opts in (`DeleteContext.resolveSecretDerivedPrincipals`,
 * a destroy) the reference is resolved to the names the CURRENT secret value
 * holds and the attachment is removed, with every printed name masked; a
 * caller that does not opt in (a deploy, whose template-removal DELETE runs
 * after a logical-id move's CREATE put the same name) keeps the skip.
 */

const debugSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());
const resolveSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({ child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    '../../../src/deployment/intrinsic-function-resolver.js'
  );
  return {
    ...actual,
    IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
      resolveDynamicReferences: resolveSpy,
    })),
  };
});

import {
  IAMPolicyProvider,
  POLICY_MALFORMED_TARGET_SKIP_REASON,
  POLICY_SECRET_PRINCIPAL_LACKS_GRANT_SKIP_REASON,
} from '../../../src/provisioning/providers/iam-policy-provider.js';
import {
  IAMUserGroupProvider,
  MEMBERSHIP_MALFORMED_USERS_SKIP_REASON,
  MEMBERSHIP_SECRET_USER_NOT_MEMBER_SKIP_REASON,
} from '../../../src/provisioning/providers/iam-user-group-provider.js';
import {
  destroyProducerRegions,
  holdsSecretDerivedPrincipalRecord,
  isResolvableSecretPrincipalList,
  resolveSecretDerivedPrincipals,
  TRANSIENT_RESOLUTION_MESSAGE,
} from '../../../src/provisioning/secret-principal-resolution.js';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import { NoSuchEntityException } from '@aws-sdk/client-iam';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const REF = '{{resolve:secretsmanager:sdp:SecretString:role::}}';
const ROLE = 'secret-named-role-0001';
const OPT_IN = {
  expectedRegion: 'us-east-1',
  resolveSecretDerivedPrincipals: { importedProducerRegions: [] as string[] },
};
const printed = (): string =>
  [...debugSpy.mock.calls, ...warnSpy.mock.calls].map((c) => String(c[0])).join('\n');
/** The WRITE calls (a membership read is not one). */
const inputs = (): Array<Record<string, unknown>> =>
  send.mock.calls
    .filter((c) => !isMembershipRead(c[0]))
    .map((c) => (c[0] as { input: Record<string, unknown> }).input);
const isMembershipRead = (cmd: unknown): boolean =>
  (cmd as { constructor: { name: string } }).constructor.name === 'ListGroupsForUserCommand';
/** IAM as a fake: every user is a member of `grp` unless listed in `outside`. */
const iamSend =
  (outside: readonly string[] = [], write: () => Promise<unknown> = () => Promise.resolve({})) =>
  (cmd: { input: Record<string, unknown> }): Promise<unknown> =>
    isMembershipRead(cmd)
      ? Promise.resolve({
          Groups: outside.includes(cmd.input['UserName'] as string) ? [] : [{ GroupName: 'grp' }],
          IsTruncated: false,
        })
      : write();
const noSuchEntity = (message = 'gone'): NoSuchEntityException =>
  new NoSuchEntityException({ message, $metadata: {} });
/** A cross-region import recorded us-west-2: a region-less reference is ambiguous. */
const FOREIGN_PRODUCER = {
  expectedRegion: 'us-east-1',
  resolveSecretDerivedPrincipals: { importedProducerRegions: ['us-west-2'] },
};

beforeEach(() => {
  vi.clearAllMocks();
  send.mockReset();
  send.mockImplementation(iamSend());
  resolveSpy.mockImplementation((leaf: string) =>
    leaf === REF ? Promise.resolve(ROLE) : Promise.reject(new Error(`cannot resolve ${leaf}`))
  );
});

describe('resolveSecretDerivedPrincipals (go-to-k/cdkd#4150)', () => {
  const fake = { resolveDynamicReferences: resolveSpy };
  const make = () => fake;

  it('resolves a local reference, keeps plain entries, and masks every resolved name', async () => {
    const r = await resolveSecretDerivedPrincipals({ Roles: ['plain', REF] }, 'us-east-1', [], make);
    expect(r?.lists).toEqual({ Roles: ['plain', ROLE] });
    expect(r?.mask(`removed from role ${ROLE}`)).not.toContain(ROLE);
    expect(r?.mask(ROLE)).not.toBe(ROLE);
  });

  it.each([
    ['no region', { Roles: [REF] }, undefined],
    ['the mask', { Roles: ['***'] }, 'us-east-1'],
    ['a mask beside a reference', { Roles: [REF, '***'] }, 'us-east-1'],
    ['a reference in place of the list', { Roles: REF }, 'us-east-1'],
    ['a non-string entry', { Roles: [7] }, 'us-east-1'],
  ])('%s: undefined, and nothing is resolved', async (_what, values, region) => {
    expect(
      await resolveSecretDerivedPrincipals(values as Record<string, unknown>, region, [], make)
    ).toBeUndefined();
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('a reference ARN naming another region is not resolved here', async () => {
    const foreign =
      '{{resolve:secretsmanager:arn:aws:secretsmanager:eu-west-1:111122223333:secret:sdp:SecretString:role::}}';
    expect(
      await resolveSecretDerivedPrincipals({ Roles: [foreign] }, 'us-east-1', [], make)
    ).toBeUndefined();
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('a region-less reference beside a FOREIGN producer region is ambiguous: not resolved', async () => {
    // A cross-region import records the producer's region-less spelling; the
    // same name can hold another value in the consumer's region.
    expect(
      await resolveSecretDerivedPrincipals({ Roles: [REF] }, 'us-east-1', ['us-west-2'], make)
    ).toBeUndefined();
    expect(resolveSpy).not.toHaveBeenCalled();
    // The stack's own region as producer is no evidence against it.
    expect(
      (await resolveSecretDerivedPrincipals({ Roles: [REF] }, 'us-east-1', ['us-east-1'], make))
        ?.lists
    ).toEqual({ Roles: [ROLE] });
  });

  it('a malformed `{{resolve:` fragment (no whole token) is undefined with no resolver call', async () => {
    expect(
      await resolveSecretDerivedPrincipals({ Roles: ['{{resolve:secretsmanager:half'] }, 'us-east-1', [], make)
    ).toBeUndefined();
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('returns a maskError that masks the whole cause chain, and the names it resolved', async () => {
    const r = await resolveSecretDerivedPrincipals({ Roles: ['plain', REF] }, 'us-east-1', [], make);
    expect([...(r?.resolvedNames.Roles ?? [])]).toEqual([ROLE]);
    const inner = new Error(`arn:aws:iam::1:role/${ROLE} denied`);
    const outer = new Error(`wrapped ${ROLE}`, { cause: inner });
    const masked = r!.maskError(outer);
    expect(masked.message).not.toContain(ROLE);
    expect((masked.cause as Error).message).not.toContain(ROLE);
    // The original is left alone.
    expect(inner.message).toContain(ROLE);
  });

  it('a name ONLY in an own field (no message holds it) is masked on a clone, the original untouched', async () => {
    const r = await resolveSecretDerivedPrincipals({ Roles: [REF] }, 'us-east-1', [], make);
    const sdkError = Object.assign(new Error('AccessDenied'), {
      Error: { Code: 'AccessDenied', Message: `role/${ROLE}` },
    });
    const out = r!.maskError(sdkError);
    // go-to-k/cdkd#4190: `maskSecretsInError` masks own fields, so a clone is
    // made even though no message or stack held the name.
    expect(out).not.toBe(sdkError);
    expect(out.Error).toEqual({ Code: 'AccessDenied', Message: 'role/***' });
    expect(sdkError.Error.Message).toBe(`role/${ROLE}`);
  });

  it('the own-field pass stops where the clone does: links past the depth cap are the originals, untouched', async () => {
    const r = await resolveSecretDerivedPrincipals({ Roles: [REF] }, 'us-east-1', [], make);
    const links: Array<Error & { Error: { Message: string } }> = [];
    let cause: Error | undefined;
    for (let i = 0; i < 25; i++) {
      const link = Object.assign(new Error(`link ${i} ${ROLE}`, cause ? { cause } : undefined), {
        Error: { Message: `role/${ROLE}` },
      });
      links.unshift(link);
      cause = link;
    }
    const masked = r!.maskError(links[0]!);
    expect((masked as unknown as { Error: { Message: string } }).Error.Message).not.toContain(ROLE);
    // Every ORIGINAL link keeps its field, the ones past the cap included.
    for (const link of links) expect(link.Error.Message).toBe(`role/${ROLE}`);
  });

  it.each([
    [[REF], true],
    [['plain', REF], true],
    [[REF, '***'], false],
    [['***'], false],
    [['plain'], false],
    [REF, false],
    [[REF, 7], false],
    // A bad PLAIN entry beside the reference never resolves either.
    [['bad name!', REF], false],
  ])('isResolvableSecretPrincipalList(%j) is %s', (value, want) => {
    expect(isResolvableSecretPrincipalList(value)).toBe(want);
  });

  it('resolves several kinds in one call, keeping which names each kind got from a secret', async () => {
    const REF2 = '{{resolve:secretsmanager:sdp:SecretString:user::}}';
    resolveSpy.mockImplementation((leaf: string) =>
      Promise.resolve(leaf === REF ? ROLE : 'secret-named-user-0001')
    );
    const r = await resolveSecretDerivedPrincipals(
      { Roles: [REF], Users: ['plain-user', REF2] },
      'us-east-1',
      [],
      make
    );
    expect(r?.lists).toEqual({ Roles: [ROLE], Users: ['plain-user', 'secret-named-user-0001'] });
    expect([...r!.resolvedNames.Roles]).toEqual([ROLE]);
    expect([...r!.resolvedNames.Users]).toEqual(['secret-named-user-0001']);
  });

  it('a TRANSIENT resolution failure is thrown (for the caller to retry), not a skip', async () => {
    const throttle = Object.assign(new Error('Rate exceeded'), {
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 400 },
    });
    resolveSpy.mockRejectedValue(throttle);
    const error = (await resolveSecretDerivedPrincipals({ Roles: [REF] }, 'us-east-1', [], make).catch(
      (e: unknown) => e
    )) as Error;
    expect(error.message).toBe(TRANSIENT_RESOLUTION_MESSAGE);
    expect((error.cause as Error).name).toBe('ThrottlingException');
  });

  it('a 5xx resolution failure is thrown too', async () => {
    resolveSpy.mockRejectedValue(
      // 502: a server error the throttle classifier (429 / 503) does not take.
      Object.assign(new Error('Bad Gateway'), {
        name: 'InternalServerError',
        $metadata: { httpStatusCode: 502 },
      })
    );
    await expect(
      resolveSecretDerivedPrincipals({ Roles: [REF] }, 'us-east-1', [], make)
    ).rejects.toThrow(TRANSIENT_RESOLUTION_MESSAGE);
  });

  it('a transient failure is masked: a name resolved before it never rides the cause', async () => {
    const REF2 = '{{resolve:secretsmanager:sdp:SecretString:user::}}';
    resolveSpy.mockImplementation((leaf: string) =>
      leaf === REF
        ? Promise.resolve(ROLE)
        : Promise.reject(
            Object.assign(new Error(`Rate exceeded after ${ROLE}`), {
              name: 'ThrottlingException',
              $metadata: {},
            })
          )
    );
    const error = (await resolveSecretDerivedPrincipals(
      { Roles: [REF], Users: [REF2] },
      'us-east-1',
      [],
      make
    ).catch((e: unknown) => e)) as Error;
    expect((error.cause as Error).message).not.toContain(ROLE);
  });

  it.each([
    // A MESSAGE pattern the runner's classifier would call retryable, and whose
    // text the runner reads as "already deleted": never rethrown.
    ['a "does not exist" message', new Error("Key 'k' does not exist")],
    ['an access denial', new Error('User: x is not authorized to perform: ssm:GetParameter')],
  ])('%s is a skip (undefined), not a throw', async (_what, err) => {
    resolveSpy.mockRejectedValue(err);
    await expect(
      resolveSecretDerivedPrincipals({ Roles: [REF] }, 'us-east-1', [], make)
    ).resolves.toBeUndefined();
  });

  it('a failing resolution is undefined (fail-safe)', async () => {
    resolveSpy.mockRejectedValue(new Error('AccessDenied'));
    expect(await resolveSecretDerivedPrincipals({ Roles: [REF] }, 'us-east-1', [], make)).toBeUndefined();
  });

  it('a resolved value that is not an IAM name is undefined', async () => {
    resolveSpy.mockResolvedValue('not a name!');
    expect(await resolveSecretDerivedPrincipals({ Roles: [REF] }, 'us-east-1', [], make)).toBeUndefined();
  });
});

describe('IAMPolicyProvider.delete with a secret-derived principal list (go-to-k/cdkd#4150)', () => {
  const record = { PolicyName: 'pol', PolicyDocument: {}, Roles: [REF] };

  it('opted in: deletes from the principal the secret names now, printing no name', async () => {
    const result = await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      record,
      OPT_IN
    );
    expect(result).toBeUndefined();
    expect(inputs()).toEqual([{ RoleName: ROLE, PolicyName: 'pol' }]);
    expect(printed()).not.toContain(ROLE);
    expect(printed()).not.toContain('{{resolve:');
    // The rotation residual, by kind only.
    expect(printed()).toContain(
      'the recorded Roles holds a secret reference, resolved to the principals the secret names NOW'
    );
    // Both rotation directions are named.
    expect(printed()).toContain('a principal only the OLD value named keeps the inline policy');
    expect(printed()).toContain(
      'a principal only the CURRENT value names loses a same-named inline policy it held from elsewhere'
    );
  });

  it('NOT opted in (a deploy): keeps the skip, resolves nothing', async () => {
    // A deploy's template-removal DELETE runs after every CREATE: on a
    // logical-id move the new policy already put `pol` on the principal the
    // secret names, so resolving here would strip that live grant.
    const result = await new IAMPolicyProvider().delete('P', 'pol', 'AWS::IAM::Policy', record, {
      expectedRegion: 'us-east-1',
    });
    expect(result).toEqual({ outcome: 'skipped', reason: POLICY_MALFORMED_TARGET_SKIP_REASON });
    expect(send).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it.each([
    ['a failing resolution', () => resolveSpy.mockRejectedValue(new Error('x')), record],
    ['a recorded mask', () => undefined, { ...record, Roles: ['***'] }],
    // An ARRAY (the helper would take it as a list and resolve Roles first):
    // only the provider's own gate refuses before any resolution.
    ['a plainly malformed kind beside it', () => undefined, { ...record, Groups: ['bad name!'] }],
  ])('opted in but %s: keeps the skip with no AWS call', async (what, arrange, props) => {
    arrange();
    const result = await new IAMPolicyProvider().delete('P', 'pol', 'AWS::IAM::Policy', props, OPT_IN);
    expect(result).toEqual({ outcome: 'skipped', reason: POLICY_MALFORMED_TARGET_SKIP_REASON });
    expect(send).not.toHaveBeenCalled();
    if (what !== 'a failing resolution') expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('opted in, a region-less reference beside a FOREIGN producer region: skip, nothing resolved', async () => {
    const result = await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      record,
      FOREIGN_PRODUCER
    );
    expect(result).toEqual({ outcome: 'skipped', reason: POLICY_MALFORMED_TARGET_SKIP_REASON });
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('opted in with a recorded mask: the skip does not say "fix that and re-run"', async () => {
    await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      { ...record, Roles: ['***'] },
      OPT_IN
    );
    expect(printed()).not.toContain('cdkd could not resolve the reference');
    expect(printed()).not.toContain('fix that and re-run');
  });

  it('opted in: the resolver is built for the record\'s own region', async () => {
    await new IAMPolicyProvider().delete('P', 'pol', 'AWS::IAM::Policy', record, {
      ...OPT_IN,
      expectedRegion: 'eu-west-1',
    });
    expect(vi.mocked(IntrinsicFunctionResolver)).toHaveBeenCalledWith('eu-west-1');
  });

  it.each([
    ['Groups', 'GroupName'],
    ['Users', 'UserName'],
  ])('opted in: a secret-derived %s is resolved, and its name is never printed', async (kind, field) => {
    await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      { PolicyName: 'pol', PolicyDocument: {}, [kind]: [REF] },
      OPT_IN
    );
    expect(inputs()).toEqual([{ [field]: ROLE, PolicyName: 'pol' }]);
    expect(printed()).not.toContain(ROLE);
  });

  it('opted in: plain Groups and Users beside a secret Roles are deleted as recorded', async () => {
    await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      {
        PolicyName: 'pol',
        PolicyDocument: {},
        Roles: [REF],
        Groups: ['plain-group'],
        Users: ['plain-user'],
      },
      OPT_IN
    );
    expect(inputs()).toEqual([
      { RoleName: ROLE, PolicyName: 'pol' },
      { GroupName: 'plain-group', PolicyName: 'pol' },
      { UserName: 'plain-user', PolicyName: 'pol' },
    ]);
  });

  it('opted in: a resolved principal WITHOUT the policy keeps the record (rotation), naming no one', async () => {
    send.mockImplementation((cmd: { input: Record<string, unknown> }) =>
      cmd.input['RoleName'] === ROLE ? Promise.reject(noSuchEntity(`no ${ROLE}`)) : Promise.resolve({})
    );
    const result = await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      { ...record, Groups: ['plain-group'] },
      OPT_IN
    );
    expect(result).toEqual({
      outcome: 'skipped',
      reason: POLICY_SECRET_PRINCIPAL_LACKS_GRANT_SKIP_REASON,
    });
    // The other principals are still detached.
    expect(inputs()).toContainEqual({ GroupName: 'plain-group', PolicyName: 'pol' });
    expect(printed()).toContain(
      "a principal the secret's CURRENT value names does not hold this inline policy"
    );
    expect(printed()).toContain("'cdkd orphan <constructPath>'");
    // No `stackDestroy`: the single-record form (go-to-k/cdkd#4602).
    expect(printed()).toContain(
      "with no CDK app, 'cdkd state orphan <stack> --stack-region <region> --resource P', which drops only this record"
    );
    expect(printed()).not.toContain(ROLE);
  });

  it('opted in on a STACK DESTROY: the rotation skip names the whole-stack drop (go-to-k/cdkd#4602)', async () => {
    send.mockImplementation((cmd: { input: Record<string, unknown> }) =>
      cmd.input['RoleName'] === ROLE ? Promise.reject(noSuchEntity(`no ${ROLE}`)) : Promise.resolve({})
    );
    await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      { ...record, Groups: ['plain-group'] },
      { ...OPT_IN, stackDestroy: true }
    );
    expect(printed()).toContain(
      "with no CDK app, 'cdkd state orphan <stack> --stack-region <region>', which drops every " +
        "record the stack still has in that region, not just this one (add '--resource P' to drop only this one)"
    );
  });

  it.each([
    ['Groups', 'GroupName'],
    ['Users', 'UserName'],
  ])('opted in: a resolved %s principal WITHOUT the policy keeps the record too', async (kind, field) => {
    send.mockImplementation((cmd: { input: Record<string, unknown> }) =>
      cmd.input[field] === ROLE ? Promise.reject(noSuchEntity()) : Promise.resolve({})
    );
    const result = await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      { PolicyName: 'pol', PolicyDocument: {}, [kind]: [REF] },
      OPT_IN
    );
    expect(result).toEqual({
      outcome: 'skipped',
      reason: POLICY_SECRET_PRINCIPAL_LACKS_GRANT_SKIP_REASON,
    });
  });

  it('opted in: a PLAIN entry of another kind with a resolved name is not read as rotated', async () => {
    // `resolvedNames` is per kind: a plain group that happens to share the
    // resolved role's name is still a plain sibling.
    send.mockImplementation((cmd: { input: Record<string, unknown> }) =>
      cmd.input['GroupName'] === ROLE ? Promise.reject(noSuchEntity()) : Promise.resolve({})
    );
    const result = await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      { ...record, Groups: [ROLE] },
      OPT_IN
    );
    expect(result).toBeUndefined();
  });

  it.each(['Roles', 'Groups', 'Users'])(
    'opted in: a RETRY of the same delete does not read its own earlier detach from %s as a rotation',
    async (kind) => {
    // Attempt 1 detaches the resolved principal, then throttles on the plain
    // one; the runner retries with the SAME opt-in object (its retryMemo).
    const optIn = {
      expectedRegion: 'us-east-1',
      resolveSecretDerivedPrincipals: {
        importedProducerRegions: [] as string[],
        retryMemo: { detached: new Set<string>() },
      },
    };
    const props = { PolicyName: 'pol', PolicyDocument: {}, [kind]: [REF, 'plain-b'] };
    send.mockImplementationOnce(() => Promise.resolve({}));
    send.mockImplementationOnce(() => Promise.reject(new Error('Rate exceeded')));
    await expect(
      new IAMPolicyProvider().delete('P', 'pol', 'AWS::IAM::Policy', props, optIn)
    ).rejects.toThrow(/Rate exceeded/);
    send.mockImplementationOnce(() => Promise.reject(noSuchEntity()));
    send.mockImplementationOnce(() => Promise.resolve({}));
    const result = await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      props,
      optIn
    );
    expect(result).toBeUndefined();
    // One resolution, and one resolution warning, across both attempts.
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('resolved to the principals'))).toHaveLength(1);
    }
  );

  it('opted in: a transient resolution failure rejects (the runner retries) rather than skipping', async () => {
    resolveSpy.mockRejectedValue(
      Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException', $metadata: {} })
    );
    await expect(
      new IAMPolicyProvider().delete('P', 'pol', 'AWS::IAM::Policy', record, OPT_IN)
    ).rejects.toThrow(TRANSIENT_RESOLUTION_MESSAGE);
    expect(send).not.toHaveBeenCalled();
  });

  it('opted in WITH a retryMemo (the runner\'s shape): a resolved principal lacking the policy still skips', async () => {
    send.mockRejectedValue(noSuchEntity());
    const result = await new IAMPolicyProvider().delete('P', 'pol', 'AWS::IAM::Policy', record, {
      expectedRegion: 'us-east-1',
      resolveSecretDerivedPrincipals: {
        importedProducerRegions: [],
        retryMemo: { detached: new Set<string>() },
      },
    });
    expect(result).toEqual({
      outcome: 'skipped',
      reason: POLICY_SECRET_PRINCIPAL_LACKS_GRANT_SKIP_REASON,
    });
  });

  it('a retry: a resolved principal NOT detached earlier still reads as rotated', async () => {
    const REF2 = '{{resolve:secretsmanager:sdp:SecretString:role2::}}';
    resolveSpy.mockImplementation((leaf: string) =>
      Promise.resolve(leaf === REF ? ROLE : 'secret-named-role-0002')
    );
    const optIn = {
      expectedRegion: 'us-east-1',
      resolveSecretDerivedPrincipals: {
        importedProducerRegions: [] as string[],
        retryMemo: { detached: new Set<string>() },
      },
    };
    const props = { ...record, Roles: [REF, REF2] };
    // Attempt 1: A detached, then a throttle on B.
    send.mockImplementationOnce(() => Promise.resolve({}));
    send.mockImplementationOnce(() => Promise.reject(new Error('Rate exceeded')));
    await expect(
      new IAMPolicyProvider().delete('P', 'pol', 'AWS::IAM::Policy', props, optIn)
    ).rejects.toThrow(/Rate exceeded/);
    // Attempt 2: both answer NoSuchEntity; B was never detached by this delete.
    send.mockRejectedValue(noSuchEntity());
    const result = await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      props,
      optIn
    );
    expect(result).toEqual({
      outcome: 'skipped',
      reason: POLICY_SECRET_PRINCIPAL_LACKS_GRANT_SKIP_REASON,
    });
  });

  it('opted in: a secret Roles beside a MASKED Groups is not attempted and says no "fix that"', async () => {
    await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      { ...record, Groups: ['***'] },
      OPT_IN
    );
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(printed()).not.toContain('fix that and re-run');
  });

  it('opted in: a bad PLAIN entry inside the secret list is not attempted and says no "could not resolve"', async () => {
    const result = await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      { ...record, Roles: ['bad name!', REF] },
      OPT_IN
    );
    expect(result).toEqual({ outcome: 'skipped', reason: POLICY_MALFORMED_TARGET_SKIP_REASON });
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(printed()).not.toContain('cdkd could not resolve the reference');
  });

  it('opted in: secret Roles AND Users are both resolved and deleted', async () => {
    const REF2 = '{{resolve:secretsmanager:sdp:SecretString:user::}}';
    resolveSpy.mockImplementation((leaf: string) =>
      Promise.resolve(leaf === REF ? ROLE : 'secret-named-user-0001')
    );
    await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      { ...record, Users: [REF2] },
      OPT_IN
    );
    expect(inputs()).toEqual([
      { RoleName: ROLE, PolicyName: 'pol' },
      { UserName: 'secret-named-user-0001', PolicyName: 'pol' },
    ]);
    expect(printed()).not.toContain('secret-named-user-0001');
  });

  it('opted in: a PLAIN sibling without the policy is still idempotent success', async () => {
    send.mockImplementation((cmd: { input: Record<string, unknown> }) =>
      cmd.input['GroupName'] === 'plain-group' ? Promise.reject(noSuchEntity()) : Promise.resolve({})
    );
    const result = await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      { ...record, Groups: ['plain-group'] },
      OPT_IN
    );
    expect(result).toBeUndefined();
  });

  it('opted in: the thrown error\'s CAUSE is masked too, keeping what the classifiers read', async () => {
    const sdkError = Object.assign(
      new Error(`not authorized on arn:aws:iam::1:role/${ROLE}`),
      {
        name: 'ServiceUnavailable',
        $metadata: { httpStatusCode: 503 },
        // What an awsQuery SDK exception carries as an own field (measured).
        Error: { Type: 'Sender', Code: 'AccessDenied', Message: `not authorized on role/${ROLE}` },
      }
    );
    send.mockRejectedValue(sdkError);
    const error = (await new IAMPolicyProvider()
      .delete('P', 'pol', 'AWS::IAM::Policy', record, OPT_IN)
      .catch((e: unknown) => e)) as ProvisioningError & { cause?: Error };
    expect(error).toBeInstanceOf(ProvisioningError);
    expect(error.logicalId).toBe('P');
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause!.message).not.toContain(ROLE);
    expect(String(error.cause!.stack)).not.toContain(ROLE);
    expect(error.cause!.name).toBe('ServiceUnavailable');
    expect((error.cause as unknown as { $metadata: unknown }).$metadata).toEqual({
      httpStatusCode: 503,
    });
    const body = (error.cause as unknown as { Error: Record<string, string> }).Error;
    expect(body.Code).toBe('AccessDenied');
    expect(body.Message).not.toContain(ROLE);
    // The SDK's own object is left alone.
    expect(sdkError.Error.Message).toContain(ROLE);
  });

  it.each([
    ['Roles', 'role'],
    ['Groups', 'group'],
    ['Users', 'user'],
  ])('opted in: a region mismatch on NoSuchEntity hides a SHORT resolved %s name', async (kind) => {
    // Under MIN_NEEDLE_LENGTH only the per-name (whole-value) mask can hide it.
    resolveSpy.mockResolvedValue('qz');
    send.mockRejectedValue(noSuchEntity());
    const error = (await new IAMPolicyProvider()
      .delete('P', 'pol', 'AWS::IAM::Policy', { PolicyName: 'pol', PolicyDocument: {}, [kind]: [REF] }, {
        ...OPT_IN,
        expectedRegion: 'eu-west-1',
      })
      .catch((e: unknown) => e)) as Error & { cause?: Error };
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Refusing to treat NotFound');
    expect(error.message).not.toContain('qz');
    // The region check records the target (`<physicalId> (<kind> <name>)`) as
    // the refusal's physicalId, which a mask of the MESSAGE cannot reach.
    const refusal = error.cause as ProvisioningError;
    expect(refusal.physicalId).toMatch(/^pol \((role|group|user) /);
    expect(refusal.physicalId).not.toContain('qz');
  });

  it('opted in: a plain well-formed kind beside the secret one is deleted too', async () => {
    await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      { PolicyName: 'pol', PolicyDocument: {}, Roles: ['plain-role'], Users: [REF] },
      OPT_IN
    );
    expect(inputs()).toEqual([
      { RoleName: 'plain-role', PolicyName: 'pol' },
      { UserName: ROLE, PolicyName: 'pol' },
    ]);
  });

  it('opted in: a SHORT resolved name is masked too (masked alone, not inside a sentence)', async () => {
    resolveSpy.mockResolvedValue('ab');
    await new IAMPolicyProvider().delete('P', 'pol', 'AWS::IAM::Policy', record, OPT_IN);
    expect(inputs()).toEqual([{ RoleName: 'ab', PolicyName: 'pol' }]);
    const debugText = debugSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(debugText).toContain('Deleted inline policy pol from role ');
    expect(debugText).not.toMatch(/from role ab\b/);
  });

  it('a failed resolution on the opted-in path says so; the plain skip does not', async () => {
    resolveSpy.mockRejectedValue(new Error('AccessDenied'));
    await new IAMPolicyProvider().delete('P', 'pol', 'AWS::IAM::Policy', record, OPT_IN);
    expect(printed()).toContain('cdkd could not resolve the reference');
    vi.clearAllMocks();
    await new IAMPolicyProvider().delete('P', 'pol', 'AWS::IAM::Policy', record, {
      expectedRegion: 'us-east-1',
    });
    expect(printed()).not.toContain('cdkd could not resolve the reference');
    expect(printed()).toContain('so do not write the name into state.json: cdkd will keep skipping');
  });

  it('opted in with a legacy "<policyName>:<roleName>" id: the resolved list, never the legacy role', async () => {
    await new IAMPolicyProvider().delete('P', 'pol:legacy-role', 'AWS::IAM::Policy', record, OPT_IN);
    expect(inputs()).toEqual([{ RoleName: ROLE, PolicyName: 'pol' }]);
  });

  it('opted in: an AWS error echoing the principal name is masked in the thrown message', async () => {
    send.mockRejectedValue(new Error(`User is not authorized on role ${ROLE}`));
    const error = await new IAMPolicyProvider()
      .delete('P', 'pol', 'AWS::IAM::Policy', record, OPT_IN)
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/Failed to delete IAM policy P/);
    expect((error as Error).message).not.toContain(ROLE);
  });

  it('opted in: a region mismatch on NoSuchEntity names no principal', async () => {
    const { NoSuchEntityException } = await import('@aws-sdk/client-iam');
    send.mockRejectedValue(new NoSuchEntityException({ message: 'gone', $metadata: {} }));
    const error = await new IAMPolicyProvider()
      .delete('P', 'pol', 'AWS::IAM::Policy', record, {
        ...OPT_IN,
        expectedRegion: 'eu-west-1',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(ROLE);
  });
});

describe('UserToGroupAddition delete with a secret-derived Users (go-to-k/cdkd#4150)', () => {
  const record = { GroupName: 'grp', Users: [REF] };
  const TYPE = 'AWS::IAM::UserToGroupAddition';

  it('opted in: removes the user the secret names now from the group, printing no name', async () => {
    const result = await new IAMUserGroupProvider().delete('M', 'M', TYPE, record, OPT_IN);
    expect(result).toBeUndefined();
    expect(inputs()).toEqual([{ GroupName: 'grp', UserName: ROLE }]);
    expect(printed()).not.toContain(ROLE);
    expect(printed()).toContain(
      'the recorded Users holds a secret reference, resolved to the users the secret names NOW'
    );
    expect(printed()).toContain(
      'a user only the CURRENT value names is removed even if it joined from elsewhere'
    );
  });

  it('NOT opted in: keeps the skip, resolves nothing', async () => {
    const result = await new IAMUserGroupProvider().delete('M', 'M', TYPE, record, {
      expectedRegion: 'us-east-1',
    });
    expect(result).toEqual({ outcome: 'skipped', reason: MEMBERSHIP_MALFORMED_USERS_SKIP_REASON });
    expect(send).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('opted in but resolution fails: keeps the skip', async () => {
    resolveSpy.mockRejectedValue(new Error('x'));
    const result = await new IAMUserGroupProvider().delete('M', 'M', TYPE, record, OPT_IN);
    expect(result).toEqual({ outcome: 'skipped', reason: MEMBERSHIP_MALFORMED_USERS_SKIP_REASON });
    expect(send).not.toHaveBeenCalled();
  });

  it('opted in: an EXISTING resolved user outside the group keeps the record (rotation)', async () => {
    // Measured: RemoveUserFromGroup SUCCEEDS for an existing user outside the
    // group, so only the membership read can tell.
    send.mockImplementation(iamSend([ROLE]));
    await expect(
      new IAMUserGroupProvider().delete('M', 'M', TYPE, record, OPT_IN)
    ).resolves.toEqual({
      outcome: 'skipped',
      reason: MEMBERSHIP_SECRET_USER_NOT_MEMBER_SKIP_REASON,
    });
    expect(inputs()).toEqual([]);
    expect(printed()).toContain("a user the secret's CURRENT value names is not in the group");
    expect(printed()).toContain("'cdkd orphan <constructPath>'");
    // No `stackDestroy`: the single-record form (go-to-k/cdkd#4602).
    expect(printed()).toContain(
      "with no CDK app, 'cdkd state orphan <stack> --stack-region <region> --resource M', which drops only this record"
    );
    expect(printed()).not.toContain(ROLE);
  });

  it('opted in on a STACK DESTROY: the rotation skip names the whole-stack drop (go-to-k/cdkd#4602)', async () => {
    send.mockImplementation(iamSend([ROLE]));
    await new IAMUserGroupProvider().delete('M', 'M', TYPE, record, {
      ...OPT_IN,
      stackDestroy: true,
    });
    expect(printed()).toContain(
      "with no CDK app, 'cdkd state orphan <stack> --stack-region <region>', which drops every " +
        "record the stack still has in that region, not just this one (add '--resource M' to drop only this one)"
    );
  });

  it('a secret-derived Users skip names the drop for its phase (go-to-k/cdkd#4602)', async () => {
    await new IAMUserGroupProvider().delete('M', 'M', TYPE, record, {
      expectedRegion: 'us-east-1',
      stackDestroy: true,
    });
    expect(printed()).toContain(
      "Remove the users from the group by hand, then drop this record with 'cdkd state orphan " +
        "<stack> --stack-region <region>', which drops every record the stack still has in that region"
    );
    warnSpy.mockClear();
    debugSpy.mockClear();
    await new IAMUserGroupProvider().delete('M', 'M', TYPE, record, { expectedRegion: 'us-east-1' });
    expect(printed()).toContain(
      "Remove the users from the group by hand, then drop this record with 'cdkd state orphan " +
        "<stack> --stack-region <region> --resource M', which drops only this record"
    );
  });

  it('opted in: a resolved user that no longer exists keeps the record too', async () => {
    send.mockImplementation((cmd: { input: Record<string, unknown> }) =>
      isMembershipRead(cmd) ? Promise.reject(noSuchEntity(`no ${ROLE}`)) : Promise.resolve({})
    );
    await expect(
      new IAMUserGroupProvider().delete('M', 'M', TYPE, record, OPT_IN)
    ).resolves.toEqual({
      outcome: 'skipped',
      reason: MEMBERSHIP_SECRET_USER_NOT_MEMBER_SKIP_REASON,
    });
    expect(printed()).not.toContain(ROLE);
  });

  it.each([
    ['a throttle', () => Object.assign(new Error(`Rate exceeded for ${ROLE}`), { name: 'ThrottlingException', $metadata: {} })],
    ['an access denial', () => Object.assign(new Error(`not authorized: iam:ListGroupsForUser on user/${ROLE}`), { name: 'AccessDenied', $metadata: {} })],
  ])('opted in: %s on the membership read FAILS the delete (never a rotation skip), naming no one', async (_what, make) => {
    send.mockImplementation((cmd: { input: Record<string, unknown> }) =>
      isMembershipRead(cmd) ? Promise.reject(make()) : Promise.resolve({})
    );
    const error = (await new IAMUserGroupProvider()
      .delete('M', 'M', TYPE, record, OPT_IN)
      .catch((e: unknown) => e)) as Error & { cause?: Error };
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/Failed to delete IAM UserToGroupAddition M/);
    expect(error.message).not.toContain(ROLE);
    expect(error.cause?.message).not.toContain(ROLE);
    expect(inputs()).toEqual([]);
  });

  it('opted in: a member per the read whose removal answers NoSuchEntity (gone in between) keeps the record', async () => {
    send.mockImplementation(iamSend([], () => Promise.reject(noSuchEntity())));
    await expect(
      new IAMUserGroupProvider().delete('M', 'M', TYPE, record, OPT_IN)
    ).resolves.toEqual({
      outcome: 'skipped',
      reason: MEMBERSHIP_SECRET_USER_NOT_MEMBER_SKIP_REASON,
    });
  });

  it.each([
    ['recorded upper, live lower', 'GRP', 'grp'],
    ['recorded lower, live upper', 'grp', 'GRP'],
  ])('opted in: the membership match is case-insensitive (%s)', async (_what, recorded, live) => {
    send.mockImplementation((cmd: { input: Record<string, unknown> }) =>
      isMembershipRead(cmd)
        ? Promise.resolve({ Groups: [{ GroupName: live }], IsTruncated: false })
        : Promise.resolve({})
    );
    await expect(
      new IAMUserGroupProvider().delete('M', 'M', TYPE, { ...record, GroupName: recorded }, OPT_IN)
    ).resolves.toBeUndefined();
    expect(inputs()).toEqual([{ GroupName: recorded, UserName: ROLE }]);
  });

  it('opted in: the membership read pages, and a member on a later page is removed', async () => {
    send.mockImplementation((cmd: { input: Record<string, unknown> }) =>
      isMembershipRead(cmd)
        ? Promise.resolve(
            cmd.input['Marker'] === 'm2'
              ? { Groups: [{ GroupName: 'grp' }], IsTruncated: false }
              : { Groups: [{ GroupName: 'other' }], IsTruncated: true, Marker: 'm2' }
          )
        : Promise.resolve({})
    );
    await expect(
      new IAMUserGroupProvider().delete('M', 'M', TYPE, record, OPT_IN)
    ).resolves.toBeUndefined();
    expect(inputs()).toEqual([{ GroupName: 'grp', UserName: ROLE }]);
  });

  it('opted in: a PLAIN user is never read for membership, and outside the group is still success', async () => {
    send.mockImplementation(iamSend(['plain-user']));
    await expect(
      new IAMUserGroupProvider().delete('M', 'M', TYPE, { ...record, Users: [REF, 'plain-user'] }, OPT_IN)
    ).resolves.toBeUndefined();
    expect(inputs()).toEqual([
      { GroupName: 'grp', UserName: ROLE },
      { GroupName: 'grp', UserName: 'plain-user' },
    ]);
    const reads = send.mock.calls.filter((c) => isMembershipRead(c[0]));
    expect(reads.map((c) => (c[0] as { input: Record<string, unknown> }).input['UserName'])).toEqual([
      ROLE,
    ]);
  });

  it('opted in: a RETRY of the same delete does not read its own earlier removal as a rotation', async () => {
    const optIn = {
      expectedRegion: 'us-east-1',
      resolveSecretDerivedPrincipals: {
        importedProducerRegions: [] as string[],
        retryMemo: { detached: new Set<string>() },
      },
    };
    const props = { ...record, Users: [REF, 'plain-user'] };
    // Attempt 1: the resolved user is a member and is removed; the plain one throttles.
    let removed = false;
    send.mockImplementation((cmd: { input: Record<string, unknown> }) => {
      if (isMembershipRead(cmd)) {
        return Promise.resolve({ Groups: removed ? [] : [{ GroupName: 'grp' }], IsTruncated: false });
      }
      if (cmd.input['UserName'] === ROLE) {
        removed = true;
        return Promise.resolve({});
      }
      return Promise.reject(new Error('Rate exceeded'));
    });
    await expect(new IAMUserGroupProvider().delete('M', 'M', TYPE, props, optIn)).rejects.toThrow(
      /Rate exceeded/
    );
    // Attempt 2: the resolved user is now outside the group -- by THIS delete.
    send.mockImplementation((cmd: { input: Record<string, unknown> }) =>
      isMembershipRead(cmd)
        ? Promise.resolve({ Groups: [], IsTruncated: false })
        : Promise.resolve({})
    );
    await expect(
      new IAMUserGroupProvider().delete('M', 'M', TYPE, props, optIn)
    ).resolves.toBeUndefined();
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('resolved to the users'))).toHaveLength(1);
  });

  it('opted in WITH a retryMemo: a resolved user outside the group still skips; a transient failure rejects', async () => {
    const withMemo = () => ({
      expectedRegion: 'us-east-1',
      resolveSecretDerivedPrincipals: {
        importedProducerRegions: [] as string[],
        retryMemo: { detached: new Set<string>() },
      },
    });
    send.mockImplementation(iamSend([ROLE]));
    await expect(
      new IAMUserGroupProvider().delete('M', 'M', TYPE, record, withMemo())
    ).resolves.toEqual({
      outcome: 'skipped',
      reason: MEMBERSHIP_SECRET_USER_NOT_MEMBER_SKIP_REASON,
    });
    resolveSpy.mockRejectedValue(
      Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException', $metadata: {} })
    );
    await expect(
      new IAMUserGroupProvider().delete('M', 'M', TYPE, record, withMemo())
    ).rejects.toThrow(TRANSIENT_RESOLUTION_MESSAGE);
  });

  it('opted in: a SHORT resolved user name is masked, and the resolver uses the record\'s region', async () => {
    resolveSpy.mockResolvedValue('qz');
    await new IAMUserGroupProvider().delete('M', 'M', TYPE, record, {
      ...OPT_IN,
      expectedRegion: 'eu-west-1',
    });
    expect(inputs()).toEqual([{ GroupName: 'grp', UserName: 'qz' }]);
    expect(printed()).toContain('Removed user ');
    expect(printed()).not.toMatch(/Removed user qz\b/);
    expect(vi.mocked(IntrinsicFunctionResolver)).toHaveBeenCalledWith('eu-west-1');
  });

  it('opted in: the rotation warning names the OLD direction too', async () => {
    await new IAMUserGroupProvider().delete('M', 'M', TYPE, record, OPT_IN);
    expect(printed()).toContain(
      'a user only the OLD value named stays in the group (remove it by hand)'
    );
  });

  it('a failed resolution on the opted-in path says so; the plain skip and a mask do not', async () => {
    resolveSpy.mockRejectedValue(new Error('AccessDenied'));
    await new IAMUserGroupProvider().delete('M', 'M', TYPE, record, OPT_IN);
    expect(printed()).toContain('cdkd could not resolve the reference');
    vi.clearAllMocks();
    await new IAMUserGroupProvider().delete('M', 'M', TYPE, record, { expectedRegion: 'us-east-1' });
    expect(printed()).not.toContain('cdkd could not resolve the reference');
    vi.clearAllMocks();
    await new IAMUserGroupProvider().delete('M', 'M', TYPE, { ...record, Users: ['***'] }, OPT_IN);
    expect(printed()).not.toContain('fix that and re-run');
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('opted in, a region-less reference beside a FOREIGN producer region: skip, nothing resolved', async () => {
    const result = await new IAMUserGroupProvider().delete('M', 'M', TYPE, record, FOREIGN_PRODUCER);
    expect(result).toEqual({ outcome: 'skipped', reason: MEMBERSHIP_MALFORMED_USERS_SKIP_REASON });
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('opted in: the thrown error\'s CAUSE is masked too', async () => {
    send.mockImplementation(
      iamSend([], () => Promise.reject(new Error(`cannot remove arn:aws:iam::1:user/${ROLE}`)))
    );
    const error = (await new IAMUserGroupProvider()
      .delete('M', 'M', TYPE, record, OPT_IN)
      .catch((e: unknown) => e)) as Error & { cause?: Error };
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause!.message).not.toContain(ROLE);
  });

  it('opted in: an AWS error echoing the user name is masked in the thrown message', async () => {
    send.mockImplementation(iamSend([], () => Promise.reject(new Error(`cannot remove ${ROLE}`))));
    const error = await new IAMUserGroupProvider()
      .delete('M', 'M', TYPE, record, OPT_IN)
      .catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/Failed to delete IAM UserToGroupAddition M/);
    expect((error as Error).message).not.toContain(ROLE);
  });
});

describe('destroyProducerRegions / holdsSecretDerivedPrincipalRecord (go-to-k/cdkd#4150)', () => {
  it('unions own and inherited regions, skipping malformed entries', () => {
    expect(
      destroyProducerRegions(
        {
          imports: [{ sourceRegion: 'us-west-2' }, null, { sourceRegion: 3 }],
          outputReads: { not: 'a list' },
        },
        ['eu-west-1', 'us-west-2']
      )
    ).toEqual(['us-west-2', 'eu-west-1']);
  });

  it.each([[null], [undefined], ['a string'], [7]])('a non-object record (%s) is not one', (record) => {
    expect(holdsSecretDerivedPrincipalRecord(record)).toBe(false);
  });

  it.each([
    ['an IAM::Policy with a secret Roles entry', 'AWS::IAM::Policy', { Roles: [REF] }, true],
    ['a UserToGroupAddition with a secret Users entry', 'AWS::IAM::UserToGroupAddition', { Users: [REF] }, true],
    // A mask never resolves, so it needs no evidence.
    ['a UserToGroupAddition with a masked Users entry', 'AWS::IAM::UserToGroupAddition', { Users: ['***'] }, false],
    ['an IAM::Policy with a reference in place of the list', 'AWS::IAM::Policy', { Roles: REF }, false],
    ['an IAM::Policy with plain names', 'AWS::IAM::Policy', { Roles: ['r1'] }, false],
    ['a secret reference outside a principal list', 'AWS::IAM::Policy', { PolicyName: REF, Roles: ['r1'] }, false],
    ['another type', 'AWS::IAM::ManagedPolicy', { Roles: [REF] }, false],
    ['a prototype-named type', '__proto__', { Roles: [REF] }, false],
  ])('%s: %s', (_what, resourceType, properties, want) => {
    expect(holdsSecretDerivedPrincipalRecord({ resourceType, properties })).toBe(want);
  });
});
