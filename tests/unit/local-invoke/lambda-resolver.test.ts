import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LocalInvokeResolutionError,
  parseTarget,
  resolveLambdaTarget,
} from '../../../src/local-invoke/lambda-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../src/types/resource.js';

/** Build a fake `StackInfo` with an on-disk asset directory so the
 * resolver's existsSync check passes. The returned cleanup fn deletes
 * the tmp dir. */
function buildStack(
  stackName: string,
  resources: Record<string, TemplateResource>,
  cdkOutDir: string
): StackInfo {
  const template: CloudFormationTemplate = { Resources: resources };
  // Materialize each asset.* directory referenced by Metadata.aws:asset:path
  // so resolveAssetCodePath's existsSync passes.
  for (const r of Object.values(resources)) {
    const meta = r.Metadata as Record<string, unknown> | undefined;
    const p = meta?.['aws:asset:path'];
    if (typeof p === 'string') {
      mkdirSync(join(cdkOutDir, p), { recursive: true });
    }
  }
  // Also produce an asset manifest path so the resolver picks the right
  // cdk.out dir (it strips the filename to get the assembly directory).
  const manifestPath = join(cdkOutDir, `${stackName}.assets.json`);
  writeFileSync(manifestPath, '{}', 'utf-8');

  return {
    stackName,
    displayName: stackName,
    artifactId: stackName,
    template,
    assetManifestPath: manifestPath,
    dependencyNames: [],
  };
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'cdkd-lambda-resolver-test-'));

beforeAll(() => {
  /* tmp dir created above */
});
afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('parseTarget', () => {
  it('parses Stack:LogicalId form', () => {
    expect(parseTarget('MyStack:Handler1234')).toEqual({
      stackPattern: 'MyStack',
      pathOrId: 'Handler1234',
      isPath: false,
    });
  });

  it('parses MyStack/Path form as a display path', () => {
    expect(parseTarget('MyStack/MyApi/Handler')).toEqual({
      stackPattern: 'MyStack',
      pathOrId: 'MyStack/MyApi/Handler',
      isPath: true,
    });
  });

  it('treats bare LogicalId as single-stack auto-detect', () => {
    expect(parseTarget('Handler1234')).toEqual({
      stackPattern: null,
      pathOrId: 'Handler1234',
      isPath: false,
    });
  });

  it('rejects empty target', () => {
    expect(() => parseTarget('')).toThrow(LocalInvokeResolutionError);
  });

  it('rejects target with only a stack prefix', () => {
    expect(() => parseTarget('MyStack:')).toThrow(/no logical ID/);
  });
});

