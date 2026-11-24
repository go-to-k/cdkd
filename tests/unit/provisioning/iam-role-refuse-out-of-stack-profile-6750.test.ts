/**
 * go-to-k/cdkd#6750: on a stack destroy, an IAM role an instance profile still
 * holds is refused (CloudFormation's handler has no
 * `iam:RemoveRoleFromInstanceProfile`, and `DeleteRole` answers
 * `DeleteConflict`) instead of being removed from that profile.
 * go-to-k/cdkd#6770: so is every other delete but a same-name re-create's
 * delete-first (`stackHoldersStillAttached`), which keeps the removal
 * (go-to-k/cdkd#4461) from the stack's own profiles (go-to-k/cdkd#6808).
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
    child: vi.fn((): unknown => logger),
  };
  return { getLogger: () => logger };
});

import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import {
  destroyStackRecordsView,
  withStackRecords,
} from '../../../src/deployment/stack-records-scope.js';

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

  // go-to-k/cdkd#6772: a profile the stack retained, whose name is secret-derived,
  // is in no bag of the role's own: the stack-wide printing masker masks it.
  it("masks a retained in-stack profile's secret-derived name with the stack-wide masker", async () => {
    drive({ ...base, ListInstanceProfilesForRoleCommand: profiles(['SECRET-profile']) });
    const run = (maskStackSecretNames?: (text: string) => string) =>
      new IAMRoleProvider()
        .delete('Role', 'my-role', 'AWS::IAM::Role', undefined, {
          stackDestroy: true,
          maskSecrets: (text) => text,
          ...(maskStackSecretNames && { maskStackSecretNames }),
        })
        .then(
          () => undefined,
          (e: unknown) => e
        );

    const masked = ((await run((text) => text.split('SECRET').join('***'))) as Error).message;
    expect(masked).toContain('instance profile(s) ***-profile, which this destroy did not delete');
    expect(masked).not.toContain('SECRET');
    // Absent, the role's own masker alone: the wording is unchanged.
    sent = [];
    const plain = ((await run()) as Error).message;
    expect(plain).toBe(masked.replace('***-profile', 'SECRET-profile'));
  });
});

describe("a same-name re-create's delete-first keeps removing it from its profiles (#4461, #6770)", () => {
  // go-to-k/cdkd#6808: the stack's own profiles only, named by its records;
  // `iam-stack-own-holders-6808.test.ts` holds the out-of-stack arms.
  const ownProfile = () =>
    destroyStackRecordsView({
      Profile: {
        resourceType: 'AWS::IAM::InstanceProfile',
        physicalId: 'stack-profile',
        properties: { Roles: ['my-role'] },
        attributes: {},
        dependencies: [],
      },
    });
  const deleteFirst = () =>
    withStackRecords(ownProfile(), () =>
      new IAMRoleProvider().delete('Role', 'my-role', 'AWS::IAM::Role', undefined, {
        stackHoldersStillAttached: true,
      })
    );

  it("removes the role from the stack's profile, then deletes it", async () => {
    drive({
      ...base,
      DeleteRoleCommand: () => ({}),
      ListInstanceProfilesForRoleCommand: profiles(['stack-profile']),
    });

    await deleteFirst();

    expect(sent).toContain('RemoveRoleFromInstanceProfileCommand');
    expect(sent.at(-1)).toBe('DeleteRoleCommand');
  });

  it('a DeleteConflict after the removal settles, and the retry deletes once no profile holds it', async () => {
    let deletes = 0;
    drive({
      ...base,
      DeleteRoleCommand: () => (deletes++ === 0 ? conflict() : {}),
      ListInstanceProfilesForRoleCommand: profiles(['stack-profile'], []),
    });

    await deleteFirst();

    expect(sent.filter((n) => n === 'RemoveRoleFromInstanceProfileCommand')).toHaveLength(1);
    expect(sent.filter((n) => n === 'DeleteRoleCommand')).toHaveLength(2);
  });
});

describe('every other deploy-side delete refuses like a stack destroy (#6770)', () => {
  // A template removal, a nested child's teardown from a deploy, a replaced
  // copy's cleanup-phase delete and a rollback delete all reach the provider
  // without `stackHoldersStillAttached`, most without `stackDestroy` either.
  const contexts = {
    'no context at all': undefined,
    'a template removal / superseded cleanup context': {
      expectedRegion: 'us-east-1',
      deletionPolicy: 'Delete',
    },
    'an explicit false': { stackHoldersStillAttached: false },
  } as const;

  for (const [label, context] of Object.entries(contexts)) {
    it(`${label}: refuses an out-of-stack profile and never removes the role from it`, async () => {
      drive({ ...base, ListInstanceProfilesForRoleCommand: profiles(['other-stack-profile']) });

      const error = await new IAMRoleProvider()
        .delete('Role', 'my-role', 'AWS::IAM::Role', undefined, context)
        .then(
          () => undefined,
          (e: unknown) => e
        );

      expect(error).toBeInstanceOf(ProvisioningError);
      const message = (error as Error).message;
      expect(message).toContain(
        'role my-role is still in instance profile(s) other-stack-profile, which this run did not delete'
      );
      expect(message).toContain('or delete the profile, then run the command again.');
      expect(message).not.toContain('destroy');
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(sent).not.toContain('RemoveRoleFromInstanceProfileCommand');
    });
  }

  it("the stack's own profile drained by the run's earlier delete: DeleteRole is retried and succeeds", async () => {
    let deletes = 0;
    drive({
      ...base,
      DeleteRoleCommand: () => (deletes++ === 0 ? conflict() : {}),
      ListInstanceProfilesForRoleCommand: profiles(['stack-profile'], []),
    });

    await new IAMRoleProvider().delete('Role', 'my-role', 'AWS::IAM::Role');

    expect(deletes).toBe(2);
    expect(sent).not.toContain('RemoveRoleFromInstanceProfileCommand');
  });

  describe('the retry after a drained settle is held to the RoleId step 0 read', () => {
    const drained = (roleIds: Array<string | 'gone'>): Record<string, Handler> => {
      let reads = 0;
      return {
        ...base,
        GetRoleCommand: () => {
          const id = roleIds[Math.min(reads++, roleIds.length - 1)]!;
          if (id === 'gone') throw new NoSuchEntityException({ $metadata: {}, message: 'gone' });
          return { Role: { RoleName: 'my-role', RoleId: id } };
        },
        ListInstanceProfilesForRoleCommand: profiles(['stack-profile'], []),
      };
    };

    it('another role under the name: refused by identity, with no second DeleteRole', async () => {
      drive(drained(['AROA-OURS', 'AROA-OTHER']));

      const error = await new IAMRoleProvider()
        .delete('Role', 'my-role', 'AWS::IAM::Role')
        .then(
          () => undefined,
          (e: unknown) => e
        );

      expect((error as Error).message).toContain('its RoleId differs');
      expect((error as Error).message).not.toContain('AROA');
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(sent.filter((n) => n === 'DeleteRoleCommand')).toHaveLength(1);
    });

    it('the same role: DeleteRole is sent again', async () => {
      let deletes = 0;
      drive({
        ...drained(['AROA-OURS']),
        DeleteRoleCommand: () => (deletes++ === 0 ? conflict() : {}),
      });

      await new IAMRoleProvider().delete('Role', 'my-role', 'AWS::IAM::Role');

      expect(deletes).toBe(2);
    });

    it('the role gone by the re-read: deleted, with no second DeleteRole', async () => {
      drive(drained(['AROA-OURS', 'gone']));

      await new IAMRoleProvider().delete('Role', 'my-role', 'AWS::IAM::Role');

      expect(sent.filter((n) => n === 'DeleteRoleCommand')).toHaveLength(1);
    });
  });

  it('masks a secret-derived profile name in the non-destroy wording too', async () => {
    drive({ ...base, ListInstanceProfilesForRoleCommand: profiles(['SECRET-profile']) });

    const error = await new IAMRoleProvider()
      .delete('Role', 'my-role', 'AWS::IAM::Role', undefined, {
        maskSecrets: (text) => text.split('SECRET').join('***'),
      })
      .then(
        () => undefined,
        (e: unknown) => e
      );

    expect((error as Error).message).toContain('instance profile(s) ***-profile, which this run');
    expect((error as Error).message).not.toContain('SECRET');
  });
});
