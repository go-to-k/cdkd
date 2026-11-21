/**
 * go-to-k/cdkd#6750: on a stack destroy, an IAM role an instance profile still
 * holds is refused (CloudFormation's handler has no
 * `iam:RemoveRoleFromInstanceProfile`, and `DeleteRole` answers
 * `DeleteConflict`) instead of being removed from that profile. A deploy's
 * delete (template removal, replacement) keeps the removal: a same-name
 * re-create relies on it (go-to-k/cdkd#4461).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeleteConflictException, NoSuchEntityException } from '@aws-sdk/client-iam';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

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

import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

type Handler = (input: Record<string, unknown>) => unknown;
let sent: string[];

function drive(handlers: Record<string, Handler>): void {
  mockSend.mockImplementation(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      sent.push(name);
      const handler = handlers[name];
      return handler ? handler(command.input) : {};
    }
  );
}

const conflict = (): never => {
  throw new DeleteConflictException({
    $metadata: {},
    message: 'Cannot delete entity, must remove roles from instance profile first.',
  });
};

/** Profiles listed per call, in order; the last one repeats. */
function profiles(...listings: string[][]): Handler {
  let call = 0;
  return () => {
    const names = listings[Math.min(call++, listings.length - 1)]!;
    return { InstanceProfiles: names.map((InstanceProfileName) => ({ InstanceProfileName })) };
  };
}

const base: Record<string, Handler> = {
  GetRoleCommand: () => ({ Role: { RoleName: 'my-role' } }),
  // Every profile read holds the role unless a case says otherwise.
  GetInstanceProfileCommand: () => ({ InstanceProfile: { Roles: [{ RoleName: 'my-role' }] } }),
  ListAttachedRolePoliciesCommand: () => ({ AttachedPolicies: [] }),
  ListRolePoliciesCommand: () => ({ PolicyNames: [] }),
  DeleteRoleCommand: conflict,
};

const destroy = (provider = new IAMRoleProvider(), maskSecrets?: (text: string) => string) =>
  provider
    .delete('Role', 'my-role', 'AWS::IAM::Role', undefined, {
      stackDestroy: true,
      ...(maskSecrets && { maskSecrets }),
    })
    .then(
      () => undefined,
      (e: unknown) => e
    );

beforeEach(() => {
  vi.restoreAllMocks();
  mockSend.mockReset();
  sent = [];
  // The recheck's wait runs at once; its duration is asserted where it matters.
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn();
    return 0;
  }) as unknown as typeof setTimeout);
});

