import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GetUserCommand,
  GetGroupCommand,
  PutUserPolicyCommand,
  DeleteUserPolicyCommand,
  PutGroupPolicyCommand,
  DeleteGroupPolicyCommand,
  AttachUserPolicyCommand,
  DetachUserPolicyCommand,
  AttachGroupPolicyCommand,
  DetachGroupPolicyCommand,
  AddUserToGroupCommand,
  RemoveUserFromGroupCommand,
  PutUserPermissionsBoundaryCommand,
  DeleteUserPermissionsBoundaryCommand,
  CreateLoginProfileCommand,
  UpdateLoginProfileCommand,
  DeleteLoginProfileCommand,
  TagUserCommand,
  UntagUserCommand,
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

import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';

const USER_NAME = 'alice';
const GROUP_NAME = 'engineers';

/**
 * Mechanical guard for the three latent bug classes documented in
 * docs/provider-development.md § 3b "Read-update round-trip test":
 *
 *   - Class 1 (discriminator-dependent fields): N/A for IAM User/Group —
 *     no fields are gated by sibling discriminators. Tested as
 *     "no discriminator-only attribute reaches AWS" by negative
 *     assertion (no FIFO-style API calls happen).
 *   - Class 2 (structurally-incomplete-when-empty fields): N/A for
 *     IAM User/Group — array placeholders (`ManagedPolicyArns: []`,
 *     `Groups: []`) are diff-applied via Set semantics, so empty-array
 *     is never sent to AWS as input. The round-trip test asserts no
 *     Attach/Detach/AddUser/RemoveUser commands fire on a no-drift
 *     snapshot.
 *   - Truthy gate: `update()` uses `!== undefined` for
 *     `PermissionsBoundary`, and the `LoginProfile` / `Policies` /
 *     array-diff paths handle the round-trip case correctly. The
 *     round-trip test asserts a no-drift `observedProperties` snapshot
 *     produces ZERO mutating SDK calls — the structural defense
 *     against a future refactor that re-introduces a truthy gate or
 *     a Class 2 placeholder shipping back to AWS.
 */
