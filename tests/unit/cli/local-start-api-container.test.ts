import { describe, expect, it } from 'vite-plus/test';
import { resolveLambdaByLogicalId } from '../../../src/cli/commands/local-start-api.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { TemplateResource } from '../../../src/types/resource.js';

/**
 * Coverage for `resolveLambdaByLogicalId`'s container-Lambda branch
 * (issue #453). The pre-fix code threw on any Lambda with
 * `Code.ImageUri`; the post-fix code returns a `kind: 'image'` resolved
 * shape carrying `imageUri` / `imageConfig` / `architecture` so the
 * downstream `buildContainerSpec` can run `docker build` /
 * `docker pull` and wire the resulting tag into the warm pool.
 *
 * Tests cover: every `Code.ImageUri` shape `cdk synth` emits (flat
 * string, `Fn::Sub` string-form, `Fn::Sub` array-form); architecture
 * defaulting and arm64 honoring; `ImageConfig` field forwarding;
 * rejection of unsupported `Architectures` values; ZIP path
 * regressions (still rejects when neither Runtime nor ImageUri is set,
 * still requires Handler on the ZIP branch).
 */

function makeStack(
  resources: Record<string, TemplateResource>,
  region?: string
): StackInfo {
  return {
    stackName: 'S',
    displayName: 'S',
    artifactId: 'S',
    template: { Resources: resources },
    dependencyNames: [],
    ...(region !== undefined && { region }),
  } as unknown as StackInfo;
}