describe('IAM role delete on a stack destroy (#6750)', () => {
  it('refuses a role an out-of-stack profile holds, non-retryably, naming the profile, and never removes it', async () => {
    drive({ ...base, ListInstanceProfilesForRoleCommand: profiles(['other-stack-profile']) });

    const error = await destroy();

    expect(error).toBeInstanceOf(ProvisioningError);
    const message = (error as Error).message;
    expect(message).toContain(
      'role my-role is still in instance profile(s) other-stack-profile, which this destroy did not delete'
    );
    expect(message).toContain('aws iam remove-role-from-instance-profile');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect((error as Error).cause).toBeInstanceOf(DeleteConflictException);
    expect(sent).not.toContain('RemoveRoleFromInstanceProfileCommand');
    // DeleteRole first; the profiles are read only after its refusal.
    expect(sent.indexOf('DeleteRoleCommand')).toBeLessThan(
      sent.indexOf('ListInstanceProfilesForRoleCommand')
    );
    expect(vi.mocked(setTimeout).mock.calls.map((c) => c[1])).toContain(2000);
  });

  it('names at most five profiles and says there are more', async () => {
    drive({
      ...base,
      ListInstanceProfilesForRoleCommand: profiles(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']),
    });

    expect(((await destroy()) as Error).message).toContain(
      'instance profile(s) p1, p2, p3, p4, p5, and more, which'
    );
  });

  it('caps the names after GetInstanceProfile, so a holder past the first five is still named', async () => {
    drive({
      ...base,
      ListInstanceProfilesForRoleCommand: profiles(['g1', 'g2', 'g3', 'g4', 'g5', 'held']),
      GetInstanceProfileCommand: (input) => {
        if (input['InstanceProfileName'] !== 'held') {
          throw new NoSuchEntityException({ $metadata: {}, message: 'not found' });
        }
        return { InstanceProfile: { Roles: [{ RoleName: 'my-role' }] } };
      },
    });

    expect(((await destroy()) as Error).message).toContain('instance profile(s) held, which');
  });

  it('names only profiles both listings show', async () => {
    drive({ ...base, ListInstanceProfilesForRoleCommand: profiles(['own', 'kept'], ['kept']) });

    const message = ((await destroy()) as Error).message;
    expect(message).toContain('instance profile(s) kept, which');
    expect(message).not.toContain('own');
  });

  it('a profile gone by the second listing (IAM lagging the stack\'s own delete) keeps AWS\'s error', async () => {
    drive({ ...base, ListInstanceProfilesForRoleCommand: profiles(['own'], []) });

    const error = await destroy();

    expect((error as Error).message).toMatch(/^Failed to delete IAM role Role: /);
    expect((error as Error).message).not.toContain('is still in instance profile');
    expect(isMarkedNonRetryable(error)).toBe(false);
    // Listed empty: DeleteRole is tried once more, and its refusal surfaces.
    expect(sent.filter((n) => n === 'DeleteRoleCommand')).toHaveLength(2);
  });

  it('a profile GetInstanceProfile shows gone, or without the role, is the listing lagging', async () => {
    drive({
      ...base,
      ListInstanceProfilesForRoleCommand: profiles(['deleted', 'detached', 'kept']),
      GetInstanceProfileCommand: (input) => {
        if (input['InstanceProfileName'] === 'deleted') {
          throw new NoSuchEntityException({ $metadata: {}, message: 'not found' });
        }
        return {
          InstanceProfile: {
            Roles: input['InstanceProfileName'] === 'kept' ? [{ RoleName: 'my-role' }] : [],
          },
        };
      },
    });

    const message = ((await destroy()) as Error).message;
    expect(message).toContain('instance profile(s) kept, which');
  });

  it('none confirmed by GetInstanceProfile keeps AWS\'s error', async () => {
    drive({
      ...base,
      ListInstanceProfilesForRoleCommand: profiles(['deleted']),
      GetInstanceProfileCommand: () => {
        throw new NoSuchEntityException({ $metadata: {}, message: 'not found' });
      },
    });

    const error = await destroy();
    expect((error as Error).message).not.toContain('is still in instance profile');
    expect(isMarkedNonRetryable(error)).toBe(false);
  });

  it("an in-stack profile deleted alongside the role (listed for several polls, then gone): DeleteRole is retried and succeeds", async () => {
    let deletes = 0;
    drive({
      ...base,
      DeleteRoleCommand: () => {
        deletes++;
        if (deletes === 1) conflict();
        return {};
      },
      ListInstanceProfilesForRoleCommand: profiles(['own'], ['own'], ['own'], []),
    });

    await expect(destroy()).resolves.toBeUndefined();
    expect(deletes).toBe(2);
    expect(sent.filter((n) => n === 'ListInstanceProfilesForRoleCommand')).toHaveLength(4);
    expect(sent).not.toContain('RemoveRoleFromInstanceProfileCommand');
  });

  it('a list that keeps changing is refused at the cap with the profiles it shows last', async () => {
    let call = 0;
    drive({
      ...base,
      ListInstanceProfilesForRoleCommand: () => ({
        InstanceProfiles: [{ InstanceProfileName: `p${++call}` }],
      }),
    });

    expect(((await destroy()) as Error).message).toContain('instance profile(s) p31, which');
    expect(call).toBe(31);
  });

  it('a DeleteRole that succeeds lists no profiles at all', async () => {
    drive({ ...base, DeleteRoleCommand: () => ({}) });

    await expect(destroy()).resolves.toBeUndefined();
    expect(sent).not.toContain('ListInstanceProfilesForRoleCommand');
  });

  it('another DeleteRole failure lists nothing and keeps AWS\'s error', async () => {
    drive({
      ...base,
      DeleteRoleCommand: () => {
        throw Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: {} });
      },
      ListInstanceProfilesForRoleCommand: profiles(['p']),
    });

    const error = await destroy();
    expect((error as Error).message).not.toContain('is still in instance profile');
    expect(sent).not.toContain('ListInstanceProfilesForRoleCommand');
  });

  it('a policy detached before the refusal marks it delete-started', async () => {
    drive({
      ...base,
      ListAttachedRolePoliciesCommand: () => ({
        AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::123456789012:policy/P' }],
      }),
      ListInstanceProfilesForRoleCommand: profiles(['p']),
    });

    const error = await destroy();
    expect((error as Error).message).toContain('is still in instance profile(s) p,');
    expect(isDeleteStarted(error)).toBe(true);
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('masks a secret-derived role or profile name', async () => {
    drive({ ...base, ListInstanceProfilesForRoleCommand: profiles(['SECRET-profile']) });

    const error = await destroy(new IAMRoleProvider(), (text) => text.split('SECRET').join('***'));
    expect((error as Error).message).toContain('instance profile(s) ***-profile');
    expect((error as Error).message).not.toContain('SECRET');
  });
});

describe('IAM role delete outside a stack destroy keeps removing it from its profiles (#4461)', () => {
  it('removes the role from each profile, then deletes it', async () => {
    drive({
      ...base,
      DeleteRoleCommand: () => ({}),
      ListInstanceProfilesForRoleCommand: profiles(['stack-profile']),
    });

    await new IAMRoleProvider().delete('Role', 'my-role', 'AWS::IAM::Role');

    expect(sent).toContain('RemoveRoleFromInstanceProfileCommand');
    expect(sent.at(-1)).toBe('DeleteRoleCommand');
  });
});