describe('IAMUserGroupProvider read-update round-trip', () => {
  let provider: IAMUserGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new IAMUserGroupProvider();
  });

  // ─── AWS::IAM::User ───────────────────────────────────────────────

  it('User: round-trip on no-drift snapshot is a logical no-op (zero mutating SDK calls)', async () => {
    // updateUser ends with a GetUser to refresh attributes; mock that.
    mockSend.mockResolvedValueOnce({
      User: { UserName: USER_NAME, Arn: `arn:aws:iam::123:user/${USER_NAME}` },
    });

    // Snapshot matches what readCurrentState emits on the happy path
    // (see iam-user-group-provider-readcurrentstate.test.ts).
    const observed = {
      UserName: USER_NAME,
      Path: '/team/',
      PermissionsBoundary: 'arn:aws:iam::aws:policy/Boundary',
      ManagedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'],
      Groups: ['engineers', 'admins'],
    };

    await provider.update('L', USER_NAME, 'AWS::IAM::User', observed, observed);

    // Diff-based update on identical input should make zero AWS-side
    // mutations. Only the trailing GetUserCommand is allowed.
    const mutatingCommands = [
      PutUserPermissionsBoundaryCommand,
      DeleteUserPermissionsBoundaryCommand,
      AttachUserPolicyCommand,
      DetachUserPolicyCommand,
      AddUserToGroupCommand,
      RemoveUserFromGroupCommand,
      PutUserPolicyCommand,
      DeleteUserPolicyCommand,
      CreateLoginProfileCommand,
      UpdateLoginProfileCommand,
      DeleteLoginProfileCommand,
      TagUserCommand,
      UntagUserCommand,
    ];
    for (const Cmd of mutatingCommands) {
      const calls = mockSend.mock.calls.filter((c) => c[0] instanceof Cmd);
      expect(calls).toHaveLength(0);
    }
  });

  it('User: round-trip with empty ManagedPolicyArns and Groups arrays does not emit Class-2-shaped requests', async () => {
    // Class 2 guard: a user with NO managed policies and NO groups
    // produces `ManagedPolicyArns: []` / `Groups: []` placeholders from
    // readCurrentState. Round-tripping must NOT translate the empty
    // arrays into an AWS-rejection-shaped Attach/Add call.
    mockSend.mockResolvedValueOnce({
      User: { UserName: USER_NAME, Arn: `arn:aws:iam::123:user/${USER_NAME}` },
    });

    const observed = {
      UserName: USER_NAME,
      ManagedPolicyArns: [] as string[],
      Groups: [] as string[],
    };

    await provider.update('L', USER_NAME, 'AWS::IAM::User', observed, observed);

    expect(mockSend.mock.calls.filter((c) => c[0] instanceof AttachUserPolicyCommand)).toHaveLength(
      0
    );
    expect(mockSend.mock.calls.filter((c) => c[0] instanceof AddUserToGroupCommand)).toHaveLength(
      0
    );
    expect(
      mockSend.mock.calls.filter((c) => c[0] instanceof DetachUserPolicyCommand)
    ).toHaveLength(0);
    expect(
      mockSend.mock.calls.filter((c) => c[0] instanceof RemoveUserFromGroupCommand)
    ).toHaveLength(0);
  });

  it('User: drift in ManagedPolicyArns produces Attach/Detach diff (sanity)', async () => {
    // Positive complement: a real diff DOES produce the expected
    // mutating calls. Guards against the round-trip test passing
    // because update() became silently inert.
    mockSend
      .mockResolvedValueOnce({}) // AttachUserPolicy
      .mockResolvedValueOnce({}) // DetachUserPolicy
      .mockResolvedValueOnce({
        User: { UserName: USER_NAME, Arn: `arn:aws:iam::123:user/${USER_NAME}` },
      });

    const oldProps = {
      UserName: USER_NAME,
      ManagedPolicyArns: ['arn:aws:iam::aws:policy/Old'],
      Groups: [] as string[],
    };
    const newProps = {
      UserName: USER_NAME,
      ManagedPolicyArns: ['arn:aws:iam::aws:policy/New'],
      Groups: [] as string[],
    };

    await provider.update('L', USER_NAME, 'AWS::IAM::User', newProps, oldProps);

    expect(mockSend.mock.calls.filter((c) => c[0] instanceof AttachUserPolicyCommand)).toHaveLength(
      1
    );
    expect(mockSend.mock.calls.filter((c) => c[0] instanceof DetachUserPolicyCommand)).toHaveLength(
      1
    );
  });

  // ─── AWS::IAM::Group ──────────────────────────────────────────────

  it('Group: round-trip on no-drift snapshot is a logical no-op (zero mutating SDK calls)', async () => {
    mockSend.mockResolvedValueOnce({
      Group: { GroupName: GROUP_NAME, Arn: `arn:aws:iam::123:group/${GROUP_NAME}` },
    });

    const observed = {
      GroupName: GROUP_NAME,
      Path: '/',
      ManagedPolicyArns: ['arn:aws:iam::aws:policy/AmazonS3FullAccess'],
    };

    await provider.update('L', GROUP_NAME, 'AWS::IAM::Group', observed, observed);

    const mutatingCommands = [
      AttachGroupPolicyCommand,
      DetachGroupPolicyCommand,
      PutGroupPolicyCommand,
      DeleteGroupPolicyCommand,
    ];
    for (const Cmd of mutatingCommands) {
      const calls = mockSend.mock.calls.filter((c) => c[0] instanceof Cmd);
      expect(calls).toHaveLength(0);
    }
  });

  it('Group: round-trip with empty ManagedPolicyArns array does not emit Class-2-shaped requests', async () => {
    mockSend.mockResolvedValueOnce({
      Group: { GroupName: GROUP_NAME, Arn: `arn:aws:iam::123:group/${GROUP_NAME}` },
    });

    const observed = {
      GroupName: GROUP_NAME,
      ManagedPolicyArns: [] as string[],
    };

    await provider.update('L', GROUP_NAME, 'AWS::IAM::Group', observed, observed);

    expect(
      mockSend.mock.calls.filter((c) => c[0] instanceof AttachGroupPolicyCommand)
    ).toHaveLength(0);
    expect(
      mockSend.mock.calls.filter((c) => c[0] instanceof DetachGroupPolicyCommand)
    ).toHaveLength(0);
  });

  // ─── AWS::IAM::UserToGroupAddition ────────────────────────────────

  it('UserToGroupAddition: round-trip on no-drift snapshot is a logical no-op (zero mutating SDK calls)', async () => {
    // UserToGroupAddition has no readCurrentState (membership-only), but
    // observedProperties on this resource type falls back to `properties`
    // per the v3 schema fallback path. Round-trip should still be inert
    // when new and old match.
    const observed = {
      GroupName: GROUP_NAME,
      Users: ['alice', 'bob'],
    };

    await provider.update(
      'L',
      'logicalAddition',
      'AWS::IAM::UserToGroupAddition',
      observed,
      observed
    );

    expect(mockSend.mock.calls.filter((c) => c[0] instanceof AddUserToGroupCommand)).toHaveLength(
      0
    );
    expect(
      mockSend.mock.calls.filter((c) => c[0] instanceof RemoveUserFromGroupCommand)
    ).toHaveLength(0);
  });
});
