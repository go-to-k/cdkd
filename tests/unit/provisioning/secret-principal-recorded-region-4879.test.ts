import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#4879: a destroy resolves a region-less secret reference in an
 * IAM principal list in the region its v12 record names
 * (`referenceProvenance[token].region`), through the stack resolver's
 * producer-region guest (`resolverForRecordedRegion`), where it used to skip
 * the token as ambiguous beside a foreign producer region. A record without
 * the field keeps that skip.
 */

const send = vi.hoisted(() => vi.fn());
const primaryResolve = vi.hoisted(() => vi.fn());
const guestResolve = vi.hoisted(() => vi.fn());
const guestFor = vi.hoisted(() => vi.fn());
const childWarn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: childWarn,
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
      resolveDynamicReferences: primaryResolve,
      resolverForRecordedRegion: guestFor,
    })),
  };
});

import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import {
  resolveSecretDerivedPrincipals,
  TRANSIENT_RESOLUTION_MESSAGE,
} from '../../../src/provisioning/secret-principal-resolution.js';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';

const REF = '{{resolve:secretsmanager:sdp:SecretString:role::}}';
const OTHER = '{{resolve:secretsmanager:sdp2:SecretString:role::}}';
const ROLE_WEST = 'west-named-role-0001';
const ROLE_EAST = 'east-named-role-0001';
const FOREIGN = ['us-west-2'];
const recorded = (entries: Record<string, string>): ReadonlyMap<string, string> =>
  new Map(Object.entries(entries));

const primary = { resolveDynamicReferences: primaryResolve, resolverForRecordedRegion: guestFor };
const make = (): typeof primary => primary;

beforeEach(() => {
  vi.clearAllMocks();
  send.mockReset();
  send.mockResolvedValue({});
  // The same secret NAME holds a different value in each region.
  primaryResolve.mockImplementation((leaf: string) =>
    leaf === REF || leaf === OTHER
      ? Promise.resolve(ROLE_EAST)
      : Promise.reject(new Error('unresolvable'))
  );
  guestResolve.mockImplementation((leaf: string) =>
    leaf === REF ? Promise.resolve(ROLE_WEST) : Promise.reject(new Error('unresolvable'))
  );
  guestFor.mockImplementation(() => ({ resolveDynamicReferences: guestResolve }));
});

