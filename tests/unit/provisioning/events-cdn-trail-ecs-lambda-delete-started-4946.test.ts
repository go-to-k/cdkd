import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DeleteEventBusCommand,
  DeleteRuleCommand,
  ListRulesCommand,
  ListTargetsByRuleCommand,
  RemoveTargetsCommand,
} from '@aws-sdk/client-eventbridge';
import {
  DeleteDistributionCommand,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import { DeleteTrailCommand, StopLoggingCommand } from '@aws-sdk/client-cloudtrail';
import { DeleteServiceCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import {
  DeleteFunctionCommand,
  GetFunctionCommand,
  UpdateFunctionConfigurationCommand,
} from '@aws-sdk/client-lambda';

// go-to-k/cdkd#4946: a delete that had already stripped the resource before
// its terminal call was refused by name throws a MARKED error, which the
// replacement path reads as 'unconfirmed' (never re-adopted). A refusal
// before any strip stays unmarked and reads 'kept'.

const mockEventBridgeSend = vi.fn();
const mockCloudFrontSend = vi.fn();
const mockLambdaSend = vi.fn();
const mockEc2Send = vi.fn();
const mockCloudTrailSend = vi.fn();
const mockEcsSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    eventBridge: {
      send: mockEventBridgeSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    cloudFront: {
      send: mockCloudFrontSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    lambda: { send: mockLambdaSend, config: { region: () => Promise.resolve('us-east-1') } },
    ec2: { send: mockEc2Send },
  }),
}));

// CloudTrail and ECS build their OWN clients, so the SDK packages are mocked.
vi.mock('@aws-sdk/client-cloudtrail', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-cloudtrail')>(
    '@aws-sdk/client-cloudtrail'
  );
  return {
    ...actual,
    CloudTrailClient: vi.fn().mockImplementation(() => ({
      send: mockCloudTrailSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-ecs', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ecs')>('@aws-sdk/client-ecs');
  return {
    ...actual,
    ECSClient: vi.fn().mockImplementation(() => ({
      send: mockEcsSend,
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

import { EventBridgeRuleProvider } from '../../../src/provisioning/providers/eventbridge-rule-provider.js';
import { EventBridgeBusProvider } from '../../../src/provisioning/providers/eventbridge-bus-provider.js';
import { CloudFrontDistributionProvider } from '../../../src/provisioning/providers/cloudfront-distribution-provider.js';
import { CloudTrailProvider } from '../../../src/provisioning/providers/cloudtrail-provider.js';
import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';
import { LambdaFunctionProvider } from '../../../src/provisioning/providers/lambda-function-provider.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';
import { replacedDeleteFailureVerdict } from '../../../src/deployment/rollback-executor/replaced-survivor.js';

/** An AWS-shaped error carrying a real `name`, as the SDK throws it. */
function awsError(name: string, message = `${name} raised`): Error {
  return Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected delete() to throw');
}

function expectMarked(err: unknown): void {
  expect(err).toBeInstanceOf(Error);
  expect(isDeleteStarted(err)).toBe(true);
  expect(replacedDeleteFailureVerdict(err)).toBe('unconfirmed');
}

function expectUnmarked(err: unknown): void {
  expect(err).toBeInstanceOf(Error);
  expect(isDeleteStarted(err)).toBe(false);
  // The named refusal is still on the cause chain, so it reads 'kept'.
  expect(replacedDeleteFailureVerdict(err)).toBe('kept');
}

function sentTypes(mock: ReturnType<typeof vi.fn>): unknown[] {
  return mock.mock.calls.map((c) => (c[0] as object).constructor);
}

beforeEach(() => {
  for (const m of [
    mockEventBridgeSend,
    mockCloudFrontSend,
    mockLambdaSend,
    mockEc2Send,
    mockCloudTrailSend,
    mockEcsSend,
  ]) {
    m.mockReset();
  }
  delete process.env['CDKD_FULL_WAIT'];
  delete process.env['CDKD_WAIT_FLAGS_AVAILABLE'];
});

describe('EventBridgeRuleProvider.delete stripped mark (#4946)', () => {
  const RULE_ARN = 'arn:aws:events:us-east-1:123456789012:rule/my-rule';

  it('marks a refused DeleteRule after RemoveTargets landed', async () => {
    mockEventBridgeSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof ListTargetsByRuleCommand) return { Targets: [{ Id: 't1' }] };
      if (cmd instanceof RemoveTargetsCommand) return { FailedEntryCount: 0 };
      if (cmd instanceof DeleteRuleCommand) throw awsError('AccessDeniedException');
      return {};
    });
    const err = await caught(
      new EventBridgeRuleProvider().delete('Rule', RULE_ARN, 'AWS::Events::Rule')
    );
    expect(sentTypes(mockEventBridgeSend)).toContain(RemoveTargetsCommand);
    expectMarked(err);
  });

  it('leaves a refused DeleteRule unmarked when the rule had no targets', async () => {
    mockEventBridgeSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof ListTargetsByRuleCommand) return { Targets: [] };
      if (cmd instanceof DeleteRuleCommand) throw awsError('AccessDeniedException');
      return {};
    });
    const err = await caught(
      new EventBridgeRuleProvider().delete('Rule', RULE_ARN, 'AWS::Events::Rule')
    );
    expect(sentTypes(mockEventBridgeSend)).not.toContain(RemoveTargetsCommand);
    expect(sentTypes(mockEventBridgeSend)).toContain(DeleteRuleCommand);
    expectUnmarked(err);
  });

  it('leaves a refused RemoveTargets unmarked (nothing was stripped)', async () => {
    mockEventBridgeSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof ListTargetsByRuleCommand) return { Targets: [{ Id: 't1' }] };
      if (cmd instanceof RemoveTargetsCommand) throw awsError('AccessDeniedException');
      return {};
    });
    const err = await caught(
      new EventBridgeRuleProvider().delete('Rule', RULE_ARN, 'AWS::Events::Rule')
    );
    expect(sentTypes(mockEventBridgeSend)).not.toContain(DeleteRuleCommand);
    expectUnmarked(err);
  });
});

