import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { setActiveWorkloadAwsWiring, setAwsEmulatorServiceRouting } from 'cdk-local/internal';
import {
  buildEcsImageResolutionContext,
  taskRoleRecordIsEmulatorSide,
} from '../../../src/cli/commands/local-run-task/image-context.js';
import { resolveEcsTaskTarget } from '../../../src/local/ecs-task-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/**
 * go-to-k/cdkd#6189 in AWS Emulator mixed mode: the task role is assumed in
 * real AWS, so the state record's role is used only when its IAM resources are
 * real AWS's too (IAM excepted under `Parameters`).
 */

const EMULATOR_URL = 'https://127.0.0.1:9297';

function mixedWiring(realServices: string[]): Parameters<typeof setActiveWorkloadAwsWiring>[0] {
  // The routing cdk-local consults per service; activation installs it beside the wiring.
  setAwsEmulatorServiceRouting({
    realServices,
    override: { endpoint: EMULATOR_URL },
    envOverrides: undefined,
  } as unknown as Parameters<typeof setAwsEmulatorServiceRouting>[0]);
  return {
    mode: 'forward',
    env: { AWS_ENDPOINT_URL: 'https://127.0.0.1:47297' },
    scrubEnvKeys: [],
    mounts: [],
    loopbackPorts: [9297, 47297],
    probeHealth: true,
    mixed: {
      realServices,
      emulatorEndpoint: { url: EMULATOR_URL, hostname: '127.0.0.1', port: 9297, loopback: true },
      resignPort: 47297,
      resignEndpoint: 'https://127.0.0.1:47297',
      emulatorCredentials: { accessKeyId: 'emulator-key', secretAccessKey: 'emulator-secret' },
      region: 'us-east-1',
      resignConfigHostPath: '/tmp/cdkd-unit-resign/resign.json',
      emulatorClientOverride: {
        endpoint: EMULATOR_URL,
        credentials: { accessKeyId: 'emulator-key', secretAccessKey: 'emulator-secret' },
      },
    },
    dispose: () => {},
  } as unknown as Parameters<typeof setActiveWorkloadAwsWiring>[0];
}

const STACK: StackInfo = {
  stackName: 'Cdkd6189Stack',
  displayName: 'Cdkd6189Stack',
  artifactId: 'Cdkd6189Stack',
  region: 'us-east-1',
  dependencyNames: [],
  template: {
    Resources: {
      TaskRole30FC0FBB: {
        Type: 'AWS::IAM::Role',
        Properties: { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] } },
      },
      TaskDef: {
        Type: 'AWS::ECS::TaskDefinition',
        Properties: {
          TaskRoleArn: { 'Fn::GetAtt': ['TaskRole30FC0FBB', 'Arn'] },
          ContainerDefinitions: [
            {
              Name: 'app',
              Image: 'public.ecr.aws/nginx/nginx:alpine',
              // An env intrinsic: state is loaded for it whatever the role does.
              Environment: [{ Name: 'ROLE', Value: { Ref: 'TaskRole30FC0FBB' } }],
            },
          ],
        },
      },
    },
  },
} as unknown as StackInfo;

const EMULATOR_ARN = 'arn:aws:iam::000000000000:role/Cdkd6189Stack-TaskRole30FC0FBB-emu';

function provider() {
  return {
    load: vi.fn().mockResolvedValue({
      region: 'us-east-1',
      resources: {
        TaskRole30FC0FBB: {
          physicalId: 'Cdkd6189Stack-TaskRole30FC0FBB-emu',
          resourceType: 'AWS::IAM::Role',
          properties: {},
          attributes: { Arn: EMULATOR_ARN },
          dependencies: [],
        },
      },
    }),
    buildCrossStackResolver: vi.fn(),
    dispose: vi.fn(),
  };
}

afterEach(() => {
  setActiveWorkloadAwsWiring(undefined);
  setAwsEmulatorServiceRouting(undefined);
});

describe('bare --assume-task-role in AWS Emulator mixed mode (go-to-k/cdkd#6189)', () => {
  it('IAM on the emulator: the record is not used for the role, and the fallback says why', async () => {
    setActiveWorkloadAwsWiring(mixedWiring(['STS']));
    expect(taskRoleRecordIsEmulatorSide()).toBe(true);
    const { context } = await buildEcsImageResolutionContext(STACK, provider() as never, {
      assumeTaskRole: true,
    } as never);
    // State is still loaded for the env intrinsic...
    expect(context?.stateResources).toBeDefined();
    // ...but the role keeps the placeholder rather than the emulator's ARN.
    const task = resolveEcsTaskTarget('Cdkd6189Stack:TaskDef', [STACK], context);
    expect(task.taskRoleArn).not.toBe(EMULATOR_ARN);
    expect(task.taskRoleUnresolved).toEqual({ logicalId: 'TaskRole30FC0FBB', reason: 'no-state' });
  });

  it('IAM excepted under Parameters: the record names the role', async () => {
    setActiveWorkloadAwsWiring(mixedWiring(['STS', 'IAM']));
    expect(taskRoleRecordIsEmulatorSide()).toBe(false);
    const { context } = await buildEcsImageResolutionContext(STACK, provider() as never, {
      assumeTaskRole: true,
    } as never);
    const task = resolveEcsTaskTarget('Cdkd6189Stack:TaskDef', [STACK], context);
    expect(task.taskRoleArn).toBe(EMULATOR_ARN);
    expect(task.taskRoleUnresolved).toBeUndefined();
  });

  it('outside mixed mode the record is always the right side', () => {
    expect(taskRoleRecordIsEmulatorSide()).toBe(false);
  });
});