describe('resolveSecretDerivedPrincipals with a recorded region (go-to-k/cdkd#4879)', () => {
  it('a region-less token beside a foreign producer, recorded in that region: resolved by its guest', async () => {
    const r = await resolveSecretDerivedPrincipals(
      { Roles: ['plain', REF] },
      'us-east-1',
      FOREIGN,
      recorded({ [REF]: 'us-west-2' }),
      make
    );
    expect(r?.lists).toEqual({ Roles: ['plain', ROLE_WEST] });
    expect(guestFor).toHaveBeenCalledWith('us-west-2');
    // Never resolved in the consumer's region, where the same name holds another value.
    expect(primaryResolve).not.toHaveBeenCalled();
    expect(r?.resolvedNames['Roles']).toEqual(new Set([ROLE_WEST]));
    expect(r?.mask(ROLE_WEST)).not.toBe(ROLE_WEST);
    expect(r?.mask(`role ${ROLE_WEST} gone`)).not.toContain(ROLE_WEST);
  });

  it('recorded in the stack region itself: resolved there, by the primary', async () => {
    const r = await resolveSecretDerivedPrincipals(
      { Roles: [REF] },
      'us-east-1',
      FOREIGN,
      recorded({ [REF]: 'us-east-1' }),
      make
    );
    expect(r?.lists).toEqual({ Roles: [ROLE_EAST] });
    expect(guestFor).not.toHaveBeenCalled();
  });

  it.each([
    ['a record without the field', undefined],
    ['a record naming another token only', recorded({ [OTHER]: 'us-west-2' })],
  ])('%s: the ambiguous skip is kept, nothing resolved', async (_what, regions) => {
    expect(
      await resolveSecretDerivedPrincipals({ Roles: [REF] }, 'us-east-1', FOREIGN, regions, make)
    ).toBeUndefined();
    expect(primaryResolve).not.toHaveBeenCalled();
    expect(guestFor).not.toHaveBeenCalled();
  });

  it('one recorded token beside an unrecorded ambiguous one: nothing is resolved', async () => {
    expect(
      await resolveSecretDerivedPrincipals(
        { Roles: [REF, OTHER] },
        'us-east-1',
        FOREIGN,
        recorded({ [REF]: 'us-west-2' }),
        make
      )
    ).toBeUndefined();
    expect(primaryResolve).not.toHaveBeenCalled();
    expect(guestResolve).not.toHaveBeenCalled();
  });

  it('an ARN-form token naming another region is still not resolved: the ARN binds, not the record', async () => {
    const arn =
      '{{resolve:secretsmanager:arn:aws:secretsmanager:eu-west-1:111122223333:secret:sdp:SecretString:role::}}';
    expect(
      await resolveSecretDerivedPrincipals(
        { Roles: [arn] },
        'us-east-1',
        [],
        recorded({ [arn]: 'us-east-1' }),
        make
      )
    ).toBeUndefined();
    expect(primaryResolve).not.toHaveBeenCalled();
  });

  it('two tokens spliced in one entry each resolve in their own region', async () => {
    primaryResolve.mockImplementation((leaf: string) =>
      leaf === OTHER ? Promise.resolve('east') : Promise.reject(new Error('whole leaf'))
    );
    guestResolve.mockImplementation((leaf: string) =>
      leaf === REF ? Promise.resolve('west') : Promise.reject(new Error('whole leaf'))
    );
    const r = await resolveSecretDerivedPrincipals(
      { Roles: [`p-${REF}-${OTHER}-s`] },
      'us-east-1',
      [],
      recorded({ [REF]: 'us-west-2' }),
      make
    );
    expect(r?.lists).toEqual({ Roles: ['p-west-east-s'] });
    expect(r?.resolvedNames['Roles']).toEqual(new Set(['p-west-east-s']));
    expect(r?.mask('role p-west-east-s gone')).not.toContain('p-west-east-s');
  });

  it('a transient failure in the guest is thrown for the runner to retry, never a skip', async () => {
    guestResolve.mockRejectedValue(
      Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException', $metadata: {} })
    );
    await expect(
      resolveSecretDerivedPrincipals(
        { Roles: [REF] },
        'us-east-1',
        FOREIGN,
        recorded({ [REF]: 'us-west-2' }),
        make
      )
    ).rejects.toThrow(TRANSIENT_RESOLUTION_MESSAGE);
  });

  it('a definitive failure in the guest is a skip (undefined)', async () => {
    guestResolve.mockRejectedValue(new Error('ResourceNotFoundException'));
    expect(
      await resolveSecretDerivedPrincipals(
        { Roles: [REF] },
        'us-east-1',
        FOREIGN,
        recorded({ [REF]: 'us-west-2' }),
        make
      )
    ).toBeUndefined();
  });
});

describe('the IAM deletes thread the recorded regions (go-to-k/cdkd#4879)', () => {
  const optIn = (regions?: ReadonlyMap<string, string>) => ({
    expectedRegion: 'us-east-1',
    resolveSecretDerivedPrincipals: {
      importedProducerRegions: FOREIGN,
      ...(regions !== undefined && { recordedRegions: regions }),
    },
  });

  it('AWS::IAM::Policy: deletes from the principal the producer region names', async () => {
    const result = await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      { PolicyName: 'pol', PolicyDocument: {}, Roles: [REF] },
      optIn(recorded({ [REF]: 'us-west-2' }))
    );
    expect(result).toBeUndefined();
    expect(vi.mocked(IntrinsicFunctionResolver)).toHaveBeenCalledWith('us-east-1');
    expect(send.mock.calls.map((c) => (c[0] as { input: unknown }).input)).toEqual([
      { RoleName: ROLE_WEST, PolicyName: 'pol' },
    ]);
  });

  it('AWS::IAM::Policy without recorded regions: the skip, no AWS call', async () => {
    const result = await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      { PolicyName: 'pol', PolicyDocument: {}, Roles: [REF] },
      optIn()
    );
    expect(result).toMatchObject({ outcome: 'skipped' });
    expect(send).not.toHaveBeenCalled();
  });

  it('AWS::IAM::UserToGroupAddition: removes the user the producer region names', async () => {
    send.mockImplementation((cmd: { constructor: { name: string }; input: Record<string, unknown> }) =>
      Promise.resolve(
        cmd.constructor.name === 'ListGroupsForUserCommand'
          ? { Groups: [{ GroupName: 'grp' }], IsTruncated: false }
          : {}
      )
    );
    const result = await new IAMUserGroupProvider().delete(
      'M',
      'M',
      'AWS::IAM::UserToGroupAddition',
      { GroupName: 'grp', Users: [REF] },
      optIn(recorded({ [REF]: 'us-west-2' }))
    );
    expect(result).toBeUndefined();
    const writes = send.mock.calls
      .map((c) => c[0] as { constructor: { name: string }; input: unknown })
      .filter((c) => c.constructor.name !== 'ListGroupsForUserCommand')
      .map((c) => c.input);
    expect(writes).toEqual([{ GroupName: 'grp', UserName: ROLE_WEST }]);
  });

  it('AWS::IAM::UserToGroupAddition without recorded regions: the skip, no AWS call', async () => {
    const result = await new IAMUserGroupProvider().delete(
      'M',
      'M',
      'AWS::IAM::UserToGroupAddition',
      { GroupName: 'grp', Users: [REF] },
      optIn()
    );
    expect(result).toMatchObject({ outcome: 'skipped' });
    expect(send).not.toHaveBeenCalled();
  });
});

