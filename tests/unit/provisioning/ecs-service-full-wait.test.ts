import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { DeleteServiceCommand, DescribeServicesCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs';

// go-to-k/cdkd#5571: cdkd waits for ECS Service steady state by DEFAULT, as
// CloudFormation does, and a circuit-breaker verdict (a FAILED deployment, or
// a rollback that settles on another deployment) fails the resource.
// `--no-wait` skips the wait; `--full-wait` changes nothing for this type.
//
// These cases pin every half of that: the default wait (create AND update),
// the --no-wait early return with its INFO line, the partial-create cleanup
// when the wait fails, both breaker checks in both polarities, and the
// warn-and-continue answer for the callers that are not a template deploy
// (a rollback replay, `cdkd drift --revert`).

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

import {
  ECSProvider,
  controllerSkipsWait,
  failedRequestedDeployment,
  requestedRolloutOf,
  rolloutSupersededBy,
  settleRolloutDelays,
} from '../../../src/provisioning/providers/ecs-provider.js';

// The by-name lookup before a waiting CreateService (go-to-k/cdkd#4403): the
// name is free.
const serviceNameHeldSpy = vi
  .spyOn(ECSProvider.prototype as unknown as { serviceNameHeld(): Promise<boolean> }, 'serviceNameHeld')
  .mockResolvedValue(false);
import {
  setResolvedResourceTimeouts,
  clearResolvedResourceTimeouts,
} from '../../../src/provisioning/resource-timeout-registry.js';
import {
  FORGED_CTRL,
  FORGED_QUOTE,
  expectWithheld,
} from './pasteable-aws-command-assert.js';

const SERVICE_ARN = 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service';
const TD_V1 = 'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:1';
const TD_V2 = 'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:2';

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

/** An UpdateService answer whose PRIMARY deployment is `ecs-svc/2222` on TD_V2. */
function mockUpdateStartingRollout() {
  mockSend.mockResolvedValueOnce({
    service: {
      serviceArn: SERVICE_ARN,
      serviceName: 'my-service',
      taskDefinition: TD_V2,
      deployments: [
        { id: 'ecs-svc/2222', status: 'PRIMARY', taskDefinition: TD_V2, rolloutState: 'IN_PROGRESS' },
        { id: 'ecs-svc/1111', status: 'ACTIVE', taskDefinition: TD_V1, rolloutState: 'COMPLETED' },
      ],
    },
  });
}

/** The post-stability DescribeServices answer: one settled deployment. */
function mockSettledOn(id: string, taskDefinition: string) {
  mockSend.mockResolvedValueOnce({
    services: [{ deployments: [{ id, status: 'PRIMARY', taskDefinition, rolloutState: 'COMPLETED' }] }],
  });
}

const ENV_KEYS = ['CDKD_FULL_WAIT', 'CDKD_NO_WAIT', 'CDKD_WAIT_FLAGS_AVAILABLE'] as const;

describe('ECS Service wait semantics (go-to-k/cdkd#5571)', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    vi.clearAllMocks();
    waitUntilServicesStableMock.mockResolvedValue({ state: 'SUCCESS' });
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    clearResolvedResourceTimeouts();
    // A non-Once implementation set by a case below must not leak into the
    // next one: clearAllMocks does not drop implementations.
    mockSend.mockReset();
  });

  describe('--no-wait', () => {
    beforeEach(() => {
      process.env['CDKD_NO_WAIT'] = 'true';
    });

    it('does not wait after CreateService, and skips the pre-create name probe', async () => {
      mockCreateOk();

      const result = await new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS);

      expect(result.physicalId).toBe(SERVICE_ARN);
      expect(waitUntilServicesStableMock).not.toHaveBeenCalled();
      // No step after CreateService can fail, so nothing to protect.
      expect(serviceNameHeldSpy).not.toHaveBeenCalled();
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

    it('prints the exact command to wait manually, naming --no-wait as the reason', async () => {
      mockCreateOk();

      await new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS);

      const hint = infoSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('aws ecs wait'));
      expect(hint).toContain('not waiting for steady state under --no-wait');
      expect(hint).toContain('aws ecs wait services-stable --cluster my-cluster --services my-service');
      expect(hint).not.toContain('--full-wait');
    });

    it('omits --cluster from the hint when the template does not set one', async () => {
      mockCreateOk();

      await new ECSProvider().create('MySvc', 'AWS::ECS::Service', {
        ServiceName: 'my-service',
        TaskDefinition: 'my-task:1',
      });

      const hint = infoSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('aws ecs wait'));
      expect(hint).toBeDefined();
      expect(hint).not.toContain('--cluster');
      expect(hint).toContain('--services my-service');
    });
  });

  describe('default', () => {
    it('waits for steady state after CreateService, with a tightened poll cap', async () => {
      mockCreateOk();

      await new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS);

      expect(waitUntilServicesStableMock).toHaveBeenCalledTimes(1);
      const [config, input] = waitUntilServicesStableMock.mock.calls[0] as unknown as [
        { maxWaitTime: number; minDelay: number; maxDelay: number; abortSignal?: AbortSignal },
        { cluster?: string; services: string[] },
      ];
      expect(input).toEqual({ cluster: 'my-cluster', services: ['my-service'] });
      expect(config.minDelay).toBeLessThanOrEqual(5);
      expect(config.maxDelay).toBeLessThanOrEqual(10);
      expect(config.maxWaitTime).toBe(600);
      // The breaker watch can end the wait early.
      expect(config.abortSignal).toBeInstanceOf(AbortSignal);
      // A wait that can fail the create asks whether the name was free.
      expect(serviceNameHeldSpy).toHaveBeenCalledTimes(1);
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

      const hint = infoSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('aws ecs wait'));
      expect(hint).toBeUndefined();
    });

    // The stability waiter's condition (one deployment, running == desired) is
    // satisfied a few seconds before ECS flips rolloutState to COMPLETED — the
    // bounded post-stability poll closes that race.
    it('polls the PRIMARY rollout to COMPLETED after the stability waiter', async () => {
      const originalSleep = settleRolloutDelays.sleep;
      settleRolloutDelays.sleep = () => Promise.resolve();
      try {
        mockCreateOk();
        mockSend.mockResolvedValueOnce({
          services: [{ deployments: [{ rolloutState: 'IN_PROGRESS' }] }],
        });
        mockSend.mockResolvedValueOnce({
          services: [{ deployments: [{ rolloutState: 'COMPLETED' }] }],
        });

        await new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS);

        const describeCalls = mockSend.mock.calls.filter(([cmd]) => cmd instanceof DescribeServicesCommand);
        expect(describeCalls).toHaveLength(2);
      } finally {
        settleRolloutDelays.sleep = originalSleep;
      }
    });

    it('warns and continues when the rollout stays IN_PROGRESS past the grace window', async () => {
      vi.useFakeTimers();
      const originalSleep = settleRolloutDelays.sleep;
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
      }
    });

    // Issue #1280: `--resource-timeout` lifts the steady-state waiter's 600s
    // cap the same way it lifts the engine's outer per-resource deadline.
    describe('maxWaitTime vs --resource-timeout (issue #1280)', () => {
      function waiterMaxWaitTime(): number {
        const [config] = waitUntilServicesStableMock.mock.calls[0] as unknown as [{ maxWaitTime: number }];
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
        setResolvedResourceTimeouts({ globalMs: 900_000, perTypeMs: { 'AWS::ECS::Service': 1_800_000 } });
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
        await new ECSProvider().update('MySvc', SERVICE_ARN, 'AWS::ECS::Service', CREATE_PROPS, CREATE_PROPS);
        expect(waiterMaxWaitTime()).toBe(1200);
      });
    });

    it('force-deletes the just-created service and fails when it never stabilizes', async () => {
      mockCreateOk();
      waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));
      mockSend.mockResolvedValueOnce({}); // the cleanup DeleteService

      await expect(new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS)).rejects.toThrow(
        /did not reach steady state: services stable timed out/
      );

      const deleteCall = mockSend.mock.calls.find((c) => c[0] instanceof DeleteServiceCommand);
      expect(deleteCall).toBeDefined();
      const input = (deleteCall![0] as DeleteServiceCommand).input;
      expect(input.service).toBe(SERVICE_ARN);
      expect(input.cluster).toBe('my-cluster');
      expect(input.force).toBe(true);
      expect(mockSend.mock.calls.some((c) => c[0] instanceof UpdateServiceCommand)).toBe(false);
    });

    it('preserves the evidence trail when the timeout cleanup deletes the service (issue #1291 item 2)', async () => {
      mockCreateOk();
      waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));
      mockSend.mockResolvedValueOnce({}); // the cleanup DeleteService

      await expect(new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS)).rejects.toThrow(
        /aws ecs list-tasks --cluster my-cluster --desired-status STOPPED, then aws ecs describe-tasks --cluster my-cluster --tasks/
      );

      const warning = warnSpy.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('Deleted partially-created ECS service'));
      expect(warning).toBeDefined();
      expect(warning).toContain(SERVICE_ARN);
      expect(warning).toContain('aws ecs list-tasks --cluster my-cluster --desired-status STOPPED');
    });

    it('names --no-wait in the failure only when the invoking command declares it (issue #1291 item 1)', async () => {
      const failureText = async (): Promise<string> => {
        mockCreateOk();
        waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));
        mockSend.mockResolvedValueOnce({}); // the cleanup DeleteService
        return new ECSProvider()
          .create('MySvc', 'AWS::ECS::Service', CREATE_PROPS)
          .then(
            () => '',
            (e: unknown) => String((e as Error).message)
          );
      };
      // A command without the wait flags names neither.
      const bare = await failureText();
      expect(bare).not.toContain('--no-wait');
      expect(bare).not.toContain('--resource-timeout');
      process.env['CDKD_WAIT_FLAGS_AVAILABLE'] = 'true';
      const hinted = await failureText();
      expect(hinted).toContain('pass --no-wait');
      // A wait that ran out names the per-type limit, value as a quoted hole.
      expect(hinted).toContain("--resource-timeout AWS::ECS::Service='<duration>'");
    });

    it('a circuit-breaker verdict offers --no-wait but never a longer --resource-timeout', async () => {
      process.env['CDKD_WAIT_FLAGS_AVAILABLE'] = 'true';
      mockUpdateStartingRollout();
      mockSettledOn('ecs-svc/1111', TD_V1);
      const message = await new ECSProvider()
        .update('MySvc', SERVICE_ARN, 'AWS::ECS::Service', { ...CREATE_PROPS, TaskDefinition: TD_V2 }, CREATE_PROPS)
        .then(
          () => '',
          (e: unknown) => String((e as Error).message)
        );
      expect(message).toContain('circuit breaker');
      expect(message).toContain('pass --no-wait');
      expect(message).not.toContain('--resource-timeout');
    });

    // An ECS-unsettled DeploymentController has no deployment the waiter can
    // settle: waiting would time out and the create arm would delete a
    // healthy new service.
    describe('DeploymentController', () => {
      for (const type of ['CODE_DEPLOY', 'EXTERNAL']) {
        it(`${type}: the create does not wait, skips the name probe, and names the controller`, async () => {
          process.env['CDKD_WAIT_FLAGS_AVAILABLE'] = 'true';
          mockCreateOk();

          await new ECSProvider().create('MySvc', 'AWS::ECS::Service', {
            ...CREATE_PROPS,
            DeploymentController: { Type: type },
          });

          expect(waitUntilServicesStableMock).not.toHaveBeenCalled();
          expect(serviceNameHeldSpy).not.toHaveBeenCalled();
          expect(mockSend.mock.calls.some((c) => c[0] instanceof DeleteServiceCommand)).toBe(false);
          const line = infoSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('not waiting'));
          expect(line).toContain(`its DeploymentController is ${type}`);
          expect(line).not.toContain('--no-wait');
        });

        it(`${type}: the update does not wait either`, async () => {
          mockUpdateOk();
          await new ECSProvider().update(
            'MySvc',
            SERVICE_ARN,
            'AWS::ECS::Service',
            { ...CREATE_PROPS, DeploymentController: { Type: type }, DesiredCount: 2 },
            { ...CREATE_PROPS, DeploymentController: { Type: type } }
          );
          expect(waitUntilServicesStableMock).not.toHaveBeenCalled();
        });
      }

      it('an explicit ECS controller waits (negative control)', async () => {
        mockCreateOk();
        await new ECSProvider().create('MySvc', 'AWS::ECS::Service', {
          ...CREATE_PROPS,
          DeploymentController: { Type: 'ECS' },
        });
        expect(waitUntilServicesStableMock).toHaveBeenCalledTimes(1);
      });

      for (const [label, controller] of [
        ['an unresolved intrinsic', { 'Fn::If': ['C', { Type: 'ECS' }, { Type: 'EXTERNAL' }] }],
        ['a non-string Type', { Type: 7 }],
        ['a non-object block', 'ECS'],
      ] as const) {
        it(`${label}: fails toward NOT waiting, never toward the cleanup delete`, async () => {
          mockCreateOk();
          await new ECSProvider().create('MySvc', 'AWS::ECS::Service', {
            ...CREATE_PROPS,
            DeploymentController: controller as unknown as Record<string, unknown>,
          });
          expect(waitUntilServicesStableMock).not.toHaveBeenCalled();
          expect(mockSend.mock.calls.some((c) => c[0] instanceof DeleteServiceCommand)).toBe(false);
          expect(infoSpy).toHaveBeenCalledWith(
            expect.stringContaining('its DeploymentController could not be read')
          );
        });
      }

      it('controllerSkipsWait: absent and ECS wait; others name the reason', () => {
        expect(controllerSkipsWait({})).toBeUndefined();
        expect(controllerSkipsWait({ DeploymentController: { Type: 'ECS' } })).toBeUndefined();
        expect(controllerSkipsWait({ DeploymentController: { Type: 'CODE_DEPLOY' } })).toContain('CODE_DEPLOY');
        expect(controllerSkipsWait({ DeploymentController: { Type: 'SOMETHING' } })).toContain('not one cdkd can settle');
      });
    });

    it('renders cluster-free diagnosis commands when the template has no Cluster', async () => {
      const { Cluster: _cluster, ...noClusterProps } = CREATE_PROPS;
      mockCreateOk();
      waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));
      mockSend.mockResolvedValueOnce({}); // the cleanup DeleteService

      await expect(new ECSProvider().create('MySvc', 'AWS::ECS::Service', noClusterProps)).rejects.toThrow(
        /aws ecs list-tasks --desired-status STOPPED/
      );
    });

    it('warns with a manual-deletion pointer when the cleanup itself fails', async () => {
      mockCreateOk();
      waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));
      mockSend.mockRejectedValueOnce(new Error('delete denied'));

      await expect(new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS)).rejects.toThrow(
        /services stable timed out/
      );

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('aws ecs delete-service --cluster my-cluster'));
    });

    it('does NOT delete the service when the UPDATE-side wait fails, and names the diagnosis commands', async () => {
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
      ).rejects.toThrow(
        /did not reach steady state: services stable timed out\. Inspect why its tasks stopped .*aws ecs list-tasks --cluster my-cluster --desired-status STOPPED/
      );

      // On update the service legitimately exists and must survive, with the
      // deploy engine's rollback re-applying the previous properties instead.
      expect(mockSend.mock.calls.some((c) => c[0] instanceof DeleteServiceCommand)).toBe(false);
    });
  });

  describe('--full-wait', () => {
    beforeEach(() => {
      process.env['CDKD_FULL_WAIT'] = 'true';
    });

    it('waits exactly as the default does', async () => {
      mockCreateOk();
      await new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS);
      mockUpdateOk();
      await new ECSProvider().update(
        'MySvc',
        SERVICE_ARN,
        'AWS::ECS::Service',
        { ...CREATE_PROPS, DesiredCount: 2 },
        CREATE_PROPS
      );

      expect(waitUntilServicesStableMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('deployment circuit breaker', () => {
    it('fails the update when the service settles on another deployment (a rollback)', async () => {
      mockUpdateStartingRollout();
      // The breaker rolled back: the single settled deployment is the old one.
      mockSettledOn('ecs-svc/1111', TD_V1);

      await expect(
        new ECSProvider().update(
          'MySvc',
          SERVICE_ARN,
          'AWS::ECS::Service',
          { ...CREATE_PROPS, TaskDefinition: TD_V2 },
          CREATE_PROPS
        )
      ).rejects.toThrow(
        /did not reach steady state: its deployment circuit breaker rolled the rollout back: the service settled on deployment ecs-svc\/1111 \(task definition revision 1\), not on the deployment this update started \(deployment ecs-svc\/2222 \(task definition revision 2\)\)\..*aws ecs list-tasks --cluster my-cluster --desired-status STOPPED/
      );
      expect(mockSend.mock.calls.some((c) => c[0] instanceof DeleteServiceCommand)).toBe(false);
    });

    it('passes an update whose settled deployment IS the one it started (negative control)', async () => {
      mockUpdateStartingRollout();
      mockSettledOn('ecs-svc/2222', TD_V2);

      const result = await new ECSProvider().update(
        'MySvc',
        SERVICE_ARN,
        'AWS::ECS::Service',
        { ...CREATE_PROPS, TaskDefinition: TD_V2 },
        CREATE_PROPS
      );

      expect(result.physicalId).toBe(SERVICE_ARN);
    });

    it('ends the wait at once when the requested deployment turns FAILED, and fails the update', async () => {
      mockUpdateStartingRollout();
      // The waiter's own DescribeServices answer: the breaker marked the new
      // deployment FAILED while ECS rolls back to the old one.
      mockSend.mockResolvedValueOnce({
        services: [
          {
            deployments: [
              { id: 'ecs-svc/1111', status: 'PRIMARY', taskDefinition: TD_V1, rolloutState: 'IN_PROGRESS' },
              { id: 'ecs-svc/2222', status: 'ACTIVE', taskDefinition: TD_V2, rolloutState: 'FAILED' },
            ],
          },
        ],
      });
      let abortedWhenReturned: boolean | undefined;
      waitUntilServicesStableMock.mockImplementationOnce((async (config: {
        client: { send(c: unknown): Promise<unknown> };
        abortSignal: AbortSignal;
      }) => {
        await config.client.send(new DescribeServicesCommand({ services: ['my-service'] }));
        abortedWhenReturned = config.abortSignal.aborted;
        // What `checkExceptions` throws for an ABORTED waiter result.
        const abortError = new Error(JSON.stringify({ state: 'ABORTED' }));
        abortError.name = 'AbortError';
        throw abortError;
      }) as unknown as () => Promise<{ state: string }>);

      await expect(
        new ECSProvider().update(
          'MySvc',
          SERVICE_ARN,
          'AWS::ECS::Service',
          { ...CREATE_PROPS, TaskDefinition: TD_V2 },
          CREATE_PROPS
        )
      ).rejects.toThrow(
        /its deployment circuit breaker failed the rollout of deployment ecs-svc\/2222 \(task definition revision 2\) \(deployment FAILED\)/
      );
      expect(abortedWhenReturned).toBe(true);
      // No post-stability poll ran: only UpdateService and the waiter's read.
      expect(mockSend.mock.calls.filter((c) => c[0] instanceof DescribeServicesCommand)).toHaveLength(1);
    });

    it('does not abort the wait while the requested deployment is still IN_PROGRESS', async () => {
      mockUpdateStartingRollout();
      mockSend.mockResolvedValueOnce({
        services: [
          {
            deployments: [
              { id: 'ecs-svc/2222', status: 'PRIMARY', taskDefinition: TD_V2, rolloutState: 'IN_PROGRESS' },
              // An OLD deployment's FAILED state is not this update's verdict.
              { id: 'ecs-svc/1111', status: 'ACTIVE', taskDefinition: TD_V1, rolloutState: 'FAILED' },
            ],
          },
        ],
      });
      let aborted: boolean | undefined;
      waitUntilServicesStableMock.mockImplementationOnce((async (config: {
        client: { send(c: unknown): Promise<unknown> };
        abortSignal: AbortSignal;
      }) => {
        await config.client.send(new DescribeServicesCommand({ services: ['my-service'] }));
        aborted = config.abortSignal.aborted;
        return { state: 'SUCCESS' };
      }) as unknown as () => Promise<{ state: string }>);
      mockSettledOn('ecs-svc/2222', TD_V2);

      await new ECSProvider().update(
        'MySvc',
        SERVICE_ARN,
        'AWS::ECS::Service',
        { ...CREATE_PROPS, TaskDefinition: TD_V2 },
        CREATE_PROPS
      );

      expect(aborted).toBe(false);
    });

    // A `rollback: false` breaker leaves the FAILED deployment in place; the
    // waiter can still resolve on that very answer.
    it('fails when the waiter RESOLVES on an answer that showed the requested deployment FAILED', async () => {
      mockUpdateStartingRollout();
      mockSend.mockResolvedValueOnce({
        services: [
          {
            runningCount: 1,
            desiredCount: 1,
            deployments: [
              { id: 'ecs-svc/2222', status: 'PRIMARY', taskDefinition: TD_V2, rolloutState: 'FAILED' },
            ],
          },
        ],
      });
      waitUntilServicesStableMock.mockImplementationOnce((async (config: {
        client: { send(c: unknown): Promise<unknown> };
      }) => {
        await config.client.send(new DescribeServicesCommand({ services: ['my-service'] }));
        return { state: 'SUCCESS' };
      }) as unknown as () => Promise<{ state: string }>);

      await expect(
        new ECSProvider().update(
          'MySvc',
          SERVICE_ARN,
          'AWS::ECS::Service',
          { ...CREATE_PROPS, TaskDefinition: TD_V2 },
          CREATE_PROPS
        )
      ).rejects.toThrow(/circuit breaker failed the rollout of deployment ecs-svc\/2222/);
      // The verdict needed no post-stability poll.
      expect(mockSend.mock.calls.filter((c) => c[0] instanceof DescribeServicesCommand)).toHaveLength(1);
    });

    it('treats FAILED in the post-stability rollout poll as the verdict, not as still in progress', async () => {
      mockUpdateStartingRollout();
      mockSend.mockResolvedValueOnce({
        services: [
          { deployments: [{ id: 'ecs-svc/2222', status: 'PRIMARY', taskDefinition: TD_V2, rolloutState: 'FAILED' }] },
        ],
      });
      const sleep = vi.spyOn(settleRolloutDelays, 'sleep').mockResolvedValue();
      try {
        await expect(
          new ECSProvider().update(
            'MySvc',
            SERVICE_ARN,
            'AWS::ECS::Service',
            { ...CREATE_PROPS, TaskDefinition: TD_V2 },
            CREATE_PROPS
          )
        ).rejects.toThrow(/circuit breaker failed the rollout of deployment ecs-svc\/2222/);
        expect(sleep).not.toHaveBeenCalled();
      } finally {
        sleep.mockRestore();
      }
    });

    it('a requested deployment FAILED beside another one in the post-stability poll is the verdict', async () => {
      mockUpdateStartingRollout();
      mockSend.mockResolvedValueOnce({
        services: [
          {
            deployments: [
              { id: 'ecs-svc/1111', status: 'PRIMARY', taskDefinition: TD_V1, rolloutState: 'IN_PROGRESS' },
              { id: 'ecs-svc/2222', status: 'ACTIVE', taskDefinition: TD_V2, rolloutState: 'FAILED' },
            ],
          },
        ],
      });

      await expect(
        new ECSProvider().update(
          'MySvc',
          SERVICE_ARN,
          'AWS::ECS::Service',
          { ...CREATE_PROPS, TaskDefinition: TD_V2 },
          CREATE_PROPS
        )
      ).rejects.toThrow(/circuit breaker failed the rollout of deployment ecs-svc\/2222/);
    });

    it('never names the template-chosen task-definition family in a verdict', async () => {
      const family = 'qx';
      mockSend.mockResolvedValueOnce({
        service: {
          serviceArn: SERVICE_ARN,
          serviceName: 'my-service',
          deployments: [
            { id: 'ecs-svc/2222', status: 'PRIMARY', taskDefinition: `${TD_V2.replace('my-task', family)}` },
          ],
        },
      });
      mockSettledOn('ecs-svc/1111', TD_V1.replace('my-task', family));
      const message = await new ECSProvider()
        .update('MySvc', SERVICE_ARN, 'AWS::ECS::Service', { ...CREATE_PROPS, TaskDefinition: TD_V2 }, CREATE_PROPS)
        .then(
          () => '',
          (e: unknown) => String((e as Error).message)
        );
      expect(message).toContain('circuit breaker rolled the rollout back');
      expect(message).not.toContain(`${family}:`);
      expect(message).not.toContain(`/${family}`);
    });

    describe('verdict helpers', () => {
      it('requestedRolloutOf reads the PRIMARY deployment, else the service task definition', () => {
        expect(
          requestedRolloutOf({
            deployments: [
              { id: 'a', status: 'ACTIVE', taskDefinition: TD_V1 },
              { id: 'b', status: 'PRIMARY', taskDefinition: TD_V2 },
            ],
          })
        ).toEqual({ deploymentId: 'b', taskDefinition: TD_V2 });
        expect(requestedRolloutOf({ taskDefinition: TD_V2 })).toEqual({
          deploymentId: undefined,
          taskDefinition: TD_V2,
        });
        expect(requestedRolloutOf({ serviceArn: SERVICE_ARN })).toBeUndefined();
        expect(requestedRolloutOf(undefined)).toBeUndefined();
      });

      it('rolloutSupersededBy decides by deployment id, then task definition, and fails open', () => {
        const requested = { deploymentId: 'ecs-svc/2222', taskDefinition: TD_V2 };
        expect(rolloutSupersededBy(requested, { id: 'ecs-svc/2222', taskDefinition: TD_V2 })).toBeUndefined();
        expect(rolloutSupersededBy(requested, { id: 'ecs-svc/1111', taskDefinition: TD_V1 })).toBe(
          'deployment ecs-svc/1111 (task definition revision 1)'
        );
        // A rollback to the same task definition (a failed network change)
        // is still another deployment.
        expect(rolloutSupersededBy(requested, { id: 'ecs-svc/1111', taskDefinition: TD_V2 })).toBe(
          'deployment ecs-svc/1111 (task definition revision 2)'
        );
        // No id on the requested side: the task-definition ARN decides.
        expect(rolloutSupersededBy({ taskDefinition: TD_V2 }, { taskDefinition: TD_V2 })).toBeUndefined();
        expect(rolloutSupersededBy({ taskDefinition: TD_V2 }, { taskDefinition: TD_V1 })).toBe(
          'task definition revision 1'
        );
        // The family (template-chosen, possibly secret-derived) never reaches
        // the text, nor does an id that is not AWS-minted in shape.
        expect(
          rolloutSupersededBy(requested, { id: 'my-task-secret', taskDefinition: TD_V1 })
        ).toBe('task definition revision 1');
        expect(rolloutSupersededBy({ taskDefinition: TD_V2 }, { taskDefinition: 'my-task' })).toBe(
          'another deployment'
        );
        // Unreadable either side: no verdict.
        expect(rolloutSupersededBy(undefined, { id: 'x' })).toBeUndefined();
        expect(rolloutSupersededBy(requested, undefined)).toBeUndefined();
        expect(rolloutSupersededBy({ deploymentId: 'ecs-svc/2222' }, { taskDefinition: TD_V1 })).toBeUndefined();
      });

      it('failedRequestedDeployment matches the requested id, else the PRIMARY deployment', () => {
        const failedNew = { id: 'ecs-svc/2222', status: 'ACTIVE', rolloutState: 'FAILED' as const };
        expect(failedRequestedDeployment({ deploymentId: 'ecs-svc/2222' }, [failedNew])).toBe(failedNew);
        expect(
          failedRequestedDeployment({ deploymentId: 'ecs-svc/other' }, [failedNew])
        ).toBeUndefined();
        const failedPrimary = { id: 'p', status: 'PRIMARY', rolloutState: 'FAILED' as const };
        expect(failedRequestedDeployment(undefined, [failedPrimary])).toBe(failedPrimary);
        expect(
          failedRequestedDeployment(undefined, [{ ...failedPrimary, rolloutState: 'IN_PROGRESS' as const }])
        ).toBeUndefined();
        expect(failedRequestedDeployment(undefined, undefined)).toBeUndefined();
      });
    });
  });

  // A rollback replay re-applies a configuration the service held before;
  // failing it on the rollout would leave the stack un-rollbackable, so it
  // warns and continues. `cdkd drift --revert` does not wait at all.
  describe('callers that are not a template deploy', () => {
    it('drift --revert (desiredFromAwsReadback) does not wait, and names no flag', async () => {
      process.env['CDKD_WAIT_FLAGS_AVAILABLE'] = 'true';
      mockUpdateOk();

      const result = await new ECSProvider().update(
        'MySvc',
        SERVICE_ARN,
        'AWS::ECS::Service',
        { ...CREATE_PROPS, DesiredCount: 2 },
        CREATE_PROPS,
        { desiredFromAwsReadback: true }
      );

      expect(result.physicalId).toBe(SERVICE_ARN);
      expect(waitUntilServicesStableMock).not.toHaveBeenCalled();
      const line = infoSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('not waiting'));
      expect(line).toContain('a drift revert does not wait for it');
      expect(line).not.toContain('--no-wait');
    });

    it('a template-path update still waits (negative control for the drift arm)', async () => {
      mockUpdateOk();
      await new ECSProvider().update(
        'MySvc',
        SERVICE_ARN,
        'AWS::ECS::Service',
        { ...CREATE_PROPS, DesiredCount: 2 },
        CREATE_PROPS,
        { desiredFromAwsReadback: false }
      );
      expect(waitUntilServicesStableMock).toHaveBeenCalledTimes(1);
    });

    for (const [label, context] of [['rollback replay (replayingState)', { replayingState: true }]] as const) {
      it(`${label}: a failed UPDATE wait warns and the update reports applied`, async () => {
        mockUpdateOk();
        waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));

        const result = await new ECSProvider().update(
          'MySvc',
          SERVICE_ARN,
          'AWS::ECS::Service',
          { ...CREATE_PROPS, DesiredCount: 2 },
          CREATE_PROPS,
          context
        );

        expect(result.physicalId).toBe(SERVICE_ARN);
        const warning = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('steady state'));
        expect(warning).toContain('services stable timed out');
        expect(warning).toContain('aws ecs list-tasks --cluster my-cluster --desired-status STOPPED');
        expect(warning).toContain('continuing');
      });

      it(`${label}: a breaker rollback warns instead of failing`, async () => {
        mockUpdateStartingRollout();
        mockSettledOn('ecs-svc/1111', TD_V1);

        const result = await new ECSProvider().update(
          'MySvc',
          SERVICE_ARN,
          'AWS::ECS::Service',
          { ...CREATE_PROPS, TaskDefinition: TD_V2 },
          CREATE_PROPS,
          context
        );

        expect(result.physicalId).toBe(SERVICE_ARN);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('circuit breaker rolled the rollout back'));
      });
    }

    it('a rollback re-create (CreateContext.replayingState) keeps the service and warns, no cleanup delete', async () => {
      mockCreateOk();
      waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));

      const result = await new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS, {
        replayingState: true,
      });

      expect(result.physicalId).toBe(SERVICE_ARN);
      expect(mockSend.mock.calls.some((c) => c[0] instanceof DeleteServiceCommand)).toBe(false);
      // The cleanup never runs, so the name probe guarding it is not asked.
      expect(serviceNameHeldSpy).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Continuing the rollback'));
    });

    it('a template-path create still deletes and fails (negative control for the replay arm)', async () => {
      mockCreateOk();
      waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));
      mockSend.mockResolvedValueOnce({}); // the cleanup DeleteService

      await expect(
        new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS, { replayingState: false })
      ).rejects.toThrow(/did not reach steady state/);
      expect(mockSend.mock.calls.some((c) => c[0] instanceof DeleteServiceCommand)).toBe(true);
    });
  });
});

