import { describe, expect, it } from 'vite-plus/test';
import { resolveEcsTaskTarget } from '../../../src/local/ecs-task-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

const app: StackInfo = {
  stackName: 'App',
  displayName: 'App',
  artifactId: 'App',
  template: { Resources: {} },
  dependencyNames: [],
};
const child: StackInfo = {
  stackName: 'App~InnerNS',
  displayName: 'App/Inner',
  artifactId: 'App',
  template: {
    Resources: {
      ChildTD1: {
        Type: 'AWS::ECS::TaskDefinition',
        Properties: {
          Family: 'fam',
          NetworkMode: 'bridge',
          ContainerDefinitions: [
            { Name: 'app', Image: 'public.ecr.aws/nginx/nginx:alpine', PortMappings: [] },
          ],
        },
        Metadata: { 'aws:cdk:path': 'App/Inner/TaskDef/Resource' },
      },
    },
  },
  dependencyNames: [],
  nestedStack: { parentStackName: 'App', rootStackName: 'App', logicalId: 'InnerNS', parameters: {} },
} as unknown as StackInfo;
const stacks = [app, child];

describe('resolveEcsTaskTarget with CDK nested stacks', () => {
  it("resolves 'Stack:LogicalId' of a nested task definition", () => {
    const r = resolveEcsTaskTarget('App:ChildTD1', stacks);
    expect(r.taskDefinitionLogicalId).toBe('ChildTD1');
    expect(r.stack).toBe(child);
  });

  it('lists the nested task definition when the target is not found', () => {
    expect(() => resolveEcsTaskTarget('App/Nope', stacks)).toThrow(/ChildTD1/);
  });
});