/**
 * go-to-k/cdkd#4887: a nested child destroyed on its own does not know the
 * regions its parent reads from (`complete: false`). A region-less token its
 * record places in a region still resolves there; one without a recorded
 * region may be the parent's and is never resolved in the stack's region.
 */
describe('resolveSecretDerivedPrincipals with incomplete producer-region evidence (go-to-k/cdkd#4887)', () => {
  const incomplete = { regions: [] as string[], complete: false };

  it('a token recorded in another region resolves there, by its guest', async () => {
    const r = await resolveSecretDerivedPrincipals(
      { Roles: ['plain', REF] },
      'us-east-1',
      incomplete,
      recorded({ [REF]: 'us-west-2' }),
      make
    );
    expect(r?.lists).toEqual({ Roles: ['plain', ROLE_WEST] });
    expect(guestFor).toHaveBeenCalledWith('us-west-2');
    expect(primaryResolve).not.toHaveBeenCalled();
  });

  it('a token recorded in the stack region resolves there, by the primary', async () => {
    const r = await resolveSecretDerivedPrincipals(
      { Roles: [REF] },
      'us-east-1',
      incomplete,
      recorded({ [REF]: 'us-east-1' }),
      make
    );
    expect(r?.lists).toEqual({ Roles: [ROLE_EAST] });
    expect(guestFor).not.toHaveBeenCalled();
  });

  it.each([
    ['a record without the field', undefined],
    ['a record naming another token only', recorded({ [OTHER]: 'us-west-2' })],
  ])('%s: a region-less token is not resolved, nothing is fetched', async (_what, regions) => {
    expect(
      await resolveSecretDerivedPrincipals({ Roles: [REF] }, 'us-east-1', incomplete, regions, make)
    ).toBeUndefined();
    expect(primaryResolve).not.toHaveBeenCalled();
    expect(guestFor).not.toHaveBeenCalled();
  });

  it('one recorded token beside an unrecorded one: nothing is resolved', async () => {
    expect(
      await resolveSecretDerivedPrincipals(
        { Roles: [`${REF}-${OTHER}`] },
        'us-east-1',
        incomplete,
        recorded({ [REF]: 'us-west-2' }),
        make
      )
    ).toBeUndefined();
    expect(primaryResolve).not.toHaveBeenCalled();
    expect(guestResolve).not.toHaveBeenCalled();
  });

  it('an ARN-form token naming the stack region names its own region: resolved', async () => {
    const arn =
      '{{resolve:secretsmanager:arn:aws:secretsmanager:us-east-1:111122223333:secret:sdp:SecretString:role::}}';
    primaryResolve.mockImplementation((leaf: string) =>
      leaf === arn ? Promise.resolve(ROLE_EAST) : Promise.reject(new Error('unresolvable'))
    );
    const r = await resolveSecretDerivedPrincipals({ Roles: [arn] }, 'us-east-1', incomplete, undefined, make);
    expect(r?.lists).toEqual({ Roles: [ROLE_EAST] });
  });

  it('control: the same unrecorded token with COMPLETE evidence and no foreign region resolves locally', async () => {
    const r = await resolveSecretDerivedPrincipals(
      { Roles: [REF] },
      'us-east-1',
      { regions: [], complete: true },
      undefined,
      make
    );
    expect(r?.lists).toEqual({ Roles: [ROLE_EAST] });
  });
});