// Issue #3136: the cluster and the service name are TEMPLATE values (the name
// echoed back on the create response), so every pasteable command the create
// path prints renders through `pasteableAwsCommand` — bare, or withheld (a
// shell-active character withholds it, go-to-k/cdkd#3950).
describe('ECS Service pasteable commands (issue #3136)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    waitUntilServicesStableMock.mockResolvedValue({ state: 'SUCCESS' });
    delete process.env['CDKD_FULL_WAIT'];
    delete process.env['CDKD_NO_WAIT'];
  });

  afterEach(() => {
    delete process.env['CDKD_FULL_WAIT'];
    delete process.env['CDKD_NO_WAIT'];
  });

  it('the --no-wait manual-wait hint withholds the command for a forged cluster or service name', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    const hintFor = async (cluster: string, serviceName: string): Promise<string> => {
      infoSpy.mockReset();
      mockSend.mockResolvedValueOnce({ service: { serviceArn: SERVICE_ARN, serviceName } });
      await new ECSProvider().create('MySvc', 'AWS::ECS::Service', { ...CREATE_PROPS, Cluster: cluster });
      return infoSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('To wait manually'))!;
    };
    expectWithheld(await hintFor(`c${FORGED_QUOTE}`, 'svc'), 'aws ecs wait');
    expectWithheld(await hintFor('c', `svc${FORGED_QUOTE}`), 'aws ecs wait');
    expect(await hintFor('c', 'svc')).toContain('aws ecs wait services-stable --cluster c --services svc');

    infoSpy.mockReset();
    mockSend.mockResolvedValueOnce({
      service: { serviceArn: SERVICE_ARN, serviceName: `svc${FORGED_CTRL}` },
    });
    await new ECSProvider().create('MySvc', 'AWS::ECS::Service', CREATE_PROPS);
    expectWithheld(
      infoSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('To wait manually'))!,
      'aws ecs wait'
    );
  });

  async function waitFailure(cluster: string, deleteOk: boolean): Promise<{ thrown: string; warn: string }> {
    mockCreateOk();
    waitUntilServicesStableMock.mockRejectedValueOnce(new Error('services stable timed out'));
    if (deleteOk) mockSend.mockResolvedValueOnce({});
    else mockSend.mockRejectedValueOnce(new Error('delete denied'));
    const thrown = await new ECSProvider()
      .create('MySvc', 'AWS::ECS::Service', { ...CREATE_PROPS, Cluster: cluster })
      .then(
        () => '',
        (e: unknown) => String((e as Error).message)
      );
    return { thrown, warn: warnSpy.mock.calls.map((c) => String(c[0])).join('\n') };
  }

  it('the steady-state failure commands are withheld wherever they would name a forged cluster', async () => {
    const clean = await waitFailure('my-cluster', true);
    // The task-arn hole is quoted: bare, `<task-arn>` is two redirections.
    expect(clean.thrown).toContain(`aws ecs describe-tasks --cluster my-cluster --tasks '<task-arn>'`);

    warnSpy.mockReset();
    const cluster = `c${FORGED_QUOTE}`;
    const ok = await waitFailure(cluster, true);
    expectWithheld(ok.warn, 'aws ecs list-tasks');
    expectWithheld(ok.thrown, 'aws ecs list-tasks');
    expectWithheld(ok.thrown, 'aws ecs describe-tasks');

    warnSpy.mockReset();
    const failed = await waitFailure(cluster, false);
    expectWithheld(failed.warn, 'aws ecs delete-service');
  });

  it('a NON-string Cluster withholds the manual-wait hint instead of dropping --cluster', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    mockCreateOk();
    await new ECSProvider().create('MySvc', 'AWS::ECS::Service', {
      ...CREATE_PROPS,
      Cluster: { Ref: 'X' } as unknown as string,
    });
    expectWithheld(
      infoSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('To wait manually'))!,
      'aws ecs wait'
    );
    delete process.env['CDKD_NO_WAIT'];
    warnSpy.mockReset();
    const failed = await waitFailure({ Ref: 'X' } as unknown as string, false);
    expectWithheld(failed.warn, 'aws ecs delete-service');
  });

  it('a NON-string Cluster withholds the commands instead of dropping --cluster', async () => {
    const { thrown, warn } = await waitFailure({ Ref: 'X' } as unknown as string, true);
    expectWithheld(warn, 'aws ecs list-tasks');
    expectWithheld(thrown, 'aws ecs');
  });

  it('the steady-state failure commands are withheld for a cluster carrying a control byte', async () => {
    const ok = await waitFailure(`c${FORGED_CTRL}`, true);
    expectWithheld(ok.warn, 'aws ecs list-tasks');
    expectWithheld(ok.thrown, 'aws ecs');

    warnSpy.mockReset();
    const failed = await waitFailure(`c${FORGED_CTRL}`, false);
    expectWithheld(failed.warn, 'aws ecs delete-service');
  });
});
