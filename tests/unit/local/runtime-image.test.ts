import { describe, expect, it } from 'vite-plus/test';
import {
  isSupportedRuntime,
  resolveRuntimeCodeMountPath,
  resolveRuntimeFileExtension,
  resolveRuntimeImage,
  resolveRuntimeSpec,
  UnsupportedRuntimeError,
} from '../../../src/local/runtime-image.js';

describe('resolveRuntimeImage', () => {
  it.each([
    ['nodejs18.x', 'public.ecr.aws/lambda/nodejs:18'],
    ['nodejs20.x', 'public.ecr.aws/lambda/nodejs:20'],
    ['nodejs22.x', 'public.ecr.aws/lambda/nodejs:22'],
    ['nodejs24.x', 'public.ecr.aws/lambda/nodejs:24'],
    ['python3.11', 'public.ecr.aws/lambda/python:3.11'],
    ['python3.12', 'public.ecr.aws/lambda/python:3.12'],
    ['python3.13', 'public.ecr.aws/lambda/python:3.13'],
    ['python3.14', 'public.ecr.aws/lambda/python:3.14'],
    ['ruby3.2', 'public.ecr.aws/lambda/ruby:3.2'],
    ['ruby3.3', 'public.ecr.aws/lambda/ruby:3.3'],
    ['java8.al2', 'public.ecr.aws/lambda/java:8.al2'],
    ['java11', 'public.ecr.aws/lambda/java:11'],
    ['java17', 'public.ecr.aws/lambda/java:17'],
    ['java21', 'public.ecr.aws/lambda/java:21'],
    ['dotnet6', 'public.ecr.aws/lambda/dotnet:6'],
    ['dotnet8', 'public.ecr.aws/lambda/dotnet:8'],
    ['provided.al2', 'public.ecr.aws/lambda/provided:al2'],
    ['provided.al2023', 'public.ecr.aws/lambda/provided:al2023'],
  ])('maps %s to %s', (runtime, expected) => {
    expect(resolveRuntimeImage(runtime)).toBe(expected);
  });

  it('rejects empty runtime (this branch is only reached for ZIP Lambdas)', () => {
    expect(() => resolveRuntimeImage('')).toThrow(UnsupportedRuntimeError);
    try {
      resolveRuntimeImage('');
    } catch (err) {
      // Container Lambdas now take a different code path (PR 5); this
      // branch is only reached when a ZIP Lambda has no Runtime
      // property — which is itself a malformed template.
      expect((err as Error).message).toMatch(/no Runtime property/);
    }
  });

  it('rejects deprecated go1.x with a migration pointer to provided.al2023', () => {
    expect(() => resolveRuntimeImage('go1.x')).toThrow(UnsupportedRuntimeError);
    try {
      resolveRuntimeImage('go1.x');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/deprecated/);
      expect(msg).toMatch(/2024-01-08/);
      expect(msg).toMatch(/PROVIDED_AL2023/);
      expect(msg).toMatch(/bootstrap/);
    }
  });

  it('no longer has a "follow in subsequent PRs" deferred branch (every AWS runtime is now either supported or deprecated)', () => {
    // Pre-#248 the unsupported-runtime path printed "Other runtimes
    // follow in subsequent PRs". With every Lambda runtime now either
    // resolved by SUPPORTED_RUNTIMES, special-cased as deprecated
    // (go1.x), or rejected as unknown, that wording is gone.
    for (const r of ['nodejs10.x', 'python2.7', 'dotnetcore3.1', 'lolcat1.0']) {
      try {
        resolveRuntimeImage(r);
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).not.toMatch(/follow in subsequent PRs/);
      }
    }
  });

  it('rejects unrecognized java versions through the unknown-runtime branch (java is no longer in the prefix-deferred list)', () => {
    // java19 has no AWS Lambda base image. With Java now supported, this
    // should land in the unknown-runtime branch (not the deferred-prefix
    // branch), so the message lists all supported runtimes — including
    // the supported Java versions — to route the user to a real version.
    expect(() => resolveRuntimeImage('java19')).toThrow(/Unknown runtime/);
    try {
      resolveRuntimeImage('java19');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/java17/);
      expect(msg).toMatch(/java21/);
    }
  });

  it('rejects unrecognized dotnet versions through the unknown-runtime branch (dotnet is no longer in the prefix-deferred list)', () => {
    // dotnet9 was added in CDK lib but not yet in cdkd's supported set.
    // Now that some dotnet versions are supported, this should land in
    // the unknown-runtime branch (not the prefix-deferred branch).
    expect(() => resolveRuntimeImage('dotnet9')).toThrow(/Unknown runtime/);
    try {
      resolveRuntimeImage('dotnet9');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/dotnet6/);
      expect(msg).toMatch(/dotnet8/);
    }
  });

  it('rejects unknown runtime strings with a clear message that lists every supported runtime', () => {
    expect(() => resolveRuntimeImage('lolcat1.0')).toThrow(/Unknown runtime/);
    try {
      resolveRuntimeImage('lolcat1.0');
    } catch (err) {
      const msg = (err as Error).message;
      // The "supported runtimes" line should mention Node, Python, Ruby, and Java.
      expect(msg).toMatch(/nodejs20\.x/);
      expect(msg).toMatch(/nodejs24\.x/);
      expect(msg).toMatch(/python3\.12/);
      expect(msg).toMatch(/python3\.14/);
      expect(msg).toMatch(/ruby3\.2/);
      expect(msg).toMatch(/ruby3\.3/);
      expect(msg).toMatch(/java11/);
      expect(msg).toMatch(/java8\.al2/);
      expect(msg).toMatch(/java17/);
      expect(msg).toMatch(/java21/);
      expect(msg).toMatch(/dotnet6/);
      expect(msg).toMatch(/dotnet8/);
      expect(msg).toMatch(/provided\.al2/);
      expect(msg).toMatch(/provided\.al2023/);
    }
  });
});

