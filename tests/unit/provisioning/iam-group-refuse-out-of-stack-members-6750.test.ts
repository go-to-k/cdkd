/**
 * go-to-k/cdkd#6750 (group half): on a stack destroy, an IAM group a user is
 * still in is refused (CloudFormation's handler has no
 * `iam:RemoveUserFromGroup`, and `DeleteGroup` answers `DeleteConflict`)
 * instead of the user being removed from it. go-to-k/cdkd#6770: so is every
 * other delete but a same-name re-create's delete-first
 * (`stackHoldersStillAttached`), which keeps the removal (go-to-k/cdkd#4461)
 * of the stack's own members (go-to-k/cdkd#6808).
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

import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { RecordedIdentityError } from '../../../src/provisioning/recorded-identity.js';
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
    message: 'Cannot delete entity, must remove users from group first.',
  });
};

/** Members per `GetGroup`, in order (step 0's read first); the last repeats. */
function members(...reads: string[][]): Handler {
  let call = 0;
  return () => {
    const names = reads[Math.min(call++, reads.length - 1)]!;
    return {
      Group: { GroupName: 'my-group', GroupId: 'AGPA' },
      Users: names.map((UserName) => ({ UserName })),
    };
  };
}

const base: Record<string, Handler> = {
  ListAttachedGroupPoliciesCommand: () => ({ AttachedPolicies: [] }),
  ListGroupPoliciesCommand: () => ({ PolicyNames: [] }),
  // Every user read is still in the group unless a case says otherwise.
  ListGroupsForUserCommand: () => ({ Groups: [{ GroupName: 'my-group' }] }),
  DeleteGroupCommand: conflict,
};

const destroy = (maskSecrets?: (text: string) => string) =>
  new IAMUserGroupProvider()
    .delete('Group', 'my-group', 'AWS::IAM::Group', undefined, {
      stackDestroy: true,
      ...(maskSecrets && { maskSecrets }),
    })
    .then(
      () => undefined,
      (e: unknown) => e
    );

const count = (name: string) => sent.filter((n) => n === name).length;

beforeEach(() => {
  vi.restoreAllMocks();
  mockSend.mockReset();
  sent = [];
  // The settle's waits run at once; their duration is asserted where it matters.
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn();
    return 0;
  }) as unknown as typeof setTimeout);
});

