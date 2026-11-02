import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#5664: `DeleteService` returns while the service is still
 * DRAINING. A real destroy then deleted the service's gateway cluster
 * association and the gateway against a live service, and the gateway delete
 * was refused ("Cannot delete gateway with active cluster associations").
 * CloudFormation waits for INACTIVE before reporting the service deleted, and
 * so must cdkd: these cases pin that `delete()` does not resolve until
 * DescribeServices reports the service gone.
 */

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-ecs', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ecs')>('@aws-sdk/client-ecs');
  return {
    ...actual,
    ECSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
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
  DeleteServiceCommand,
  DescribeServicesCommand,
  UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import {
  ECSProvider,
  serviceInactiveWait,
} from '../../../src/provisioning/providers/ecs-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';

const TYPE = 'AWS::ECS::Service';
const SERVICE_ARN = 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service';
const PROPS = { Cluster: 'my-cluster', DesiredCount: 1 };

const realSleep = serviceInactiveWait.sleep;
const realNow = serviceInactiveWait.now;

const awsError = (name: string): Error => Object.assign(new Error(name), { name });

/** The command class names `mockSend` was called with, in order. */
const sentCommands = (): string[] =>
  mockSend.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name);

describe('ECS Service delete waits for INACTIVE (go-to-k/cdkd#5664)', () => {
  let provider: ECSProvider;
  let clock: number;
  let sleeps: number[];

  beforeEach(() => {
    mockSend.mockReset();
    provider = new ECSProvider();
    clock = 0;
    sleeps = [];
    serviceInactiveWait.sleep = async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
    };
    serviceInactiveWait.now = () => clock;
  });

  afterEach(() => {
    serviceInactiveWait.sleep = realSleep;
    serviceInactiveWait.now = realNow;
  });

  it('polls DescribeServices after DeleteService until the service is INACTIVE', async () => {
    mockSend
      .mockResolvedValueOnce({}) // UpdateService desiredCount 0
      .mockResolvedValueOnce({}) // DeleteService force
      .mockResolvedValueOnce({ services: [{ status: 'DRAINING' }] })
      .mockResolvedValueOnce({ services: [{ status: 'DRAINING' }] })
      .mockResolvedValueOnce({ services: [{ status: 'INACTIVE' }] });

    await provider.delete('Svc', SERVICE_ARN, TYPE, PROPS);

    expect(sentCommands()).toEqual([
      UpdateServiceCommand.name,
      DeleteServiceCommand.name,
      DescribeServicesCommand.name,
      DescribeServicesCommand.name,
      DescribeServicesCommand.name,
    ]);
    const describe = mockSend.mock.calls[2]![0] as DescribeServicesCommand;
    expect(describe.input).toEqual({ cluster: 'my-cluster', services: [SERVICE_ARN] });
    expect(sleeps).toHaveLength(2);
  });

  it('treats a MISSING service as gone', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ services: [], failures: [{ arn: SERVICE_ARN, reason: 'MISSING' }] });

    await provider.delete('Svc', SERVICE_ARN, TYPE, PROPS);

    expect(sentCommands()).toHaveLength(3);
    expect(sleeps).toEqual([]);
  });

  it('treats a gone cluster as the service gone', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(awsError('ClusterNotFoundException'));

    await expect(provider.delete('Svc', SERVICE_ARN, TYPE, PROPS)).resolves.toBeUndefined();
  });

  it('throws a non-retryable, delete-started error when the service never reaches INACTIVE', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValue({ services: [{ status: 'DRAINING' }] });

    const error = await provider.delete('Svc', SERVICE_ARN, TYPE, PROPS).then(
      () => undefined,
      (e: unknown) => e as Error
    );

    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toContain('did not reach INACTIVE within 600s (last status: DRAINING)');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(isDeleteStarted(error)).toBe(true);
    // The deadline, not a poll count, ends the wait.
    expect(clock).toBeGreaterThanOrEqual(600_000);
  });

  it('a service an earlier attempt already deleted (NOT ACTIVE on scale-down) is still waited for', async () => {
    mockSend
      .mockRejectedValueOnce(awsError('ServiceNotActiveException'))
      .mockResolvedValueOnce({ services: [{ status: 'DRAINING' }] })
      .mockResolvedValueOnce({ services: [{ status: 'INACTIVE' }] });

    await provider.delete('Svc', SERVICE_ARN, TYPE, PROPS);

    expect(sentCommands()).toEqual([
      UpdateServiceCommand.name,
      DescribeServicesCommand.name,
      DescribeServicesCommand.name,
    ]);
  });

  it('a DeleteService answered NOT ACTIVE (a concurrent delete) is still waited for', async () => {
    mockSend
      .mockResolvedValueOnce({}) // UpdateService desiredCount 0
      .mockRejectedValueOnce(awsError('ServiceNotActiveException')) // DeleteService
      .mockResolvedValueOnce({ services: [{ status: 'DRAINING' }] })
      .mockResolvedValueOnce({ services: [{ status: 'INACTIVE' }] });

    await provider.delete('Svc', SERVICE_ARN, TYPE, PROPS);

    expect(sentCommands()).toEqual([
      UpdateServiceCommand.name,
      DeleteServiceCommand.name,
      DescribeServicesCommand.name,
      DescribeServicesCommand.name,
    ]);
  });

  it('a NOT ACTIVE service that never drains fails with the wait error itself, not a re-wrapped delete failure', async () => {
    mockSend
      .mockRejectedValueOnce(awsError('ServiceNotActiveException'))
      .mockResolvedValue({ services: [{ status: 'DRAINING' }] });

    const error = await provider.delete('Svc', SERVICE_ARN, TYPE, PROPS).then(
      () => undefined,
      (e: unknown) => e as Error
    );

    expect(error!.message).toMatch(/^ECS service .*Svc.* was deleted but did not reach INACTIVE/);
    expect(error!.message).not.toContain('Failed to delete ECS service');
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(isDeleteStarted(error)).toBe(true);
  });

  it('a service that is not found is gone, with no wait', async () => {
    mockSend.mockRejectedValueOnce(awsError('ServiceNotFoundException'));

    await provider.delete('Svc', SERVICE_ARN, TYPE, PROPS);

    expect(sentCommands()).toEqual([UpdateServiceCommand.name]);
  });

  it('a failed status read fails the delete as delete-started (the engine retry re-enters the wait)', async () => {
    mockSend
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(awsError('AccessDeniedException'));

    const error = await provider.delete('Svc', SERVICE_ARN, TYPE, PROPS).then(
      () => undefined,
      (e: unknown) => e as Error
    );

    expect(error!.message).toContain('Failed to confirm ECS service Svc deletion: AccessDeniedException');
    expect(isDeleteStarted(error)).toBe(true);
    expect(isMarkedNonRetryable(error)).toBe(false);
  });
});
