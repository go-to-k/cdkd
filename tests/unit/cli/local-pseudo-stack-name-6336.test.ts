/**
 * go-to-k/cdkd#6336: cdk-local 0.168.1 resolves `Ref: AWS::StackName` and
 * `${AWS::StackName}` from a `stackName` field of the pseudo-parameter bag
 * (go-to-k/cdk-local#979). cdkd's own `local` commands build their own bags, so
 * each builder fills the field: the deployed name of the stack that owns the
 * value, an explicit `--from-cfn-stack <name>` when given.
 *
 * The provider is a fake standing for the state source; the substitution, the
 * env resolver and cdk-local's helpers run unmocked.
 */
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('cdk-local/internal', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  takeAwsEmulatorStateSourceHint: () => undefined,
}));
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(() => ({
    send: async () => ({ Account: '111111111111' }),
    destroy: () => undefined,
  })),
  GetCallerIdentityCommand: vi.fn((input: unknown) => ({ input })),
}));
const stateSource = vi.hoisted(() => ({ createLocalStateProvider: vi.fn() }));
vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLocalStateProvider: stateSource.createLocalStateProvider,
}));

import { resolveInvokeTemplateEnv } from '../../../src/cli/commands/local-invoke/command.js';
import { loadStateForRoutedStacks } from '../../../src/cli/commands/local-start-api.js';
import { buildEcsImageResolutionContext } from '../../../src/cli/commands/local-run-task/image-context.js';
import {
  buildAgentCoreImageContext,
  resolveFromS3BucketIntrinsic,
} from '../../../src/cli/commands/local-invoke-agentcore.js';
import { withDeployedStackName } from '../../../src/cli/commands/local-state-source.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';

const ENV = {
  STACK: { Ref: 'AWS::StackName' },
  SUB: { 'Fn::Sub': '${AWS::StackName}-sub' },
};

function stack(resources: Record<string, unknown>): StackInfo {
  return {
    stackName: 'S',
    displayName: 'S',
    artifactId: 'S',
    region: 'us-east-1',
    dependencyNames: [],
    template: { Resources: resources },
  } as unknown as StackInfo;
}

const fnStack = () =>
  stack({
    Fn: {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Code: { ZipFile: 'exports.handler = async () => ({});' },
        Environment: { Variables: ENV },
      },
      Metadata: { 'aws:cdk:path': 'S/Fn/Resource' },
    },
  });

const taskStack = () =>
  stack({
    Task: {
      Type: 'AWS::ECS::TaskDefinition',
      Properties: {
        ContainerDefinitions: [
          {
            Name: 'app',
            Image: 'public.ecr.aws/docker/library/busybox:latest',
            Environment: [{ Name: 'STACK', Value: { Ref: 'AWS::StackName' } }],
          },
        ],
      },
    },
  });

function provider() {
  return {
    label: '--from-state',
    load: vi.fn(async () => ({ region: 'us-east-1', outputs: {}, resources: {} })),
    buildCrossStackResolver: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
}

afterEach(() => {
  stateSource.createLocalStateProvider.mockReset();
});

describe('withDeployedStackName (#6336)', () => {
  it('keeps the bag and adds the stack name; an explicit --from-cfn-stack name wins', () => {
    expect(withDeployedStackName({ region: 'us-east-1' }, {}, 'S')).toEqual({
      region: 'us-east-1',
      stackName: 'S',
    });
    expect(withDeployedStackName(undefined, { fromCfnStack: true }, 'S')).toEqual({
      stackName: 'S',
    });
    expect(withDeployedStackName(undefined, { fromCfnStack: 'Deployed' }, 'S')).toEqual({
      stackName: 'Deployed',
    });
  });
});

describe('local invoke (#6336)', () => {
  const invoke = (options: Record<string, unknown>) => {
    const s = fnStack();
    return resolveInvokeTemplateEnv(
      { logicalId: 'Fn', resource: s.template.Resources!['Fn'], stack: s } as never,
      { statePrefix: 'cdkd', ...options } as never
    );
  };

  it('Ref AWS::StackName and ${AWS::StackName} resolve to the stack name', async () => {
    stateSource.createLocalStateProvider.mockReturnValue(provider());
    expect((await invoke({ fromState: true })).env).toEqual({ STACK: 'S', SUB: 'S-sub' });
  });

  it('an explicit --from-cfn-stack name is the deployed name', async () => {
    stateSource.createLocalStateProvider.mockReturnValue(provider());
    expect((await invoke({ fromCfnStack: 'Deployed' })).env).toEqual({
      STACK: 'Deployed',
      SUB: 'Deployed-sub',
    });
  });
});

describe('local start-api (#6336)', () => {
  it("the stack bundle's pseudo parameters carry the stack name", async () => {
    stateSource.createLocalStateProvider.mockReturnValue(provider());
    const route = { lambdaLogicalId: 'Fn', apiStackName: 'S' } as unknown as DiscoveredRoute;
    const bundles = await loadStateForRoutedStacks([fnStack()], [route], [], {
      fromState: true,
    } as never);
    expect(bundles.get('S')?.pseudoParameters?.stackName).toBe('S');
  });
});

describe('local run-task (#6336)', () => {
  it('the image context pseudo parameters carry the stack name', async () => {
    const { context } = await buildEcsImageResolutionContext(taskStack(), provider() as never, {
      fromCfnStack: 'Deployed',
    } as never);
    expect(context?.pseudoParameters?.stackName).toBe('Deployed');
  });
});

describe('local invoke-agentcore (#6336)', () => {
  it('the image context pseudo parameters carry the stack name', async () => {
    const { context } = await buildAgentCoreImageContext(stack({}), provider() as never, {
      fromState: true,
    } as never);
    expect(context?.pseudoParameters?.stackName).toBe('S');
  });

  it('the fromS3 bucket fallback bag carries the deployed name', async () => {
    const resolved = {
      logicalId: 'Rt',
      stack: stack({}),
      codeArtifact: { s3Source: { bucketIntrinsic: { 'Fn::Sub': '${AWS::StackName}-code' } } },
    };
    await resolveFromS3BucketIntrinsic(
      resolved as never,
      provider() as never,
      { region: 'us-east-1', outputs: {}, resources: {} } as never,
      undefined,
      { fromCfnStack: 'Deployed' }
    );
    expect(resolved.codeArtifact.s3Source).toMatchObject({ bucket: 'Deployed-code' });
  });
});
