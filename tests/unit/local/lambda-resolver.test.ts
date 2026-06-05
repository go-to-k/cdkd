import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  LocalInvokeResolutionError,
  parseLayerVersionArn,
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
  cdkOutDir: string,
  region?: string
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
    ...(region !== undefined && { region }),
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

  // Issue #768 — ZIP Lambdas carry Architectures too (threaded to
  // `--platform` on the container run, like the IMAGE path).
  it('captures Architectures: [arm64] on a ZIP Lambda', () => {
    const stack = buildStack(
      'MyStack',
      {
        ArmZip: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'provided.al2023',
            Handler: 'bootstrap',
            Architectures: ['arm64'],
          },
          Metadata: { 'aws:asset:path': 'asset.armzip' },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:ArmZip', [stack]);
    expect(result.kind).toBe('zip');
    if (result.kind !== 'zip') return;
    expect(result.architecture).toBe('arm64');
  });

  it('defaults a ZIP Lambda Architectures to x86_64 when omitted', () => {
    const stack = buildStack(
      'MyStack',
      {
        DefaultZip: {
          Type: 'AWS::Lambda::Function',
          Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler' },
          Metadata: { 'aws:asset:path': 'asset.defaultzip' },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:DefaultZip', [stack]);
    expect(result.kind).toBe('zip');
    if (result.kind !== 'zip') return;
    expect(result.architecture).toBe('x86_64');
  });

  it('rejects an unsupported Architectures value on a ZIP Lambda', () => {
    const stack = buildStack(
      'MyStack',
      {
        BadZip: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Architectures: ['mips64'],
          },
          Metadata: { 'aws:asset:path': 'asset.badzip' },
        },
      },
      tmpRoot
    );
    expect(() => resolveLambdaTarget('MyStack:BadZip', [stack])).toThrow(
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

  // Issue #286 Gap 2 — Fn::Join Code.ImageUri shape (lambda.DockerImageCode.fromEcr)
  //
  // CDK 2.x synthesizes `lambda.DockerImageCode.fromEcr(repo, { tagOrDigest })`
  // as a Fn::Join over nested Fn::Select / Fn::Split / Fn::GetAtt against
  // the same-stack `AWS::ECR::Repository`. Captured via `cdk synth` + `jq`
  // from a real CDK app. The same canonical shape covers Lambda container
  // and ECS `ContainerImage.fromEcrRepository(...)`; the resolver is
  // shared via `src/local/intrinsic-image.ts`.

  it('rejects a same-stack fromEcr Fn::Join Code.ImageUri with a clear --from-state hint', () => {
    const stack = buildStack(
      'MyStack',
      {
        Repo1: {
          Type: 'AWS::ECR::Repository',
          Properties: {},
        },
        ContainerFn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            PackageType: 'Image',
            Code: {
              ImageUri: {
                'Fn::Join': [
                  '',
                  [
                    {
                      'Fn::Select': [
                        4,
                        { 'Fn::Split': [':', { 'Fn::GetAtt': ['Repo1', 'Arn'] }] },
                      ],
                    },
                    '.dkr.ecr.',
                    {
                      'Fn::Select': [
                        3,
                        { 'Fn::Split': [':', { 'Fn::GetAtt': ['Repo1', 'Arn'] }] },
                      ],
                    },
                    '.',
                    { Ref: 'AWS::URLSuffix' },
                    '/',
                    { Ref: 'Repo1' },
                    ':latest',
                  ],
                ],
              },
            },
          },
        },
      },
      tmpRoot
    );
    expect(() => resolveLambdaTarget('MyStack:ContainerFn', [stack])).toThrow(
      /references same-stack ECR repository 'Repo1' via Fn::Join/
    );
  });

  it('rejects a malformed Fn::Join Code.ImageUri with an unsupported-shape error', () => {
    const stack = buildStack(
      'MyStack',
      {
        Bad: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            PackageType: 'Image',
            Code: {
              ImageUri: {
                'Fn::Join': [42, ['a', 'b']],
              },
            },
          },
        },
      },
      tmpRoot
    );
    expect(() => resolveLambdaTarget('MyStack:Bad', [stack])).toThrow(
      /unsupported Fn::Join Code\.ImageUri shape.*delimiter must be a string/s
    );
  });

  it('rejects an imported-repo Fn::Join Code.ImageUri (no ECR ref + AWS::URLSuffix) with a clear hint', () => {
    // Imported-repo shape: literal acct-id + region + `Ref: AWS::URLSuffix`
    // + literal repo path. No same-stack `AWS::ECR::Repository`, so the
    // resolver's needs-state branch doesn't fire. Without pseudo-
    // parameter context the URLSuffix Ref can't be resolved, so the
    // helper returns not-applicable; the lambda-resolver layer then
    // surfaces a specific error rather than falling through to the ZIP
    // branch's misleading "no Runtime" message.
    const stack = buildStack(
      'MyStack',
      {
        ImportedRepoFn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            PackageType: 'Image',
            Code: {
              ImageUri: {
                'Fn::Join': [
                  '',
                  ['123456789012.dkr.ecr.us-east-1.', { Ref: 'AWS::URLSuffix' }, '/external:v1'],
                ],
              },
            },
          },
        },
      },
      tmpRoot
    );
    expect(() => resolveLambdaTarget('MyStack:ImportedRepoFn', [stack])).toThrow(
      /Fn::Join Code\.ImageUri that cdkd local invoke cannot resolve/
    );
  });

  it('resolves canonical fromImageAsset Fn::Join Code.ImageUri using region-derived URLSuffix (issue #637)', () => {
    // The canonical `lambda.DockerImageCode.fromImageAsset(...)` shape:
    // literal account / region / repo path + `Ref: AWS::URLSuffix`.
    // Pre-#637 this surfaced `not-applicable` and required `--from-state`
    // even though the only intrinsic was URLSuffix (derivable from
    // region). Post-#637 the resolver substitutes URLSuffix using
    // `stack.region` and the URI resolves cleanly.
    const stack = buildStack(
      'MyStack',
      {
        AssetFn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            PackageType: 'Image',
            Code: {
              ImageUri: {
                'Fn::Join': [
                  '',
                  [
                    '123456789012.dkr.ecr.us-east-1.',
                    { Ref: 'AWS::URLSuffix' },
                    '/cdk-hnb659fds-container-assets-123456789012-us-east-1:abc123',
                  ],
                ],
              },
            },
          },
        },
      },
      tmpRoot,
      'us-east-1'
    );
    const resolved = resolveLambdaTarget('MyStack:AssetFn', [stack]);
    expect(resolved.kind).toBe('image');
    if (resolved.kind !== 'image') return;
    expect(resolved.imageUri).toBe(
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/cdk-hnb659fds-container-assets-123456789012-us-east-1:abc123'
    );
  });

  it('resolves canonical fromImageAsset shape against aws-cn partition (issue #637)', () => {
    const stack = buildStack(
      'MyStack',
      {
        AssetFn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            PackageType: 'Image',
            Code: {
              ImageUri: {
                'Fn::Join': [
                  '',
                  [
                    '123456789012.dkr.ecr.cn-north-1.',
                    { Ref: 'AWS::URLSuffix' },
                    '/cdk-hnb659fds-container-assets-123456789012-cn-north-1:abc123',
                  ],
                ],
              },
            },
          },
        },
      },
      tmpRoot,
      'cn-north-1'
    );
    const resolved = resolveLambdaTarget('MyStack:AssetFn', [stack]);
    expect(resolved.kind).toBe('image');
    if (resolved.kind !== 'image') return;
    expect(resolved.imageUri).toBe(
      '123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn/cdk-hnb659fds-container-assets-123456789012-cn-north-1:abc123'
    );
  });

  it('resolves a literal-only Fn::Join Code.ImageUri without state (public image)', () => {
    // Edge case: a Fn::Join with no intrinsic refs is just a string
    // concat. The shared resolver handles this so a hand-crafted
    // template (or a future CDK that flattens to Fn::Join) works.
    const stack = buildStack(
      'MyStack',
      {
        PublicJoinFn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            PackageType: 'Image',
            Code: {
              ImageUri: {
                'Fn::Join': ['', ['public.ecr.aws/', 'lambda/nodejs:20']],
              },
            },
          },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:PublicJoinFn', [stack]);
    expect(result.kind).toBe('image');
    if (result.kind !== 'image') return;
    expect(result.imageUri).toBe('public.ecr.aws/lambda/nodejs:20');
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

  it("rejects the YAML-only Fn::GetAtt string form ('LogicalId.attr') — CFn JSON never emits it", () => {
    // Issue #241 item 5: CloudFormation YAML accepts the dot-shorthand
    // `Fn::GetAtt: '<LogicalId>.<attr>'` and converts it to the array
    // form on the wire, but CDK's `cdk synth` output (CFn JSON, the only
    // thing cdkd ingests) never emits the string form. Surfacing it as
    // resolvable would silently accept hand-edited / malformed templates;
    // we hard-error so the offending shape is called out.
    const stack = buildStack(
      'MyStack',
      {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Layers: [{ 'Fn::GetAtt': 'MyLayer.Ref' }],
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
    expect(() => resolveLambdaTarget('MyStack:Fn', [stack])).toThrow(
      /cdkd cannot resolve locally.*Expected a same-stack Ref \/ Fn::GetAtt/
    );
  });

  it('resolves literal-ARN layer entries (cross-account / pre-existing — issue #448)', () => {
    // PR #491 review NICE-TO-HAVE: use `expect.assertions(...)` so the
    // type-narrowed `if (layer.kind === 'arn')` block fails loudly when
    // the kind discriminator is wrong (instead of silently no-op'ing
    // through every nested assertion).
    expect.assertions(8);
    const stack = buildStack(
      'MyStack',
      {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Layers: ['arn:aws:lambda:us-east-1:123456789012:layer:External:7'],
          },
          Metadata: { 'aws:asset:path': 'asset.fn' },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:Fn', [stack]);
    expect(result.layers).toHaveLength(1);
    const layer = result.layers[0]!;
    expect(layer.kind).toBe('arn');
    if (layer.kind === 'arn') {
      expect(layer.arn).toBe('arn:aws:lambda:us-east-1:123456789012:layer:External:7');
      expect(layer.region).toBe('us-east-1');
      expect(layer.accountId).toBe('123456789012');
      expect(layer.name).toBe('External');
      expect(layer.version).toBe('7');
      expect(layer.logicalId).toBe(layer.arn);
    }
  });

  it('preserves order across multiple literal-ARN layer entries (last-wins relies on order)', () => {
    // PR #491 review MUST-FIX 2: the materialization pass in
    // `local-invoke.ts` / `local-start-api.ts` walks `lambda.layers`
    // sequentially and `cpSync({force: true})`-merges them in order;
    // AWS's "last layer wins" file-collision semantic ONLY works if the
    // resolver hands us the array in template order. This pins it for
    // the all-ARN case.
    const stack = buildStack(
      'MyStack',
      {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Layers: [
              'arn:aws:lambda:us-east-1:123456789012:layer:LayerA:1',
              'arn:aws:lambda:us-east-1:123456789012:layer:LayerB:2',
              'arn:aws:lambda:us-east-1:123456789012:layer:LayerC:3',
            ],
          },
          Metadata: { 'aws:asset:path': 'asset.fn' },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:Fn', [stack]);
    expect(result.layers).toHaveLength(3);
    expect(result.layers.map((l) => l.kind)).toEqual(['arn', 'arn', 'arn']);
    // Order MUST be preserved exactly as templated.
    expect(result.layers.map((l) => l.logicalId)).toEqual([
      'arn:aws:lambda:us-east-1:123456789012:layer:LayerA:1',
      'arn:aws:lambda:us-east-1:123456789012:layer:LayerB:2',
      'arn:aws:lambda:us-east-1:123456789012:layer:LayerC:3',
    ]);
  });

  it('preserves order for mixed [asset, arn] layer entries — asset first', () => {
    // PR #491 review MUST-FIX 2: same-stack asset + literal ARN
    // interleaved. The materializer merges `lambda.layers` in this
    // order; flipping a-then-b vs b-then-a would change which file wins
    // on collision. Verify both directions.
    const stack = buildStack(
      'MyStack',
      {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Layers: [
              { Ref: 'AssetLayer' },
              'arn:aws:lambda:us-east-1:123456789012:layer:External:5',
            ],
          },
          Metadata: { 'aws:asset:path': 'asset.fn' },
        },
        AssetLayer: {
          Type: 'AWS::Lambda::LayerVersion',
          Properties: {},
          Metadata: { 'aws:asset:path': 'asset.al' },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:Fn', [stack]);
    expect(result.layers).toHaveLength(2);
    expect(result.layers.map((l) => l.kind)).toEqual(['asset', 'arn']);
    expect(result.layers[0]!.logicalId).toBe('AssetLayer');
    expect(result.layers[1]!.logicalId).toBe(
      'arn:aws:lambda:us-east-1:123456789012:layer:External:5'
    );
  });

  it('preserves order for mixed [arn, asset] layer entries — arn first', () => {
    // PR #491 review MUST-FIX 2: reverse direction of the previous test.
    const stack = buildStack(
      'MyStack',
      {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            Layers: [
              'arn:aws:lambda:us-east-1:123456789012:layer:External:5',
              { Ref: 'AssetLayer' },
            ],
          },
          Metadata: { 'aws:asset:path': 'asset.fn' },
        },
        AssetLayer: {
          Type: 'AWS::Lambda::LayerVersion',
          Properties: {},
          Metadata: { 'aws:asset:path': 'asset.al' },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:Fn', [stack]);
    expect(result.layers).toHaveLength(2);
    expect(result.layers.map((l) => l.kind)).toEqual(['arn', 'asset']);
    expect(result.layers[0]!.logicalId).toBe(
      'arn:aws:lambda:us-east-1:123456789012:layer:External:5'
    );
    expect(result.layers[1]!.logicalId).toBe('AssetLayer');
  });

  it('rejects malformed string entries that are not a valid layer-version ARN', () => {
    const stack = buildStack(
      'MyStack',
      {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            // Wrong service segment.
            Layers: ['arn:aws:s3:::my-layer-bucket'],
          },
          Metadata: { 'aws:asset:path': 'asset.fn' },
        },
      },
      tmpRoot
    );
    expect(() => resolveLambdaTarget('MyStack:Fn', [stack])).toThrow(
      /literal string.*arn:aws:s3:::my-layer-bucket.*Expected a same-stack Ref/
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

  // Issue #440 — Lambda Properties.EphemeralStorage.Size
  //
  // CDK 2.x's `lambda.Function({ ephemeralStorageSize: cdk.Size.gibibytes(N) })`
  // synthesizes `EphemeralStorage: { Size: N * 1024 }`. The resolver
  // surfaces it on `ResolvedLambda.ephemeralStorageMb`; the CLI plumbs
  // it through to docker's `--tmpfs /tmp:size=Nm` so handlers exceeding
  // the cap fail locally the way they would on AWS.

  it('surfaces EphemeralStorage.Size on a ZIP Lambda', () => {
    const stack = buildStack(
      'MyStack',
      {
        Big: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            EphemeralStorage: { Size: 1024 },
          },
          Metadata: { 'aws:asset:path': 'asset.big' },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:Big', [stack]);
    expect(result.ephemeralStorageMb).toBe(1024);
  });

  it('surfaces EphemeralStorage.Size on an IMAGE Lambda', () => {
    const stack = buildStack(
      'MyStack',
      {
        Container: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            PackageType: 'Image',
            Code: { ImageUri: { 'Fn::Sub': 'r:hash123abc' } },
            EphemeralStorage: { Size: 2048 },
          },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:Container', [stack]);
    expect(result.kind).toBe('image');
    expect(result.ephemeralStorageMb).toBe(2048);
  });

  it('omits ephemeralStorageMb when EphemeralStorage is absent', () => {
    const stack = buildStack(
      'MyStack',
      {
        NoEs: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
          },
          Metadata: { 'aws:asset:path': 'asset.noes' },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:NoEs', [stack]);
    expect(result.ephemeralStorageMb).toBeUndefined();
  });

  it('rejects EphemeralStorage.Size > 10240 with an actionable error', () => {
    const stack = buildStack(
      'MyStack',
      {
        TooBig: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            EphemeralStorage: { Size: 20000 },
          },
          Metadata: { 'aws:asset:path': 'asset.toobig' },
        },
      },
      tmpRoot
    );
    expect(() => resolveLambdaTarget('MyStack:TooBig', [stack])).toThrow(
      /exceeds the AWS limit of 10240 MiB/
    );
  });

  it('floors fractional EphemeralStorage.Size values', () => {
    const stack = buildStack(
      'MyStack',
      {
        Frac: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            EphemeralStorage: { Size: 1024.7 },
          },
          Metadata: { 'aws:asset:path': 'asset.frac' },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:Frac', [stack]);
    expect(result.ephemeralStorageMb).toBe(1024);
  });

  it('drops EphemeralStorage when Size is an intrinsic / non-numeric', () => {
    const stack = buildStack(
      'MyStack',
      {
        IntrinsicEs: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            // CFn allows `{Ref: 'SomeParam'}` for Size in theory; cdkd
            // can't resolve it without the Parameters context the
            // deploy engine has, so the safe fallback is to drop the
            // `--tmpfs` flag and let the container's `/tmp` come from
            // the base image (matches the pre-#440 behavior).
            EphemeralStorage: { Size: { Ref: 'TmpSize' } },
          },
          Metadata: { 'aws:asset:path': 'asset.intrinsic' },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:IntrinsicEs', [stack]);
    expect(result.ephemeralStorageMb).toBeUndefined();
  });

  it('drops EphemeralStorage when the property is malformed (non-object)', () => {
    const stack = buildStack(
      'MyStack',
      {
        BadShape: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Runtime: 'nodejs20.x',
            Handler: 'index.handler',
            EphemeralStorage: 'not-an-object',
          },
          Metadata: { 'aws:asset:path': 'asset.badshape' },
        },
      },
      tmpRoot
    );
    const result = resolveLambdaTarget('MyStack:BadShape', [stack]);
    expect(result.ephemeralStorageMb).toBeUndefined();
  });
});

describe('parseLayerVersionArn (issue #448)', () => {
  it('parses a canonical commercial-partition layer ARN', () => {
    expect(parseLayerVersionArn('arn:aws:lambda:us-east-1:111122223333:layer:MyLayer:5')).toEqual({
      arn: 'arn:aws:lambda:us-east-1:111122223333:layer:MyLayer:5',
      region: 'us-east-1',
      accountId: '111122223333',
      name: 'MyLayer',
      version: '5',
    });
  });

  it('parses a hyphenated layer name', () => {
    expect(
      parseLayerVersionArn('arn:aws:lambda:eu-west-1:333344445555:layer:aws-lambda-powertools:42')
    ).toEqual({
      arn: 'arn:aws:lambda:eu-west-1:333344445555:layer:aws-lambda-powertools:42',
      region: 'eu-west-1',
      accountId: '333344445555',
      name: 'aws-lambda-powertools',
      version: '42',
    });
  });

  it('accepts GovCloud / China partitions', () => {
    expect(
      parseLayerVersionArn('arn:aws-us-gov:lambda:us-gov-west-1:111122223333:layer:Gov:1')?.region
    ).toBe('us-gov-west-1');
    expect(
      parseLayerVersionArn('arn:aws-cn:lambda:cn-north-1:111122223333:layer:CN:1')?.region
    ).toBe('cn-north-1');
  });

  it('rejects a non-Lambda ARN', () => {
    expect(parseLayerVersionArn('arn:aws:s3:::my-bucket')).toBeUndefined();
  });

  it('rejects a non-layer Lambda ARN (function ARN)', () => {
    expect(
      parseLayerVersionArn('arn:aws:lambda:us-east-1:111122223333:function:MyFn')
    ).toBeUndefined();
  });

  it('rejects an unversioned layer ARN', () => {
    expect(
      parseLayerVersionArn('arn:aws:lambda:us-east-1:111122223333:layer:MyLayer')
    ).toBeUndefined();
  });

  it('rejects a 13-digit account id (non-12)', () => {
    expect(
      parseLayerVersionArn('arn:aws:lambda:us-east-1:1111222233334:layer:MyLayer:1')
    ).toBeUndefined();
  });

  it('rejects non-numeric version', () => {
    expect(
      parseLayerVersionArn('arn:aws:lambda:us-east-1:111122223333:layer:MyLayer:latest')
    ).toBeUndefined();
  });
});
