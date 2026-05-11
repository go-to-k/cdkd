import { describe, expect, it } from 'vitest';
import {
  isSupportedRuntime,
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

  it('rejects java / go / dotnet / provided runtimes (Ruby is no longer in the deferred list)', () => {
    for (const r of ['java17', 'go1.x', 'dotnet8', 'provided.al2', 'provided.al2023']) {
      expect(() => resolveRuntimeImage(r)).toThrow(UnsupportedRuntimeError);
      try {
        resolveRuntimeImage(r);
      } catch (err) {
        // Ruby should no longer appear in the rejection message — it's
        // now a supported runtime.
        const msg = (err as Error).message;
        expect(msg).not.toMatch(/Ruby is planned/);
        expect(msg).not.toMatch(/Ruby.*deferred/);
      }
    }
  });

  it('rejects unknown runtime strings with a clear message that lists every supported runtime', () => {
    expect(() => resolveRuntimeImage('lolcat1.0')).toThrow(/Unknown runtime/);
    try {
      resolveRuntimeImage('lolcat1.0');
    } catch (err) {
      const msg = (err as Error).message;
      // The "supported runtimes" line should now mention Node, Python, and Ruby.
      expect(msg).toMatch(/nodejs20\.x/);
      expect(msg).toMatch(/nodejs24\.x/);
      expect(msg).toMatch(/python3\.12/);
      expect(msg).toMatch(/python3\.14/);
      expect(msg).toMatch(/ruby3\.2/);
      expect(msg).toMatch(/ruby3\.3/);
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
    expect(() => resolveRuntimeFileExtension('java17')).toThrow(UnsupportedRuntimeError);
    expect(() => resolveRuntimeFileExtension('')).toThrow(UnsupportedRuntimeError);
  });
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
});

describe('isSupportedRuntime', () => {
  it('returns true for Node.js, Python, and Ruby supported sets, false otherwise', () => {
    expect(isSupportedRuntime('nodejs20.x')).toBe(true);
    expect(isSupportedRuntime('nodejs24.x')).toBe(true);
    expect(isSupportedRuntime('python3.12')).toBe(true);
    expect(isSupportedRuntime('python3.11')).toBe(true);
    expect(isSupportedRuntime('python3.13')).toBe(true);
    expect(isSupportedRuntime('python3.14')).toBe(true);
    expect(isSupportedRuntime('ruby3.2')).toBe(true);
    expect(isSupportedRuntime('ruby3.3')).toBe(true);
    expect(isSupportedRuntime('ruby3.1')).toBe(false);
    expect(isSupportedRuntime('python3.10')).toBe(false);
    expect(isSupportedRuntime('java17')).toBe(false);
    expect(isSupportedRuntime('')).toBe(false);
  });
});
