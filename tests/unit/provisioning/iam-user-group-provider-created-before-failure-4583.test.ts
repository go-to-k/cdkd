import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

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

import { NoSuchEntityException } from '@aws-sdk/client-iam';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const POLICY_ARN = 'arn:aws:iam::aws:policy/ReadOnlyAccess';

function script(fail: Record<string, Error | undefined>): void {
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    const name = command.constructor.name;
    if (fail[name]) return Promise.reject(fail[name]);
    switch (name) {
      case 'CreateUserCommand':
        return Promise.resolve({ User: { Arn: 'arn:aws:iam::123:user/u' } });
      case 'CreateGroupCommand':
        return Promise.resolve({ Group: { Arn: 'arn:aws:iam::123:group/g' } });
      case 'ListGroupsForUserCommand':
        return Promise.resolve({ Groups: [] });
      case 'ListAttachedUserPoliciesCommand':
      case 'ListAttachedGroupPoliciesCommand':
        return Promise.resolve({ AttachedPolicies: [] });
      case 'ListUserPoliciesCommand':
      case 'ListGroupPoliciesCommand':
        return Promise.resolve({ PolicyNames: [] });
      case 'DeleteLoginProfileCommand':
      case 'DeleteUserPermissionsBoundaryCommand':
        return Promise.reject(
          new NoSuchEntityException({ message: 'not found', $metadata: {} })
        );
      default:
        return Promise.resolve({});
    }
  });
}

async function createError(
  provider: IAMUserGroupProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>
): Promise<unknown> {
  try {
    await provider.create(logicalId, resourceType, properties);
  } catch (error) {
    return error;
  }
  throw new Error('create() did not throw');
}

describe('IAMUserGroupProvider created-before-failure mark (go-to-k/cdkd#4583)', () => {
  let provider: IAMUserGroupProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new IAMUserGroupProvider();
  });

  describe('AWS::IAM::User', () => {
    const TYPE = 'AWS::IAM::User';
    const NAME = 'my-test-user-xxx';
    const props = { UserName: NAME, ManagedPolicyArns: [POLICY_ARN] };

    it('marks the user name when the wiring failed and the cleanup DeleteUser failed', async () => {
      script({
        AttachUserPolicyCommand: new Error('AttachUserPolicy boom'),
        DeleteUserCommand: new Error('DeleteUser boom'),
      });

      const error = await createError(provider, 'MyUser', TYPE, props);
      expect(createdBeforeFailure(error, 'MyUser', TYPE)).toBe(NAME);
    });

    it('does not mark when the cleanup deleted the user', async () => {
      script({ AttachUserPolicyCommand: new Error('AttachUserPolicy boom') });

      const error = await createError(provider, 'MyUser', TYPE, props);
      expect(error).toBeInstanceOf(Error);
      expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).toContain(
        'DeleteUserCommand'
      );
      expect(createdBeforeFailure(error, 'MyUser', TYPE)).toBeUndefined();
    });

    it('does not mark when CreateUser itself failed', async () => {
      script({ CreateUserCommand: new Error('EntityAlreadyExists: User already exists') });

      const error = await createError(provider, 'MyUser', TYPE, props);
      expect(error).toBeInstanceOf(Error);
      expect(createdBeforeFailure(error, 'MyUser', TYPE)).toBeUndefined();
    });

    it('does not mark a pre-flight refusal (malformed Groups)', async () => {
      const error = await createError(provider, 'MyUser', TYPE, { UserName: NAME, Groups: 'g' });
      expect(error).toBeInstanceOf(Error);
      expect(mockSend).not.toHaveBeenCalled();
      expect(createdBeforeFailure(error, 'MyUser', TYPE)).toBeUndefined();
    });
  });

  describe('AWS::IAM::Group', () => {
    const TYPE = 'AWS::IAM::Group';
    const NAME = 'my-test-group-xxx';
    const props = { GroupName: NAME, ManagedPolicyArns: [POLICY_ARN] };

    it('marks the group name when the wiring failed and the cleanup DeleteGroup failed', async () => {
      script({
        AttachGroupPolicyCommand: new Error('AttachGroupPolicy boom'),
        DeleteGroupCommand: new Error('DeleteGroup boom'),
      });

      const error = await createError(provider, 'MyGroup', TYPE, props);
      expect(createdBeforeFailure(error, 'MyGroup', TYPE)).toBe(NAME);
    });

    it('does not mark when the cleanup deleted the group', async () => {
      script({ AttachGroupPolicyCommand: new Error('AttachGroupPolicy boom') });

      const error = await createError(provider, 'MyGroup', TYPE, props);
      expect(error).toBeInstanceOf(Error);
      expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).toContain(
        'DeleteGroupCommand'
      );
      expect(createdBeforeFailure(error, 'MyGroup', TYPE)).toBeUndefined();
    });

    it('does not mark when CreateGroup itself failed', async () => {
      script({ CreateGroupCommand: new Error('EntityAlreadyExists: Group already exists') });

      const error = await createError(provider, 'MyGroup', TYPE, props);
      expect(error).toBeInstanceOf(Error);
      expect(createdBeforeFailure(error, 'MyGroup', TYPE)).toBeUndefined();
    });
  });
});
