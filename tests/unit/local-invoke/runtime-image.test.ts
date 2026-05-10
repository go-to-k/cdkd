import { describe, expect, it } from 'vitest';
import {
  isSupportedRuntime,
  resolveRuntimeImage,
  UnsupportedRuntimeError,
} from '../../../src/local-invoke/runtime-image.js';

describe('resolveRuntimeImage', () => {
  it.each([
    ['nodejs18.x', 'public.ecr.aws/lambda/nodejs:18'],
    ['nodejs20.x', 'public.ecr.aws/lambda/nodejs:20'],
    ['nodejs22.x', 'public.ecr.aws/lambda/nodejs:22'],
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

  it('rejects python with a "deferred to PR 4" hint', () => {
    expect(() => resolveRuntimeImage('python3.12')).toThrow(/not supported in cdkd local invoke v1/);
  });

  it('rejects java / go / ruby / dotnet / provided runtimes', () => {
    for (const r of ['java17', 'go1.x', 'ruby3.2', 'dotnet8', 'provided.al2']) {
      expect(() => resolveRuntimeImage(r)).toThrow(UnsupportedRuntimeError);
    }
  });

  it('rejects unknown runtime strings with a clear message', () => {
    expect(() => resolveRuntimeImage('lolcat1.0')).toThrow(/Unknown runtime/);
  });
});

describe('isSupportedRuntime', () => {
  it('returns true only for the supported Node.js set', () => {
    expect(isSupportedRuntime('nodejs20.x')).toBe(true);
    expect(isSupportedRuntime('python3.12')).toBe(false);
    expect(isSupportedRuntime('')).toBe(false);
  });
});
