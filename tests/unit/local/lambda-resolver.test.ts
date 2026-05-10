import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LocalInvokeResolutionError,
  parseTarget,
  resolveLambdaTarget,
} from '../../../src/local/lambda-resolver.js';
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
    expect(result.kind).toBe('zip');
    if (result.kind !== 'zip') return;
    expect(result.runtime).toBe('python3.11');
    expect(result.codePath).toMatch(/asset\.pyabc$/);
  });

  // PR 5 — container Lambda support (Code.ImageUri)

  it('resolves a container Lambda from Fn::Sub-shaped Code.ImageUri', () => {
    const stack = buildStack(
      'MyStack',
      {
        ContainerFn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            PackageType: 'Image',
            Code: {
              ImageUri: {
                'Fn::Sub':
                  '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/cdk-hnb659fds-container-assets-${AWS::AccountId}-${AWS::Region}:abcdef1234567890',
              },
            },
            ImageConfig: {
              Command: ['app.handler'],
              EntryPoint: ['/lambda-entrypoint.sh'],
              WorkingDirectory: '/var/task',
            },
            Architectures: ['arm64'],
          },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:ContainerFn', [stack]);
    expect(result.kind).toBe('image');
    if (result.kind !== 'image') return;
    expect(result.imageUri).toContain(':abcdef1234567890');
    expect(result.imageConfig.command).toEqual(['app.handler']);
    expect(result.imageConfig.entryPoint).toEqual(['/lambda-entrypoint.sh']);
    expect(result.imageConfig.workingDirectory).toBe('/var/task');
    expect(result.architecture).toBe('arm64');
  });

  it('resolves a container Lambda from a flat-string Code.ImageUri', () => {
    const stack = buildStack(
      'MyStack',
      {
        Plain: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            PackageType: 'Image',
            Code: { ImageUri: '111111111111.dkr.ecr.us-east-1.amazonaws.com/r:hash123abc' },
          },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:Plain', [stack]);
    expect(result.kind).toBe('image');
    if (result.kind !== 'image') return;
    expect(result.imageUri).toBe(
      '111111111111.dkr.ecr.us-east-1.amazonaws.com/r:hash123abc'
    );
  });

  it('defaults Architectures to x86_64 when omitted', () => {
    const stack = buildStack(
      'MyStack',
      {
        Default: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            PackageType: 'Image',
            Code: { ImageUri: { 'Fn::Sub': 'r:abc12345' } },
          },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:Default', [stack]);
    expect(result.kind).toBe('image');
    if (result.kind !== 'image') return;
    expect(result.architecture).toBe('x86_64');
  });

  it('container Lambda does NOT require Handler/Runtime properties (D5.5)', () => {
    const stack = buildStack(
      'MyStack',
      {
        NoHandlerNoRuntime: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            PackageType: 'Image',
            Code: { ImageUri: { 'Fn::Sub': 'r:hash123abc' } },
          },
        },
      },
      tmpRoot
    );
    // Should NOT throw — prior to PR 5 the resolver required Runtime.
    expect(() => resolveLambdaTarget('MyStack:NoHandlerNoRuntime', [stack])).not.toThrow();
  });

  it('rejects unsupported Architectures values', () => {
    const stack = buildStack(
      'MyStack',
      {
        Bad: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            PackageType: 'Image',
            Code: { ImageUri: { 'Fn::Sub': 'r:hash123' } },
            Architectures: ['mips64'],
          },
        },
      },
      tmpRoot
    );
    expect(() => resolveLambdaTarget('MyStack:Bad', [stack])).toThrow(
      /unsupported Architectures/
    );
  });

  it('emits an empty imageConfig when ImageConfig is absent', () => {
    const stack = buildStack(
      'MyStack',
      {
        Bare: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            PackageType: 'Image',
            Code: { ImageUri: { 'Fn::Sub': 'r:hash9876' } },
          },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:Bare', [stack]);
    expect(result.kind).toBe('image');
    if (result.kind !== 'image') return;
    expect(result.imageConfig).toEqual({});
  });

  // PR 6 of #224 — Lambda Layers (issue #232)

  it('returns layers: [] when Properties.Layers is absent (ZIP)', () => {
    const stack = buildStack(
      'MyStack',
      {
        Plain: {
          Type: 'AWS::Lambda::Function',
          Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler' },
          Metadata: { 'aws:asset:path': 'asset.fn' },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:Plain', [stack]);
    expect(result.kind).toBe('zip');
    expect(result.layers).toEqual([]);
  });

  it('returns layers: [] when Properties.Layers is an empty array', () => {
    const stack = buildStack(
      'MyStack',
      {
        Plain: {
          Type: 'AWS::Lambda::Function',
          Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler', Layers: [] },
          Metadata: { 'aws:asset:path': 'asset.fn' },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:Plain', [stack]);
    expect(result.layers).toEqual([]);
  });

  it('resolves a same-stack Ref to a LayerVersion via aws:asset:path', () => {
    const stack = buildStack(
      'MyStack',
      {
        WithLayer: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Layers: [{ Ref: 'MyLayer' }],
          },
          Metadata: { 'aws:asset:path': 'asset.fn' },
        },
        MyLayer: {
          Type: 'AWS::Lambda::LayerVersion',
          Properties: { Content: { S3Bucket: 'b', S3Key: 'k' } },
          Metadata: { 'aws:asset:path': 'asset.layer1' },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:WithLayer', [stack]);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]?.logicalId).toBe('MyLayer');
    expect(result.layers[0]?.assetPath).toMatch(/asset\.layer1$/);
  });

  it('resolves Fn::GetAtt-shaped layer references', () => {
    const stack = buildStack(
      'MyStack',
      {
        WithLayer: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Layers: [{ 'Fn::GetAtt': ['MyLayer', 'Ref'] }],
          },
          Metadata: { 'aws:asset:path': 'asset.fn' },
        },
        MyLayer: {
          Type: 'AWS::Lambda::LayerVersion',
          Properties: {},
          Metadata: { 'aws:asset:path': 'asset.layer1' },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:WithLayer', [stack]);
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]?.logicalId).toBe('MyLayer');
  });

  it('preserves Layers array order (last-wins relies on order)', () => {
    const stack = buildStack(
      'MyStack',
      {
        Multi: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Layers: [{ Ref: 'LayerA' }, { Ref: 'LayerB' }, { Ref: 'LayerC' }],
          },
          Metadata: { 'aws:asset:path': 'asset.fn' },
        },
        LayerA: {
          Type: 'AWS::Lambda::LayerVersion',
          Properties: {},
          Metadata: { 'aws:asset:path': 'asset.la' },
        },
        LayerB: {
          Type: 'AWS::Lambda::LayerVersion',
          Properties: {},
          Metadata: { 'aws:asset:path': 'asset.lb' },
        },
        LayerC: {
          Type: 'AWS::Lambda::LayerVersion',
          Properties: {},
          Metadata: { 'aws:asset:path': 'asset.lc' },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:Multi', [stack]);
    expect(result.layers.map((l) => l.logicalId)).toEqual(['LayerA', 'LayerB', 'LayerC']);
  });

  it('rejects literal-ARN layer entries (cross-account / pre-existing — out of scope)', () => {
    const stack = buildStack(
      'MyStack',
      {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Layers: ['arn:aws:lambda:us-east-1:123456789012:layer:External:1'],
          },
          Metadata: { 'aws:asset:path': 'asset.fn' },
        },
      },
      tmpRoot
    );
    expect(() => resolveLambdaTarget('MyStack:Fn', [stack])).toThrow(
      /literal ARN.*External.*Only same-stack/
    );
  });

  it('rejects a layer Ref that points at a non-LayerVersion resource', () => {
    const stack = buildStack(
      'MyStack',
      {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Layers: [{ Ref: 'MyTable' }],
          },
          Metadata: { 'aws:asset:path': 'asset.fn' },
        },
        MyTable: { Type: 'AWS::DynamoDB::Table', Properties: {} },
      },
      tmpRoot
    );
    expect(() => resolveLambdaTarget('MyStack:Fn', [stack])).toThrow(
      /references 'MyTable'.*AWS::DynamoDB::Table/
    );
  });

  it('rejects a layer Ref that points at an unknown logical ID', () => {
    const stack = buildStack(
      'MyStack',
      {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Layers: [{ Ref: 'Missing' }],
          },
          Metadata: { 'aws:asset:path': 'asset.fn' },
        },
      },
      tmpRoot
    );
    expect(() => resolveLambdaTarget('MyStack:Fn', [stack])).toThrow(
      /references 'Missing'.*no resource with that logical ID/
    );
  });

  it('rejects a layer with no aws:asset:path Metadata (no local directory to mount)', () => {
    const stack = buildStack(
      'MyStack',
      {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Layers: [{ Ref: 'MyLayer' }],
          },
          Metadata: { 'aws:asset:path': 'asset.fn' },
        },
        MyLayer: {
          Type: 'AWS::Lambda::LayerVersion',
          Properties: { Content: { S3Bucket: 'b', S3Key: 'k' } },
          // No aws:asset:path → resolveAssetCodePath rejects.
        },
      },
      tmpRoot
    );
    expect(() => resolveLambdaTarget('MyStack:Fn', [stack])).toThrow(
      /Lambda 'MyLayer' has no Metadata\['aws:asset:path'\]/
    );
  });

  it('container Lambdas have layers: [] (silent ignore — AWS rejects layers on container images at deploy time)', () => {
    const stack = buildStack(
      'MyStack',
      {
        Container: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            PackageType: 'Image',
            Code: { ImageUri: { 'Fn::Sub': 'r:hash123abc' } },
            // Even with Layers in the template, the IMAGE branch
            // silently ignores them (matches AWS behavior).
            Layers: [{ Ref: 'NonExistent' }],
          },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:Container', [stack]);
    expect(result.kind).toBe('image');
    expect(result.layers).toEqual([]);
  });

  it('rejects a non-array Layers property', () => {
    const stack = buildStack(
      'MyStack',
      {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Layers: 'not-an-array',
          },
          Metadata: { 'aws:asset:path': 'asset.fn' },
        },
      },
      tmpRoot
    );
    expect(() => resolveLambdaTarget('MyStack:Fn', [stack])).toThrow(/non-array Layers/);
  });
});
