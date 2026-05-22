import { describe, expect, it } from 'vite-plus/test';
import {
  extractServiceProperties,
  resolveEcsServiceTarget,
} from '../../../src/local/ecs-service-resolver.js';
import { EcsTaskResolutionError } from '../../../src/local/ecs-task-resolver.js';
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

function makeTaskDef(opts?: {
  containerName?: string;
  family?: string;
}): TemplateResource {
  return {
    Type: 'AWS::ECS::TaskDefinition',
    Properties: {
      Family: opts?.family ?? 'fam',
      NetworkMode: 'bridge',
      ContainerDefinitions: [
        {
          Name: opts?.containerName ?? 'app',
          Image: 'public.ecr.aws/nginx/nginx:alpine',
          PortMappings: [{ ContainerPort: 80, Protocol: 'tcp' }],
        },
      ],
    },
  };
}

function makeService(opts: {
  taskDef?: unknown;
  desiredCount?: unknown;
  healthCheckGracePeriodSeconds?: unknown;
  serviceName?: string;
  loadBalancers?: unknown[];
  serviceConnect?: unknown;
  cdkPath?: string;
}): TemplateResource {
  const props: Record<string, unknown> = {
    TaskDefinition: opts.taskDef ?? { Ref: 'TaskDef' },
  };
  if (opts.desiredCount !== undefined) props['DesiredCount'] = opts.desiredCount;
  if (opts.healthCheckGracePeriodSeconds !== undefined)
    props['HealthCheckGracePeriodSeconds'] = opts.healthCheckGracePeriodSeconds;
  if (opts.serviceName !== undefined) props['ServiceName'] = opts.serviceName;
  if (opts.loadBalancers !== undefined) props['LoadBalancers'] = opts.loadBalancers;
  if (opts.serviceConnect !== undefined) props['ServiceConnectConfiguration'] = opts.serviceConnect;
  const r: TemplateResource = { Type: 'AWS::ECS::Service', Properties: props };
  if (opts.cdkPath) r.Metadata = { 'aws:cdk:path': opts.cdkPath };
  return r;
}

