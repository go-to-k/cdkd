import { describe, it, expect } from 'vite-plus/test';
import { promoteRecreateTargets } from '../../../src/deployment/recreate-target-promotion.js';
import type { ResourceChange } from '../../../src/types/state.js';

function row(logicalId: string, changeType: ResourceChange['changeType']): ResourceChange {
  return { logicalId, changeType, resourceType: 'AWS::SNS::Topic' };
}

function targets(viaCcApi: string[], viaSdkProvider: string[] = [], stackName = 'S') {
  return { stackName, viaCcApi: new Set(viaCcApi), viaSdkProvider: new Set(viaSdkProvider) };
}

describe('promoteRecreateTargets (#2651)', () => {
  it('turns a NO_CHANGE target into an UPDATE with no property change, for both flags', () => {
    const changes = new Map([
      ['A', row('A', 'NO_CHANGE')],
      ['B', row('B', 'NO_CHANGE')],
    ]);
    const out = promoteRecreateTargets(changes, targets(['A'], ['B']), 'S');
    expect(out).toEqual({ promoted: ['A', 'B'], unreached: [] });
    expect(changes.get('A')).toMatchObject({ changeType: 'UPDATE', propertyChanges: [] });
    expect(changes.get('B')).toMatchObject({ changeType: 'UPDATE', propertyChanges: [] });
  });

  it('leaves an UPDATE target and its property changes as they are', () => {
    const update: ResourceChange = {
      ...row('A', 'UPDATE'),
      propertyChanges: [{ path: 'DisplayName', oldValue: 'a', newValue: 'b', requiresReplacement: false }],
    };
    const changes = new Map([['A', update]]);
    expect(promoteRecreateTargets(changes, targets(['A']), 'S')).toEqual({
      promoted: [],
      unreached: [],
    });
    expect(changes.get('A')).toBe(update);
    expect(update.propertyChanges).toHaveLength(1);
  });

  it('touches no row that is not a target', () => {
    const changes = new Map([
      ['A', row('A', 'NO_CHANGE')],
      ['Other', row('Other', 'NO_CHANGE')],
    ]);
    promoteRecreateTargets(changes, targets(['A']), 'S');
    expect(changes.get('Other')?.changeType).toBe('NO_CHANGE');
  });

  it('reports a DELETE, a CREATE, and an absent target as unreached, naming the flag', () => {
    const changes = new Map([
      ['Del', row('Del', 'DELETE')],
      ['New', row('New', 'CREATE')],
    ]);
    const out = promoteRecreateTargets(changes, targets(['Del', 'Gone'], ['New']), 'S');
    expect(out.promoted).toEqual([]);
    expect(out.unreached).toEqual([
      { logicalId: 'Del', flag: '--recreate-via-cc-api', changeType: 'DELETE' },
      { logicalId: 'Gone', flag: '--recreate-via-cc-api', changeType: undefined },
      { logicalId: 'New', flag: '--recreate-via-sdk-provider', changeType: 'CREATE' },
    ]);
    expect(changes.get('Del')?.changeType).toBe('DELETE');
    expect(changes.get('New')?.changeType).toBe('CREATE');
  });

  it('does nothing in a stack the targets were not validated against (#2567)', () => {
    const changes = new Map([['A', row('A', 'NO_CHANGE')]]);
    expect(promoteRecreateTargets(changes, targets(['A', 'Gone'], [], 'Parent'), 'Parent~Child')).toEqual({
      promoted: [],
      unreached: [],
    });
    expect(changes.get('A')?.changeType).toBe('NO_CHANGE');
  });

  it('does nothing without targets', () => {
    const changes = new Map([['A', row('A', 'NO_CHANGE')]]);
    expect(promoteRecreateTargets(changes, undefined, 'S')).toEqual({ promoted: [], unreached: [] });
  });
});
