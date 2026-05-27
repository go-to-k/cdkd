import { describe, expect, it } from 'vite-plus/test';
import {
  pickTargetStacks,
  shouldEmitFromCfnRedundancyTip,
} from '../../../src/cli/commands/local-start-api.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

function stack(name: string): StackInfo {
  return {
    stackName: name,
    template: { Resources: {} },
  } as unknown as StackInfo;
}

describe('pickTargetStacks', () => {
  const A = stack('A');
  const B = stack('B');

  describe('single-stack app', () => {
    it('auto-picks the only stack when --stack is omitted', () => {
      expect(pickTargetStacks([A], undefined)).toEqual([A]);
    });
  });

  describe('--stack pattern (explicit)', () => {
    it('matches by stack name', () => {
      expect(pickTargetStacks([A, B], 'A')).toEqual([A]);
    });

    it('wins over a --from-cfn-stack fallback (CFn fallback only fires when --stack is omitted)', () => {
      expect(pickTargetStacks([A, B], 'A', 'B')).toEqual([A]);
    });

    it('wins over both cfnStackFallback AND targetFallback', () => {
      expect(pickTargetStacks([A, B], 'A', 'B', 'C')).toEqual([A]);
    });

    it('returns empty when no stack matches the pattern', () => {
      expect(pickTargetStacks([A, B], 'Other')).toEqual([]);
    });
  });

  describe('--from-cfn-stack fallback', () => {
    it('disambiguates a multi-stack app when its value matches a stack name', () => {
      expect(pickTargetStacks([A, B], undefined, 'B')).toEqual([B]);
    });

    it('returns empty when the CFn stack name does not match any synth stack (caller surfaces a clearer error)', () => {
      expect(pickTargetStacks([A, B], undefined, 'Other')).toEqual([]);
    });

    it('wins over the targetFallback when both are supplied', () => {
      expect(pickTargetStacks([A, B], undefined, 'B', 'A')).toEqual([B]);
    });

    it('is ignored when undefined (bare --from-cfn-stack flag => the regular multi-stack rejection still fires)', () => {
      expect(() => pickTargetStacks([A, B], undefined, undefined)).toThrowError(
        /Multi-stack app/
      );
    });
  });

  describe('targetFallback (positional target prefix)', () => {
    it('selects the stack whose name matches the target prefix', () => {
      expect(pickTargetStacks([A, B], undefined, undefined, 'A')).toEqual([A]);
    });

    it('returns empty when the target prefix matches no stack', () => {
      expect(pickTargetStacks([A, B], undefined, undefined, 'Other')).toEqual([]);
    });

    it('is ignored when undefined (bare target => the regular single-stack auto-pick path applies)', () => {
      expect(pickTargetStacks([A], undefined, undefined, undefined)).toEqual([A]);
    });
  });

  describe('error message', () => {
    it('lists every available stack name and mentions all three selection routes', () => {
      expect(() => pickTargetStacks([A, B], undefined)).toThrowError(
        /Multi-stack app: pass --stack <name>, --from-cfn-stack <name>, or a stack-qualified target like "<StackName>\/<construct>" to pick a target\. Available stacks: A, B\./
      );
    });
  });
});

describe('shouldEmitFromCfnRedundancyTip', () => {
  it('fires when the explicit value equals the single routed stack name', () => {
    expect(shouldEmitFromCfnRedundancyTip('MyStack', ['MyStack'])).toBe(true);
  });

  it('does not fire when --from-cfn-stack is bare (true)', () => {
    expect(shouldEmitFromCfnRedundancyTip(true, ['MyStack'])).toBe(false);
  });

  it('does not fire when --from-cfn-stack is absent', () => {
    expect(shouldEmitFromCfnRedundancyTip(undefined, ['MyStack'])).toBe(false);
  });

  it('does not fire on multi-stack runs (out of scope)', () => {
    expect(shouldEmitFromCfnRedundancyTip('MyStack', ['MyStack', 'Other'])).toBe(false);
  });

  it('does not fire when the explicit value differs from the routed stack name (intentional different CFn stack)', () => {
    expect(shouldEmitFromCfnRedundancyTip('OtherStack', ['MyStack'])).toBe(false);
  });

  it('does not fire when the explicit value is an empty string', () => {
    expect(shouldEmitFromCfnRedundancyTip('', ['MyStack'])).toBe(false);
  });

  it('does not fire when no stack is routed', () => {
    expect(shouldEmitFromCfnRedundancyTip('MyStack', [])).toBe(false);
  });
});
