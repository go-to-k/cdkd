import { describe, it, expect } from 'vite-plus/test';
import {
  undeclaredGrantDriftKeys,
  withUndeclaredGrantBaseline,
  undeclaredGrantIgnorePaths,
  withoutUndeclaredNoBoundary,
  removedGrantMembers,
} from '../../../src/analyzer/drift-undeclared-grants.js';

describe('undeclaredGrantDriftKeys (go-to-k/cdkd#6627)', () => {
  it.each([
    ['AWS::IAM::Role', {}, ['ManagedPolicyArns', 'PermissionsBoundary', 'Policies']],
    ['AWS::IAM::Role', { ManagedPolicyArns: [] }, ['PermissionsBoundary', 'Policies']],
    ['AWS::IAM::User', {}, ['Groups', 'ManagedPolicyArns', 'PermissionsBoundary', 'Policies']],
    ['AWS::IAM::User', { Groups: ['g'], Policies: [] }, ['ManagedPolicyArns', 'PermissionsBoundary']],
    ['AWS::IAM::Group', {}, ['ManagedPolicyArns', 'Policies']],
    [
      'AWS::IAM::Group',
      { ManagedPolicyArns: ['a'], Policies: [], PermissionsBoundary: 'x' },
      [],
    ],
    ['AWS::IAM::ManagedPolicy', {}, []],
    ['AWS::S3::Bucket', {}, []],
  ])('%s with %j -> %j', (type, properties, expected) => {
    expect(undeclaredGrantDriftKeys(type, properties)).toEqual(expected);
  });

  it('names none for a record whose properties are not a plain object', () => {
    expect(undeclaredGrantDriftKeys('AWS::IAM::Role', undefined)).toEqual([]);
    expect(undeclaredGrantDriftKeys('AWS::IAM::Role', [])).toEqual([]);
  });

  it('does not read an inherited key as declared', () => {
    expect(undeclaredGrantDriftKeys('AWS::IAM::Group', Object.create({ Policies: [] }))).toEqual([
      'ManagedPolicyArns',
      'Policies',
    ]);
  });
});

describe('withUndeclaredGrantBaseline (go-to-k/cdkd#6627)', () => {
  const keys = ['Groups', 'ManagedPolicyArns', 'PermissionsBoundary', 'Policies'];

  it('a baseline without the keys holds none of the live members', () => {
    const out = withUndeclaredGrantBaseline(
      { UserName: 'u' },
      { ManagedPolicyArns: ['x'], Groups: ['G'], Policies: [], PermissionsBoundary: 'b' },
      keys
    );
    expect(out).toEqual({
      UserName: 'u',
      ManagedPolicyArns: [],
      Groups: [],
      Policies: [],
      PermissionsBoundary: '',
    });
  });

  it('keeps a recorded member AWS still holds (by identity, in live order) and drops one AWS lost', () => {
    const recordedPolicy = { PolicyName: 'p', PolicyDocument: { v: 1 } };
    const out = withUndeclaredGrantBaseline(
      {
        ManagedPolicyArns: ['gone', 'kept'],
        Groups: ['Admins'],
        Policies: [recordedPolicy, { PolicyName: 'lost', PolicyDocument: {} }],
      },
      {
        ManagedPolicyArns: ['new', 'kept'],
        Groups: ['admins'],
        Policies: [{ PolicyName: 'p', PolicyDocument: { v: 2 } }],
      },
      keys
    );
    expect(out['ManagedPolicyArns']).toEqual(['kept']);
    // IAM group names are case-insensitive.
    expect(out['Groups']).toEqual(['Admins']);
    // The RECORDED document, so an out-of-band edit still differs.
    expect(out['Policies']).toEqual([recordedPolicy]);
  });

  it('leaves a recorded boundary and a key the readback lacks alone; returns the input by identity when nothing changes', () => {
    const baseline = { PermissionsBoundary: 'b', ManagedPolicyArns: ['x'] };
    expect(withUndeclaredGrantBaseline(baseline, { ManagedPolicyArns: ['x'] }, keys)).toBe(baseline);
    expect(withUndeclaredGrantBaseline(baseline, {}, keys)).toBe(baseline);
  });

  it('leaves every key when none is undeclared', () => {
    const baseline = {};
    expect(withUndeclaredGrantBaseline(baseline, { ManagedPolicyArns: ['x'] }, [])).toBe(baseline);
  });
});