describe('IAM group delete on a stack destroy (#6750)', () => {
  it('refuses a group an out-of-stack user is in, non-retryably, naming the user, and never removes it', async () => {
    drive({ ...base, GetGroupCommand: members(['outsider']) });

    const error = await destroy();

    expect(error).toBeInstanceOf(ProvisioningError);
    const message = (error as Error).message;
    expect(message).toContain(
      'group my-group still has user(s) outsider, whose membership this destroy did not remove'
    );
    expect(message).toContain('aws iam remove-user-from-group');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect((error as Error).cause).toBeInstanceOf(DeleteConflictException);
    expect(sent).not.toContain('RemoveUserFromGroupCommand');
    // Step 0's read, then five unchanged reads.
    expect(count('GetGroupCommand')).toBe(1 + 5);
    expect(count('DeleteGroupCommand')).toBe(1);
    expect(vi.mocked(setTimeout).mock.calls.map((c) => c[1])).toContain(2000);
  });

  it("the stack's own member still shown for a few reads, then gone: DeleteGroup is retried and succeeds", async () => {
    let deletes = 0;
    drive({
      ...base,
      GetGroupCommand: members(['own'], ['own'], ['own'], []),
      DeleteGroupCommand: () => {
        deletes++;
        if (deletes === 1) conflict();
        return {};
      },
    });

    await expect(destroy()).resolves.toBeUndefined();
    expect(deletes).toBe(2);
    expect(sent).not.toContain('RemoveUserFromGroupCommand');
  });

  it('waits while the members drain, then refuses with who stays', async () => {
    drive({ ...base, GetGroupCommand: members(['stacku', 'kept'], ['stacku', 'kept'], ['kept']) });

    const message = ((await destroy()) as Error).message;
    expect(message).toContain('still has user(s) kept, whose');
    expect(message).not.toContain('stacku');
  });

  it('a user ListGroupsForUser shows gone, or out of the group, is the read lagging', async () => {
    drive({
      ...base,
      GetGroupCommand: members(['deleted', 'left', 'kept']),
      ListGroupsForUserCommand: (input) => {
        if (input['UserName'] === 'deleted') {
          throw new NoSuchEntityException({ $metadata: {}, message: 'not found' });
        }
        return { Groups: input['UserName'] === 'kept' ? [{ GroupName: 'my-group' }] : [] };
      },
    });

    expect(((await destroy()) as Error).message).toContain('still has user(s) kept, whose');
  });

  it("none confirmed: DeleteGroup is tried once more and AWS's error surfaces", async () => {
    drive({
      ...base,
      GetGroupCommand: members(['deleted']),
      ListGroupsForUserCommand: () => {
        throw new NoSuchEntityException({ $metadata: {}, message: 'not found' });
      },
    });

    const error = await destroy();
    expect((error as Error).message).toMatch(/^Failed to delete IAM group Group: /);
    expect((error as Error).message).not.toContain('still has user');
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(count('DeleteGroupCommand')).toBe(2);
  });

  it('names at most five users and says there are more', async () => {
    drive({ ...base, GetGroupCommand: members(['u1', 'u2', 'u3', 'u4', 'u5', 'u6']) });

    expect(((await destroy()) as Error).message).toContain(
      'still has user(s) u1, u2, u3, u4, u5, and more, whose'
    );
  });

  it('says there are more when GetGroup reports another page', async () => {
    drive({
      ...base,
      GetGroupCommand: () => ({
        Group: { GroupName: 'my-group' },
        Users: [{ UserName: 'outsider' }],
        IsTruncated: true,
      }),
    });

    const message = ((await destroy()) as Error).message;
    expect(message).toContain('still has user(s) outsider, and more, whose');
    // Step 0's page counts as the first read: five unchanged reads follow.
    expect(count('GetGroupCommand')).toBe(1 + 5);
  });

  it('a user whose group list is truncated is kept as still in the group', async () => {
    drive({
      ...base,
      GetGroupCommand: members(['many-groups']),
      ListGroupsForUserCommand: () => ({ Groups: [{ GroupName: 'other' }], IsTruncated: true }),
    });

    expect(((await destroy()) as Error).message).toContain('still has user(s) many-groups,');
  });

  it("step 0 read no member: DeleteGroup is tried once more at once, with no wait and no re-read", async () => {
    let deletes = 0;
    drive({
      ...base,
      GetGroupCommand: members([]),
      DeleteGroupCommand: () => {
        deletes++;
        if (deletes === 1) conflict();
        return {};
      },
    });

    await expect(destroy()).resolves.toBeUndefined();
    expect(deletes).toBe(2);
    expect(count('GetGroupCommand')).toBe(1);
    expect(vi.mocked(setTimeout)).not.toHaveBeenCalled();
  });

  it('a group gone during the settle is deleted, not a failure', async () => {
    let reads = 0;
    drive({
      ...base,
      GetGroupCommand: () => {
        reads++;
        if (reads > 1) throw new NoSuchEntityException({ $metadata: {}, message: 'gone' });
        return { Group: { GroupName: 'my-group' }, Users: [{ UserName: 'outsider' }] };
      },
    });

    await expect(destroy()).resolves.toBeUndefined();
  });

  it('a group re-created under the name mid-settle is refused by identity, with no second DeleteGroup', async () => {
    let reads = 0;
    drive({
      ...base,
      GetGroupCommand: () => {
        reads++;
        return {
          Group: { GroupName: 'my-group', GroupId: reads <= 2 ? 'AGPAORIGINAL' : 'AGPASUCCESSOR' },
          Users: [{ UserName: 'outsider' }],
        };
      },
    });

    const error = await destroy();

    expect(error).toBeInstanceOf(RecordedIdentityError);
    expect((error as Error).message).toContain(
      'the group now holding that name is not the one this delete read before it (its GroupId differs)'
    );
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(count('DeleteGroupCommand')).toBe(1);
    expect(sent).not.toContain('ListGroupsForUserCommand');
  });

  it('a group re-created under the name before the second refusal is refused by identity too', async () => {
    let reads = 0;
    drive({
      ...base,
      GetGroupCommand: () => {
        reads++;
        return {
          Group: { GroupName: 'my-group', GroupId: reads === 1 ? 'AGPAORIGINAL' : 'AGPASUCCESSOR' },
          Users: reads === 1 ? [] : [{ UserName: 'outsider' }],
        };
      },
    });

    const error = await destroy();

    expect(error).toBeInstanceOf(RecordedIdentityError);
    expect((error as Error).message).toContain('(its GroupId differs)');
    expect(count('DeleteGroupCommand')).toBe(2);
    expect(sent).not.toContain('ListGroupsForUserCommand');
  });

  it('the identity refusal after a policy detach is marked delete-started', async () => {
    let reads = 0;
    drive({
      ...base,
      ListAttachedGroupPoliciesCommand: () => ({
        AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::123456789012:policy/P' }],
      }),
      GetGroupCommand: () => {
        reads++;
        return {
          Group: { GroupName: 'my-group', GroupId: reads === 1 ? 'AGPAORIGINAL' : 'AGPASUCCESSOR' },
          Users: [{ UserName: 'outsider' }],
        };
      },
    });

    const error = await destroy();
    expect(error).toBeInstanceOf(RecordedIdentityError);
    expect(isDeleteStarted(error)).toBe(true);
  });

  it('a step 0 read with no GroupId holds no later read to one', async () => {
    let reads = 0;
    drive({
      ...base,
      GetGroupCommand: () => {
        reads++;
        return {
          Group: reads === 1 ? { GroupName: 'my-group' } : { GroupName: 'my-group', GroupId: 'AGPAANY' },
          Users: [{ UserName: 'outsider' }],
        };
      },
    });

    // No identity refusal: the member refusal, after the full settle.
    expect(((await destroy()) as Error).message).toContain('still has user(s) outsider, whose');
  });

  it("the second attempt's DeleteConflict reads the members once more and names them", async () => {
    drive({ ...base, GetGroupCommand: members([], ['outsider']) });

    const error = await destroy();

    expect((error as Error).message).toContain('still has user(s) outsider, whose');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(count('DeleteGroupCommand')).toBe(2);
    // Step 0, then one read after the second refusal: no settle.
    expect(count('GetGroupCommand')).toBe(2);
  });

  it('the refusal tells a stack user still being deleted apart from one to remove by hand', async () => {
    drive({ ...base, GetGroupCommand: members(['outsider']) });

    const message = ((await destroy()) as Error).message;
    expect(message).toContain(
      "If a named user is one of this stack's users, run the destroy again once its delete finishes. Otherwise"
    );
  });

  it('a member list that keeps changing is refused at the cap with who it shows last', async () => {
    let call = 0;
    drive({
      ...base,
      GetGroupCommand: () => ({
        Group: { GroupName: 'my-group' },
        Users: [{ UserName: `u${++call}` }],
      }),
    });

    expect(((await destroy()) as Error).message).toContain('still has user(s) u31, whose');
    expect(call).toBe(31);
  });

  it('a DeleteGroup that succeeds reads the members only once (step 0)', async () => {
    drive({ ...base, GetGroupCommand: members(['outsider']), DeleteGroupCommand: () => ({}) });

    await expect(destroy()).resolves.toBeUndefined();
    expect(count('GetGroupCommand')).toBe(1);
    expect(sent).not.toContain('RemoveUserFromGroupCommand');
  });

  it("another DeleteGroup failure keeps AWS's error and reads nothing more", async () => {
    drive({
      ...base,
      GetGroupCommand: members(['outsider']),
      DeleteGroupCommand: () => {
        throw Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: {} });
      },
    });

    const error = await destroy();
    expect((error as Error).message).not.toContain('still has user');
    expect(count('GetGroupCommand')).toBe(1);
  });

  it('a policy detached before the refusal marks it delete-started', async () => {
    drive({
      ...base,
      ListAttachedGroupPoliciesCommand: () => ({
        AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::123456789012:policy/P' }],
      }),
      GetGroupCommand: members(['outsider']),
    });

    const error = await destroy();
    expect((error as Error).message).toContain('still has user(s) outsider,');
    expect(isDeleteStarted(error)).toBe(true);
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('masks a secret-derived user name', async () => {
    drive({ ...base, GetGroupCommand: members(['SECRET-user']) });

    const error = await destroy((text) => text.split('SECRET').join('***'));
    expect((error as Error).message).toContain('user(s) ***-user');
    expect((error as Error).message).not.toContain('SECRET');
  });

  // go-to-k/cdkd#6772: a user the stack retained, whose name is secret-derived,
  // is in no bag of the group's own: the stack-wide printing masker masks it.
  it("masks a retained in-stack user's secret-derived name with the stack-wide masker", async () => {
    drive({ ...base, GetGroupCommand: members(['SECRET-user']) });
    const run = (maskStackSecretNames?: (text: string) => string) =>
      new IAMUserGroupProvider()
        .delete('Group', 'my-group', 'AWS::IAM::Group', undefined, {
          stackDestroy: true,
          maskSecrets: (text) => text,
          ...(maskStackSecretNames && { maskStackSecretNames }),
        })
        .then(
          () => undefined,
          (e: unknown) => e
        );

    const masked = ((await run((text) => text.split('SECRET').join('***'))) as Error).message;
    expect(masked).toContain('user(s) ***-user, whose membership this destroy did not remove');
    expect(masked).not.toContain('SECRET');
    // Absent, the group's own masker alone: the wording is unchanged.
    sent = [];
    const plain = ((await run()) as Error).message;
    expect(plain).toBe(masked.replace('***-user', 'SECRET-user'));
  });
});

