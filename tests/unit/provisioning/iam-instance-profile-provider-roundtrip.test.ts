import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AddRoleToInstanceProfileCommand,
  GetInstanceProfileCommand,
  RemoveRoleFromInstanceProfileCommand,
} from '@aws-sdk/client-iam';

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

import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';

const PHYSICAL_ID = 'my-instance-profile';
const RESOURCE_TYPE = 'AWS::IAM::InstanceProfile';

describe('IAMInstanceProfileProvider read-update round-trip', () => {
  let provider: IAMInstanceProfileProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new IAMInstanceProfileProvider();
  });

  it('round-trip on no-drift snapshot is a logical no-op (zero AWS mutations)', async () => {
    // Class 2 placeholder safety: empty Roles: [] from readCurrentState
    // must round-trip through update() without producing
    // Add/RemoveRoleFromInstanceProfile calls. The diff-based update
    // iterates the role lists, so empty == empty produces zero AWS-side
    // mutations by construction — but assert it mechanically so a
    // future refactor that breaks the contract is caught immediately.
    const observed = {
      InstanceProfileName: PHYSICAL_ID,
      Path: '/',
      Roles: [] as string[],
    };

    // GetInstanceProfile is called at the end of update() to refresh
    // attributes. Mock its response.
    mockSend.mockResolvedValueOnce({
      InstanceProfile: { Arn: `arn:aws:iam::123:instance-profile/${PHYSICAL_ID}` },
    });

    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, observed, observed);

    const addCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof AddRoleToInstanceProfileCommand
    );
    const removeCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof RemoveRoleFromInstanceProfileCommand
    );
    expect(addCalls).toHaveLength(0);
    expect(removeCalls).toHaveLength(0);
  });

  it('round-trip on no-drift snapshot with attached role is a logical no-op', async () => {
    // Same shape as the empty-roles case but with one role attached on
    // both sides. The diff (newRoles minus oldRoles, oldRoles minus
    // newRoles) is empty so no AWS-side mutations should fire.
    const observed = {
      InstanceProfileName: PHYSICAL_ID,
      Path: '/',
      Roles: ['my-role'],
    };

    mockSend.mockResolvedValueOnce({
      InstanceProfile: { Arn: `arn:aws:iam::123:instance-profile/${PHYSICAL_ID}` },
    });

    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, observed, observed);

    const addCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof AddRoleToInstanceProfileCommand
    );
    const removeCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof RemoveRoleFromInstanceProfileCommand
    );
    expect(addCalls).toHaveLength(0);
    expect(removeCalls).toHaveLength(0);
  });

  it('round-trip refreshes Arn attribute via GetInstanceProfile', async () => {
    // The end-of-update GetInstanceProfile must run so attributes stay
    // in sync — otherwise sibling Fn::GetAtt resolutions go stale after
    // a --revert. This is a structural safeguard against an
    // optimization that drops the Get when no diff is detected.
    const observed = {
      InstanceProfileName: PHYSICAL_ID,
      Path: '/',
      Roles: [] as string[],
    };

    mockSend.mockResolvedValueOnce({
      InstanceProfile: { Arn: `arn:aws:iam::123:instance-profile/${PHYSICAL_ID}` },
    });

    const result = await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, observed, observed);

    const getCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof GetInstanceProfileCommand
    );
    expect(getCalls).toHaveLength(1);
    expect(result.attributes?.Arn).toBe(`arn:aws:iam::123:instance-profile/${PHYSICAL_ID}`);
    expect(result.wasReplaced).toBe(false);
  });

  it('drifted Roles → diff produces minimal Add/Remove calls', async () => {
    // Sanity check the diff logic: removing role-a and adding role-b
    // should produce exactly one Remove and one Add, not a full
    // detach/reattach.
    const oldProps = {
      InstanceProfileName: PHYSICAL_ID,
      Path: '/',
      Roles: ['role-a'],
    };
    const newProps = {
      InstanceProfileName: PHYSICAL_ID,
      Path: '/',
      Roles: ['role-b'],
    };

    mockSend
      .mockResolvedValueOnce({}) // RemoveRoleFromInstanceProfile
      .mockResolvedValueOnce({}) // AddRoleToInstanceProfile
      .mockResolvedValueOnce({
        InstanceProfile: { Arn: `arn:aws:iam::123:instance-profile/${PHYSICAL_ID}` },
      });

    await provider.update('L', PHYSICAL_ID, RESOURCE_TYPE, newProps, oldProps);

    const removeCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof RemoveRoleFromInstanceProfileCommand
    );
    const addCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof AddRoleToInstanceProfileCommand
    );
    expect(removeCalls).toHaveLength(1);
    expect((removeCalls[0]![0] as RemoveRoleFromInstanceProfileCommand).input.RoleName).toBe(
      'role-a'
    );
    expect(addCalls).toHaveLength(1);
    expect((addCalls[0]![0] as AddRoleToInstanceProfileCommand).input.RoleName).toBe('role-b');
  });
});
