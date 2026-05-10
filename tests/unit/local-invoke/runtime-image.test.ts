import { describe, expect, it } from 'vitest';
import {
  isSupportedRuntime,
  resolveRuntimeFileExtension,
  resolveRuntimeImage,
  resolveRuntimeSpec,
  UnsupportedRuntimeError,
} from '../../../src/local-invoke/runtime-image.js';

describe('resolveRuntimeImage', () => {
  it.each([
    ['nodejs18.x', 'public.ecr.aws/lambda/nodejs:18'],
    ['nodejs20.x', 'public.ecr.aws/lambda/nodejs:20'],
    ['nodejs22.x', 'public.ecr.aws/lambda/nodejs:22'],
    ['python3.11', 'public.ecr.aws/lambda/python:3.11'],
    ['python3.12', 'public.ecr.aws/lambda/python:3.12'],
    ['python3.13', 'public.ecr.aws/lambda/python:3.13'],
  ])('maps %s to %s', (runtime, expected) => {
    expect(resolveRuntimeImage(runtime)).toBe(expected);
  });

  it('rejects empty runtime with a hint at container Lambdas', () => {
    expect(() => resolveRuntimeImage('')).toThrow(UnsupportedRuntimeError);
    try {
      resolveRuntimeImage('');
    } catch (err) {
      expect((err as Error).message).toMatch(/Container-image Lambdas/);
    }
  });

  it('rejects java / go / ruby / dotnet / provided runtimes (Python is no longer in the deferred list)', () => {
    for (const r of ['java17', 'go1.x', 'ruby3.2', 'dotnet8', 'provided.al2']) {
      expect(() => resolveRuntimeImage(r)).toThrow(UnsupportedRuntimeError);
      try {
        resolveRuntimeImage(r);
      } catch (err) {
        // Python should no longer appear in the rejection message — it's
        // now a supported runtime.
        const msg = (err as Error).message;
        expect(msg).not.toMatch(/Python is planned/);
        expect(msg).not.toMatch(/Python.*deferred/);
      }
    }
  });

  it('rejects unknown runtime strings with a clear message that lists every supported runtime', () => {
    expect(() => resolveRuntimeImage('lolcat1.0')).toThrow(/Unknown runtime/);
    try {
      resolveRuntimeImage('lolcat1.0');
    } catch (err) {
      const msg = (err as Error).message;
      // The "supported runtimes" line should now mention both Node and Python.
      expect(msg).toMatch(/nodejs20\.x/);
      expect(msg).toMatch(/python3\.12/);
    }
  });
});

describe('resolveRuntimeFileExtension', () => {
  it.each([
    ['nodejs18.x', '.js'],
    ['nodejs20.x', '.js'],
    ['nodejs22.x', '.js'],
    ['python3.11', '.py'],
    ['python3.12', '.py'],
    ['python3.13', '.py'],
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
  });
});

describe('isSupportedRuntime', () => {
  it('returns true for Node.js and Python supported sets, false otherwise', () => {
    expect(isSupportedRuntime('nodejs20.x')).toBe(true);
    expect(isSupportedRuntime('python3.12')).toBe(true);
    expect(isSupportedRuntime('python3.11')).toBe(true);
    expect(isSupportedRuntime('python3.13')).toBe(true);
    expect(isSupportedRuntime('python3.10')).toBe(false);
    expect(isSupportedRuntime('java17')).toBe(false);
    expect(isSupportedRuntime('')).toBe(false);
  });
});