describe("a same-name re-create's delete-first keeps removing its members (#4461, #6770)", () => {
  // go-to-k/cdkd#6808: the stack's own members only, named by its records;
  // `iam-stack-own-holders-6808.test.ts` holds the out-of-stack arms.
  const deleteFirst = () =>
    withStackRecords(
      destroyStackRecordsView({
        Member: {
          resourceType: 'AWS::IAM::User',
          physicalId: 'member',
          properties: { Groups: ['my-group'] },
          attributes: {},
          dependencies: [],
        },
      }),
      () =>
        new IAMUserGroupProvider().delete('Group', 'my-group', 'AWS::IAM::Group', undefined, {
          stackHoldersStillAttached: true,
        })
    );

  it("removes the stack's member, then deletes the group", async () => {
    drive({ ...base, GetGroupCommand: members(['member']), DeleteGroupCommand: () => ({}) });

    await deleteFirst();

    expect(sent).toContain('RemoveUserFromGroupCommand');
    expect(sent.at(-1)).toBe('DeleteGroupCommand');
  });

  it('a DeleteConflict after the removal settles, and the retry deletes once no user is in it', async () => {
    let deletes = 0;
    drive({
      ...base,
      GetGroupCommand: members(['member'], []),
      DeleteGroupCommand: () => (deletes++ === 0 ? conflict() : {}),
    });

    await deleteFirst();

    expect(count('RemoveUserFromGroupCommand')).toBe(1);
    expect(count('DeleteGroupCommand')).toBe(2);
  });
});

