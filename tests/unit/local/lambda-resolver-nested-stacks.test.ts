import { describe, expect, it } from 'vite-plus/test';
import { resolveLambdaTarget } from '../../../src/local/lambda-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { TemplateResource } from '../../../src/types/resource.js';

function lambda(cdkPath: string): TemplateResource {
  return {
    Type: 'AWS::Lambda::Function',
    Properties: {
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Code: { ZipFile: 'exports.handler = async () => "hi";' },
    },
    Metadata: { 'aws:cdk:path': cdkPath },
  };
}

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
  template: { Resources: { ChildFn123: lambda('App/Inner/Fn/Resource') } },
  dependencyNames: [],
  nestedStack: { parentStackName: 'App', rootStackName: 'App', logicalId: 'InnerNS', parameters: {} },
} as unknown as StackInfo;
const stacks = [app, child];

describe('resolveLambdaTarget with CDK nested stacks', () => {
  it("resolves 'Stack:LogicalId' of a nested function into the nested stack", () => {
    expect(resolveLambdaTarget('App:ChildFn123', stacks).stack).toBe(child);
  });

  it('resolves a bare logical id into the nested stack when one top-level stack exists', () => {
    const r = resolveLambdaTarget('ChildFn123', stacks);
    expect(r.stack).toBe(child);
    expect(r.logicalId).toBe('ChildFn123');
  });

  it('resolves the nested display path form', () => {
    expect(resolveLambdaTarget('App/Inner/Fn', stacks).stack).toBe(child);
  });

  it('lists the nested stack functions when the target is not found', () => {
    expect(() => resolveLambdaTarget('App/Nope', stacks)).toThrow(/App\/Inner\/Fn\/Resource/);
  });
});