describe('the IAM deletes thread the incomplete-evidence marker (go-to-k/cdkd#4887)', () => {
  const optIn = (regions?: ReadonlyMap<string, string>) => ({
    expectedRegion: 'us-east-1',
    resolveSecretDerivedPrincipals: {
      importedProducerRegions: [],
      producerRegionsIncomplete: true,
      ...(regions !== undefined && { recordedRegions: regions }),
    },
  });

  it('AWS::IAM::Policy recorded in a region: deletes from the principal that region names', async () => {
    const result = await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      { PolicyName: 'pol', PolicyDocument: {}, Roles: [REF] },
      optIn(recorded({ [REF]: 'us-west-2' }))
    );
    expect(result).toBeUndefined();
    expect(send.mock.calls.map((c) => (c[0] as { input: unknown }).input)).toEqual([
      { RoleName: ROLE_WEST, PolicyName: 'pol' },
    ]);
  });

  it('AWS::IAM::Policy without a recorded region: the skip, no AWS call', async () => {
    const result = await new IAMPolicyProvider().delete(
      'P',
      'pol',
      'AWS::IAM::Policy',
      { PolicyName: 'pol', PolicyDocument: {}, Roles: [REF] },
      optIn()
    );
    expect(result).toMatchObject({ outcome: 'skipped' });
    expect(primaryResolve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    // The remedy is the top-level stack, not "fix that and re-run".
    const warned = childWarn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('destroy it through its top-level stack');
    expect(warned).not.toContain('so fix that and re-run');
  });

  it.each(['AWS::IAM::Policy', 'AWS::IAM::UserToGroupAddition'])(
    '%s recorded in a region whose lookup fails: the skip names the lookup, not the parent',
    async (type) => {
      guestResolve.mockRejectedValue(new Error('ResourceNotFoundException'));
      const result =
        type === 'AWS::IAM::Policy'
          ? await new IAMPolicyProvider().delete(
              'P',
              'pol',
              type,
              { PolicyName: 'pol', PolicyDocument: {}, Roles: [REF] },
              optIn(recorded({ [REF]: 'us-west-2' }))
            )
          : await new IAMUserGroupProvider().delete(
              'M',
              'M',
              type,
              { GroupName: 'grp', Users: [REF] },
              optIn(recorded({ [REF]: 'us-west-2' }))
            );
      expect(result).toMatchObject({ outcome: 'skipped' });
      const warned = childWarn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('so fix that and re-run');
      expect(warned).not.toContain('destroy it through its top-level stack');
    }
  );

  it('AWS::IAM::UserToGroupAddition recorded in a region: removes the user that region names', async () => {
    send.mockImplementation((cmd: { constructor: { name: string }; input: Record<string, unknown> }) =>
      Promise.resolve(
        cmd.constructor.name === 'ListGroupsForUserCommand'
          ? { Groups: [{ GroupName: 'grp' }], IsTruncated: false }
          : {}
      )
    );
    const result = await new IAMUserGroupProvider().delete(
      'M',
      'M',
      'AWS::IAM::UserToGroupAddition',
      { GroupName: 'grp', Users: [REF] },
      optIn(recorded({ [REF]: 'us-west-2' }))
    );
    expect(result).toBeUndefined();
    const writes = send.mock.calls
      .map((c) => c[0] as { constructor: { name: string }; input: unknown })
      .filter((c) => c.constructor.name !== 'ListGroupsForUserCommand')
      .map((c) => c.input);
    expect(writes).toEqual([{ GroupName: 'grp', UserName: ROLE_WEST }]);
  });

  it('AWS::IAM::UserToGroupAddition without a recorded region: the skip, no AWS call', async () => {
    const result = await new IAMUserGroupProvider().delete(
      'M',
      'M',
      'AWS::IAM::UserToGroupAddition',
      { GroupName: 'grp', Users: [REF] },
      optIn()
    );
    expect(result).toMatchObject({ outcome: 'skipped' });
    expect(primaryResolve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    const warned = childWarn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('destroy it through its top-level stack');
    expect(warned).not.toContain('so fix that and re-run');
  });
});
