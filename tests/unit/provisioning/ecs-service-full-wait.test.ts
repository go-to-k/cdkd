import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { DeleteServiceCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs';

// Issue #1275: cdkd does NOT wait for ECS Service steady state by default.
// CloudFormation waits, Terraform's `aws_ecs_service` does not
// (`wait_for_steady_state` defaults to false), and cdkd takes the fast side
// on purpose. `--full-wait` opts into the CloudFormation definition.
//
// These cases pin all three halves of that decision: no wait + an actionable
// INFO line by default, a real waiter under --full-wait (create AND update),
// and the partial-create cleanup when the opted-in wait fails.

const { mockSend, waitUntilServicesStableMock, infoSpy, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  waitUntilServicesStableMock: vi.fn(() => Promise.resolve({ state: 'SUCCESS' })),
  infoSpy: vi.fn(),
  warnSpy: vi.fn(),
}));

vi.mock('@aws-sdk/client-ecs', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    ECSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
    waitUntilServicesStable: waitUntilServicesStableMock,
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: infoSpy,
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';

const SERVICE_ARN = 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service';

const CREATE_PROPS = {
  Cluster: 'my-cluster',
  ServiceName: 'my-service',
  TaskDefinition: 'my-task:1',
  DesiredCount: 1,
};

function mockCreateOk() {
  mockSend.mockResolvedValueOnce({
    service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' },
  });
}

function mockUpdateOk() {
  mockSend.mockResolvedValueOnce({
    service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' },
  });
}

describe('ECS Service wait semantics (issue #1275)', () => {
  let originalFullWait: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    waitUntilServicesStableMock.mockResolvedValue({ state: 'SUCCESS' });
    originalFullWait = process.env['CDKD_FULL_WAIT'];
    delete process.env['CDKD_FULL_WAIT'];
  });

  afterEach(() => {
    if (originalFullWait === undefined) delete process.env['CDKD_FULL_WAIT'];
    else process.env['CDKD_FULL_WAIT'] = originalFullWait;
  });

  describe('default (no --full-wait)', () => {
    it('does not wait after CreateService', async () => {
      mockCreateOk();

      const result = await new ECSProvider().create(
        'MySvc',
        'AWS::ECS::Service',
        CREATE_PROPS
      );

      expect(result.physicalId).toBe(SERVICE_ARN);
      expect(waitUntilServicesStableMock).not.toHaveBeenCalled();
    });

    it('prints the exact command to wait manually', async () => {
      mockCreateOk();

      await new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS);

      // A copy-pasteable next step, NOT a health verdict: right after
      // CreateService a healthy and a doomed service are indistinguishable,
      // so cdkd must not imply it checked.
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'aws ecs wait services-stable --cluster my-cluster --services my-service'
        )
      );
    });

    it('omits --cluster from the hint when the template does not set one', async () => {
      mockSend.mockResolvedValueOnce({
        service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' },
      });

      await new ECSProvider().create('MySvc', 'AWS::ECS::Service', {
        ServiceName: 'my-service',
        TaskDefinition: 'my-task:1',
      });

      const hint = infoSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('aws ecs wait'));
      expect(hint).toBeDefined();
      expect(hint).not.toContain('--cluster');
      expect(hint).toContain('--services my-service');
    });

    it('does not wait after UpdateService either', async () => {
      mockUpdateOk();

      await new ECSProvider().update(
        'MySvc',
        SERVICE_ARN,
        'AWS::ECS::Service',
        { ...CREATE_PROPS, DesiredCount: 2 },
        CREATE_PROPS
      );

      expect(waitUntilServicesStableMock).not.toHaveBeenCalled();
    });
  });

  describe('--full-wait', () => {
    beforeEach(() => {
      process.env['CDKD_FULL_WAIT'] = 'true';
    });

    it('waits for steady state after CreateService, with a tightened poll cap', async () => {
      mockCreateOk();

      await new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS);

      expect(waitUntilServicesStableMock).toHaveBeenCalledTimes(1);
      const [config, input] = waitUntilServicesStableMock.mock.calls[0] as unknown as [
        { maxWaitTime: number; minDelay: number; maxDelay: number },
        { cluster?: string; services: string[] },
      ];
      expect(input).toEqual({ cluster: 'my-cluster', services: ['my-service'] });
      expect(config.minDelay).toBeLessThanOrEqual(5);
      expect(config.maxDelay).toBeLessThanOrEqual(10);
      expect(config.maxWaitTime).toBe(600);
    });

    it('waits after UpdateService too', async () => {
      mockUpdateOk();

      await new ECSProvider().update(
        'MySvc',
        SERVICE_ARN,
        'AWS::ECS::Service',
        { ...CREATE_PROPS, DesiredCount: 2 },
        CREATE_PROPS
      );

      expect(waitUntilServicesStableMock).toHaveBeenCalledTimes(1);
    });

    it('emits no manual-wait hint (it did the waiting)', async () => {
      mockCreateOk();

      await new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS);

      const hint = infoSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('aws ecs wait'));
      expect(hint).toBeUndefined();
    });

    it('force-deletes the just-created service and fails when it never stabilizes', async () => {
      mockCreateOk();
      waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));
      mockSend.mockResolvedValueOnce({}); // the cleanup DeleteService

      await expect(
        new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS)
      ).rejects.toThrow(/services stable timed out/);

      // Without the delete the service exists on AWS but not in cdkd state,
      // and the next deploy collides on the service name.
      const deleteCall = mockSend.mock.calls.find((c) => c[0] instanceof DeleteServiceCommand);
      expect(deleteCall).toBeDefined();
      const input = (deleteCall![0] as DeleteServiceCommand).input;
      expect(input.service).toBe(SERVICE_ARN);
      expect(input.cluster).toBe('my-cluster');
      // force skips the separate scale-to-0 round trip.
      expect(input.force).toBe(true);
      expect(mockSend.mock.calls.some((c) => c[0] instanceof UpdateServiceCommand)).toBe(false);
    });

    it('warns with a manual-deletion pointer when the cleanup itself fails', async () => {
      mockCreateOk();
      waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));
      mockSend.mockRejectedValueOnce(new Error('delete denied'));

      await expect(
        new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS)
      ).rejects.toThrow(/services stable timed out/);

      // The pointer must carry --cluster: a service in a non-default cluster
      // cannot be deleted without it, so a copy-pasted command would 404.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('aws ecs delete-service --cluster my-cluster')
      );
    });

    it('does NOT delete the service when the UPDATE-side wait fails', async () => {
      mockUpdateOk();
      waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));

      await expect(
        new ECSProvider().update(
          'MySvc',
          SERVICE_ARN,
          'AWS::ECS::Service',
          { ...CREATE_PROPS, DesiredCount: 2 },
          CREATE_PROPS
        )
      ).rejects.toThrow(/services stable timed out/);

      // Cleanup is a CREATE-only concern: on update the service legitimately
      // exists and must survive, with the deploy engine's rollback re-applying
      // the previous properties instead.
      expect(mockSend.mock.calls.some((c) => c[0] instanceof DeleteServiceCommand)).toBe(false);
    });
  });
});
