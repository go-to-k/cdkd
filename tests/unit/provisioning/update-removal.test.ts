import { describe, expect, it } from 'vite-plus/test';
import {
  clearOnUpdateRemoval,
  prepareRemovalForUpdate,
  removalWarning,
  removedTemplateKeys,
  withoutInjectedRemovals,
  withRemovalDefaults,
} from '../../../src/provisioning/update-removal.js';
import type { ResourceProvider } from '../../../src/types/resource.js';

/**
 * Module-own pins for the shared clear-on-removal resolver (issue #1223,
 * extracted from the per-provider copies of the #1160 fix). The per-provider
 * removal test suites (lambda / ecs / rds / asg) pin the END-TO-END behavior
 * through each update(); this file pins the helper's tri-state contract
 * directly so a semantics change fails here first.
 */
describe('clearOnUpdateRemoval (shared, issue #1160/#1223)', () => {
  it('passes a present value through unchanged', () => {
    expect(clearOnUpdateRemoval(5, 3, 0)).toBe(5);
    expect(clearOnUpdateRemoval('keep', 'old', 'reset')).toBe('keep');
    // Falsy-but-present values are still "present" — never replaced.
    expect(clearOnUpdateRemoval(0, 3, 99)).toBe(0);
    expect(clearOnUpdateRemoval(false, true, true)).toBe(false);
    expect(clearOnUpdateRemoval('', 'old', 'reset')).toBe('');
    expect(clearOnUpdateRemoval<unknown>(null, 'old', 'reset')).toBeNull();
  });

  it('returns the clear value when the field was present before and is now absent', () => {
    expect(clearOnUpdateRemoval(undefined, 3, 0)).toBe(0);
    const clearShape = { MinHealthyPercentage: -1 };
    expect(clearOnUpdateRemoval(undefined, { MinHealthyPercentage: 90 }, clearShape)).toBe(
      clearShape
    );
    // A falsy previous value still counts as "was present".
    expect(clearOnUpdateRemoval(undefined, 0, 300)).toBe(300);
    expect(clearOnUpdateRemoval(undefined, false, true)).toBe(true);
  });

  it('stays absent when the field was never present (no spurious reset)', () => {
    expect(clearOnUpdateRemoval(undefined, undefined, 0)).toBeUndefined();
    expect(clearOnUpdateRemoval(undefined, undefined, { Variables: {} })).toBeUndefined();
  });
});

/**
 * Issue #1160: the declared half — `removalDefaults` injected by the update
 * CALLER, and the warning for an audited type's undeclared removal.
 */
describe('removal declarations (issue #1160)', () => {
  const TYPE = 'AWS::Test::Thing';
  const provider = {
    removalDefaults: new Map([[TYPE, new Map<string, unknown>([['Timeout', 3], ['Layers', []]])]]),
    removalHandledInUpdate: new Map([[TYPE, new Set(['Tags'])]]),
  } as unknown as ResourceProvider;

  it('removedTemplateKeys: a key the baseline declares and the desired bag omits', () => {
    expect(removedTemplateKeys({ A: 1, B: 0, C: null }, { A: 2 })).toEqual(['B', 'C']);
    expect(removedTemplateKeys({ A: 1 }, { A: 1, B: 2 })).toEqual([]);
    // A malformed state record declares nothing.
    expect(removedTemplateKeys('oops' as never, {})).toEqual([]);
    expect(removedTemplateKeys(['x'] as never, {})).toEqual([]);
  });

  it('a removed DECLARED key reaches the provider as its declared value, as a fresh copy', () => {
    const prep = prepareRemovalForUpdate(provider, TYPE, { Name: 'n' }, { Name: 'n', Layers: ['l'] });
    expect(prep.properties).toEqual({ Name: 'n', Layers: [] });
    expect(prep.properties['Layers']).not.toBe(provider.removalDefaults!.get(TYPE)!.get('Layers'));
    expect(prep.injected).toEqual(['Layers']);
    expect([...prep.context.removedProperties!]).toEqual(['Layers']);
    expect(prep.unhandled).toEqual([]);
  });

  it('a removed UNDECLARED key on an audited type is reported, and the bag is unchanged', () => {
    const desired = { Name: 'n' };
    const prep = prepareRemovalForUpdate(provider, TYPE, desired, { Name: 'n', RecursiveLoop: 'Allow' });
    expect(prep.properties).toBe(desired);
    expect(prep.injected).toEqual([]);
    expect(prep.unhandled).toEqual(['RecursiveLoop']);
  });

  it('a removed key the type handles in update() is not reported', () => {
    const prep = prepareRemovalForUpdate(provider, TYPE, {}, { Tags: [] });
    expect(prep.unhandled).toEqual([]);
  });

  it('a type with no removalHandledInUpdate entry is never reported', () => {
    const prep = prepareRemovalForUpdate(provider, 'AWS::Other::Thing', {}, { X: 1 });
    expect(prep.unhandled).toEqual([]);
    expect([...prep.context.removedProperties!]).toEqual(['X']);
  });

  it('nothing removed: the same bag, no report, an empty removed set', () => {
    const desired = { Timeout: 9 };
    const prep = prepareRemovalForUpdate(provider, TYPE, desired, { Timeout: 3 });
    expect(prep.properties).toBe(desired);
    expect(prep.unhandled).toEqual([]);
    expect(prep.context.removedProperties!.size).toBe(0);
  });

  it('withRemovalDefaults injects on a direct call and is a no-op once the caller did', () => {
    expect(withRemovalDefaults(provider.removalDefaults, TYPE, {}, { Timeout: 30 }, undefined)).toEqual({
      Timeout: 3,
    });
    const desired = {};
    expect(
      withRemovalDefaults(provider.removalDefaults, TYPE, desired, { Timeout: 30 }, { removedProperties: new Set() })
    ).toBe(desired);
  });

  it('withoutInjectedRemovals takes an echoed reset back out of effectiveProperties', () => {
    const result = { physicalId: 'p', wasReplaced: false, effectiveProperties: { A: 1, Timeout: 3 } };
    expect(withoutInjectedRemovals(result, ['Timeout']).effectiveProperties).toEqual({ A: 1 });
    expect(result.effectiveProperties).toEqual({ A: 1, Timeout: 3 });
    expect(withoutInjectedRemovals(result, [])).toBe(result);
  });

  it('removalWarning names every property on one line', () => {
    expect(removalWarning('Fn', 'AWS::Lambda::Function', ['RecursiveLoop'])).toBe(
      'Fn (AWS::Lambda::Function): property RecursiveLoop was removed from the template; cdkd leaves the current AWS value in place (CloudFormation would reset it to its default).'
    );
    expect(removalWarning('Fn\nforged', 'T', ['A', 'B'])).not.toContain('\n');
    expect(removalWarning('Fn', 'T', ['A', 'B'])).toContain('properties A, B were removed');
    expect(removalWarning('Fn', 'T', ['A'], 'rollback')).toBe(
      'Fn (T): property A is absent from the state being restored; the rollback leaves the value the failed deploy applied in place (CloudFormation would reset it to its default).'
    );
  });
});
