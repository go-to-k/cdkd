import { describe, expect, it } from 'vitest';
import {
  derivePartitionAndUrlSuffix,
  detectEcsImageResolutionNeeds,
  EcsTaskResolutionError,
  parseEcsTarget,
  resolveEcsTaskTarget,
  TASK_ROLE_ACCOUNT_PLACEHOLDER,
} from '../../../src/local/ecs-task-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

function buildStack(name: string, resources: Record<string, TemplateResource>): StackInfo {
  const template: CloudFormationTemplate = { Resources: resources };
  return {
    stackName: name,
    displayName: name,
    artifactId: name,
    template,
    dependencyNames: [],
  };
}

function makeTaskDef(opts: {
  containerName?: string;
  image?: unknown;
  family?: string;
  networkMode?: string;
  containers?: unknown[];
  volumes?: unknown[];
  cdkPath?: string;
  runtimePlatform?: unknown;
  taskRoleArn?: unknown;
}): TemplateResource {
  const containers = opts.containers ?? [
    {
      Name: opts.containerName ?? 'app',
      Image: opts.image ?? 'public.ecr.aws/nginx/nginx:alpine',
      PortMappings: [{ ContainerPort: 80, Protocol: 'tcp' }],
    },
  ];
  const props: Record<string, unknown> = {
    Family: opts.family ?? 'fam',
    NetworkMode: opts.networkMode ?? 'bridge',
    ContainerDefinitions: containers,
  };
  if (opts.volumes !== undefined) props['Volumes'] = opts.volumes;
  if (opts.runtimePlatform !== undefined) props['RuntimePlatform'] = opts.runtimePlatform;
  if (opts.taskRoleArn !== undefined) props['TaskRoleArn'] = opts.taskRoleArn;
  const r: TemplateResource = {
    Type: 'AWS::ECS::TaskDefinition',
    Properties: props,
  };
  if (opts.cdkPath) r.Metadata = { 'aws:cdk:path': opts.cdkPath };
  return r;
}

describe('parseEcsTarget', () => {
  it('parses Stack:LogicalId form', () => {
    expect(parseEcsTarget('MyStack:TaskDef')).toEqual({
      stackPattern: 'MyStack',
      pathOrId: 'TaskDef',
      isPath: false,
    });
  });
  it('parses Stack/Path display form', () => {
    expect(parseEcsTarget('MyStack/MyService/TaskDef')).toEqual({
      stackPattern: 'MyStack',
      pathOrId: 'MyStack/MyService/TaskDef',
      isPath: true,
    });
  });
  it('treats bare logical id as auto-detect', () => {
    expect(parseEcsTarget('TaskDef')).toEqual({
      stackPattern: null,
      pathOrId: 'TaskDef',
      isPath: false,
    });
  });
  it('rejects empty', () => {
    expect(() => parseEcsTarget('')).toThrow(EcsTaskResolutionError);
  });
});