describe('EventBridgeBusProvider.delete stripped mark (#4946)', () => {
  it('marks a refused DeleteEventBus after the rules on the bus were removed', async () => {
    mockEventBridgeSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof ListRulesCommand) return { Rules: [{ Name: 'r1' }] };
      if (cmd instanceof ListTargetsByRuleCommand) return { Targets: [{ Id: 't1' }] };
      if (cmd instanceof DeleteEventBusCommand) throw awsError('AccessDeniedException');
      return {};
    });
    const err = await caught(
      new EventBridgeBusProvider().delete('Bus', 'my-bus', 'AWS::Events::EventBus')
    );
    expect(sentTypes(mockEventBridgeSend)).toContain(RemoveTargetsCommand);
    expect(sentTypes(mockEventBridgeSend)).toContain(DeleteRuleCommand);
    expectMarked(err);
  });

  it('leaves a refused DeleteEventBus unmarked when the bus had no rules', async () => {
    mockEventBridgeSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof ListRulesCommand) return { Rules: [] };
      if (cmd instanceof DeleteEventBusCommand) throw awsError('AccessDeniedException');
      return {};
    });
    const err = await caught(
      new EventBridgeBusProvider().delete('Bus', 'my-bus', 'AWS::Events::EventBus')
    );
    expect(sentTypes(mockEventBridgeSend)).not.toContain(DeleteRuleCommand);
    expect(sentTypes(mockEventBridgeSend)).toContain(DeleteEventBusCommand);
    expectUnmarked(err);
  });

  it('leaves a refused DeleteEventBus unmarked when ListRules itself was refused', async () => {
    mockEventBridgeSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof ListRulesCommand) throw awsError('AccessDeniedException');
      if (cmd instanceof DeleteEventBusCommand) throw awsError('AccessDeniedException');
      return {};
    });
    const err = await caught(
      new EventBridgeBusProvider().delete('Bus', 'my-bus', 'AWS::Events::EventBus')
    );
    expect(sentTypes(mockEventBridgeSend)).toContain(DeleteEventBusCommand);
    expectUnmarked(err);
  });
});