describe('resolveRuntimeFileExtension', () => {
  it.each([
    ['nodejs18.x', '.js'],
    ['nodejs20.x', '.js'],
    ['nodejs22.x', '.js'],
    ['nodejs24.x', '.js'],
    ['python3.11', '.py'],
    ['python3.12', '.py'],
    ['python3.13', '.py'],
    ['python3.14', '.py'],
    ['ruby3.2', '.rb'],
    ['ruby3.3', '.rb'],
  ])('maps %s to %s', (runtime, expected) => {
    expect(resolveRuntimeFileExtension(runtime)).toBe(expected);
  });

  it('rejects unsupported runtimes the same way resolveRuntimeImage does', () => {
    expect(() => resolveRuntimeFileExtension('go1.x')).toThrow(UnsupportedRuntimeError);
    expect(() => resolveRuntimeFileExtension('')).toThrow(UnsupportedRuntimeError);
  });

  it.each([
    'java8.al2',
    'java11',
    'java17',
    'java21',
    'dotnet6',
    'dotnet8',
    'provided.al2',
    'provided.al2023',
  ])(
    'rejects inline Code.ZipFile for compiled-artifact runtime %s with a message routing to Code.fromAsset',
    (runtime) => {
      expect(() => resolveRuntimeFileExtension(runtime)).toThrow(UnsupportedRuntimeError);
      try {
        resolveRuntimeFileExtension(runtime);
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toMatch(/Inline 'Code\.ZipFile' is not supported/);
        expect(msg).toMatch(/lambda\.Code\.fromAsset/);
        expect(msg).toContain(runtime);
      }
    }
  );
});

