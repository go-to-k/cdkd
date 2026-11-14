import { describe, it, expect } from 'vite-plus/test';
import {
  nestedCreateOnlyGaps,
  withCarriedCreateOnlyMembers,
  writesTopLevelObject,
} from '../../../src/provisioning/cc-nested-create-only-patch.js';
import type { JsonPatchOp } from '../../../src/provisioning/json-patch-generator.js';

const PATHS = [['Name'], ['Config', 'Mode'], ['Config', 'Inner', 'Kind'], ['List', '*', 'Id']];

describe('nestedCreateOnlyGaps (go-to-k/cdkd#6294)', () => {
  it('lists each nested create-only path a whole-object op omits, for add and replace', () => {
    const patch: JsonPatchOp[] = [
      { op: 'replace', path: '/Config', value: { Port: 1, Inner: {} } },
      { op: 'add', path: '/Other', value: {} },
    ];
    expect(nestedCreateOnlyGaps(patch, PATHS)).toEqual([
      ['Config', 'Mode'],
      ['Config', 'Inner', 'Kind'],
    ]);
    expect(
      nestedCreateOnlyGaps([{ op: 'add', path: '/Config', value: { Inner: { Kind: 'k' } } }], PATHS)
    ).toEqual([['Config', 'Mode']]);
  });

  it('lists a member below an object the op omits, and decodes ~1 / ~0 in the key', () => {
    expect(
      nestedCreateOnlyGaps([{ op: 'replace', path: '/Config', value: { Port: 1 } }], PATHS)
    ).toEqual([
      ['Config', 'Mode'],
      ['Config', 'Inner', 'Kind'],
    ]);
    expect(
      nestedCreateOnlyGaps([{ op: 'replace', path: '/a~1b~0c', value: {} }], [['a/b~c', 'Leaf']])
    ).toEqual([['a/b~c', 'Leaf']]);
  });

  it('lists nothing for a declared member, a top-level path, a remove, a sub-path op, an array, or a non-object above the member', () => {
    expect(
      nestedCreateOnlyGaps(
        [
          { op: 'replace', path: '/Config', value: { Mode: 'm', Inner: 'x' } },
          { op: 'replace', path: '/Name', value: { a: 1 } },
          { op: 'remove', path: '/Config' },
          { op: 'replace', path: '/Config/Port', value: { a: 1 } },
          { op: 'replace', path: '/List', value: [{ Id: 'x' }] },
        ],
        PATHS
      )
    ).toEqual([]);
  });
});

describe('withCarriedCreateOnlyMembers (go-to-k/cdkd#6294)', () => {
  it('sets each gap from the live model on a copy, skipping one the model lacks', () => {
    const value = { Port: 1, Inner: {} };
    const patch: JsonPatchOp[] = [{ op: 'replace', path: '/Config', value }];
    const out = withCarriedCreateOnlyMembers(
      patch,
      [
        ['Config', 'Mode'],
        ['Config', 'Inner', 'Kind'],
      ],
      { Config: { Mode: false, Port: 9 } }
    );
    expect(out).toEqual([{ op: 'replace', path: '/Config', value: { Port: 1, Mode: false, Inner: {} } }]);
    expect(value).toEqual({ Port: 1, Inner: {} });
    expect(patch[0]!.value).toBe(value);
  });

  it('creates an object above a carried member that the op omits', () => {
    const out = withCarriedCreateOnlyMembers(
      [{ op: 'replace', path: '/Config', value: { Port: 1 } }],
      [['Config', 'Inner', 'Kind']],
      { Config: { Inner: { Kind: 'k', Other: 2 } } }
    );
    expect(out).toEqual([{ op: 'replace', path: '/Config', value: { Port: 1, Inner: { Kind: 'k' } } }]);
  });

  it('returns ops it carries nothing into by identity', () => {
    const op: JsonPatchOp = { op: 'replace', path: '/Other', value: { a: 1 } };
    expect(withCarriedCreateOnlyMembers([op], [['Config', 'Mode']], { Config: { Mode: 1 } })[0]).toBe(op);
  });
});

describe('writesTopLevelObject (go-to-k/cdkd#6294)', () => {
  it('is true only for an add / replace of a top-level plain object', () => {
    expect(writesTopLevelObject([{ op: 'replace', path: '/A', value: {} }])).toBe(true);
    expect(writesTopLevelObject([{ op: 'add', path: '/A', value: {} }])).toBe(true);
    expect(writesTopLevelObject([{ op: 'replace', path: '/A', value: [] }])).toBe(false);
    expect(writesTopLevelObject([{ op: 'replace', path: '/A/B', value: {} }])).toBe(false);
    expect(writesTopLevelObject([{ op: 'replace', path: '/A', value: 'x' }])).toBe(false);
    expect(writesTopLevelObject([{ op: 'remove', path: '/A' }])).toBe(false);
  });
});