describe('CloudFrontDistributionProvider.delete stripped mark (#4946)', () => {
  const DIST_ID = 'EDFDVBD6EXAMPLE';

  function cloudFrontMock(opts: { enabled: boolean; refuseUpdate?: boolean }): void {
    let enabled = opts.enabled;
    mockCloudFrontSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetDistributionConfigCommand) {
        return { ETag: 'E1', DistributionConfig: { CallerReference: 'ref', Enabled: enabled } };
      }
      if (cmd instanceof UpdateDistributionCommand) {
        if (opts.refuseUpdate === true) throw awsError('AccessDenied');
        enabled = false;
        return { ETag: 'E2' };
      }
      if (cmd instanceof GetDistributionCommand) {
        // Settled on the first poll, so the wait never sleeps.
        return {
          Distribution: { Id: DIST_ID, Status: 'Deployed', DistributionConfig: { Enabled: false } },
        };
      }
      if (cmd instanceof DeleteDistributionCommand) throw awsError('AccessDenied');
      return {};
    });
  }

  it('marks a refused DeleteDistribution after the disable was accepted', async () => {
    cloudFrontMock({ enabled: true });
    const err = await caught(
      new CloudFrontDistributionProvider().delete('Dist', DIST_ID, 'AWS::CloudFront::Distribution')
    );
    expect(sentTypes(mockCloudFrontSend)).toContain(UpdateDistributionCommand);
    expect(sentTypes(mockCloudFrontSend)).toContain(DeleteDistributionCommand);
    expectMarked(err);
  });

  it('leaves a refused DeleteDistribution unmarked when the distribution was already disabled', async () => {
    cloudFrontMock({ enabled: false });
    const err = await caught(
      new CloudFrontDistributionProvider().delete('Dist', DIST_ID, 'AWS::CloudFront::Distribution')
    );
    expect(sentTypes(mockCloudFrontSend)).not.toContain(UpdateDistributionCommand);
    expect(sentTypes(mockCloudFrontSend)).toContain(DeleteDistributionCommand);
    expectUnmarked(err);
  });

  it('leaves a refused disable unmarked (nothing was stripped)', async () => {
    cloudFrontMock({ enabled: true, refuseUpdate: true });
    const err = await caught(
      new CloudFrontDistributionProvider().delete('Dist', DIST_ID, 'AWS::CloudFront::Distribution')
    );
    expect(sentTypes(mockCloudFrontSend)).not.toContain(DeleteDistributionCommand);
    expectUnmarked(err);
  });
});

describe('CloudTrailProvider.delete stripped mark (#4946)', () => {
  const TRAIL_ARN = 'arn:aws:cloudtrail:us-east-1:123456789012:trail/my-trail';

  function cloudTrailMock(stopLogging: () => unknown): void {
    mockCloudTrailSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof StopLoggingCommand) return stopLogging();
      if (cmd instanceof DeleteTrailCommand) throw awsError('AccessDeniedException');
      return {};
    });
  }

  it('marks a refused DeleteTrail after StopLogging landed', async () => {
    cloudTrailMock(() => ({}));
    const err = await caught(
      new CloudTrailProvider().delete('Trail', TRAIL_ARN, 'AWS::CloudTrail::Trail')
    );
    expect(sentTypes(mockCloudTrailSend)).toEqual([StopLoggingCommand, DeleteTrailCommand]);
    expectMarked(err);
  });

  it('leaves a refused DeleteTrail unmarked when StopLogging was refused by name (swallowed)', async () => {
    cloudTrailMock(() => {
      throw awsError('AccessDeniedException');
    });
    const err = await caught(
      new CloudTrailProvider().delete('Trail', TRAIL_ARN, 'AWS::CloudTrail::Trail')
    );
    expect(sentTypes(mockCloudTrailSend)).toEqual([StopLoggingCommand, DeleteTrailCommand]);
    expectUnmarked(err);
  });

  it('marks a refused DeleteTrail when StopLogging failed without a refusal name (may have landed)', async () => {
    cloudTrailMock(() => {
      throw awsError('TimeoutError', 'socket timed out');
    });
    const err = await caught(
      new CloudTrailProvider().delete('Trail', TRAIL_ARN, 'AWS::CloudTrail::Trail')
    );
    expect(sentTypes(mockCloudTrailSend)).toEqual([StopLoggingCommand, DeleteTrailCommand]);
    expectMarked(err);
  });

  it('leaves it unmarked when the record already says the trail is not logging', async () => {
    cloudTrailMock(() => ({}));
    for (const IsLogging of [false, 'false']) {
      const err = await caught(
        new CloudTrailProvider().delete('Trail', TRAIL_ARN, 'AWS::CloudTrail::Trail', {
          IsLogging,
        })
      );
      expectUnmarked(err);
    }
    // A recorded `true` still counts the stop.
    expectMarked(
      await caught(
        new CloudTrailProvider().delete('Trail', TRAIL_ARN, 'AWS::CloudTrail::Trail', {
          IsLogging: true,
        })
      )
    );
  });

  it('marks a refused DeleteTrail when StopLogging threw a generic Error (may have landed)', async () => {
    cloudTrailMock(() => {
      throw new Error('connection reset');
    });
    const err = await caught(
      new CloudTrailProvider().delete('Trail', TRAIL_ARN, 'AWS::CloudTrail::Trail')
    );
    expectMarked(err);
  });
});

