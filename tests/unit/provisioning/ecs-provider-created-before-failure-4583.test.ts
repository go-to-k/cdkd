/**
 * go-to-k/cdkd#4583: an ECS service CreateService returned, left behind
 * because the --full-wait cleanup delete FAILED, is named on the thrown error
 * for the failed-CREATE journal -- and only then. A service that held the name
 * before the create (CreateService hands an ACTIVE one back) is neither
 * cleaned up nor marked, nor is one the lookup could not answer for.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { DeleteServiceCommand } from '@aws-sdk/client-ecs';

const { mockSend, lookupSend, waitUntilServicesStableMock } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  // The by-name DescribeServices before CreateService (go-to-k/cdkd#4403).
  lookupSend: vi.fn(),
  waitUntilServicesStableMock: vi.fn(),
}));

vi.mock('@aws-sdk/client-ecs', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    ECSClient: vi.fn().mockImplementation(() => ({
      // A DescribeServices sent before any CreateService is the pre-create
      // lookup; one after it is the settle poll.
      send: (command: { constructor: { name: string } }) =>
        command.constructor.name === 'DescribeServicesCommand' &&
        !mockSend.mock.calls.some(([c]) => c.constructor.name === 'CreateServiceCommand')
          ? lookupSend(command)
          : mockSend(command),
      config: { region: () => Promise.resolve('us-east-1') },
    })),
    waitUntilServicesStable: waitUntilServicesStableMock,
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const child = { ...l, child: vi.fn().mockReturnThis() };
  return { getLogger: () => ({ ...l, child: () => child }) };
});

import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { clearResolvedResourceTimeouts } from '../../../src/provisioning/resource-timeout-registry.js';

const TYPE = 'AWS::ECS::Service';
const SERVICE_ARN = 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service';
const PROPS = {
  Cluster: 'my-cluster',
  ServiceName: 'my-service',
  TaskDefinition: 'my-task:1',
  DesiredCount: 1,
};

function deleteCalls(): unknown[] {
  return mockSend.mock.calls.filter((c) => c[0] instanceof DeleteServiceCommand);
}

async function failedCreate(props: Record<string, unknown> = PROPS): Promise<unknown> {
  return new ECSProvider().create('MySvc', TYPE, { ...props }).then(
    () => {
      throw new Error('create unexpectedly succeeded');
    },
    (e: unknown) => e
  );
}

describe('ECSProvider.create (Service) — created-before-failure mark (#4583)', () => {
  let originalFullWait: string | undefined;

  beforeEach(() => {
    mockSend.mockReset();
    lookupSend.mockReset();
    lookupSend.mockResolvedValue({ services: [], failures: [{ reason: 'MISSING' }] });
    waitUntilServicesStableMock.mockReset();
    originalFullWait = process.env['CDKD_FULL_WAIT'];
    process.env['CDKD_FULL_WAIT'] = 'true';
  });

  afterEach(() => {
    if (originalFullWait === undefined) delete process.env['CDKD_FULL_WAIT'];
    else process.env['CDKD_FULL_WAIT'] = originalFullWait;
    clearResolvedResourceTimeouts();
  });

  it('marks the service ARN (the success physicalId) when the --full-wait cleanup delete FAILS', async () => {
    mockSend.mockResolvedValueOnce({
      service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' },
    });
    waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));
    mockSend.mockRejectedValueOnce(new Error('delete denied'));

    const error = await failedCreate();

    expect((error as Error).message).toMatch(/services stable timed out/);
    expect(deleteCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBe(SERVICE_ARN);
  });

  it('does not mark when the cleanup delete succeeded', async () => {
    mockSend.mockResolvedValueOnce({
      service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' },
    });
    waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));
    mockSend.mockResolvedValueOnce({});

    const error = await failedCreate();

    expect(deleteCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBeUndefined();
  });

  it('looks the name up in the cluster before CreateService', async () => {
    mockSend.mockResolvedValueOnce({
      service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' },
    });
    waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));
    mockSend.mockResolvedValueOnce({});

    await failedCreate();

    expect(lookupSend).toHaveBeenCalledTimes(1);
    expect((lookupSend.mock.calls[0]![0] as { input: unknown }).input).toEqual({
      cluster: 'my-cluster',
      services: ['my-service'],
    });
  });

  it('cleans up as before when the only service under the name is INACTIVE', async () => {
    lookupSend.mockResolvedValue({ services: [{ serviceName: 'my-service', status: 'INACTIVE' }] });
    mockSend.mockResolvedValueOnce({
      service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' },
    });
    waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));
    mockSend.mockRejectedValueOnce(new Error('delete denied'));

    const error = await failedCreate();

    expect(deleteCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBe(SERVICE_ARN);
  });

  it('cleans up when the cluster does not exist yet (ClusterNotFoundException reads as free)', async () => {
    lookupSend.mockRejectedValue(
      Object.assign(new Error('Cluster not found.'), { name: 'ClusterNotFoundException' })
    );
    mockSend.mockResolvedValueOnce({
      service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' },
    });
    waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));
    mockSend.mockResolvedValueOnce({});

    const error = await failedCreate();

    expect(deleteCalls()).toHaveLength(1);
    expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBeUndefined();
  });

  it.each([
    [
      'an ACTIVE service held the name',
      () => ({ services: [{ serviceName: 'my-service', status: 'ACTIVE' }] }),
    ],
    [
      'a DRAINING service held the name',
      () => ({ services: [{ serviceName: 'my-service', status: 'DRAINING' }] }),
    ],
    [
      'the lookup answered a failure other than MISSING',
      () => ({ services: [], failures: [{ reason: 'ACCESS_DENIED' }] }),
    ],
    ['the lookup answered nothing', () => ({})],
  ])('neither deletes nor marks when %s', async (_label, answer) => {
    lookupSend.mockResolvedValue(answer());
    mockSend.mockResolvedValueOnce({
      service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' },
    });
    waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));

    const error = await failedCreate();

    expect((error as Error).message).toMatch(/services stable timed out/);
    expect(deleteCalls()).toHaveLength(0);
    expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBeUndefined();
  });

  it('neither deletes nor marks when the lookup throws (unknown)', async () => {
    lookupSend.mockRejectedValue(
      Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' })
    );
    mockSend.mockResolvedValueOnce({
      service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' },
    });
    waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));

    const error = await failedCreate();

    expect(deleteCalls()).toHaveLength(0);
    expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBeUndefined();
  });

  it('skips the lookup without --full-wait (no step after CreateService can fail)', async () => {
    delete process.env['CDKD_FULL_WAIT'];
    mockSend.mockResolvedValueOnce({
      service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' },
    });

    await new ECSProvider().create('MySvc', TYPE, { ...PROPS });

    expect(lookupSend).not.toHaveBeenCalled();
  });

  it("does not mark CreateService's own failure", async () => {
    mockSend.mockRejectedValueOnce(new Error('InvalidParameterException: not idempotent'));

    const error = await failedCreate();

    expect(deleteCalls()).toHaveLength(0);
    expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBeUndefined();
  });

  it('does not mark a CreateService answer with no service ARN', async () => {
    mockSend.mockResolvedValueOnce({ service: { serviceName: 'my-service' } });

    const error = await failedCreate();

    expect((error as Error).message).toMatch(/did not return service ARN/);
    expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBeUndefined();
  });

  it('does not mark the pre-flight refusal of malformed Tags', async () => {
    const error = await failedCreate({ ...PROPS, Tags: 'not-a-list' });

    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'MySvc', TYPE)).toBeUndefined();
  });
});