describe('resolveLambdaTarget', () => {
  it('resolves a stack-qualified logical ID', () => {
    const stack = buildStack(
      'MyStack',
      {
        MyHandler: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Code: { S3Bucket: 'b', S3Key: 'k' },
          },
          Metadata: { 'aws:asset:path': 'asset.abc', 'aws:cdk:path': 'MyStack/MyHandler/Resource' },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:MyHandler', [stack]);
    expect(result.logicalId).toBe('MyHandler');
    expect(result.runtime).toBe('nodejs20.x');
    expect(result.handler).toBe('index.handler');
    expect(result.codePath).toMatch(/asset\.abc$/);
  });

  it('resolves a CDK display path to its synthesized L1 child', () => {
    const stack = buildStack(
      'MyStack',
      {
        MyHandlerResource: {
          Type: 'AWS::Lambda::Function',
          Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler' },
          Metadata: {
            'aws:asset:path': 'asset.abc',
            'aws:cdk:path': 'MyStack/MyHandler/Resource',
          },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack/MyHandler', [stack]);
    expect(result.logicalId).toBe('MyHandlerResource');
  });

  it('auto-detects single stack when target omits prefix', () => {
    const stack = buildStack(
      'OnlyStack',
      {
        Handler: {
          Type: 'AWS::Lambda::Function',
          Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler' },
          Metadata: { 'aws:asset:path': 'asset.abc' },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('Handler', [stack]);
    expect(result.stack.stackName).toBe('OnlyStack');
    expect(result.logicalId).toBe('Handler');
  });

  it('refuses to auto-detect when multiple stacks exist', () => {
    const a = buildStack(
      'StackA',
      {
        Handler: {
          Type: 'AWS::Lambda::Function',
          Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler' },
          Metadata: { 'aws:asset:path': 'asset.abc' },
        },
      },
      tmpRoot
    );
    const b = buildStack(
      'StackB',
      {
        Handler: {
          Type: 'AWS::Lambda::Function',
          Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler' },
          Metadata: { 'aws:asset:path': 'asset.abc' },
        },
      },
      tmpRoot
    );
    expect(() => resolveLambdaTarget('Handler', [a, b])).toThrow(/missing a stack prefix/);
  });

  it('lists available Lambdas when target is not found', () => {
    const stack = buildStack(
      'MyStack',
      {
        Handler1: {
          Type: 'AWS::Lambda::Function',
          Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler' },
          Metadata: { 'aws:asset:path': 'asset.a', 'aws:cdk:path': 'MyStack/Handler1/Resource' },
        },
        Handler2: {
          Type: 'AWS::Lambda::Function',
          Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler' },
          Metadata: { 'aws:asset:path': 'asset.b', 'aws:cdk:path': 'MyStack/Handler2/Resource' },
        },
      },
      tmpRoot
    );
    try {
      resolveLambdaTarget('MyStack:Wrong', [stack]);
      expect.fail('should have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/did not match any Lambda/);
      expect(msg).toMatch(/MyStack\/Handler1\/Resource/);
      expect(msg).toMatch(/MyStack\/Handler2\/Resource/);
    }
  });

  it('rejects a target that points at a non-Lambda resource', () => {
    const stack = buildStack(
      'MyStack',
      {
        MyTable: { Type: 'AWS::DynamoDB::Table', Properties: {} },
      },
      tmpRoot
    );
    expect(() => resolveLambdaTarget('MyStack:MyTable', [stack])).toThrow(
      /not a Lambda function/
    );
  });

  it('rejects a Custom Resource with a hint at the underlying ServiceToken Lambda', () => {
    const stack = buildStack(
      'MyStack',
      {
        MyCR: { Type: 'Custom::DoStuff', Properties: { ServiceToken: 'arn:...' } },
      },
      tmpRoot
    );
    expect(() => resolveLambdaTarget('MyStack:MyCR', [stack])).toThrow(/Custom Resource/);
  });

  it('returns inline code body when Code.ZipFile is set', () => {
    const stack = buildStack(
      'MyStack',
      {
        Inline: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Code: { ZipFile: 'exports.handler = async () => "hi";' },
          },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:Inline', [stack]);
    expect(result.codePath).toBeNull();
    expect(result.inlineCode).toMatch(/exports.handler/);
  });

  it('resolves a Python Lambda with Code.ZipFile (runtime+inlineCode propagated)', () => {
    const stack = buildStack(
      'MyStack',
      {
        PyInline: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'python3.12',
            Handler: 'index.handler',
            Code: { ZipFile: 'def handler(event, context):\n    return {"ok": True}\n' },
          },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:PyInline', [stack]);
    expect(result.runtime).toBe('python3.12');
    expect(result.handler).toBe('index.handler');
    expect(result.codePath).toBeNull();
    expect(result.inlineCode).toMatch(/def handler/);
  });

  it('resolves an asset-backed Python Lambda', () => {
    const stack = buildStack(
      'MyStack',
      {
        PyHandler: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'python3.11',
            Handler: 'index.handler',
            Code: { S3Bucket: 'b', S3Key: 'k' },
          },
          Metadata: {
            'aws:asset:path': 'asset.pyabc',
            'aws:cdk:path': 'MyStack/PyHandler/Resource',
          },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:PyHandler', [stack]);
    expect(result.runtime).toBe('python3.11');
    expect(result.codePath).toMatch(/asset\.pyabc$/);
  });
});
