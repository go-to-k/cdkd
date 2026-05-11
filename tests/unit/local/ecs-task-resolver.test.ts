import { describe, expect, it } from 'vitest';
import {
  EcsTaskResolutionError,
  parseEcsTarget,
  resolveEcsTaskTarget,
} from '../../../src/local/ecs-task-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../src/types/resource.js';

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
      TD: { Type: 'AWS::ECS::TaskDefinition', Properties: { ContainerDefinitions: [{ Name: 'a', Image: 'nginx' }] } },
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
    expect(app.mountPoints).toEqual([{ sourceVolume: 'shared', containerPath: '/data', readOnly: true }]);
    expect(app.dependsOn).toEqual([{ containerName: 'sidecar', condition: 'START' }]);
    expect(app.healthCheck?.command).toEqual(['CMD', 'true']);
    expect(app.essential).toBe(false);
    expect(r.volumes[0]?.kind).toBe('host');
  });

  it('extracts RuntimePlatform when X86_64/LINUX', () => {
    const stack = buildStack('S1', {
      TD: makeTaskDef({ runtimePlatform: { CpuArchitecture: 'ARM64', OperatingSystemFamily: 'LINUX' } }),
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
        image: { 'Fn::Sub': '${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/myrepo:latest' },
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
});
