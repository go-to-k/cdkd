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
  EMRInstanceFleetConfigProvider,
  resetEMRInstanceFleetCreateRetryStateForTests,
} from '../../../src/provisioning/providers/emr-instance-fleet-config-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const TYPE = 'AWS::EMR::InstanceFleetConfig';
const FLEET_ID = 'if-ABC123';
const PROPS = {
  ClusterId: 'j-CLUSTER',
  InstanceFleetType: 'TASK',
  TargetOnDemandCapacity: 1,
  InstanceTypeConfigs: [{ InstanceType: 'm5.xlarge' }],
};

/** Route by command name: `AddInstanceFleetCommand` and `ListInstanceFleetsCommand` answer from the given handlers. */
function routeSend(add: () => unknown, list: () => unknown): void {
  mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
    if (command.constructor.name === 'AddInstanceFleetCommand') return add();
    if (command.constructor.name === 'ListInstanceFleetsCommand') return list();
    throw new Error(`unexpected command ${command.constructor.name}`);
  });
}

async function createError(props: Record<string, unknown> = PROPS): Promise<unknown> {
  return new EMRInstanceFleetConfigProvider().create('Fleet', TYPE, props).then(
    () => {
      throw new Error('expected create to fail');
    },
    (e: unknown) => e
  );
}

describe('EMRInstanceFleetConfigProvider create marks a created-before-failure fleet (#4583)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    resetEMRInstanceFleetCreateRetryStateForTests();
  });

  it('marks the fleet id when the fleet ends TERMINATED after AddInstanceFleet returned', async () => {
    routeSend(
      () => ({ InstanceFleetId: FLEET_ID }),
      () => ({
        InstanceFleets: [
          { Id: FLEET_ID, Status: { State: 'TERMINATED', StateChangeReason: { Message: 'boom' } } },
        ],
      })
    );
    const error = await createError();
    expect(createdBeforeFailure(error, 'Fleet', TYPE)).toBe(FLEET_ID);
  });

  it('marks the fleet id when the readiness poll throws a non-transient error', async () => {
    routeSend(
      () => ({ InstanceFleetId: FLEET_ID }),
      () => {
        throw Object.assign(new Error('not authorized to perform ListInstanceFleets'), {
          name: 'AccessDeniedException',
        });
      }
    );
    const error = await createError();
    expect(createdBeforeFailure(error, 'Fleet', TYPE)).toBe(FLEET_ID);
  });

  it('leaves no mark when AddInstanceFleet itself fails', async () => {
    routeSend(
      () => {
        throw Object.assign(new Error('Cluster is terminated'), { name: 'InvalidRequestException' });
      },
      () => ({ InstanceFleets: [] })
    );
    const error = await createError();
    expect(createdBeforeFailure(error, 'Fleet', TYPE)).toBeUndefined();
  });

  it('leaves no mark when AddInstanceFleet returns no fleet id', async () => {
    routeSend(
      () => ({}),
      () => ({ InstanceFleets: [] })
    );
    const error = await createError();
    expect(createdBeforeFailure(error, 'Fleet', TYPE)).toBeUndefined();
  });

  it('leaves no mark on the pre-flight missing-ClusterId refusal', async () => {
    const { ClusterId: _omit, ...rest } = PROPS;
    const error = await createError(rest);
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'Fleet', TYPE)).toBeUndefined();
  });
});