describe('every other deploy-side delete refuses like a stack destroy (#6770)', () => {
  // A template removal, a nested child's teardown from a deploy, a replaced
  // group's cleanup-phase delete (its in-stack members already moved to the
  // new group) and a rollback delete all reach the provider without
  // `stackHoldersStillAttached`, most without `stackDestroy` either.
  const contexts = {
    'no context at all': undefined,
    'a template removal / superseded cleanup context': {
      expectedRegion: 'us-east-1',
      deletionPolicy: 'Delete',
    },
    'an explicit false': { stackHoldersStillAttached: false },
  } as const;

  for (const [label, context] of Object.entries(contexts)) {
    it(`${label}: refuses an out-of-stack user and never removes them`, async () => {
      drive({ ...base, GetGroupCommand: members(['outsider']) });

      const error = await new IAMUserGroupProvider()
        .delete('Group', 'my-group', 'AWS::IAM::Group', undefined, context)
        .then(
          () => undefined,
          (e: unknown) => e
        );

      expect(error).toBeInstanceOf(ProvisioningError);
      const message = (error as Error).message;
      expect(message).toContain(
        'group my-group still has user(s) outsider, whose membership this run did not remove'
      );
      expect(message).toContain(
        "If a named user is one of this stack's users, run the command again once its delete finishes."
      );
      expect(message).toContain('--user-name <user>), then run the command again.');
      expect(message).not.toContain('destroy');
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(sent).not.toContain('RemoveUserFromGroupCommand');
    });
  }

  it("the stack's own membership drained by the run's earlier update: DeleteGroup is retried and succeeds", async () => {
    let deletes = 0;
    drive({
      ...base,
      GetGroupCommand: members(['stack-user'], []),
      DeleteGroupCommand: () => (deletes++ === 0 ? conflict() : {}),
    });

    await new IAMUserGroupProvider().delete('Group', 'my-group', 'AWS::IAM::Group');

    expect(deletes).toBe(2);
    expect(sent).not.toContain('RemoveUserFromGroupCommand');
  });

  it('masks a secret-derived user name in the non-destroy wording too', async () => {
    drive({ ...base, GetGroupCommand: members(['SECRET-user']) });

    const error = await new IAMUserGroupProvider()
      .delete('Group', 'my-group', 'AWS::IAM::Group', undefined, {
        maskSecrets: (text) => text.split('SECRET').join('***'),
      })
      .then(
        () => undefined,
        (e: unknown) => e
      );

    expect((error as Error).message).toContain('user(s) ***-user, whose membership this run');
    expect((error as Error).message).not.toContain('SECRET');
  });
});
