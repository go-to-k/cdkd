import { describe, expect, it, vi } from 'vite-plus/test';
import {
  pickTargetStacks,
  shouldEmitFromCfnRedundancyTip,
  tryEmitFromCfnRedundancyTipOnce,
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

describe('tryEmitFromCfnRedundancyTipOnce', () => {
  it('emits once and flips the ref to true on the first redundant invocation', () => {
    const emit = vi.fn();
    const ref = { value: false };
    tryEmitFromCfnRedundancyTipOnce('MyStack', ['MyStack'], ref, emit);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('MyStack');
    expect(ref.value).toBe(true);
  });

  it('skips subsequent redundant invocations once the ref is true (--watch hot-reload re-run)', () => {
    const emit = vi.fn();
    const ref = { value: false };
    tryEmitFromCfnRedundancyTipOnce('MyStack', ['MyStack'], ref, emit);
    tryEmitFromCfnRedundancyTipOnce('MyStack', ['MyStack'], ref, emit);
    tryEmitFromCfnRedundancyTipOnce('MyStack', ['MyStack'], ref, emit);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(ref.value).toBe(true);
  });

  it('leaves the ref false on a non-redundant invocation and fires later when conditions become redundant', () => {
    const emit = vi.fn();
    const ref = { value: false };
    // First call: --from-cfn-stack absent → predicate returns false, ref stays false.
    tryEmitFromCfnRedundancyTipOnce(undefined, ['MyStack'], ref, emit);
    expect(emit).not.toHaveBeenCalled();
    expect(ref.value).toBe(false);
    // Later (e.g. user restarts the server with --from-cfn-stack <name> and
    // the synth resolves to the same stack name) the predicate fires and
    // the helper emits its one-shot tip.
    tryEmitFromCfnRedundancyTipOnce('MyStack', ['MyStack'], ref, emit);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(ref.value).toBe(true);
  });

  it('does not fire when the explicit value differs from the routed stack name (intentional different CFn stack)', () => {
    const emit = vi.fn();
    const ref = { value: false };
    tryEmitFromCfnRedundancyTipOnce('OtherStack', ['MyStack'], ref, emit);
    tryEmitFromCfnRedundancyTipOnce('OtherStack', ['MyStack'], ref, emit);
    expect(emit).not.toHaveBeenCalled();
    expect(ref.value).toBe(false);
  });

  it('does not fire on multi-stack runs (out of scope)', () => {
    const emit = vi.fn();
    const ref = { value: false };
    tryEmitFromCfnRedundancyTipOnce('MyStack', ['MyStack', 'Other'], ref, emit);
    expect(emit).not.toHaveBeenCalled();
    expect(ref.value).toBe(false);
  });

  it('uses independent flags for independent server invocations (each localStartApiCommand call gets a fresh ref)', () => {
    // Two independent refs model two independent `localStartApiCommand`
    // invocations (e.g. user Ctrl+Cs the first server and boots a second).
    // The first server's emission must not bleed into the second's gate.
    const refA = { value: false };
    const refB = { value: false };
    const emitA = vi.fn();
    const emitB = vi.fn();
    // First server: emits and flips its own ref.
    tryEmitFromCfnRedundancyTipOnce('MyStack', ['MyStack'], refA, emitA);
    tryEmitFromCfnRedundancyTipOnce('MyStack', ['MyStack'], refA, emitA);
    expect(emitA).toHaveBeenCalledTimes(1);
    expect(refA.value).toBe(true);
    // Second server: independent ref → starts at false, still emits once.
    expect(refB.value).toBe(false);
    tryEmitFromCfnRedundancyTipOnce('MyStack', ['MyStack'], refB, emitB);
    expect(emitB).toHaveBeenCalledTimes(1);
    expect(refB.value).toBe(true);
  });
});
