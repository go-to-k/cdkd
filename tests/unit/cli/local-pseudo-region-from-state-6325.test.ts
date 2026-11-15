/**
 * go-to-k/cdkd#6325: an environment-agnostic stack has no synth region, and
 * with no `--region` / `AWS_REGION` / `AWS_DEFAULT_REGION` (the region lives
 * only in the AWS profile) `local invoke` and `local run-task` built their
 * pseudo-parameter bag with no region. Every env value needing
 * `${AWS::Region}`, `${AWS::Partition}` or `${AWS::URLSuffix}` was dropped,
 * although the state record that resolved the same env's `Ref`s names the
 * region the stack was deployed to. `local start-api` already used it.
 *
 * The provider is a fake standing for `--from-state`; the substitution and the
 * env resolver run unmocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('cdk-local/internal', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  takeAwsEmulatorStateSourceHint: () => undefined,
}));
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
import { buildEcsImageResolutionContext } from '../../../src/cli/commands/local-run-task/image-context.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

const ENV = {
  BUCKET: { Ref: 'B' },
  R: { Ref: 'AWS::Region' },
  ARN: { 'Fn::Sub': ['arn:${AWS::Partition}:s3:::${X}', { X: { Ref: 'B' } }] },
  HOST: { 'Fn::Sub': 's3.${AWS::URLSuffix}' },
};

function stack(region: string | undefined, resources: Record<string, unknown>): StackInfo {
  return {
    stackName: 'S',
    displayName: 'S',
    artifactId: 'S',
    region,
    dependencyNames: [],
    template: { Resources: resources },
  } as unknown as StackInfo;
}

const fnStack = (region: string | undefined) =>
  stack(region, {
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

const taskStack = (region: string | undefined) =>
  stack(region, {
    Task: {
      Type: 'AWS::ECS::TaskDefinition',
      Properties: {
        ContainerDefinitions: [
          {
            Name: 'app',
            Image: 'public.ecr.aws/docker/library/busybox:latest',
            Environment: [{ Name: 'R', Value: { Ref: 'AWS::Region' } }],
          },
        ],
      },
    },
  });

/** A `--from-state` provider whose record was deployed to `recordRegion`. */
function provider(recordRegion: string) {
  return {
    label: '--from-state',
    load: vi.fn(async () => ({
      region: recordRegion,
      outputs: {},
      resources: { B: { physicalId: 'my-bucket', resourceType: 'AWS::S3::Bucket', attributes: {} } },
    })),
    buildCrossStackResolver: vi.fn(async () => undefined),
    dispose: vi.fn(),
  };
}

const REGION_VARS = ['AWS_REGION', 'AWS_DEFAULT_REGION'] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(REGION_VARS.map((k) => [k, process.env[k]]));
  for (const k of REGION_VARS) delete process.env[k];
});
afterEach(() => {
  for (const k of REGION_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  stateSource.createLocalStateProvider.mockReset();
});

describe('local invoke --from-state: an env-agnostic stack takes the state record region (#6325)', () => {
  const invoke = (stackRegion: string | undefined) => {
    const s = fnStack(stackRegion);
    return resolveInvokeTemplateEnv(
      { logicalId: 'Fn', resource: s.template.Resources!['Fn'], stack: s } as never,
      { fromState: true, statePrefix: 'cdkd' } as never
    );
  };

  it('resolves AWS::Region / Partition / URLSuffix from the record region', async () => {
    stateSource.createLocalStateProvider.mockReturnValue(provider('eu-west-1'));
    expect((await invoke(undefined)).env).toEqual({
      BUCKET: 'my-bucket',
      R: 'eu-west-1',
      ARN: 'arn:aws:s3:::my-bucket',
      HOST: 's3.amazonaws.com',
    });
  });

  it('derives the partition and suffix from that region too', async () => {
    stateSource.createLocalStateProvider.mockReturnValue(provider('cn-north-1'));
    expect((await invoke(undefined)).env).toMatchObject({
      R: 'cn-north-1',
      ARN: 'arn:aws-cn:s3:::my-bucket',
      HOST: 's3.amazonaws.com.cn',
    });
  });

  it('a region the user named, or the stack declares, still outranks the record', async () => {
    stateSource.createLocalStateProvider.mockReturnValue(provider('eu-west-1'));
    expect((await invoke('us-west-2')).env['R']).toBe('us-west-2');
    process.env['AWS_REGION'] = 'ap-northeast-1';
    expect((await invoke(undefined)).env['R']).toBe('ap-northeast-1');
  });
});

describe('local run-task --from-state: an env-agnostic stack takes the state record region (#6325)', () => {
  it('the image context pseudo parameters carry the record region', async () => {
    const { context, stateRecordRegion } = await buildEcsImageResolutionContext(
      taskStack(undefined),
      provider('cn-north-1') as never,
      { fromState: true } as never
    );
    expect(stateRecordRegion).toBe('cn-north-1');
    expect(context?.pseudoParameters).toMatchObject({
      region: 'cn-north-1',
      partition: 'aws-cn',
      urlSuffix: 'amazonaws.com.cn',
    });
  });

  it('a stack region still outranks the record', async () => {
    const { context } = await buildEcsImageResolutionContext(
      taskStack('us-west-2'),
      provider('eu-west-1') as never,
      { fromState: true } as never
    );
    expect(context?.pseudoParameters?.region).toBe('us-west-2');
  });
});
