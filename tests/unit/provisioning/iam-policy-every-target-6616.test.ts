/**
 * go-to-k/cdkd#6616: an `AWS::IAM::Policy` attached to several principals holds
 * one copy of its document per principal, and `readCurrentState` read only the
 * FIRST. An out-of-band edit of any other copy (a widened `Action`) read clean,
 * so `cdkd drift` missed it and `--revert` left it. Every recorded target is
 * read now, except on the deploy's own post-write capture (`afterOwnWrite`).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetRolePolicyCommand,
  GetGroupPolicyCommand,
  GetUserPolicyCommand,
  NoSuchEntityException,
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

import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';

const TYPE = 'AWS::IAM::Policy';
const RECORDED = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
};
const WIDENED = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
};

const notFound = (): NoSuchEntityException =>
  new NoSuchEntityException({ message: 'The policy was not found.', $metadata: {} });

/** Live copies keyed `role:R1` / `group:G1` / `user:U1`; a missing key is NoSuchEntity. */
function liveCopies(copies: Record<string, unknown>): void {
  mockSend.mockImplementation((command: unknown) => {
    let key: string;
    if (command instanceof GetRolePolicyCommand) key = `role:${command.input.RoleName}`;
    else if (command instanceof GetGroupPolicyCommand) key = `group:${command.input.GroupName}`;
    else if (command instanceof GetUserPolicyCommand) key = `user:${command.input.UserName}`;
    else throw new Error('unexpected command');
    if (!(key in copies)) return Promise.reject(notFound());
    return Promise.resolve({ PolicyDocument: encodeURIComponent(JSON.stringify(copies[key])) });
  });
}

const calledKeys = (): string[] =>
  mockSend.mock.calls.map(([c]: unknown[]) =>
    c instanceof GetRolePolicyCommand
      ? `role:${c.input.RoleName}`
      : c instanceof GetGroupPolicyCommand
        ? `group:${c.input.GroupName}`
        : `user:${(c as GetUserPolicyCommand).input.UserName}`
  );

