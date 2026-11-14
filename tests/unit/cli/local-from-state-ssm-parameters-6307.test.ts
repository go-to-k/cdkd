/**
 * go-to-k/cdkd#6307: every cdkd-owned `local` command puts a state provider's
 * SSM-typed template parameter values into its substitution context, so an env
 * var that `Ref`s one (`ssm.StringParameter.valueForStringParameter`) gets the
 * value instead of being dropped. `local invoke` and `local start-api` built
 * their context without `parameters`, and `local run-task` mapped none from
 * its image context; `local invoke-agentcore` already did (image.ts).
 *
 * The provider is a fake standing for `--from-state`; the substitution, the
 * env resolver and cdk-local's helpers run unmocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const h = vi.hoisted(() => ({
  smSend: vi.fn(),
  ssmSend: vi.fn(),
  destroy: vi.fn(),
  profiles: [] as Array<string | undefined>,
  workloads: [] as unknown[],
}));

vi.mock('cdk-local/internal', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  takeAwsEmulatorStateSourceHint: () => undefined,
}));
vi.mock('../../../src/local/dynamic-reference.js', async () =>
  (await import('../_caller-resolver-double.js')).callerResolverModule(h)
);
// An intrinsic env asks STS for `${AWS::AccountId}`.
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
import {
  buildContainerSpec,
  loadStateForRoutedStacks,
} from '../../../src/cli/commands/local-start-api.js';
import { buildEcsImageResolutionContext } from '../../../src/cli/commands/local-run-task/image-context.js';
import { buildSubstitutionContextFromImageContext } from '../../../src/local/ecs-task-resolver/container.js';
import { resolveEcsTaskTarget } from '../../../src/local/ecs-task-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';

const PARAM = 'SsmParameterValueappparamParameter';
const VALUE = 'value-6307';
const ENV = { PARAM_VALUE: { Ref: PARAM }, GREETING: 'hi' };

function fnResource(env: Record<string, unknown>) {
  return {
    Type: 'AWS::Lambda::Function',
    Properties: {
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Code: { ZipFile: 'exports.handler = async () => ({});' },
      Environment: { Variables: env },
    },
    Metadata: { 'aws:cdk:path': 'S/Fn/Resource' },
  };
}

function stack(): StackInfo {
  return {
    stackName: 'S',
    displayName: 'S',
    artifactId: 'S',
    region: 'us-east-1',
    dependencyNames: [],
    template: {
      Parameters: { [PARAM]: { Type: 'AWS::SSM::Parameter::Value<String>', Default: '/app/param' } },
      Resources: { Fn: fnResource(ENV) },
    },
  } as unknown as StackInfo;
}

/** A `--from-state` provider; `ssm: false` stands for one that cannot read SSM (the pre-fix S3 provider). */
function provider(ssm = true) {
  const resolveTemplateSsmParameters = vi.fn(async () => ({
    values: { [PARAM]: VALUE },
    secureStringLogicalIds: [] as string[],
  }));
  return {
    label: '--from-state',
    load: vi.fn(async () => ({ region: 'us-east-1', outputs: {}, resources: {} })),
    buildCrossStackResolver: vi.fn(async () => undefined),
    dispose: vi.fn(),
    ...(ssm && { resolveTemplateSsmParameters }),
  };
}

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'cdkd-6307-'));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  stateSource.createLocalStateProvider.mockReset();
});

describe('local invoke --from-state (#6307)', () => {
  const invoke = () => {
    const s = stack();
    return resolveInvokeTemplateEnv(
      { logicalId: 'Fn', resource: s.template.Resources!['Fn'], stack: s } as never,
      { fromState: true, statePrefix: 'cdkd' } as never
    );
  };

  it('a Ref to an SSM-typed parameter gets its value', async () => {
    const p = provider();
    stateSource.createLocalStateProvider.mockReturnValue(p);
    const out = await invoke();
    expect(out.env).toEqual({ PARAM_VALUE: VALUE, GREETING: 'hi' });
    expect(p.resolveTemplateSsmParameters).toHaveBeenCalledWith(stack().template);
  });

  it('control: a provider that reads no SSM still drops it', async () => {
    stateSource.createLocalStateProvider.mockReturnValue(provider(false));
    expect((await invoke()).env).toEqual({ GREETING: 'hi' });
  });
});

