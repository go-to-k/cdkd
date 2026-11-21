/**
 * go-to-k/cdkd#6770: an `AWS::IAM::UserToGroupAddition` create that fails
 * after adding some of its users removes them again. The failed op records no
 * physical id, so its rollback deletes nothing, and the group's later delete
 * (a destroy, a template removal) refuses a member no record holds.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';

let sent: Array<{ name: string; input: Record<string, unknown> }>;

beforeEach(() => {
  mockSend.mockReset();
  sent = [];
});

function drive(failAddFor: string | undefined, failRemove = false): void {
  mockSend.mockImplementation(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      sent.push({ name, input: command.input });
      if (name === 'AddUserToGroupCommand' && command.input['UserName'] === failAddFor) {
        throw Object.assign(new Error('Rate exceeded'), { name: 'LimitExceededException' });
      }
      if (name === 'RemoveUserFromGroupCommand' && failRemove) {
        throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      }
      return {};
    }
  );
}

const create = () =>
  new IAMUserGroupProvider()
    .create('Addition', 'AWS::IAM::UserToGroupAddition', {
      GroupName: 'my-group',
      Users: ['u1', 'u2', 'u3'],
    })
    .then(
      () => undefined,
      (e: unknown) => e
    );

const writes = () =>
  sent
    .filter((c) => c.name === 'AddUserToGroupCommand' || c.name === 'RemoveUserFromGroupCommand')
    .map((c) => `${c.name === 'AddUserToGroupCommand' ? 'add' : 'remove'} ${String(c.input['UserName'])}`);

describe('UserToGroupAddition partial create (#6770)', () => {
  it('a later add failing removes the users already added, newest first, and fails the create', async () => {
    drive('u3');

    const error = await create();

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('Failed to create IAM UserToGroupAddition Addition');
    expect(writes()).toEqual(['add u1', 'add u2', 'add u3', 'remove u2', 'remove u1']);
    for (const call of sent.filter((c) => c.name === 'RemoveUserFromGroupCommand')) {
      expect(call.input['GroupName']).toBe('my-group');
    }
  });

  it('the first add failing removes nothing', async () => {
    drive('u1');
    await create();
    expect(writes()).toEqual(['add u1']);
  });

  it("a removal that fails is best effort: the add's own failure surfaces", async () => {
    drive('u2', true);
    const error = await create();
    // The add's failure, not the removal's.
    expect((error as Error).message).toContain('Failed to create IAM UserToGroupAddition Addition');
    expect((error as Error).message).not.toContain('AccessDenied');
    expect(writes()).toEqual(['add u1', 'add u2', 'remove u1']);
  });

  it('a create that succeeds removes nothing', async () => {
    drive(undefined);
    expect(await create()).toBeUndefined();
    expect(writes()).toEqual(['add u1', 'add u2', 'add u3']);
  });
});