describe('IAMPolicyProvider.readCurrentState reads every recorded target (#6616)', () => {
  let provider: IAMPolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new IAMPolicyProvider();
  });

  it('a single-target policy makes the one call it always did', async () => {
    liveCopies({ 'role:R1': RECORDED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyName: 'pol',
      PolicyDocument: RECORDED,
      Roles: ['R1'],
    });
    expect(calledKeys()).toEqual(['role:R1']);
    expect(result).toEqual({ PolicyName: 'pol', PolicyDocument: RECORDED, Roles: ['R1'] });
  });

  it('two roles, clean: both read, the recorded document and both roles reported', async () => {
    liveCopies({ 'role:R1': RECORDED, 'role:R2': RECORDED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: ['R1', 'R2'],
    });
    expect(calledKeys()).toEqual(['role:R1', 'role:R2']);
    expect(result).toEqual({ PolicyName: 'pol', PolicyDocument: RECORDED, Roles: ['R1', 'R2'] });
  });

  it('two roles, the SECOND edited out of band: the edited document is reported', async () => {
    liveCopies({ 'role:R1': RECORDED, 'role:R2': WIDENED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: ['R1', 'R2'],
    });
    expect(result).toMatchObject({ PolicyDocument: WIDENED, Roles: ['R1', 'R2'] });
  });

  it('two roles, the FIRST edited out of band: the edited document is reported', async () => {
    liveCopies({ 'role:R1': WIDENED, 'role:R2': RECORDED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: ['R1', 'R2'],
    });
    expect(result).toMatchObject({ PolicyDocument: WIDENED });
  });

  it('a recorded document held as a JSON string still picks the edited copy', async () => {
    liveCopies({ 'role:R1': RECORDED, 'role:R2': WIDENED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: JSON.stringify(RECORDED),
      Roles: ['R1', 'R2'],
    });
    expect(result).toMatchObject({ PolicyDocument: WIDENED });
  });

  it('three targets across a role, a group and a user, the user edited: reported', async () => {
    liveCopies({ 'role:R1': RECORDED, 'group:G1': RECORDED, 'user:U1': WIDENED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: ['R1'],
      Groups: ['G1'],
      Users: ['U1'],
    });
    expect(calledKeys()).toEqual(['role:R1', 'group:G1', 'user:U1']);
    expect(result).toEqual({
      PolicyName: 'pol',
      PolicyDocument: WIDENED,
      Roles: ['R1'],
      Groups: ['G1'],
      Users: ['U1'],
    });
  });

  it('three roles, the third edited: reported', async () => {
    liveCopies({ 'role:R1': RECORDED, 'role:R2': RECORDED, 'role:R3': WIDENED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: ['R1', 'R2', 'R3'],
    });
    expect(calledKeys()).toEqual(['role:R1', 'role:R2', 'role:R3']);
    expect(result).toMatchObject({ PolicyDocument: WIDENED });
  });

  it('three targets, clean: the recorded document and every target are reported', async () => {
    liveCopies({ 'group:G1': RECORDED, 'group:G2': RECORDED, 'user:U1': RECORDED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Groups: ['G1', 'G2'],
      Users: ['U1'],
    });
    expect(result).toEqual({
      PolicyName: 'pol',
      PolicyDocument: RECORDED,
      Groups: ['G1', 'G2'],
      Users: ['U1'],
    });
  });

  it('a non-first target that lacks the policy drops out of its list (drift on Roles)', async () => {
    liveCopies({ 'role:R1': RECORDED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: ['R1', 'R2'],
    });
    expect(result).toEqual({ PolicyName: 'pol', PolicyDocument: RECORDED, Roles: ['R1'] });
  });

  it('a FIRST target that lacks the policy no longer reads the whole policy as gone', async () => {
    liveCopies({ 'user:U1': RECORDED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: ['R1'],
      Users: ['U1'],
    });
    expect(result).toEqual({
      PolicyName: 'pol',
      PolicyDocument: RECORDED,
      Roles: [],
      Users: ['U1'],
    });
  });

  it('every target lacking the policy is RESOURCE_NOT_FOUND', async () => {
    liveCopies({});
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: ['R1', 'R2'],
      Groups: ['G1'],
    });
    expect(result).toBe(RESOURCE_NOT_FOUND);
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('an error other than NoSuchEntity on any target propagates', async () => {
    mockSend.mockImplementation((command: unknown) =>
      command instanceof GetRolePolicyCommand && command.input.RoleName === 'R2'
        ? Promise.reject(new Error('AccessDenied'))
        : Promise.resolve({ PolicyDocument: encodeURIComponent(JSON.stringify(RECORDED)) })
    );
    await expect(
      provider.readCurrentState('pol', 'P', TYPE, {
        PolicyDocument: RECORDED,
        Roles: ['R1', 'R2'],
      })
    ).rejects.toThrow('AccessDenied');
  });

  it("the deploy's own post-write capture reads the first target only", async () => {
    liveCopies({ 'role:R1': RECORDED, 'role:R2': WIDENED });
    const result = await provider.readCurrentState(
      'pol',
      'P',
      TYPE,
      { PolicyDocument: RECORDED, Roles: ['R1', 'R2'] },
      { afterOwnWrite: true }
    );
    expect(calledKeys()).toEqual(['role:R1']);
    expect(result).toEqual({ PolicyName: 'pol', PolicyDocument: RECORDED, Roles: ['R1', 'R2'] });
  });

  it('a drift read with a sibling context (no afterOwnWrite) still reads every target', async () => {
    liveCopies({ 'role:R1': RECORDED, 'role:R2': WIDENED });
    const result = await provider.readCurrentState(
      'pol',
      'P',
      TYPE,
      { PolicyDocument: RECORDED, Roles: ['R1', 'R2'] },
      { siblings: {} }
    );
    expect(calledKeys()).toEqual(['role:R1', 'role:R2']);
    expect(result).toMatchObject({ PolicyDocument: WIDENED });
  });
});