describe('ECSProvider.delete (Service) stripped mark (#4946)', () => {
  const SERVICE_ARN = 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service';

  it('marks a refused DeleteService after the scale-down to 0 was accepted', async () => {
    mockEcsSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof UpdateServiceCommand) return { service: { desiredCount: 0 } };
      if (cmd instanceof DeleteServiceCommand) throw awsError('AccessDeniedException');
      return {};
    });
    const err = await caught(
      new ECSProvider().delete('Svc', SERVICE_ARN, 'AWS::ECS::Service', { Cluster: 'my-cluster' })
    );
    expect(sentTypes(mockEcsSend)).toEqual([UpdateServiceCommand, DeleteServiceCommand]);
    expectMarked(err);
  });

  it('leaves it unmarked when the record already sets DesiredCount to 0', async () => {
    mockEcsSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof UpdateServiceCommand) return { service: { desiredCount: 0 } };
      if (cmd instanceof DeleteServiceCommand) throw awsError('AccessDeniedException');
      return {};
    });
    for (const DesiredCount of [0, '0']) {
      const err = await caught(
        new ECSProvider().delete('Svc', SERVICE_ARN, 'AWS::ECS::Service', {
          Cluster: 'my-cluster',
          DesiredCount,
        })
      );
      expectUnmarked(err);
    }
    expectMarked(
      await caught(
        new ECSProvider().delete('Svc', SERVICE_ARN, 'AWS::ECS::Service', {
          Cluster: 'my-cluster',
          DesiredCount: 2,
        })
      )
    );
  });

  it('leaves a refused scale-down unmarked (nothing was stripped)', async () => {
    mockEcsSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof UpdateServiceCommand) throw awsError('AccessDeniedException');
      return {};
    });
    const err = await caught(
      new ECSProvider().delete('Svc', SERVICE_ARN, 'AWS::ECS::Service', { Cluster: 'my-cluster' })
    );
    expect(sentTypes(mockEcsSend)).toEqual([UpdateServiceCommand]);
    expectUnmarked(err);
  });
});

describe('LambdaFunctionProvider.delete stripped mark (#4946)', () => {
  const VPC = { VpcConfig: { SubnetIds: ['subnet-aaa'], SecurityGroupIds: ['sg-1'] } };

  function lambdaMock(detach: () => unknown): void {
    mockLambdaSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof UpdateFunctionConfigurationCommand) return detach();
      if (cmd instanceof GetFunctionCommand) {
        // Settled on the first poll, so the wait never sleeps.
        return { Configuration: { LastUpdateStatus: 'Successful' } };
      }
      if (cmd instanceof DeleteFunctionCommand) throw awsError('AccessDeniedException');
      return {};
    });
  }

  it('marks a refused DeleteFunction after the VPC detach landed', async () => {
    lambdaMock(() => ({}));
    const err = await caught(
      new LambdaFunctionProvider().delete('Fn', 'fn-vpc', 'AWS::Lambda::Function', VPC)
    );
    expect(sentTypes(mockLambdaSend)).toContain(UpdateFunctionConfigurationCommand);
    expect(sentTypes(mockLambdaSend)).toContain(DeleteFunctionCommand);
    expectMarked(err);
  });

  it('leaves a refused DeleteFunction unmarked when the function has no VpcConfig', async () => {
    lambdaMock(() => ({}));
    const err = await caught(
      new LambdaFunctionProvider().delete('Fn', 'fn-no-vpc', 'AWS::Lambda::Function', {})
    );
    expect(sentTypes(mockLambdaSend)).toEqual([DeleteFunctionCommand]);
    expectUnmarked(err);
  });

  it('leaves a refused DeleteFunction unmarked when the VPC detach was refused by name (swallowed)', async () => {
    lambdaMock(() => {
      throw awsError('AccessDeniedException');
    });
    const err = await caught(
      new LambdaFunctionProvider().delete('Fn', 'fn-vpc', 'AWS::Lambda::Function', VPC)
    );
    expect(sentTypes(mockLambdaSend)).toContain(UpdateFunctionConfigurationCommand);
    expect(sentTypes(mockLambdaSend)).toContain(DeleteFunctionCommand);
    expectUnmarked(err);
  });

  it('marks a refused DeleteFunction when the VPC detach failed without a refusal name (may have landed)', async () => {
    lambdaMock(() => {
      throw awsError('TimeoutError', 'socket timed out');
    });
    const err = await caught(
      new LambdaFunctionProvider().delete('Fn', 'fn-vpc', 'AWS::Lambda::Function', VPC)
    );
    expect(sentTypes(mockLambdaSend)).toContain(DeleteFunctionCommand);
    expectMarked(err);
  });

  it('marks a refused DeleteFunction when the VPC detach threw a generic Error (may have landed)', async () => {
    lambdaMock(() => {
      throw new Error('connection reset');
    });
    const err = await caught(
      new LambdaFunctionProvider().delete('Fn', 'fn-vpc', 'AWS::Lambda::Function', VPC)
    );
    expectMarked(err);
  });
});
