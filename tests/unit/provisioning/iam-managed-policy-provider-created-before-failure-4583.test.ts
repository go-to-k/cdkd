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

import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const RESOURCE_TYPE = 'AWS::IAM::ManagedPolicy';
const ARN = 'arn:aws:iam::123456789012:policy/my-test-policy';
const PROPS = {
  ManagedPolicyName: 'my-test-policy',
  PolicyDocument: { Version: '2012-10-17', Statement: [] },
  Roles: ['role-a'],
};

function script(fail: Record<string, Error | undefined>, createResponse?: unknown): void {
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    const name = command.constructor.name;
    if (fail[name]) return Promise.reject(fail[name]);
    switch (name) {
      case 'CreatePolicyCommand':
        return Promise.resolve(createResponse ?? { Policy: { Arn: ARN } });
      case 'ListEntitiesForPolicyCommand':
        return Promise.resolve({ PolicyGroups: [], PolicyRoles: [], PolicyUsers: [] });
      case 'ListPolicyVersionsCommand':
        return Promise.resolve({ Versions: [] });
      default:
        return Promise.resolve({});
    }
  });
}

async function createError(
  provider: IAMManagedPolicyProvider,
  properties: Record<string, unknown> = PROPS
): Promise<unknown> {
  try {
    await provider.create('MyPolicy', RESOURCE_TYPE, properties);
  } catch (error) {
    return error;
  }
  throw new Error('create() did not throw');
}

describe('IAMManagedPolicyProvider created-before-failure mark (go-to-k/cdkd#4583)', () => {
  let provider: IAMManagedPolicyProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new IAMManagedPolicyProvider();
  });

  it('marks the policy ARN when the attachment failed and the cleanup DeletePolicy failed', async () => {
    script({
      AttachRolePolicyCommand: new Error('AttachRolePolicy boom'),
      DeletePolicyCommand: new Error('DeletePolicy boom'),
    });

    const error = await createError(provider);
    expect(createdBeforeFailure(error, 'MyPolicy', RESOURCE_TYPE)).toBe(ARN);
  });

  it('does not mark when the cleanup deleted the policy', async () => {
    script({ AttachRolePolicyCommand: new Error('AttachRolePolicy boom') });

    const error = await createError(provider);
    expect(error).toBeInstanceOf(Error);
    expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).toContain(
      'DeletePolicyCommand'
    );
    expect(createdBeforeFailure(error, 'MyPolicy', RESOURCE_TYPE)).toBeUndefined();
  });

  it('does not mark when CreatePolicy itself failed', async () => {
    script({ CreatePolicyCommand: new Error('EntityAlreadyExists: policy already exists') });

    const error = await createError(provider);
    expect(error).toBeInstanceOf(Error);
    expect(createdBeforeFailure(error, 'MyPolicy', RESOURCE_TYPE)).toBeUndefined();
  });

  it('does not mark when CreatePolicy returned no ARN (no id delete() could take)', async () => {
    script({}, { Policy: {} });

    const error = await createError(provider);
    expect(error).toBeInstanceOf(Error);
    expect(createdBeforeFailure(error, 'MyPolicy', RESOURCE_TYPE)).toBeUndefined();
  });

  it('does not mark a pre-flight refusal (no PolicyDocument)', async () => {
    const error = await createError(provider, { ManagedPolicyName: 'x' });
    expect(error).toBeInstanceOf(Error);
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'MyPolicy', RESOURCE_TYPE)).toBeUndefined();
  });
});
