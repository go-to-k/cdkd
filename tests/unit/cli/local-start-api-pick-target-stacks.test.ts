import { describe, expect, it, vi } from 'vite-plus/test';
import {
  pickTargetStacks,
  targetStackHint,
  shouldEmitFromCfnRedundancyTip,
  tryEmitFromCfnRedundancyTipOnce,
} from '../../../src/cli/commands/local-start-api.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import {
  PASTE_PAYLOADS,
  expectNoCommandBesideDisplay,
  spansThatRun,
  withPasteDir,
} from '../utils/paste-harness.js';

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
    it('names no payload stack beside --stack / --from-cfn-stack (go-to-k/cdkd#4295)', () => {
      for (const { value } of PASTE_PAYLOADS) {
        let message = '';
        try {
          pickTargetStacks([stack(value), B], undefined);
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message, value).toContain(
          'Available stacks: a stack name that is not a plain identifier, B.'
        );
        withPasteDir((dir) => {
          expectNoCommandBesideDisplay(message, value);
          expect(spansThatRun(message, dir), `${value}: ${message}`).toEqual([]);
        });
      }
    }, 120_000);

    it('lists every available stack name and mentions all three selection routes', () => {
      expect(() => pickTargetStacks([A, B], undefined)).toThrowError(
        /Multi-stack app: pass --stack '<name>', --from-cfn-stack '<name>', or a stack-qualified target like "<StackName>\/<construct>" to pick a target\. Available stacks: A, B\./
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

describe('targetStackHint: a start-api target under a CDK Stage (go-to-k/cdkd#3953)', () => {
  const staged = (stackName: string, displayName: string): StackInfo =>
    ({ stackName, displayName, template: { Resources: {} } }) as unknown as StackInfo;
  const api = staged('MyStage-Api', 'MyStage/Api');
  const v2 = staged('MyStage-ApiV2', 'MyStage/ApiV2');
  const outer = staged('Outer', 'Outer');
  const inner = staged('Outer-Inner-Api', 'Outer/Inner/Api');

  it('returns the Stage stack itself, which pickTargetStacks then selects alone', () => {
    const hint = targetStackHint('MyStage/Api/HttpApi', [api, v2]);
    expect(hint).toBe(api);
    expect(pickTargetStacks([api, v2], undefined, undefined, hint)).toEqual([api]);
  });

  it('selects the stack the target names when another shares its physical name', () => {
    // A Stage deployed twice with an explicit stackName: both stacks carry
    // `Shared`. Re-matching the NAME goes through matchStacks, which keeps
    // the first stack by name -- `West` here, for a target under `East`.
    const east = staged('Shared', 'East/Api');
    const west = staged('Shared', 'West/Api');
    const hint = targetStackHint('East/Api/HttpApi', [west, east]);
    expect(pickTargetStacks([west, east], undefined, undefined, hint)).toEqual([east]);
  });

  it('keeps --stack and --from-cfn-stack ahead of the target stack', () => {
    const hint = targetStackHint('MyStage/Api/HttpApi', [api, v2]);
    expect(pickTargetStacks([api, v2], 'MyStage-ApiV2', undefined, hint)).toEqual([v2]);
    expect(pickTargetStacks([api, v2], undefined, 'MyStage-ApiV2', hint)).toEqual([v2]);
  });

  it('picks the longest prefix under a nested Stage', () => {
    expect(targetStackHint('Outer/Inner/Api/HttpApi', [outer, inner])).toBe(inner);
  });

  it('does not let a stack claim a sibling whose name it prefixes', () => {
    expect(targetStackHint('MyStage/ApiV2/HttpApi', [api, v2])).toBe(v2);
  });

  it('falls back to the first segment when no stack path prefixes the target', () => {
    expect(targetStackHint('My*/HttpApi', [api, v2])).toBe('My*');
  });

  it('is undefined for a target with no slash', () => {
    expect(targetStackHint('HttpApi', [api])).toBeUndefined();
    expect(targetStackHint(undefined, [api])).toBeUndefined();
  });
});
