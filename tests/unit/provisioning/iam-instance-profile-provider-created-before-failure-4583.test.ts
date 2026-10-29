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

import { IAMInstanceProfileProvider } from '../../../src/provisioning/providers/iam-instance-profile-provider.js';
import {
  createdBeforeFailure,
  createdResourceIdentityBeforeFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import {
  CreatedResourceSink,
  collectCreatedResources,
} from '../../../src/provisioning/created-resource-sink.js';

const RESOURCE_TYPE = 'AWS::IAM::InstanceProfile';
const NAME = 'my-test-profile-xxx';

async function createError(provider: IAMInstanceProfileProvider): Promise<unknown> {
  try {
    await provider.create('MyProfile', RESOURCE_TYPE, {
      InstanceProfileName: NAME,
      Roles: ['role-a', 'role-b'],
    });
  } catch (error) {
    return error;
  }
  throw new Error('create() did not throw');
}

describe('IAMInstanceProfileProvider created-before-failure mark (go-to-k/cdkd#4583)', () => {
  let provider: IAMInstanceProfileProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new IAMInstanceProfileProvider();
  });

  it('marks the profile name when the wiring failed and the cleanup delete failed', async () => {
    mockSend.mockResolvedValueOnce({ InstanceProfile: { Arn: 'arn' } }); // Create
    mockSend.mockRejectedValueOnce(new Error('AddRole boom')); // AddRole
    mockSend.mockRejectedValueOnce(new Error('DeleteInstanceProfile boom')); // cleanup delete

    const error = await createError(provider);
    expect(createdBeforeFailure(error, 'MyProfile', RESOURCE_TYPE)).toBe(NAME);
  });

  it('does not mark when the cleanup deleted the profile', async () => {
    mockSend.mockResolvedValueOnce({ InstanceProfile: { Arn: 'arn' } }); // Create
    mockSend.mockRejectedValueOnce(new Error('AddRole boom')); // AddRole
    mockSend.mockResolvedValueOnce({}); // cleanup delete

    const error = await createError(provider);
    expect(error).toBeInstanceOf(Error);
    // The cleanup delete was really sent, so the undefined is the cleanup's.
    const deleteCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'DeleteInstanceProfileCommand'
    );
    expect(deleteCall?.[0].input).toEqual({ InstanceProfileName: NAME });
    expect(createdBeforeFailure(error, 'MyProfile', RESOURCE_TYPE)).toBeUndefined();
  });

  it('reports the profile name and identity before the role wiring; a failed delete leaves it (#5511)', async () => {
    const sink = new CreatedResourceSink('MyProfile', RESOURCE_TYPE);
    let atAddRole: unknown = 'unset';
    mockSend.mockResolvedValueOnce({ InstanceProfile: { Arn: 'arn', InstanceProfileId: 'AIPAEXAMPLE' } });
    mockSend.mockImplementationOnce(() => {
      atAddRole = sink.report;
      return Promise.reject(new Error('AddRole boom'));
    });
    mockSend.mockRejectedValueOnce(new Error('DeleteInstanceProfile boom'));

    const error = await collectCreatedResources(sink, () => createError(provider));

    const identity = createdResourceIdentityBeforeFailure(error, 'MyProfile', RESOURCE_TYPE);
    expect(identity).toBeDefined();
    expect(atAddRole).toEqual({ physicalId: NAME, createdResourceIdentity: identity });
    expect(sink.report).toEqual({ physicalId: NAME, createdResourceIdentity: identity });
  });

  it('retracts the report when the cleanup deleted the profile (#5511)', async () => {
    const sink = new CreatedResourceSink('MyProfile', RESOURCE_TYPE);
    mockSend.mockResolvedValueOnce({ InstanceProfile: { Arn: 'arn' } });
    mockSend.mockRejectedValueOnce(new Error('AddRole boom'));
    mockSend.mockResolvedValueOnce({});

    await collectCreatedResources(sink, () => createError(provider));

    expect(sink.report).toBeUndefined();
  });

  it('reports nothing when CreateInstanceProfile itself failed (#5511)', async () => {
    const sink = new CreatedResourceSink('MyProfile', RESOURCE_TYPE);
    mockSend.mockRejectedValueOnce(new Error('EntityAlreadyExists: already exists'));
    await collectCreatedResources(sink, () => createError(provider));
    expect(sink.report).toBeUndefined();
  });

  it('does not mark when CreateInstanceProfile itself failed', async () => {
    mockSend.mockRejectedValueOnce(new Error('EntityAlreadyExists: already exists'));

    const error = await createError(provider);
    expect(error).toBeInstanceOf(Error);
    expect(createdBeforeFailure(error, 'MyProfile', RESOURCE_TYPE)).toBeUndefined();
  });

  it('does not mark a pre-flight refusal', async () => {
    let error: unknown;
    try {
      await provider.create('MyProfile', RESOURCE_TYPE, { InstanceProfileName: NAME, Roles: 'x' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'MyProfile', RESOURCE_TYPE)).toBeUndefined();
  });
});