describe('undeclaredGrantIgnorePaths (go-to-k/cdkd#6627)', () => {
  const keys = ['ManagedPolicyArns', 'PermissionsBoundary', 'Policies'];

  it('skips a key the readback omits whose baseline is none', () => {
    expect(undeclaredGrantIgnorePaths({ ManagedPolicyArns: [] }, {}, keys)).toEqual(keys);
    expect(undeclaredGrantIgnorePaths({ PermissionsBoundary: '' }, {}, keys)).toEqual(keys);
  });

  it('compares a recorded boundary the readback omits (removed) and every key the readback holds', () => {
    expect(undeclaredGrantIgnorePaths({ PermissionsBoundary: 'b' }, {}, keys)).toEqual([
      'ManagedPolicyArns',
      'Policies',
    ]);
    expect(
      undeclaredGrantIgnorePaths({}, { ManagedPolicyArns: [], PermissionsBoundary: '', Policies: [] }, keys)
    ).toEqual([]);
  });
});

describe('withoutUndeclaredNoBoundary (go-to-k/cdkd#6627)', () => {
  it('sends a "none" boundary absent, and keeps a recorded one', () => {
    expect(withoutUndeclaredNoBoundary({ PermissionsBoundary: '', A: 1 }, ['PermissionsBoundary'])).toEqual({
      desired: { A: 1 },
      absent: ['PermissionsBoundary'],
    });
    const kept = { PermissionsBoundary: 'b' };
    expect(withoutUndeclaredNoBoundary(kept, ['PermissionsBoundary'])).toEqual({
      desired: kept,
      absent: [],
    });
    // A declared boundary is not in `keys`.
    const declared = { PermissionsBoundary: '' };
    expect(withoutUndeclaredNoBoundary(declared, []).desired).toBe(declared);
  });
});

describe('removedGrantMembers (go-to-k/cdkd#6627)', () => {
  it('names each live member the baseline lacks', () => {
    expect(removedGrantMembers('ManagedPolicyArns', ['a', 'b'], ['a'])).toEqual([
      { key: 'ManagedPolicyArns', member: 'b' },
    ]);
    expect(
      removedGrantMembers(
        'Policies',
        [
          { PolicyName: 'p', PolicyDocument: {} },
          { PolicyName: 'q', PolicyDocument: {} },
        ],
        [{ PolicyName: 'p', PolicyDocument: { old: true } }]
      )
    ).toEqual([{ key: 'Policies', member: 'q' }]);
    expect(removedGrantMembers('Groups', ['G', 'h'], ['g'])).toEqual([{ key: 'Groups', member: 'h' }]);
  });

  it('a boundary is removed only when the baseline has none', () => {
    expect(removedGrantMembers('PermissionsBoundary', 'b', '')).toEqual([
      { key: 'PermissionsBoundary', member: 'b' },
    ]);
    expect(removedGrantMembers('PermissionsBoundary', 'b', 'c')).toEqual([]);
    expect(removedGrantMembers('PermissionsBoundary', undefined, 'c')).toEqual([]);
  });

  it('names nothing when the live side holds nothing the baseline lacks', () => {
    expect(removedGrantMembers('ManagedPolicyArns', ['a'], ['a', 'b'])).toEqual([]);
    expect(removedGrantMembers('ManagedPolicyArns', undefined, [])).toEqual([]);
  });
});