describe('resolveEcsTaskTarget', () => {
  it('single-stack auto-detect resolves a bare logical id', () => {
    const stack = buildStack('S1', { TD: makeTaskDef({}) });
    const r = resolveEcsTaskTarget('TD', [stack]);
    expect(r.taskDefinitionLogicalId).toBe('TD');
    expect(r.family).toBe('fam');
    expect(r.networkMode).toBe('bridge');
    expect(r.containers.length).toBe(1);
  });

  it('rejects a target that points to a Lambda', () => {
    const stack = buildStack('S1', {
      L: { Type: 'AWS::Lambda::Function', Properties: { Runtime: 'nodejs20.x' } },
    });
    expect(() => resolveEcsTaskTarget('L', [stack])).toThrow(/Lambda function/);
  });

  it('falls back to logical id when no family', () => {
    const stack = buildStack('S1', {
      TD: {
        Type: 'AWS::ECS::TaskDefinition',
        Properties: { ContainerDefinitions: [{ Name: 'a', Image: 'nginx' }] },
      },
    });
    const r = resolveEcsTaskTarget('TD', [stack]);
    expect(r.family).toBe('TD');
  });

  it('warns and degrades awsvpc to bridge', () => {
    const stack = buildStack('S1', { TD: makeTaskDef({ networkMode: 'awsvpc' }) });
    const r = resolveEcsTaskTarget('TD', [stack]);
    expect(r.networkMode).toBe('awsvpc');
    expect(r.warnings.some((w) => /awsvpc/i.test(w))).toBe(true);
  });

  it('rejects EFSVolumeConfiguration with a routing hint', () => {
    const stack = buildStack('S1', {
      TD: makeTaskDef({
        volumes: [{ Name: 'efs', EFSVolumeConfiguration: { FilesystemId: 'fs-xx' } }],
      }),
    });
    expect(() => resolveEcsTaskTarget('TD', [stack])).toThrow(/EFSVolumeConfiguration/);
  });

  it('parses port mappings, env, secrets, mountpoints, dependsOn, healthCheck', () => {
    const stack = buildStack('S1', {
      TD: makeTaskDef({
        containers: [
          {
            Name: 'app',
            Image: 'nginx:alpine',
            PortMappings: [{ ContainerPort: 8080, HostPort: 9090, Protocol: 'tcp' }],
            Environment: [
              { Name: 'LOG_LEVEL', Value: 'debug' },
              { Name: 'WITH_INTRINSIC', Value: { Ref: 'X' } },
            ],
            Secrets: [
              {
                Name: 'API_KEY',
                ValueFrom: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:k',
              },
            ],
            MountPoints: [{ SourceVolume: 'shared', ContainerPath: '/data', ReadOnly: true }],
            DependsOn: [{ ContainerName: 'sidecar', Condition: 'START' }],
            HealthCheck: { Command: ['CMD', 'true'], Interval: 5, Timeout: 2, Retries: 3 },
            Essential: false,
          },
          { Name: 'sidecar', Image: 'nginx:alpine' },
        ],
        volumes: [{ Name: 'shared', Host: {} }],
      }),
    });
    const r = resolveEcsTaskTarget('TD', [stack]);
    const app = r.containers.find((c) => c.name === 'app')!;
    expect(app.portMappings).toEqual([{ containerPort: 8080, hostPort: 9090, protocol: 'tcp' }]);
    // Intrinsic-valued env vars are silently dropped here; the literal stays.
    expect(app.environment).toEqual({ LOG_LEVEL: 'debug' });
    expect(app.secrets).toEqual([
      { name: 'API_KEY', valueFrom: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:k' },
    ]);
    expect(app.mountPoints).toEqual([
      { sourceVolume: 'shared', containerPath: '/data', readOnly: true },
    ]);
    expect(app.dependsOn).toEqual([{ containerName: 'sidecar', condition: 'START' }]);
    expect(app.healthCheck?.command).toEqual(['CMD', 'true']);
    expect(app.essential).toBe(false);
    expect(r.volumes[0]?.kind).toBe('host');
  });

  it('extracts RuntimePlatform when X86_64/LINUX', () => {
    const stack = buildStack('S1', {
      TD: makeTaskDef({
        runtimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' },
      }),
    });
    const r = resolveEcsTaskTarget('TD', [stack]);
    expect(r.runtimePlatform).toEqual({ cpuArchitecture: 'ARM64', operatingSystemFamily: 'LINUX' });
  });

  it('rejects cyclic dependsOn through dag construction is deferred to runner; resolver only checks names', () => {
    const stack = buildStack('S1', {
      TD: makeTaskDef({
        containers: [
          {
            Name: 'a',
            Image: 'nginx',
            DependsOn: [{ ContainerName: 'b', Condition: 'START' }],
          },
          // Note: 'b' missing from container list — resolver catches the dangling reference.
        ],
      }),
    });
    expect(() => resolveEcsTaskTarget('TD', [stack])).toThrow(/'b'/);
  });

  it('classifies Image: ECR shape', () => {
    const stack = buildStack('S1', {
      TD: makeTaskDef({
        image: '123456789012.dkr.ecr.us-east-1.amazonaws.com/myrepo:latest',
      }),
    });
    const r = resolveEcsTaskTarget('TD', [stack]);
    const img = r.containers[0]!.image;
    expect(img.kind).toBe('ecr');
    if (img.kind === 'ecr') {
      expect(img.account).toBe('123456789012');
      expect(img.region).toBe('us-east-1');
    }
  });

  it('classifies Image: CDK asset Fn::Sub', () => {
    const stack = buildStack('S1', {
      TD: makeTaskDef({
        image: {
          'Fn::Sub':
            '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/cdk-hnb659fds-container-assets-${AWS::AccountId}-${AWS::Region}:deadbeefcafef00d',
        },
      }),
    });
    const r = resolveEcsTaskTarget('TD', [stack]);
    const img = r.containers[0]!.image;
    expect(img.kind).toBe('cdk-asset');
    if (img.kind === 'cdk-asset') {
      expect(img.assetHash).toBe('deadbeefcafef00d');
    }
  });

  it('classifies Image: public uri', () => {
    const stack = buildStack('S1', {
      TD: makeTaskDef({ image: 'public.ecr.aws/nginx/nginx:alpine' }),
    });
    const r = resolveEcsTaskTarget('TD', [stack]);
    expect(r.containers[0]!.image.kind).toBe('public');
  });

  it('rejects an unresolved AccountId pseudo-parameter image', () => {
    const stack = buildStack('S1', {
      TD: makeTaskDef({
        image: {
          'Fn::Sub': '${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/myrepo:latest',
        },
      }),
    });
    expect(() => resolveEcsTaskTarget('TD', [stack])).toThrow(/pseudo parameters/);
  });

  it('prefix-based path matching resolves L2 → L1 child', () => {
    // L2 wrapper path "S1/MyService/TaskDef" — the synthesized L1 child is at "S1/MyService/TaskDef/Resource".
    const stack = buildStack('S1', {
      TD: makeTaskDef({ cdkPath: 'S1/MyService/TaskDef/Resource' }),
    });
    const r = resolveEcsTaskTarget('S1/MyService/TaskDef', [stack]);
    expect(r.taskDefinitionLogicalId).toBe('TD');
  });

  it('errors with available list when target misses', () => {
    const stack = buildStack('S1', {
      TD: makeTaskDef({ cdkPath: 'S1/Foo/TaskDef' }),
    });
    expect(() => resolveEcsTaskTarget('S1:NotThere', [stack])).toThrow(/did not match/);
  });

  describe('TaskRoleArn resolution', () => {
    function makeRole(): TemplateResource {
      return {
        Type: 'AWS::IAM::Role',
        Properties: { AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [] } },
      };
    }

    it('passes through a flat string ARN unchanged', () => {
      const stack = buildStack('S1', {
        TD: makeTaskDef({ taskRoleArn: 'arn:aws:iam::111111111111:role/MyRole' }),
      });
      const r = resolveEcsTaskTarget('TD', [stack]);
      expect(r.taskRoleArn).toBe('arn:aws:iam::111111111111:role/MyRole');
    });

    it('surfaces a placeholder ARN when TaskRoleArn is {Ref: <IAM::Role>}', () => {
      const stack = buildStack('S1', {
        MyRole: makeRole(),
        TD: makeTaskDef({ taskRoleArn: { Ref: 'MyRole' } }),
      });
      const r = resolveEcsTaskTarget('TD', [stack]);
      expect(r.taskRoleArn).toBe(`arn:aws:iam::${TASK_ROLE_ACCOUNT_PLACEHOLDER}:role/MyRole`);
    });

    it('surfaces a placeholder ARN when TaskRoleArn is {Fn::GetAtt: [<IAM::Role>, "Arn"]}', () => {
      const stack = buildStack('S1', {
        MyRole: makeRole(),
        TD: makeTaskDef({ taskRoleArn: { 'Fn::GetAtt': ['MyRole', 'Arn'] } }),
      });
      const r = resolveEcsTaskTarget('TD', [stack]);
      expect(r.taskRoleArn).toBe(`arn:aws:iam::${TASK_ROLE_ACCOUNT_PLACEHOLDER}:role/MyRole`);
    });

    it('returns undefined when TaskRoleArn references a non-IAM-Role resource type', () => {
      const stack = buildStack('S1', {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        TD: makeTaskDef({ taskRoleArn: { Ref: 'Bucket' } }),
      });
      const r = resolveEcsTaskTarget('TD', [stack]);
      expect(r.taskRoleArn).toBeUndefined();
    });

    it('returns undefined when TaskRoleArn references a missing logical id', () => {
      const stack = buildStack('S1', {
        TD: makeTaskDef({ taskRoleArn: { Ref: 'DoesNotExist' } }),
      });
      const r = resolveEcsTaskTarget('TD', [stack]);
      expect(r.taskRoleArn).toBeUndefined();
    });

    it('returns undefined when TaskRoleArn is an unsupported intrinsic shape', () => {
      const stack = buildStack('S1', {
        TD: makeTaskDef({ taskRoleArn: { 'Fn::Sub': '${SomeParam}' } }),
      });
      const r = resolveEcsTaskTarget('TD', [stack]);
      expect(r.taskRoleArn).toBeUndefined();
    });

    it('returns undefined when TaskRoleArn is absent', () => {
      const stack = buildStack('S1', { TD: makeTaskDef({}) });
      const r = resolveEcsTaskTarget('TD', [stack]);
      expect(r.taskRoleArn).toBeUndefined();
    });
  });

  it('resolves Fn::Sub pseudo-parameter ECR image via Tier 1 context', () => {
    const stack = buildStack('S1', {
      TD: makeTaskDef({
        image: {
          'Fn::Sub': '${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/myrepo:latest',
        },
      }),
    });
    const r = resolveEcsTaskTarget('TD', [stack], {
      pseudoParameters: {
        accountId: '123456789012',
        region: 'us-east-1',
        partition: 'aws',
        urlSuffix: 'amazonaws.com',
      },
    });
    const img = r.containers[0]!.image;
    expect(img.kind).toBe('ecr');
    if (img.kind === 'ecr') {
      expect(img.uri).toBe('123456789012.dkr.ecr.us-east-1.amazonaws.com/myrepo:latest');
      expect(img.account).toBe('123456789012');
      expect(img.region).toBe('us-east-1');
    }
  });

  it('resolves Fn::Sub with cn-north-1 partition into amazonaws.com.cn URI', () => {
    const stack = buildStack('S1', {
      TD: makeTaskDef({
        image: {
          'Fn::Sub': '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/myrepo:latest',
        },
      }),
    });
    const r = resolveEcsTaskTarget('TD', [stack], {
      pseudoParameters: {
        accountId: '210987654321',
        region: 'cn-north-1',
        partition: 'aws-cn',
        urlSuffix: 'amazonaws.com.cn',
      },
    });
    const img = r.containers[0]!.image;
    expect(img.kind).toBe('ecr');
    if (img.kind === 'ecr') {
      expect(img.uri).toBe('210987654321.dkr.ecr.cn-north-1.amazonaws.com.cn/myrepo:latest');
    }
  });

  it('hard-errors with --from-state hint when Fn::Sub references a same-stack ECR Repo and no state was provided', () => {
    const stack = buildStack('S1', {
      MyRepo: { Type: 'AWS::ECR::Repository', Properties: {} },
      TD: makeTaskDef({
        image: {
          'Fn::Sub': '${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/${MyRepo}:tag',
        },
      }),
    });
    // Tier 1 only — substitutes pseudo parameters but leaves `${MyRepo}` for state.
    expect(() =>
      resolveEcsTaskTarget('TD', [stack], {
        pseudoParameters: {
          accountId: '123456789012',
          region: 'us-east-1',
          partition: 'aws',
          urlSuffix: 'amazonaws.com',
        },
      })
    ).toThrow(/--from-state/);
  });

  it('resolves Fn::Sub with same-stack ECR Repo Ref via Tier 2 state', () => {
    const stack = buildStack('S1', {
      MyRepo: { Type: 'AWS::ECR::Repository', Properties: {} },
      TD: makeTaskDef({
        image: {
          'Fn::Sub': '${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/${MyRepo}:tag',
        },
      }),
    });
    const stateResources: Record<string, ResourceState> = {
      MyRepo: {
        physicalId: 'deployed-repo-name',
        resourceType: 'AWS::ECR::Repository',
        properties: {},
        attributes: {
          RepositoryUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/deployed-repo-name',
        },
        dependencies: [],
      },
    };
    const r = resolveEcsTaskTarget('TD', [stack], {
      pseudoParameters: {
        accountId: '123456789012',
        region: 'us-east-1',
        partition: 'aws',
        urlSuffix: 'amazonaws.com',
      },
      stateResources,
    });
    const img = r.containers[0]!.image;
    expect(img.kind).toBe('ecr');
    if (img.kind === 'ecr') {
      expect(img.uri).toBe('123456789012.dkr.ecr.us-east-1.amazonaws.com/deployed-repo-name:tag');
    }
  });

  it('resolves Fn::GetAtt [Repo, RepositoryUri] via Tier 2 state', () => {
    const stack = buildStack('S1', {
      MyRepo: { Type: 'AWS::ECR::Repository', Properties: {} },
      TD: makeTaskDef({
        image: { 'Fn::GetAtt': ['MyRepo', 'RepositoryUri'] },
      }),
    });
    const stateResources: Record<string, ResourceState> = {
      MyRepo: {
        physicalId: 'deployed-repo-name',
        resourceType: 'AWS::ECR::Repository',
        properties: {},
        attributes: {
          RepositoryUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/deployed-repo-name',
        },
        dependencies: [],
      },
    };
    const r = resolveEcsTaskTarget('TD', [stack], { stateResources });
    const img = r.containers[0]!.image;
    expect(img.kind).toBe('ecr');
    if (img.kind === 'ecr') {
      expect(img.uri).toBe('123456789012.dkr.ecr.us-east-1.amazonaws.com/deployed-repo-name');
    }
  });

  it('plain string image stays a public pass-through regardless of context', () => {
    const stack = buildStack('S1', { TD: makeTaskDef({ image: 'nginx:alpine' }) });
    const r = resolveEcsTaskTarget('TD', [stack], {
      pseudoParameters: { accountId: '123', region: 'us-east-1' },
    });
    expect(r.containers[0]!.image.kind).toBe('public');
  });

  // Issue #271: CDK 2.x synthesizes ContainerImage.fromEcrRepository(repo, tag)
  // as Fn::Join rather than Fn::Sub. The exact shape (extracted via jq from
  // cdk-sample) reconstructs the ECR URI from nested Fn::Select/Fn::Split
  // over the repo's Arn GetAtt plus a Ref to the same repo and Ref:
  // AWS::URLSuffix.
  describe('Fn::Join ECR image (issue #271, fromEcrRepository)', () => {
    function makeFromEcrRepositoryJoin(repoLogicalId: string, tag = 'latest'): unknown {
      return {
        'Fn::Join': [
          '',
          [
            {
              'Fn::Select': [
                4,
                { 'Fn::Split': [':', { 'Fn::GetAtt': [repoLogicalId, 'Arn'] }] },
              ],
            },
            '.dkr.ecr.',
            {
              'Fn::Select': [
                3,
                { 'Fn::Split': [':', { 'Fn::GetAtt': [repoLogicalId, 'Arn'] }] },
              ],
            },
            '.',
            { Ref: 'AWS::URLSuffix' },
            '/',
            { Ref: repoLogicalId },
            `:${tag}`,
          ],
        ],
      };
    }

    function deployedRepoState(opts: {
      physicalId?: string;
      arn?: string;
    } = {}): Record<string, ResourceState> {
      return {
        MyEcrRepo: {
          physicalId: opts.physicalId ?? 'my-deployed-repo',
          resourceType: 'AWS::ECR::Repository',
          properties: {},
          attributes: {
            Arn:
              opts.arn ?? 'arn:aws:ecr:us-east-1:123456789012:repository/my-deployed-repo',
          },
          dependencies: [],
        },
      };
    }

    it('resolves the canonical CDK 2.x shape with state + pseudo params', () => {
      const stack = buildStack('S1', {
        MyEcrRepo: { Type: 'AWS::ECR::Repository', Properties: {} },
        TD: makeTaskDef({ image: makeFromEcrRepositoryJoin('MyEcrRepo') }),
      });
      const r = resolveEcsTaskTarget('TD', [stack], {
        pseudoParameters: {
          accountId: '123456789012',
          region: 'us-east-1',
          partition: 'aws',
          urlSuffix: 'amazonaws.com',
        },
        stateResources: deployedRepoState(),
      });
      const img = r.containers[0]!.image;
      expect(img.kind).toBe('ecr');
      if (img.kind === 'ecr') {
        expect(img.uri).toBe(
          '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-deployed-repo:latest'
        );
        expect(img.account).toBe('123456789012');
        expect(img.region).toBe('us-east-1');
      }
    });

    it('resolves with state-recorded Arn even when pseudoParameters is absent', () => {
      // The canonical shape derives account-id / region from the Arn split,
      // not from pseudo parameters — the only pseudo parameter it touches is
      // `AWS::URLSuffix`. With state providing the Arn AND state providing
      // the URLSuffix via the partition derivation, this should still
      // resolve. (In practice the CLI always populates pseudoParameters
      // when calling --from-state — but the resolver shouldn't require it
      // when state alone is sufficient.)
      const stack = buildStack('S1', {
        MyEcrRepo: { Type: 'AWS::ECR::Repository', Properties: {} },
        TD: makeTaskDef({ image: makeFromEcrRepositoryJoin('MyEcrRepo') }),
      });
      const r = resolveEcsTaskTarget('TD', [stack], {
        pseudoParameters: { urlSuffix: 'amazonaws.com' },
        stateResources: deployedRepoState(),
      });
      const img = r.containers[0]!.image;
      expect(img.kind).toBe('ecr');
      if (img.kind === 'ecr') {
        expect(img.uri).toBe(
          '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-deployed-repo:latest'
        );
      }
    });

    it('resolves with a custom tag', () => {
      const stack = buildStack('S1', {
        MyEcrRepo: { Type: 'AWS::ECR::Repository', Properties: {} },
        TD: makeTaskDef({ image: makeFromEcrRepositoryJoin('MyEcrRepo', 'v1.2.3') }),
      });
      const r = resolveEcsTaskTarget('TD', [stack], {
        pseudoParameters: {
          accountId: '123456789012',
          region: 'us-east-1',
          partition: 'aws',
          urlSuffix: 'amazonaws.com',
        },
        stateResources: deployedRepoState(),
      });
      const img = r.containers[0]!.image;
      expect(img.kind).toBe('ecr');
      if (img.kind === 'ecr') {
        expect(img.uri).toBe(
          '123456789012.dkr.ecr.us-east-1.amazonaws.com/my-deployed-repo:v1.2.3'
        );
      }
    });

    it('hard-errors with a --from-state hint when state is missing', () => {
      const stack = buildStack('S1', {
        MyEcrRepo: { Type: 'AWS::ECR::Repository', Properties: {} },
        TD: makeTaskDef({ image: makeFromEcrRepositoryJoin('MyEcrRepo') }),
      });
      expect(() =>
        resolveEcsTaskTarget('TD', [stack], {
          pseudoParameters: {
            accountId: '123456789012',
            region: 'us-east-1',
            partition: 'aws',
            urlSuffix: 'amazonaws.com',
          },
        })
      ).toThrow(/--from-state/);
    });

    it('hard-errors when state is missing the Repository Arn attribute', () => {
      const stack = buildStack('S1', {
        MyEcrRepo: { Type: 'AWS::ECR::Repository', Properties: {} },
        TD: makeTaskDef({ image: makeFromEcrRepositoryJoin('MyEcrRepo') }),
      });
      const stateResources: Record<string, ResourceState> = {
        MyEcrRepo: {
          physicalId: 'my-deployed-repo',
          resourceType: 'AWS::ECR::Repository',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      };
      expect(() =>
        resolveEcsTaskTarget('TD', [stack], {
          pseudoParameters: {
            accountId: '123456789012',
            region: 'us-east-1',
            partition: 'aws',
            urlSuffix: 'amazonaws.com',
          },
          stateResources,
        })
      ).toThrow(/unsupported Fn::Join Image shape/);
    });

    it('rejects a non-canonical Fn::Join with a clear unsupported-shape error', () => {
      const stack = buildStack('S1', {
        MyEcrRepo: { Type: 'AWS::ECR::Repository', Properties: {} },
        TD: makeTaskDef({
          image: {
            'Fn::Join': [
              '-',
              [{ Ref: 'MyEcrRepo' }, 'tail'],
            ],
          },
        }),
      });
      // Non-empty delimiter, no Arn GetAtt — needs-state still triggers
      // because Ref against the ECR Repo is present, but the resulting
      // URI does not match the ECR regex so it would be classified as
      // public if it resolved. With state available it resolves to
      // `my-deployed-repo-tail` (a public image).
      const r = resolveEcsTaskTarget('TD', [stack], {
        stateResources: deployedRepoState(),
      });
      expect(r.containers[0]!.image.kind).toBe('public');
      if (r.containers[0]!.image.kind === 'public') {
        expect(r.containers[0]!.image.uri).toBe('my-deployed-repo-tail');
      }
    });

    it('non-ECR Fn::Join (no Repository refs) falls through to extractImageString public path', () => {
      const stack = buildStack('S1', {
        TD: makeTaskDef({
          image: {
            'Fn::Join': ['', ['public.ecr.aws/', 'nginx/nginx', ':alpine']],
          },
        }),
      });
      const r = resolveEcsTaskTarget('TD', [stack]);
      const img = r.containers[0]!.image;
      expect(img.kind).toBe('public');
      if (img.kind === 'public') {
        expect(img.uri).toBe('public.ecr.aws/nginx/nginx:alpine');
      }
    });

    it('existing Fn::Sub 1-arg path still works (no regression)', () => {
      const stack = buildStack('S1', {
        MyRepo: { Type: 'AWS::ECR::Repository', Properties: {} },
        TD: makeTaskDef({
          image: {
            'Fn::Sub': '${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/${MyRepo}:tag',
          },
        }),
      });
      const r = resolveEcsTaskTarget('TD', [stack], {
        pseudoParameters: {
          accountId: '123456789012',
          region: 'us-east-1',
          partition: 'aws',
          urlSuffix: 'amazonaws.com',
        },
        stateResources: {
          MyRepo: {
            physicalId: 'my-repo-name',
            resourceType: 'AWS::ECR::Repository',
            properties: {},
            attributes: {},
            dependencies: [],
          },
        },
      });
      const img = r.containers[0]!.image;
      expect(img.kind).toBe('ecr');
      if (img.kind === 'ecr') {
        expect(img.uri).toBe('123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo-name:tag');
      }
    });

    it('Tier 2 needs are detected for the Fn::Join shape', () => {
      const stack = buildStack('S1', {
        MyEcrRepo: { Type: 'AWS::ECR::Repository', Properties: {} },
        TD: makeTaskDef({ image: makeFromEcrRepositoryJoin('MyEcrRepo') }),
      });
      const needs = detectEcsImageResolutionNeeds(stack);
      // URLSuffix triggers Tier 1; Repository Ref + GetAtt trigger Tier 2.
      expect(needs.needsPseudoParameters).toBe(true);
      expect(needs.needsStateResources).toBe(true);
    });
  });
});

describe('derivePartitionAndUrlSuffix', () => {
  it('returns aws / amazonaws.com for commercial regions', () => {
    expect(derivePartitionAndUrlSuffix('us-east-1')).toEqual({
      partition: 'aws',
      urlSuffix: 'amazonaws.com',
    });
    expect(derivePartitionAndUrlSuffix('eu-west-1')).toEqual({
      partition: 'aws',
      urlSuffix: 'amazonaws.com',
    });
  });
  it('returns aws-cn / amazonaws.com.cn for cn-* regions', () => {
    expect(derivePartitionAndUrlSuffix('cn-north-1')).toEqual({
      partition: 'aws-cn',
      urlSuffix: 'amazonaws.com.cn',
    });
  });
  it('returns aws-us-gov / amazonaws.com for us-gov-* regions', () => {
    expect(derivePartitionAndUrlSuffix('us-gov-west-1')).toEqual({
      partition: 'aws-us-gov',
      urlSuffix: 'amazonaws.com',
    });
  });
});

describe('detectEcsImageResolutionNeeds', () => {
  it('returns false/false for plain string + cdk-asset images', () => {
    const stack = buildStack('S1', {
      A: makeTaskDef({ image: 'nginx:alpine' }),
      B: makeTaskDef({
        image: {
          'Fn::Sub':
            '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/cdk-hnb659fds-container-assets-${AWS::AccountId}-${AWS::Region}:deadbeefcafef00d',
        },
      }),
    });
    // cdk-asset shape DOES include pseudo placeholders — we still report
    // needsPseudoParameters=true so the CLI can supply them; the
    // resolver's cdk-asset branch wins downstream regardless.
    const needs = detectEcsImageResolutionNeeds(stack);
    expect(needs.needsPseudoParameters).toBe(true);
    expect(needs.needsStateResources).toBe(false);
  });
  it('flags pseudo-parameter-only Fn::Sub as Tier 1 only', () => {
    const stack = buildStack('S1', {
      TD: makeTaskDef({
        image: { 'Fn::Sub': '${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/r:t' },
      }),
    });
    const needs = detectEcsImageResolutionNeeds(stack);
    expect(needs.needsPseudoParameters).toBe(true);
    expect(needs.needsStateResources).toBe(false);
  });
  it('flags Fn::Sub with same-stack ECR Repo as Tier 1 + Tier 2', () => {
    const stack = buildStack('S1', {
      MyRepo: { Type: 'AWS::ECR::Repository', Properties: {} },
      TD: makeTaskDef({
        image: { 'Fn::Sub': '${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/${MyRepo}:t' },
      }),
    });
    const needs = detectEcsImageResolutionNeeds(stack);
    expect(needs.needsPseudoParameters).toBe(true);
    expect(needs.needsStateResources).toBe(true);
  });
  it('flags Fn::GetAtt against an ECR Repository as Tier 2 only', () => {
    const stack = buildStack('S1', {
      MyRepo: { Type: 'AWS::ECR::Repository', Properties: {} },
      TD: makeTaskDef({ image: { 'Fn::GetAtt': ['MyRepo', 'RepositoryUri'] } }),
    });
    const needs = detectEcsImageResolutionNeeds(stack);
    expect(needs.needsPseudoParameters).toBe(false);
    expect(needs.needsStateResources).toBe(true);
  });
});
