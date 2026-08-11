import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { DeleteServiceCommand, DescribeServicesCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs';

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

import { ECSProvider, settleRolloutDelays } from '../../../src/provisioning/providers/ecs-provider.js';
import {
  setResolvedResourceTimeouts,
  clearResolvedResourceTimeouts,
} from '../../../src/provisioning/resource-timeout-registry.js';

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
    clearResolvedResourceTimeouts();
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

    it('mentions --full-wait only when the invoking command declares the flag (issue #1291 item 1)', async () => {
      // `cdkd deploy` sets CDKD_WAIT_FLAGS_AVAILABLE; `cdkd drift --revert`
      // reaches the same provider code through update() and does NOT -- the
      // flag does not exist there, so the hint must not advertise it.
      process.env['CDKD_WAIT_FLAGS_AVAILABLE'] = 'true';
      try {
        mockCreateOk();
        await new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS);
        const hint = infoSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('aws ecs wait'));
        expect(hint).toContain('pass --full-wait to wait');
      } finally {
        delete process.env['CDKD_WAIT_FLAGS_AVAILABLE'];
      }
    });

    it('does NOT advertise --full-wait when the invoking command lacks the flag (drift --revert path)', async () => {
      delete process.env['CDKD_WAIT_FLAGS_AVAILABLE'];
      mockCreateOk();

      await new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS);

      const hint = infoSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('aws ecs wait'));
      expect(hint).toBeDefined();
      expect(hint).not.toContain('--full-wait');
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

    // The stability waiter's condition (one deployment, running == desired) is
    // satisfied a few seconds before ECS flips rolloutState to COMPLETED —
    // --full-wait closes that race with a bounded post-stability poll (found
    // live by the ecs-fargate fixture's update phase after the #609 SDK-route
    // flip; the CC route's CFn handler had been absorbing the gap).
    it('polls the PRIMARY rollout to COMPLETED after the stability waiter', async () => {
      const originalSleep = settleRolloutDelays.sleep;
      settleRolloutDelays.sleep = () => Promise.resolve();
      try {
        mockCreateOk();
        // Post-waiter DescribeServices polls: IN_PROGRESS, then COMPLETED.
        mockSend.mockResolvedValueOnce({
          services: [{ deployments: [{ rolloutState: 'IN_PROGRESS' }] }],
        });
        mockSend.mockResolvedValueOnce({
          services: [{ deployments: [{ rolloutState: 'COMPLETED' }] }],
        });

        await new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS);

        const describeCalls = mockSend.mock.calls.filter(
          ([cmd]) => cmd instanceof DescribeServicesCommand
        );
        expect(describeCalls).toHaveLength(2);
      } finally {
        settleRolloutDelays.sleep = originalSleep;
      }
    });

    it('warns and continues when the rollout stays IN_PROGRESS past the grace window', async () => {
      vi.useFakeTimers();
      const originalSleep = settleRolloutDelays.sleep;
      // Each "sleep" jumps system time past the 120s deadline so the loop
      // exits on the next iteration instead of really waiting.
      settleRolloutDelays.sleep = () => {
        vi.setSystemTime(Date.now() + 130_000);
        return Promise.resolve();
      };
      try {
        mockCreateOk();
        mockSend.mockResolvedValue({
          services: [{ deployments: [{ rolloutState: 'IN_PROGRESS' }] }],
        });

        await new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS);

        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('rollout is still IN_PROGRESS'));
      } finally {
        settleRolloutDelays.sleep = originalSleep;
        vi.useRealTimers();
        // mockResolvedValue (non-Once) would leak the permanent IN_PROGRESS
        // response into later tests — clearAllMocks does not drop
        // implementations.
        mockSend.mockReset();
      }
    });

    // Issue #1280: `--resource-timeout` must lift the steady-state waiter's
    // 600s cap the same way it lifts the engine's outer per-resource deadline
    // — the inner waiter firing first made the flag a no-op for slow services.
    describe('maxWaitTime vs --resource-timeout (issue #1280)', () => {
      function waiterMaxWaitTime(): number {
        const [config] = waitUntilServicesStableMock.mock.calls[0] as unknown as [
          { maxWaitTime: number },
        ];
        return config.maxWaitTime;
      }

      it('keeps the 600s floor when the flag is not supplied', async () => {
        mockCreateOk();
        await new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS);
        expect(waiterMaxWaitTime()).toBe(600);
      });

      it('lifts the cap to a per-type --resource-timeout AWS::ECS::Service=20m', async () => {
        setResolvedResourceTimeouts({ perTypeMs: { 'AWS::ECS::Service': 1_200_000 } });
        mockCreateOk();
        await new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS);
        expect(waiterMaxWaitTime()).toBe(1200);
      });

      it('lifts the cap to a global --resource-timeout 15m', async () => {
        setResolvedResourceTimeouts({ globalMs: 900_000, perTypeMs: {} });
        mockCreateOk();
        await new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS);
        expect(waiterMaxWaitTime()).toBe(900);
      });

      it('per-type override wins over the global value', async () => {
        setResolvedResourceTimeouts({
          globalMs: 900_000,
          perTypeMs: { 'AWS::ECS::Service': 1_800_000 },
        });
        mockCreateOk();
        await new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS);
        expect(waiterMaxWaitTime()).toBe(1800);
      });

      it('never lowers the cap below the 600s floor', async () => {
        setResolvedResourceTimeouts({ perTypeMs: { 'AWS::ECS::Service': 120_000 } });
        mockCreateOk();
        await new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS);
        expect(waiterMaxWaitTime()).toBe(600);
      });

      it('applies on the UPDATE-side wait too', async () => {
        setResolvedResourceTimeouts({ perTypeMs: { 'AWS::ECS::Service': 1_200_000 } });
        mockUpdateOk();
        await new ECSProvider().update(
          'MySvc',
          SERVICE_ARN,
          'AWS::ECS::Service',
          CREATE_PROPS,
          CREATE_PROPS
        );
        expect(waiterMaxWaitTime()).toBe(1200);
      });
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

    it('preserves the evidence trail when the timeout cleanup deletes the service (issue #1291 item 2)', async () => {
      mockCreateOk();
      waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));
      mockSend.mockResolvedValueOnce({}); // the cleanup DeleteService

      // The thrown message must carry the diagnosis path itself: the dominant
      // --full-wait failure is a crashing container, and the cleanup just
      // deleted the service the user would have inspected first.
      await expect(
        new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS)
      ).rejects.toThrow(
        /aws ecs list-tasks --cluster my-cluster --desired-status STOPPED, then aws ecs describe-tasks --cluster my-cluster --tasks/
      );

      // And the successful deletion is a warn, not a debug line: silently
      // removing a service the user asked to wait for hides WHY it is gone.
      const warning = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('Deleted partially-created ECS service'));
      expect(warning).toBeDefined();
      expect(warning).toContain(SERVICE_ARN);
      expect(warning).toContain('aws ecs list-tasks --cluster my-cluster --desired-status STOPPED');
    });

    it('renders cluster-free diagnosis commands when the template has no Cluster', async () => {
      const { Cluster: _cluster, ...noClusterProps } = CREATE_PROPS;
      mockCreateOk();
      waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));
      mockSend.mockResolvedValueOnce({}); // the cleanup DeleteService

      // Without a Cluster the commands must degrade to the default cluster --
      // no dangling `--cluster ` fragment that would break a copy-paste.
      await expect(
        new ECSProvider().create('MySvc', 'AWS::ECS::Service', noClusterProps)
      ).rejects.toThrow(/aws ecs list-tasks --desired-status STOPPED/);
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