const imageResource: TemplateResource = {
  Type: 'AWS::Lambda::Function',
  Properties: {
    Code: { ImageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag' },
    PackageType: 'Image',
    Architectures: ['x86_64'],
    MemorySize: 512,
    Timeout: 30,
    ImageConfig: {
      Command: ['app.handler'],
      WorkingDirectory: '/var/task',
    },
  },
};

describe('resolveLambdaByLogicalId — IMAGE branch (issue #453)', () => {
  it('returns kind:image for Code.ImageUri (flat-string shape)', () => {
    const resolved = resolveLambdaByLogicalId('Fn', [makeStack({ Fn: imageResource })]);
    expect(resolved.kind).toBe('image');
    if (resolved.kind !== 'image') throw new Error('TS narrowing');
    expect(resolved.imageUri).toBe('123456789012.dkr.ecr.us-east-1.amazonaws.com/repo:tag');
    expect(resolved.imageConfig.command).toEqual(['app.handler']);
    expect(resolved.imageConfig.workingDirectory).toBe('/var/task');
    expect(resolved.architecture).toBe('x86_64');
    expect(resolved.memoryMb).toBe(512);
    expect(resolved.timeoutSec).toBe(30);
    expect(resolved.layers).toEqual([]); // always [] on the IMAGE branch
  });

  it('returns kind:image for Code.ImageUri Fn::Sub (string form, the cdk-asset canonical shape)', () => {
    const subResource: TemplateResource = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Code: {
          ImageUri: {
            'Fn::Sub':
              '${AWS::AccountId}.dkr.ecr.${AWS::Region}.${AWS::URLSuffix}/cdk-hnb659fds-container-assets-${AWS::AccountId}-${AWS::Region}:abc123',
          },
        },
        PackageType: 'Image',
      },
    };
    const resolved = resolveLambdaByLogicalId('Fn', [makeStack({ Fn: subResource })]);
    expect(resolved.kind).toBe('image');
    if (resolved.kind !== 'image') throw new Error('TS narrowing');
    // Fn::Sub string-form passes through verbatim; downstream the
    // cdk-assets manifest lookup substitutes the ${AWS::*} placeholders.
    expect(resolved.imageUri).toContain('cdk-hnb659fds-container-assets');
    expect(resolved.imageUri).toContain(':abc123');
  });

  it('returns kind:image for Code.ImageUri Fn::Sub (array form: [template, vars])', () => {
    const subArrayResource: TemplateResource = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Code: {
          ImageUri: {
            'Fn::Sub': ['repo:${Tag}', { Tag: 'abc123' }],
          },
        },
        PackageType: 'Image',
      },
    };
    const resolved = resolveLambdaByLogicalId('Fn', [makeStack({ Fn: subArrayResource })]);
    expect(resolved.kind).toBe('image');
    if (resolved.kind !== 'image') throw new Error('TS narrowing');
    expect(resolved.imageUri).toBe('repo:${Tag}');
  });

  it('honors Architectures: [arm64]', () => {
    const armResource: TemplateResource = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Code: { ImageUri: 'repo:tag' },
        PackageType: 'Image',
        Architectures: ['arm64'],
      },
    };
    const resolved = resolveLambdaByLogicalId('Fn', [makeStack({ Fn: armResource })]);
    if (resolved.kind !== 'image') throw new Error('TS narrowing');
    expect(resolved.architecture).toBe('arm64');
  });

  it('defaults architecture to x86_64 when Architectures is absent', () => {
    const resource: TemplateResource = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Code: { ImageUri: 'repo:tag' },
        PackageType: 'Image',
      },
    };
    const resolved = resolveLambdaByLogicalId('Fn', [makeStack({ Fn: resource })]);
    if (resolved.kind !== 'image') throw new Error('TS narrowing');
    expect(resolved.architecture).toBe('x86_64');
  });

  it('rejects unsupported Architectures values', () => {
    const resource: TemplateResource = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Code: { ImageUri: 'repo:tag' },
        PackageType: 'Image',
        Architectures: ['mips64'],
      },
    };
    expect(() => resolveLambdaByLogicalId('Fn', [makeStack({ Fn: resource })])).toThrow(
      /unsupported Architectures value 'mips64'/
    );
  });

  it('forwards ImageConfig.EntryPoint when set', () => {
    const resource: TemplateResource = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Code: { ImageUri: 'repo:tag' },
        PackageType: 'Image',
        ImageConfig: {
          EntryPoint: ['/usr/bin/python3', '-u'],
          Command: ['app.handler'],
        },
      },
    };
    const resolved = resolveLambdaByLogicalId('Fn', [makeStack({ Fn: resource })]);
    if (resolved.kind !== 'image') throw new Error('TS narrowing');
    expect(resolved.imageConfig.entryPoint).toEqual(['/usr/bin/python3', '-u']);
    expect(resolved.imageConfig.command).toEqual(['app.handler']);
  });

  it('omits ImageConfig fields when not set', () => {
    const resource: TemplateResource = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Code: { ImageUri: 'repo:tag' },
        PackageType: 'Image',
      },
    };
    const resolved = resolveLambdaByLogicalId('Fn', [makeStack({ Fn: resource })]);
    if (resolved.kind !== 'image') throw new Error('TS narrowing');
    expect(resolved.imageConfig.command).toBeUndefined();
    expect(resolved.imageConfig.entryPoint).toBeUndefined();
    expect(resolved.imageConfig.workingDirectory).toBeUndefined();
  });

  it('returns kind:zip for ZIP Lambdas (regression — pre-fix sole path)', () => {
    const zipResource: TemplateResource = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Code: { S3Bucket: 'b', S3Key: 'k' },
      },
      Metadata: { 'aws:asset:path': '/tmp/some-asset' },
    };
    // resolveAssetCodePath will try statSync('/tmp/some-asset') which may
    // not exist — but for ZIP coverage, the kind-discriminator branch is
    // exercised inside resolveLambdaByLogicalId BEFORE the asset path
    // check fires. Use Code.ZipFile to avoid the filesystem hop.
    const inlineZipResource: TemplateResource = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Runtime: 'nodejs20.x',
        Handler: 'index.handler',
        Code: { ZipFile: 'exports.handler = () => ({});' },
      },
    };
    // Use the inline shape so the test doesn't depend on a real fs path.
    void zipResource;
    const resolved = resolveLambdaByLogicalId('Fn', [makeStack({ Fn: inlineZipResource })]);
    expect(resolved.kind).toBe('zip');
    if (resolved.kind !== 'zip') throw new Error('TS narrowing');
    expect(resolved.runtime).toBe('nodejs20.x');
    expect(resolved.handler).toBe('index.handler');
  });

  it('still rejects when neither Runtime nor Code.ImageUri is set', () => {
    const resource: TemplateResource = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Code: { ZipFile: 'exports.handler=()=>({});' },
      },
    };
    expect(() => resolveLambdaByLogicalId('Fn', [makeStack({ Fn: resource })])).toThrow(
      /no Runtime property and no Code\.ImageUri/
    );
  });

  it('still rejects ZIP Lambdas missing Handler', () => {
    const resource: TemplateResource = {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Runtime: 'nodejs20.x',
        Code: { ZipFile: 'exports.handler=()=>({});' },
      },
    };
    expect(() => resolveLambdaByLogicalId('Fn', [makeStack({ Fn: resource })])).toThrow(
      /no Handler property/
    );
  });

  it('still rejects when no AWS::Lambda::Function with the logical ID exists', () => {
    expect(() => resolveLambdaByLogicalId('NoSuch', [makeStack({})])).toThrow(
      /No AWS::Lambda::Function resource named 'NoSuch'/
    );
  });

  /**
   * Issue #627: `lambda.DockerImageCode.fromImageAsset(...)` in CDK 2.x
   * synthesizes an `Fn::Join` shape over the literal bootstrap ECR URI
   * with `${AWS::URLSuffix}` as the only intrinsic. Pre-fix
   * `extractImageUri` only recognized literal strings + `Fn::Sub`, so
   * the Lambda fell through to the ZIP branch's misleading "no Runtime"
   * hard error. Post-fix the `Fn::Join` arm routes through the shared
   * `tryResolveImageFnJoin` helper and surfaces a clear error naming
   * the actual root cause (pseudo-param substitution / same-stack ECR
   * ref needing state) instead.
   */
  describe('Code.ImageUri Fn::Join (issues #627 + #637)', () => {
    // The exact shape `cdk synth` emits for
    // `lambda.DockerImageCode.fromImageAsset(...)` — literal account /
    // region / repo path bracketing `Ref: AWS::URLSuffix`.
    const fromImageAssetJoin = (region: string): TemplateResource => ({
      Type: 'AWS::Lambda::Function',
      Properties: {
        Code: {
          ImageUri: {
            'Fn::Join': [
              '',
              [
                `123456789012.dkr.ecr.${region}.`,
                { Ref: 'AWS::URLSuffix' },
                `/cdk-hnb659fds-container-assets-123456789012-${region}:abc123`,
              ],
            ],
          },
        },
        PackageType: 'Image',
      },
    });

    it('resolves canonical fromImageAsset bootstrap-ECR shape under aws partition (issue #637)', () => {
      // #637 plumbs `derivePseudoParametersFromRegion` into the resolver
      // so the canonical fromImageAsset shape — only intrinsic is
      // `${AWS::URLSuffix}` — substitutes to `amazonaws.com` and the
      // Lambda boots locally.
      const resolved = resolveLambdaByLogicalId('Fn', [
        makeStack({ Fn: fromImageAssetJoin('us-east-1') }, 'us-east-1'),
      ]);
      expect(resolved.kind).toBe('image');
      if (resolved.kind !== 'image') return;
      expect(resolved.imageUri).toBe(
        '123456789012.dkr.ecr.us-east-1.amazonaws.com/cdk-hnb659fds-container-assets-123456789012-us-east-1:abc123'
      );
    });

    it('resolves canonical fromImageAsset shape under aws-cn partition (issue #637)', () => {
      const resolved = resolveLambdaByLogicalId('Fn', [
        makeStack({ Fn: fromImageAssetJoin('cn-north-1') }, 'cn-north-1'),
      ]);
      expect(resolved.kind).toBe('image');
      if (resolved.kind !== 'image') return;
      expect(resolved.imageUri).toBe(
        '123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn/cdk-hnb659fds-container-assets-123456789012-cn-north-1:abc123'
      );
    });

    it('resolves canonical fromImageAsset shape under aws-us-gov partition (issue #637)', () => {
      // GovCloud uses urlSuffix amazonaws.com (same as commercial), but
      // partition is aws-us-gov (not visible in the URI itself — the
      // partition matters for service ARNs elsewhere).
      const resolved = resolveLambdaByLogicalId('Fn', [
        makeStack({ Fn: fromImageAssetJoin('us-gov-west-1') }, 'us-gov-west-1'),
      ]);
      expect(resolved.kind).toBe('image');
      if (resolved.kind !== 'image') return;
      expect(resolved.imageUri).toBe(
        '123456789012.dkr.ecr.us-gov-west-1.amazonaws.com/cdk-hnb659fds-container-assets-123456789012-us-gov-west-1:abc123'
      );
    });

    it('throws a clear error when stack.region is undefined (fallback path)', () => {
      // No region context means we cannot derive urlSuffix / partition,
      // so the canonical fromImageAsset shape falls back to the
      // pre-#637 `not-applicable` branch. The error message names the
      // root cause specifically (stack.region was undefined).
      expect(() =>
        resolveLambdaByLogicalId('Fn', [makeStack({ Fn: fromImageAssetJoin('us-east-1') })])
      ).toThrow(/stack\.region was undefined/);
      // Regression guard against #627's pre-fix misleading "no Runtime"
      // hard error.
      expect(() =>
        resolveLambdaByLogicalId('Fn', [makeStack({ Fn: fromImageAssetJoin('us-east-1') })])
      ).not.toThrow(/no Runtime property/);
    });

    it('throws a clear "needs state" error for a same-stack ECR repository Fn::Join', () => {
      // The CDK 2.x `lambda.DockerImageCode.fromEcr(repo, ...)` shape —
      // same-stack ECR Repository ref + Ref: AWS::URLSuffix. Without
      // state we can't recover the repo's physical id, so the resolver
      // reports `needs-state` and we surface a `--from-state`-style hint.
      // start-api doesn't have `--from-state` today; the message
      // names the actual gap.
      const joinResource: TemplateResource = {
        Type: 'AWS::Lambda::Function',
        Properties: {
          Code: {
            ImageUri: {
              'Fn::Join': [
                '',
                [
                  { 'Fn::Select': [4, { 'Fn::Split': [':', { 'Fn::GetAtt': ['Repo', 'Arn'] }] }] },
                  '.dkr.ecr.',
                  { 'Fn::Select': [3, { 'Fn::Split': [':', { 'Fn::GetAtt': ['Repo', 'Arn'] }] }] },
                  '.',
                  { Ref: 'AWS::URLSuffix' },
                  '/',
                  { Ref: 'Repo' },
                  ':latest',
                ],
              ],
            },
          },
          PackageType: 'Image',
        },
      };
      const repoResource: TemplateResource = {
        Type: 'AWS::ECR::Repository',
        Properties: {},
      };
      expect(() =>
        resolveLambdaByLogicalId('Fn', [makeStack({ Fn: joinResource, Repo: repoResource })])
      ).toThrow(/same-stack ECR repository 'Repo'/);
      expect(() =>
        resolveLambdaByLogicalId('Fn', [makeStack({ Fn: joinResource, Repo: repoResource })])
      ).not.toThrow(/no Runtime property/);
    });

    it('throws a clear "unsupported Fn::Join shape" error for a malformed Fn::Join', () => {
      // Delimiter must be a string; this exercises the
      // `unsupported-join` arm.
      const joinResource: TemplateResource = {
        Type: 'AWS::Lambda::Function',
        Properties: {
          Code: {
            ImageUri: {
              'Fn::Join': [
                42,
                ['some', 'parts'],
              ],
            },
          },
          PackageType: 'Image',
        },
      };
      expect(() =>
        resolveLambdaByLogicalId('Fn', [makeStack({ Fn: joinResource })])
      ).toThrow(/unsupported Fn::Join Code\.ImageUri shape/);
    });
  });
});
