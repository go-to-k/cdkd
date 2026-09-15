import { describe, expect, it } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  malformedResourcesWarning,
  normalizeLoadedState,
} from '../../../src/state/normalize-loaded-state.js';
import type { StackState } from '../../../src/types/state.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function state(resources: unknown): StackState {
  return {
    version: 10,
    stackName: 'S',
    region: 'us-east-1',
    resources: resources as StackState['resources'],
    outputs: {},
    lastModified: 0,
  };
}

describe('normalizeLoadedState', () => {
  it('repairs a null resources bag and reports that it did', () => {
    const s = state(null);
    expect(normalizeLoadedState(s)).toBe(true);
    expect(s.resources).toEqual({});
  });

  it('repairs an absent resources bag', () => {
    const s = state(undefined);
    expect(normalizeLoadedState(s)).toBe(true);
    expect(s.resources).toEqual({});
  });

  it('leaves a populated bag byte-identical and reports no repair', () => {
    const bag = { A: { physicalId: 'p', resourceType: 'T', properties: {} } };
    const s = state(bag);
    expect(normalizeLoadedState(s)).toBe(false);
    // The SAME object, not a copy: callers hold the backend's reference and an
    // etag-paired saveState must write back the record that was read.
    expect(s.resources).toBe(bag);
  });

  it('leaves an EMPTY bag alone — {} is a legitimate deployed-nothing record', () => {
    const bag = {};
    const s = state(bag);
    expect(normalizeLoadedState(s)).toBe(false);
    expect(s.resources).toBe(bag);
  });

  it('warns in terms of what the user must NOT then do', () => {
    const warning = malformedResourcesWarning('MyStack', 'eu-west-1');
    expect(warning).toContain('MyStack');
    expect(warning).toContain('eu-west-1');
    // An empty resource set is indistinguishable from a healthy empty stack in
    // every later line of output, so the warning has to say which it is.
    expect(warning).toContain('EMPTY');
    // deploy / destroy read the same record and would act on the empty set.
    expect(warning).toContain('cdkd deploy');
    expect(warning).toContain('cdkd destroy');
  });
});

/**
 * The first cut of go-to-k/cdkd#3018 guarded the twelve
 * `Object.entries(state.resources)` LOOPS, which was inert: every flow
 * dereferences the bag EARLIER, so the `TypeError` still aborted the command
 * one line above the guard. These cases pin the repair to the LOAD, which is
 * the only position that dominates every such dereference.
 */
describe('the repair sits at the load, not at the loops', () => {
  const sites: ReadonlyArray<readonly [string, string]> = [
    ['src/cli/commands/orphan.ts', 'stateBackend.getState(stackInfo.stackName, targetRegion)'],
    ['src/cli/commands/import.ts', 'stateBackend.getState(stackInfo.stackName, targetRegion)'],
    ['src/cli/commands/diff-recursive.ts', 'stateBackend.getState(stackName, region)'],
    ['src/cli/commands/scrub.ts', 'stateBackend.getState(stack.stackName, region)'],
    ['src/cli/commands/scrub.ts', 'backend.getState(stackName, stateRegion)'],
  ];

  for (const [file, load] of sites) {
    it(`${file} normalizes within a few lines of \`${load}\``, () => {
      const src = readFileSync(join(repoRoot, file), 'utf8');
      const at = src.indexOf(load);
      expect(at, `${file} no longer contains the load site \`${load}\``).toBeGreaterThan(-1);
      // A small window, so moving the call away from the load reds this rather
      // than passing on a normalization that happens somewhere else entirely.
      const window = src.slice(at, at + 400);
      expect(
        window,
        `${file} loads state at \`${load}\` without calling normalizeLoadedState right after ` +
          `it. Every flow behind this load dereferences \`state.resources\` before reaching any ` +
          `\`?? {}\` guard, so an unnormalized load aborts the command with a raw TypeError ` +
          `(go-to-k/cdkd#3018).`
      ).toContain('normalizeLoadedState');
      expect(
        window,
        `${file} normalizes at \`${load}\` without warning. A silent repair turns "the record ` +
          `was unreadable" into a clean verdict about zero resources.`
      ).toContain('malformedResourcesWarning');
    });
  }
});
