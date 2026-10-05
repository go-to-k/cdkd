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

import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const RESOURCE_TYPE = 'AWS::IAM::Role';
const NAME = 'my-test-role-xxx';
const ASSUME = {
  Version: '2012-10-17',
  Statement: [
    { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
  ],
};

function script(fail: Record<string, Error | undefined>): void {
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    const name = command.constructor.name;
    if (fail[name]) return Promise.reject(fail[name]);
    switch (name) {
      case 'CreateRoleCommand':
        return Promise.resolve({ Role: { Arn: `arn:aws:iam::123:role/${NAME}`, RoleId: 'AROA' } });
      case 'ListAttachedRolePoliciesCommand':
        return Promise.resolve({ AttachedPolicies: [] });
      case 'ListRolePoliciesCommand':
        return Promise.resolve({ PolicyNames: [] });
      default:
        return Promise.resolve({});
    }
  });
}

async function createError(
  provider: IAMRoleProvider,
  properties: Record<string, unknown> = {
    RoleName: NAME,
    AssumeRolePolicyDocument: ASSUME,
    ManagedPolicyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'],
  }
): Promise<unknown> {
  try {
    await provider.create('MyRole', RESOURCE_TYPE, properties);
  } catch (error) {
    return error;
  }
  throw new Error('create() did not throw');
}

describe('IAMRoleProvider created-before-failure mark (go-to-k/cdkd#4583)', () => {
  let provider: IAMRoleProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new IAMRoleProvider();
  });

  it('marks the role name when the wiring failed and the cleanup DeleteRole failed', async () => {
    script({
      AttachRolePolicyCommand: new Error('AttachRolePolicy boom'),
      DeleteRoleCommand: new Error('DeleteRole boom'),
    });

    const error = await createError(provider);
    expect(createdBeforeFailure(error, 'MyRole', RESOURCE_TYPE)).toBe(NAME);
  });

  it('does not mark when the cleanup deleted the role', async () => {
    script({ AttachRolePolicyCommand: new Error('AttachRolePolicy boom') });

    const error = await createError(provider);
    expect(error).toBeInstanceOf(Error);
    expect(mockSend.mock.calls.map((c) => c[0].constructor.name)).toContain('DeleteRoleCommand');
    expect(createdBeforeFailure(error, 'MyRole', RESOURCE_TYPE)).toBeUndefined();
  });

  it('does not mark when CreateRole itself failed', async () => {
    script({ CreateRoleCommand: new Error('EntityAlreadyExists: Role already exists') });

    const error = await createError(provider);
    expect(error).toBeInstanceOf(Error);
    expect(createdBeforeFailure(error, 'MyRole', RESOURCE_TYPE)).toBeUndefined();
  });

  it('does not mark a pre-flight refusal (no AssumeRolePolicyDocument)', async () => {
    const error = await createError(provider, { RoleName: NAME });
    expect(error).toBeInstanceOf(Error);
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'MyRole', RESOURCE_TYPE)).toBeUndefined();
  });
});
