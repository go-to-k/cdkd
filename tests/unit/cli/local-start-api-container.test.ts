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

function makeStack(resources: Record<string, TemplateResource>): StackInfo {
  return {
    stackName: 'S',
    displayName: 'S',
    artifactId: 'S',
    template: { Resources: resources },
    dependencyNames: [],
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
});
