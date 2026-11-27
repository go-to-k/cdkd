/**
 * go-to-k/cdkd#7117: a managed policy's delete detaches only the principals
 * its record declares, as CloudFormation's handler does, and refuses over a
 * role, user or group attached outside the record (measured: CloudFormation
 * fails the delete with `Cannot delete a policy attached to entities`).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DeletePolicyCommand,
  DetachGroupPolicyCommand,
  DetachRolePolicyCommand,
  DetachUserPolicyCommand,
  GetPolicyCommand,
  ListEntitiesForPolicyCommand,
  ListPolicyVersionsCommand,
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

import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';

const ARN = 'arn:aws:iam::123456789012:policy/MyPolicy';
const TYPE = 'AWS::IAM::ManagedPolicy';

/** Answers by command class; every call is recorded in `mockSend.mock.calls`. */
function respond(entities: {
  PolicyGroups?: { GroupName: string }[];
  PolicyRoles?: { RoleName: string }[];
  PolicyUsers?: { UserName: string }[];
}) {
  mockSend.mockImplementation(async (command: unknown) => {
    if (command instanceof GetPolicyCommand) return { Policy: { Arn: ARN } };
    if (command instanceof ListEntitiesForPolicyCommand) return { ...entities, IsTruncated: false };
    if (command instanceof ListPolicyVersionsCommand) {
      return { Versions: [{ VersionId: 'v1', IsDefaultVersion: true }], IsTruncated: false };
    }
    return {};
  });
}

function sent<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.map(([c]) => c).filter((c): c is T => c instanceof ctor);
}

const names = (calls: { input: Record<string, unknown> }[], key: string) =>
  calls.map((c) => c.input[key]);

describe('IAMManagedPolicyProvider.delete: undeclared principals (#7117)', () => {
  let provider: IAMManagedPolicyProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new IAMManagedPolicyProvider();
  });

  it('detaches the declared principals and refuses over a role attached outside the record', async () => {
    respond({
      PolicyRoles: [{ RoleName: 'stack-role' }, { RoleName: 'outside-role' }],
      PolicyUsers: [{ UserName: 'outside-user' }],
    });

    const err = await provider
      .delete('MyPolicy', ARN, TYPE, { PolicyDocument: {}, Roles: ['stack-role'] })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain('role outside-role');
    expect(message).toContain('user outside-user');
    expect(message).not.toContain('stack-role');
    expect(message).not.toMatch(/not found|does not exist|NoSuchEntity/i);
    expect(isMarkedNonRetryable(err)).toBe(true);
    // The declared role was detached before the refusal.
    expect(isDeleteStarted(err)).toBe(true);
    expect(names(sent(DetachRolePolicyCommand), 'RoleName')).toEqual(['stack-role']);
    expect(sent(DetachUserPolicyCommand)).toHaveLength(0);
    expect(sent(DeletePolicyCommand)).toHaveLength(0);
  });

  it('refuses before any detach when no principal is declared, without the delete-started mark', async () => {
    respond({ PolicyGroups: [{ GroupName: 'ops' }] });

    const err = await provider
      .delete('MyPolicy', ARN, TYPE, { PolicyDocument: {} })
      .catch((e: unknown) => e);

    expect((err as Error).message).toContain('group ops');
    expect(isDeleteStarted(err)).toBe(false);
    expect(sent(DetachGroupPolicyCommand)).toHaveLength(0);
    expect(sent(DeletePolicyCommand)).toHaveLength(0);
  });

  it('matches declared names ignoring case, as IAM does, and deletes', async () => {
    respond({
      PolicyGroups: [{ GroupName: 'admins' }],
      PolicyRoles: [{ RoleName: 'my-role' }],
      PolicyUsers: [{ UserName: 'alice' }],
    });

    await provider.delete('MyPolicy', ARN, TYPE, {
      Groups: ['Admins'],
      Roles: ['My-Role'],
      Users: ['ALICE'],
    });

    expect(names(sent(DetachGroupPolicyCommand), 'GroupName')).toEqual(['admins']);
    expect(names(sent(DetachRolePolicyCommand), 'RoleName')).toEqual(['my-role']);
    expect(names(sent(DetachUserPolicyCommand), 'UserName')).toEqual(['alice']);
    expect(sent(DeletePolicyCommand)).toHaveLength(1);
  });

  it('deletes a policy attached to nothing', async () => {
    respond({});

    await provider.delete('MyPolicy', ARN, TYPE, { PolicyDocument: {} });

    expect(sent(DeletePolicyCommand)).toHaveLength(1);
  });

  it('detaches every principal under detachUndeclaredPrincipals (the in-update replacement)', async () => {
    respond({ PolicyRoles: [{ RoleName: 'stack-role' }, { RoleName: 'other' }] });

    await provider.delete(
      'MyPolicy',
      ARN,
      TYPE,
      { Roles: ['stack-role'] },
      { detachUndeclaredPrincipals: true }
    );

    expect(names(sent(DetachRolePolicyCommand), 'RoleName')).toEqual(['stack-role', 'other']);
    expect(sent(DeletePolicyCommand)).toHaveLength(1);
  });

  it.each([
    ['a masked list', { Roles: ['***'] }],
    ['a secret reference', { Roles: ['{{resolve:secretsmanager:s:SecretString:r}}'] }],
    ['no record bag', undefined],
  ])(
    'detaches every principal when the record cannot tell its own (%s), as before',
    async (_label, bag) => {
      respond({ PolicyRoles: [{ RoleName: 'r1' }, { RoleName: 'r2' }] });

      await provider.delete('MyPolicy', ARN, TYPE, bag);

      expect(names(sent(DetachRolePolicyCommand), 'RoleName')).toEqual(['r1', 'r2']);
      expect(sent(DeletePolicyCommand)).toHaveLength(1);
    }
  );
});

describe('IAMManagedPolicyProvider.update: the in-update replacement keeps detaching every principal', () => {
  it('passes detachUndeclaredPrincipals to the old policy delete', async () => {
    mockSend.mockReset();
    const provider = new IAMManagedPolicyProvider();
    const createSpy = vi
      .spyOn(provider, 'create')
      .mockResolvedValue({ physicalId: 'arn:aws:iam::123456789012:policy/New', attributes: {} });
    const deleteSpy = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);

    await provider.update(
      'MyPolicy',
      ARN,
      TYPE,
      { ManagedPolicyName: 'New', PolicyDocument: {} },
      { ManagedPolicyName: 'MyPolicy', PolicyDocument: {} }
    );

    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(deleteSpy.mock.calls[0]![4]).toMatchObject({ detachUndeclaredPrincipals: true });
  });
});
