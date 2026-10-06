import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-emr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-emr')>();
  const baseStrategy = {
    acquireInitialRetryToken: async (_scope: string) => 'token',
    refreshRetryTokenForRetry: async (_token: unknown, _info: { error?: unknown }) =>
      'retry-token',
    recordSuccess: (_token: unknown) => undefined,
  };
  return {
    ...actual,
    EMRClient: vi.fn().mockImplementation((options: { region?: unknown }) => ({
      config: {
        region: () => Promise.resolve(options.region ?? 'us-east-1'),
        retryStrategy: async (): Promise<unknown> => baseStrategy,
      },
      send: (command: unknown) => mockSend(command),
    })),
  };
});

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

import {
  EMRInstanceGroupConfigProvider,
  resetEMRInstanceGroupCreateRetryStateForTests,
} from '../../../src/provisioning/providers/emr-instance-group-config-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const TYPE = 'AWS::EMR::InstanceGroupConfig';
const GROUP_ID = 'ig-ABC123';
const PROPS = {
  JobFlowId: 'j-CLUSTER',
  InstanceRole: 'TASK',
  InstanceType: 'm5.xlarge',
  InstanceCount: 1,
};

/** Route by command name: `AddInstanceGroupsCommand` and `ListInstanceGroupsCommand` answer from the given handlers. */
function routeSend(add: () => unknown, list: () => unknown): void {
  mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
    if (command.constructor.name === 'AddInstanceGroupsCommand') return add();
    if (command.constructor.name === 'ListInstanceGroupsCommand') return list();
    throw new Error(`unexpected command ${command.constructor.name}`);
  });
}

async function createError(props: Record<string, unknown> = PROPS): Promise<unknown> {
  return new EMRInstanceGroupConfigProvider().create('Group', TYPE, props).then(
    () => {
      throw new Error('expected create to fail');
    },
    (e: unknown) => e
  );
}

describe('EMRInstanceGroupConfigProvider create marks a created-before-failure group (#4583)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    resetEMRInstanceGroupCreateRetryStateForTests();
  });

  it('marks the group id when the group ends ARRESTED after AddInstanceGroups returned', async () => {
    routeSend(
      () => ({ InstanceGroupIds: [GROUP_ID] }),
      () => ({
        InstanceGroups: [
          { Id: GROUP_ID, Status: { State: 'ARRESTED', StateChangeReason: { Message: 'boom' } } },
        ],
      })
    );
    const error = await createError();
    expect(createdBeforeFailure(error, 'Group', TYPE)).toBe(GROUP_ID);
  });

  it('marks the group id when the readiness poll throws a non-transient error', async () => {
    routeSend(
      () => ({ InstanceGroupIds: [GROUP_ID] }),
      () => {
        throw Object.assign(new Error('not authorized to perform ListInstanceGroups'), {
          name: 'AccessDeniedException',
        });
      }
    );
    const error = await createError();
    expect(createdBeforeFailure(error, 'Group', TYPE)).toBe(GROUP_ID);
  });

  it('leaves no mark when AddInstanceGroups itself fails', async () => {
    routeSend(
      () => {
        throw Object.assign(new Error('Cluster is terminated'), { name: 'InvalidRequestException' });
      },
      () => ({ InstanceGroups: [] })
    );
    const error = await createError();
    expect(createdBeforeFailure(error, 'Group', TYPE)).toBeUndefined();
  });

  it('leaves no mark when AddInstanceGroups returns no group id', async () => {
    routeSend(
      () => ({ InstanceGroupIds: [] }),
      () => ({ InstanceGroups: [] })
    );
    const error = await createError();
    expect(createdBeforeFailure(error, 'Group', TYPE)).toBeUndefined();
  });

  it('leaves no mark on the pre-flight missing-JobFlowId refusal', async () => {
    const { JobFlowId: _omit, ...rest } = PROPS;
    const error = await createError(rest);
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'Group', TYPE)).toBeUndefined();
  });
});