describe('resolveRuntimeSpec', () => {
  it('returns both image and fileExtension in one shot', () => {
    expect(resolveRuntimeSpec('python3.12')).toEqual({
      image: 'public.ecr.aws/lambda/python:3.12',
      fileExtension: '.py',
    });
    expect(resolveRuntimeSpec('nodejs22.x')).toEqual({
      image: 'public.ecr.aws/lambda/nodejs:22',
      fileExtension: '.js',
    });
    expect(resolveRuntimeSpec('ruby3.3')).toEqual({
      image: 'public.ecr.aws/lambda/ruby:3.3',
      fileExtension: '.rb',
    });
  });

  it('returns fileExtension: null for Java entries — inline materialization is unsupported (use Code.fromAsset)', () => {
    expect(resolveRuntimeSpec('java17')).toEqual({
      image: 'public.ecr.aws/lambda/java:17',
      fileExtension: null,
    });
    expect(resolveRuntimeSpec('java8.al2')).toEqual({
      image: 'public.ecr.aws/lambda/java:8.al2',
      fileExtension: null,
    });
  });

  it('returns fileExtension: null for .NET entries — inline materialization is unsupported (use Code.fromAsset)', () => {
    expect(resolveRuntimeSpec('dotnet8')).toEqual({
      image: 'public.ecr.aws/lambda/dotnet:8',
      fileExtension: null,
    });
    expect(resolveRuntimeSpec('dotnet6')).toEqual({
      image: 'public.ecr.aws/lambda/dotnet:6',
      fileExtension: null,
    });
  });

  it('returns fileExtension: null for OS-only provided.* entries — host an arbitrary bootstrap binary via Code.fromAsset', () => {
    expect(resolveRuntimeSpec('provided.al2023')).toEqual({
      image: 'public.ecr.aws/lambda/provided:al2023',
      fileExtension: null,
    });
    expect(resolveRuntimeSpec('provided.al2')).toEqual({
      image: 'public.ecr.aws/lambda/provided:al2',
      fileExtension: null,
    });
  });
});

describe('resolveRuntimeCodeMountPath', () => {
  it.each([
    'nodejs20.x',
    'nodejs24.x',
    'python3.12',
    'python3.14',
    'ruby3.3',
    'java17',
    'java8.al2',
    'dotnet8',
    'dotnet6',
  ])('returns /var/task for non-provided runtime %s', (runtime) => {
    expect(resolveRuntimeCodeMountPath(runtime)).toBe('/var/task');
  });

  it.each(['provided.al2', 'provided.al2023'])(
    'returns /var/runtime for provided.* runtime %s (Lambda base image hardcodes the bootstrap path)',
    (runtime) => {
      expect(resolveRuntimeCodeMountPath(runtime)).toBe('/var/runtime');
    }
  );

  it('throws for unsupported runtimes — validation matches resolveRuntimeImage', () => {
    expect(() => resolveRuntimeCodeMountPath('go1.x')).toThrow(UnsupportedRuntimeError);
    expect(() => resolveRuntimeCodeMountPath('lolcat1.0')).toThrow(UnsupportedRuntimeError);
    expect(() => resolveRuntimeCodeMountPath('')).toThrow(UnsupportedRuntimeError);
  });
});

describe('isSupportedRuntime', () => {
  it('returns true for every current AWS Lambda runtime, false otherwise', () => {
    expect(isSupportedRuntime('nodejs20.x')).toBe(true);
    expect(isSupportedRuntime('nodejs24.x')).toBe(true);
    expect(isSupportedRuntime('python3.12')).toBe(true);
    expect(isSupportedRuntime('python3.11')).toBe(true);
    expect(isSupportedRuntime('python3.13')).toBe(true);
    expect(isSupportedRuntime('python3.14')).toBe(true);
    expect(isSupportedRuntime('ruby3.2')).toBe(true);
    expect(isSupportedRuntime('ruby3.3')).toBe(true);
    expect(isSupportedRuntime('java8.al2')).toBe(true);
    expect(isSupportedRuntime('java11')).toBe(true);
    expect(isSupportedRuntime('java17')).toBe(true);
    expect(isSupportedRuntime('java21')).toBe(true);
    expect(isSupportedRuntime('dotnet6')).toBe(true);
    expect(isSupportedRuntime('dotnet8')).toBe(true);
    expect(isSupportedRuntime('provided.al2')).toBe(true);
    expect(isSupportedRuntime('provided.al2023')).toBe(true);
    // Deprecated / unknown runtimes don't count as supported (they go
    // through the rejection / unknown-runtime branches in resolveRuntimeSpec).
    expect(isSupportedRuntime('go1.x')).toBe(false);
    expect(isSupportedRuntime('ruby3.1')).toBe(false);
    expect(isSupportedRuntime('python3.10')).toBe(false);
    expect(isSupportedRuntime('java19')).toBe(false);
    expect(isSupportedRuntime('java8')).toBe(false);
    expect(isSupportedRuntime('dotnet9')).toBe(false);
    expect(isSupportedRuntime('dotnetcore3.1')).toBe(false);
    expect(isSupportedRuntime('provided')).toBe(false);
    expect(isSupportedRuntime('')).toBe(false);
  });
});