describe('local start-api --from-state (#6307)', () => {
  const route = { lambdaLogicalId: 'Fn', apiStackName: 'S' } as unknown as DiscoveredRoute;

  it('the stack bundle carries the values, and the container spec substitutes them', async () => {
    stateSource.createLocalStateProvider.mockReturnValue(provider());
    const bundles = await loadStateForRoutedStacks([stack()], [route], [], {
      fromState: true,
    } as never);
    expect(bundles.get('S')?.parameters).toEqual({ [PARAM]: VALUE });

    const spec = await buildContainerSpec({
      logicalId: 'Fn',
      stacks: [stack()],
      overrides: undefined,
      assumeRole: undefined,
      containerHost: '127.0.0.1',
      stsRegion: undefined,
      inlineTmpDirs: new Set([workDir]),
      layerTmpDirs: new Set(),
      stateByStack: bundles,
      skipPull: true,
    });
    expect(spec.env['PARAM_VALUE']).toBe(VALUE);
  });

  it('control: a provider that reads no SSM leaves the bundle without values', async () => {
    stateSource.createLocalStateProvider.mockReturnValue(provider(false));
    const bundles = await loadStateForRoutedStacks([stack()], [route], [], {
      fromState: true,
    } as never);
    expect(bundles.get('S')?.parameters).toBeUndefined();
  });
});

describe('local run-task --from-state (#6307)', () => {
  const taskStack = () =>
    ({
      ...stack(),
      template: {
        Parameters: stack().template.Parameters,
        Resources: {
          Task: {
            Type: 'AWS::ECS::TaskDefinition',
            Properties: {
              ContainerDefinitions: [
                {
                  Name: 'app',
                  Image: 'public.ecr.aws/docker/library/busybox:latest',
                  Environment: [{ Name: 'PARAM_VALUE', Value: { Ref: PARAM } }],
                },
              ],
            },
          },
        },
      },
    }) as unknown as StackInfo;

  it('the image context carries the values, and the substitution context maps them', async () => {
    const p = provider();
    const { context } = await buildEcsImageResolutionContext(taskStack(), p as never, {
      fromState: true,
    } as never);
    expect(context?.stateParameters).toEqual({ [PARAM]: VALUE });
    expect(buildSubstitutionContextFromImageContext(context)?.parameters).toEqual({
      [PARAM]: VALUE,
    });
  });

  it('an image context with no intrinsic env reads no SSM (as cdk-local gates it)', async () => {
    const p = provider();
    const s = taskStack();
    const task = s.template.Resources!['Task'] as { Properties: { ContainerDefinitions: object[] } };
    // The state record IS loaded (a same-stack ECR image), but no env needs it.
    s.template.Resources!['Repo'] = { Type: 'AWS::ECR::Repository', Properties: {} };
    task.Properties.ContainerDefinitions = [
      {
        Name: 'app',
        Image: { 'Fn::Join': ['', [{ 'Fn::GetAtt': ['Repo', 'RepositoryUri'] }, ':latest']] },
      },
    ];
    await buildEcsImageResolutionContext(s, p as never, { fromState: true } as never);
    expect(p.load).toHaveBeenCalled();
    expect(p.resolveTemplateSsmParameters).not.toHaveBeenCalled();
  });

  it('a SecureString value is a plaintext key of its container (value-less -e KEY); a String one is not', () => {
    const s = taskStack();
    const task = s.template.Resources!['Task'] as { Properties: { ContainerDefinitions: object[] } };
    task.Properties.ContainerDefinitions = [
      {
        Name: 'app',
        Image: 'public.ecr.aws/docker/library/busybox:latest',
        Environment: [
          { Name: 'SECRET_VALUE', Value: { Ref: PARAM } },
          { Name: 'PLAIN_VALUE', Value: { Ref: 'Plain' } },
        ],
      },
    ];
    const resolved = resolveEcsTaskTarget('S:Task', [s], {
      stateResources: {},
      stateParameters: { [PARAM]: 's3cret', Plain: 'plain' },
      stateSensitiveParameters: [PARAM],
    });
    const app = resolved.containers[0]!;
    expect(app.environment).toEqual({ SECRET_VALUE: 's3cret', PLAIN_VALUE: 'plain' });
    expect(app.resolvedDynamicReferenceKeys).toEqual(['SECRET_VALUE']);
  });

  it('a SecureString parameter is marked sensitive on the substitution context', () => {
    const sub = buildSubstitutionContextFromImageContext({
      stateResources: {},
      stateParameters: { [PARAM]: 's3cret' },
      stateSensitiveParameters: [PARAM],
    });
    expect([...(sub?.sensitiveParameters ?? [])]).toEqual([PARAM]);
  });
});