describe('resolveEcsServiceTarget', () => {
  it('resolves a service by Stack:LogicalId and chains into the task descriptor', () => {
    const stack = buildStack('MyStack', {
      TaskDef: makeTaskDef({ family: 'web' }),
      WebService: makeService({ desiredCount: 2, serviceName: 'WebSvc' }),
    });
    const svc = resolveEcsServiceTarget('MyStack:WebService', [stack]);
    expect(svc.serviceLogicalId).toBe('WebService');
    expect(svc.serviceName).toBe('WebSvc');
    expect(svc.desiredCount).toBe(2);
    expect(svc.task.taskDefinitionLogicalId).toBe('TaskDef');
    expect(svc.task.family).toBe('web');
  });

  it('resolves a service by display path (single-stack auto-detect)', () => {
    const stack = buildStack('MyStack', {
      WebTaskDef: { ...makeTaskDef(), Metadata: { 'aws:cdk:path': 'MyStack/Web/TaskDef/Resource' } },
      WebSvc: {
        ...makeService({ taskDef: { Ref: 'WebTaskDef' } }),
        Metadata: { 'aws:cdk:path': 'MyStack/Web/Service/Resource' },
      },
    });
    const svc = resolveEcsServiceTarget('MyStack/Web/Service', [stack]);
    expect(svc.serviceLogicalId).toBe('WebSvc');
    expect(svc.desiredCount).toBe(1); // default
  });

  it('defaults DesiredCount to 1 when absent', () => {
    const stack = buildStack('MyStack', {
      TaskDef: makeTaskDef(),
      Svc: makeService({}),
    });
    const svc = resolveEcsServiceTarget('MyStack:Svc', [stack]);
    expect(svc.desiredCount).toBe(1);
  });

  it('defaults HealthCheckGracePeriodSeconds to 30 when absent', () => {
    const stack = buildStack('MyStack', {
      TaskDef: makeTaskDef(),
      Svc: makeService({}),
    });
    const svc = resolveEcsServiceTarget('MyStack:Svc', [stack]);
    expect(svc.healthCheckGracePeriodSeconds).toBe(30);
  });

  it('falls back to logical ID for serviceName when ServiceName property absent', () => {
    const stack = buildStack('MyStack', {
      TaskDef: makeTaskDef(),
      MyServiceLogicalId: makeService({}),
    });
    const svc = resolveEcsServiceTarget('MyStack:MyServiceLogicalId', [stack]);
    expect(svc.serviceName).toBe('MyServiceLogicalId');
  });

  it('accepts a string DesiredCount (e.g. "3") and coerces to number', () => {
    const stack = buildStack('MyStack', {
      TaskDef: makeTaskDef(),
      Svc: makeService({ desiredCount: '3' }),
    });
    const svc = resolveEcsServiceTarget('MyStack:Svc', [stack]);
    expect(svc.desiredCount).toBe(3);
  });

  it('rejects negative DesiredCount with an actionable error', () => {
    const stack = buildStack('MyStack', {
      TaskDef: makeTaskDef(),
      Svc: makeService({ desiredCount: -1 }),
    });
    expect(() => resolveEcsServiceTarget('MyStack:Svc', [stack])).toThrow(EcsTaskResolutionError);
  });

  it('rejects non-Ref TaskDefinition shapes with an actionable error', () => {
    const stack = buildStack('MyStack', {
      Svc: makeService({ taskDef: { 'Fn::ImportValue': 'OtherStackTaskDef' } }),
    });
    expect(() => resolveEcsServiceTarget('MyStack:Svc', [stack])).toThrow(
      /unsupported TaskDefinition reference shape/i
    );
  });

  it('rejects a Ref pointing at a non-TaskDefinition resource', () => {
    const stack = buildStack('MyStack', {
      Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
      Svc: makeService({ taskDef: { Ref: 'Bucket' } }),
    });
    expect(() => resolveEcsServiceTarget('MyStack:Svc', [stack])).toThrow(
      /not AWS::ECS::TaskDefinition/i
    );
  });

  it('rejects a Ref pointing at a missing resource with a clear error', () => {
    const stack = buildStack('MyStack', {
      Svc: makeService({ taskDef: { Ref: 'GhostTask' } }),
    });
    expect(() => resolveEcsServiceTarget('MyStack:Svc', [stack])).toThrow(
      /no such resource exists/i
    );
  });

  it('rejects targeting a TaskDefinition resource as service', () => {
    const stack = buildStack('MyStack', { TaskDef: makeTaskDef() });
    expect(() => resolveEcsServiceTarget('MyStack:TaskDef', [stack])).toThrow(
      /Use `cdkd local run-task`/
    );
  });

  it('rejects when no service matches the target', () => {
    const stack = buildStack('MyStack', { TaskDef: makeTaskDef() });
    expect(() => resolveEcsServiceTarget('MyStack:GhostService', [stack])).toThrow(
      EcsTaskResolutionError
    );
  });

  it('warns about LoadBalancers being deferred', () => {
    const stack = buildStack('MyStack', {
      TaskDef: makeTaskDef(),
      Svc: makeService({
        loadBalancers: [{ TargetGroupArn: 'arn:aws:elasticloadbalancing:...', ContainerPort: 80 }],
      }),
    });
    const svc = resolveEcsServiceTarget('MyStack:Svc', [stack]);
    expect(svc.warnings.some((w) => w.includes('LoadBalancers'))).toBe(true);
  });

  it('warns about ServiceConnectConfiguration being deferred', () => {
    const stack = buildStack('MyStack', {
      TaskDef: makeTaskDef(),
      Svc: makeService({ serviceConnect: { Enabled: true } }),
    });
    const svc = resolveEcsServiceTarget('MyStack:Svc', [stack]);
    expect(svc.warnings.some((w) => w.includes('ServiceConnect'))).toBe(true);
  });

  it('does not warn when LoadBalancers is an empty array', () => {
    const stack = buildStack('MyStack', {
      TaskDef: makeTaskDef(),
      Svc: makeService({ loadBalancers: [] }),
    });
    const svc = resolveEcsServiceTarget('MyStack:Svc', [stack]);
    expect(svc.warnings.some((w) => w.includes('LoadBalancers'))).toBe(false);
  });

  it('rejects missing TaskDefinition property with a clear error', () => {
    const stack = buildStack('MyStack', {
      Svc: {
        Type: 'AWS::ECS::Service',
        Properties: { DesiredCount: 1 },
      },
    });
    expect(() => resolveEcsServiceTarget('MyStack:Svc', [stack])).toThrow(
      /has no TaskDefinition property/
    );
  });

  it('coerces fractional DesiredCount via Math.floor', () => {
    // Defensive: CFn never emits this but the parser should not crash.
    const stack = buildStack('MyStack', {
      TaskDef: makeTaskDef(),
      Svc: makeService({ desiredCount: 2.7 }),
    });
    const svc = resolveEcsServiceTarget('MyStack:Svc', [stack]);
    expect(svc.desiredCount).toBe(2);
  });
});

describe('extractServiceProperties', () => {
  it('matches the public resolver output shape', () => {
    const stack = buildStack('MyStack', {
      TaskDef: makeTaskDef(),
      Svc: makeService({ desiredCount: 5 }),
    });
    const result = extractServiceProperties(stack, 'Svc', stack.template.Resources!.Svc!, [
      stack,
    ]);
    expect(result.serviceLogicalId).toBe('Svc');
    expect(result.desiredCount).toBe(5);
    expect(result.task.taskDefinitionLogicalId).toBe('TaskDef');
  });
});
