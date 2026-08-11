import { describe, it, expect } from 'vite-plus/test';
import {
  canonicalizeIdArraysDeep,
  canonicalizeTagListsDeep,
  canonicalizeUnorderedArraysAtPaths,
  matchesPathPrefix,
} from '../../../src/analyzer/drift-normalize.js';

describe('canonicalizeTagListsDeep', () => {
  it('sorts a tag list by Key so a reorder canonicalizes equal', () => {
    const a = [
      { Key: 'env', Value: 'prod' },
      { Key: 'team', Value: 'core' },
    ];
    const b = [
      { Key: 'team', Value: 'core' },
      { Key: 'env', Value: 'prod' },
    ];
    expect(canonicalizeTagListsDeep(a)).toEqual(canonicalizeTagListsDeep(b));
  });

  it('breaks Key ties deterministically by stringified entry', () => {
    const a = [
      { Key: 'k', Value: 'b' },
      { Key: 'k', Value: 'a' },
    ];
    const b = [
      { Key: 'k', Value: 'a' },
      { Key: 'k', Value: 'b' },
    ];
    expect(canonicalizeTagListsDeep(a)).toEqual(canonicalizeTagListsDeep(b));
  });

  it('recurses into nested objects carrying tag lists', () => {
    const a = { Spec: { Tags: [{ Key: 'b', Value: '2' }, { Key: 'a', Value: '1' }] } };
    const b = { Spec: { Tags: [{ Key: 'a', Value: '1' }, { Key: 'b', Value: '2' }] } };
    expect(canonicalizeTagListsDeep(a)).toEqual(canonicalizeTagListsDeep(b));
  });

  it('leaves a non-tag object array order untouched', () => {
    const arr = [{ Name: 'b' }, { Name: 'a' }];
    expect(canonicalizeTagListsDeep(arr)).toEqual([{ Name: 'b' }, { Name: 'a' }]);
  });

  it('leaves a plain scalar array untouched', () => {
    const arr = ['z', 'a', 'm'];
    expect(canonicalizeTagListsDeep(arr)).toEqual(['z', 'a', 'm']);
  });

  it('passes scalars through unchanged', () => {
    expect(canonicalizeTagListsDeep('x')).toBe('x');
    expect(canonicalizeTagListsDeep(42)).toBe(42);
    expect(canonicalizeTagListsDeep(null)).toBe(null);
    expect(canonicalizeTagListsDeep(undefined)).toBe(undefined);
  });
});

describe('canonicalizeIdArraysDeep', () => {
  it('sorts an id-like array (subnet-*) so a reorder canonicalizes equal', () => {
    const a = ['subnet-0abc123def', 'subnet-0fed321cba'];
    const b = ['subnet-0fed321cba', 'subnet-0abc123def'];
    expect(canonicalizeIdArraysDeep(a)).toEqual([
      'subnet-0abc123def',
      'subnet-0fed321cba',
    ]);
    expect(canonicalizeIdArraysDeep(a)).toEqual(canonicalizeIdArraysDeep(b));
  });

  it('does NOT sort when an element has a non-hex suffix (not id-like)', () => {
    // ID_RE requires a hex-only suffix after the dash; 'subnet-9xyz...'
    // contains non-hex chars so the array is left in original order.
    const arr = ['subnet-0abc123def', 'subnet-9xyz987abc'];
    expect(canonicalizeIdArraysDeep(arr)).toEqual([
      'subnet-0abc123def',
      'subnet-9xyz987abc',
    ]);
  });

  it('sorts an ARN array', () => {
    const a = ['arn:aws:iam::111:role/b', 'arn:aws:iam::111:role/a'];
    const b = ['arn:aws:iam::111:role/a', 'arn:aws:iam::111:role/b'];
    expect(canonicalizeIdArraysDeep(a)).toEqual([
      'arn:aws:iam::111:role/a',
      'arn:aws:iam::111:role/b',
    ]);
    expect(canonicalizeIdArraysDeep(a)).toEqual(canonicalizeIdArraysDeep(b));
  });

  it('recurses into nested objects carrying id arrays', () => {
    const a = { VpcConfig: { SubnetIds: ['subnet-bbb222', 'subnet-aaa111'] } };
    const b = { VpcConfig: { SubnetIds: ['subnet-aaa111', 'subnet-bbb222'] } };
    expect(canonicalizeIdArraysDeep(a)).toEqual(canonicalizeIdArraysDeep(b));
  });

  it('leaves a plain non-id scalar array order untouched', () => {
    const arr = ['us-east-1a', 'us-east-1b', 'us-east-1c'];
    expect(canonicalizeIdArraysDeep(arr)).toEqual(['us-east-1a', 'us-east-1b', 'us-east-1c']);
  });

  it('does not sort a single-element id array', () => {
    expect(canonicalizeIdArraysDeep(['subnet-aaa111'])).toEqual(['subnet-aaa111']);
  });

  it('does not sort a mixed id/non-id array', () => {
    const arr = ['subnet-aaa111', 'not-an-id'];
    expect(canonicalizeIdArraysDeep(arr)).toEqual(['subnet-aaa111', 'not-an-id']);
  });

  it('passes scalars through unchanged', () => {
    expect(canonicalizeIdArraysDeep('subnet-aaa111')).toBe('subnet-aaa111');
    expect(canonicalizeIdArraysDeep(7)).toBe(7);
    expect(canonicalizeIdArraysDeep(null)).toBe(null);
  });
});

describe('canonicalizeUnorderedArraysAtPaths', () => {
  it('sorts a plain-string array at a declared leaf path', () => {
    const v = { WindowsConfiguration: { Aliases: ['b.example.com', 'a.example.com'] } };
    expect(canonicalizeUnorderedArraysAtPaths(v, ['WindowsConfiguration.Aliases'])).toEqual({
      WindowsConfiguration: { Aliases: ['a.example.com', 'b.example.com'] },
    });
  });

  it('leaves a plain-string array at an undeclared path untouched', () => {
    const v = { Layers: ['z', 'a'] };
    expect(canonicalizeUnorderedArraysAtPaths(v, ['WindowsConfiguration.Aliases'])).toEqual({
      Layers: ['z', 'a'],
    });
  });

  it('treats a declared entry as a subtree prefix', () => {
    const v = {
      WindowsConfiguration: {
        SelfManagedActiveDirectoryConfiguration: { DnsIps: ['10.0.0.2', '10.0.0.1'] },
      },
    };
    expect(canonicalizeUnorderedArraysAtPaths(v, ['WindowsConfiguration'])).toEqual({
      WindowsConfiguration: {
        SelfManagedActiveDirectoryConfiguration: { DnsIps: ['10.0.0.1', '10.0.0.2'] },
      },
    });
  });

  it('sorts an object array at a declared path (issue #1620)', () => {
    const v = { P: [{ B: 2 }, { A: 1 }] };
    expect(canonicalizeUnorderedArraysAtPaths(v, ['P'])).toEqual({ P: [{ A: 1 }, { B: 2 }] });
  });

  it('sorts an object array independently of each element KEY order', () => {
    // The two sides carry the same two targets with their own keys emitted in
    // opposite orders. A raw JSON.stringify sort key would order them
    // differently and reintroduce the phantom drift this pass removes.
    const state = {
      Targets: [
        { Id: '10.0.0.2', Port: 80 },
        { Port: 80, Id: '10.0.0.1' },
      ],
    };
    const aws = {
      Targets: [
        { Port: 80, Id: '10.0.0.1' },
        { Id: '10.0.0.2', Port: 80 },
      ],
    };
    const a = canonicalizeUnorderedArraysAtPaths(state, ['Targets']) as {
      Targets: Array<Record<string, unknown>>;
    };
    const b = canonicalizeUnorderedArraysAtPaths(aws, ['Targets']) as {
      Targets: Array<Record<string, unknown>>;
    };
    expect(a.Targets.map((t) => t['Id'])).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(b.Targets.map((t) => t['Id'])).toEqual(['10.0.0.1', '10.0.0.2']);
  });

  it('sorts an object array at a declared path only, not at an undeclared one', () => {
    const v = { P: [{ B: 2 }, { A: 1 }] };
    expect(canonicalizeUnorderedArraysAtPaths(v, ['Other'])).toEqual({ P: [{ B: 2 }, { A: 1 }] });
  });

  it('does not sort an object array whose elements differ only in a NESTED key order', () => {
    // Guards the recursion of the sort key: nested objects must canonicalize
    // too, or two structurally equal elements compare unequal and the sort
    // becomes input-order dependent.
    const v = {
      P: [
        { Id: 'b', Meta: { Y: 2, X: 1 } },
        { Id: 'a', Meta: { X: 1, Y: 2 } },
      ],
    };
    const sorted = canonicalizeUnorderedArraysAtPaths(v, ['P']) as {
      P: Array<Record<string, unknown>>;
    };
    expect(sorted.P.map((e) => e['Id'])).toEqual(['a', 'b']);
  });

  it('does not sort a mixed-type array at a declared path', () => {
    const v = { P: ['b', 1] };
    expect(canonicalizeUnorderedArraysAtPaths(v, ['P'])).toEqual({ P: ['b', 1] });
  });

  it('does not sort an array mixing strings and objects at a declared path', () => {
    // Homogeneity is required for BOTH element shapes: a heterogeneous list has
    // no meaningful canonical order and the pass must leave it alone.
    const v = { P: ['b', { A: 1 }] };
    expect(canonicalizeUnorderedArraysAtPaths(v, ['P'])).toEqual({ P: ['b', { A: 1 }] });
  });

  it('does not sort an array containing a null element at a declared path', () => {
    // `typeof null === 'object'`, so an unguarded object test would sort here
    // and throw or mis-order on the null.
    const v = { P: [{ B: 2 }, null] };
    expect(canonicalizeUnorderedArraysAtPaths(v, ['P'])).toEqual({ P: [{ B: 2 }, null] });
  });

  it('leaves an empty array at a declared path unchanged', () => {
    expect(canonicalizeUnorderedArraysAtPaths({ P: [] }, ['P'])).toEqual({ P: [] });
  });

  it('does not sort an array sitting at a PREFIX of a declared path', () => {
    // 'A.B' is a prefix of the declared 'A.B.C' but is not itself declared:
    // neither exact-equal nor `<entry>.`-prefixed, so it must be left alone.
    const v = { A: { B: ['z', 'a'] } };
    expect(canonicalizeUnorderedArraysAtPaths(v, ['A.B.C'])).toEqual({ A: { B: ['z', 'a'] } });
  });

  it('does not sort the inner lists of an array-of-arrays at a declared path', () => {
    // Array elements inherit the parent path, so without the nested-array
    // guard the INNER lists would be sorted even though the outer array's
    // elements are not plain strings.
    const v = { P: [['b', 'a'], ['d', 'c']] };
    expect(canonicalizeUnorderedArraysAtPaths(v, ['P'])).toEqual({
      P: [['b', 'a'], ['d', 'c']],
    });
  });

  it('is a no-op when no paths are declared', () => {
    const v = { WindowsConfiguration: { Aliases: ['b', 'a'] } };
    expect(canonicalizeUnorderedArraysAtPaths(v, [])).toBe(v);
  });

  it('sorts a declared array nested under an array element (elements inherit the parent path)', () => {
    const v = { Items: [{ Aliases: ['b', 'a'] }] };
    expect(canonicalizeUnorderedArraysAtPaths(v, ['Items.Aliases'])).toEqual({
      Items: [{ Aliases: ['a', 'b'] }],
    });
  });

  it('passes scalars through unchanged', () => {
    expect(canonicalizeUnorderedArraysAtPaths('x', ['P'])).toBe('x');
    expect(canonicalizeUnorderedArraysAtPaths(null, ['P'])).toBe(null);
  });
});

describe('matchesPathPrefix (shared by both provider-declared path lists)', () => {
  // This matcher is the single implementation behind getDriftUnknownPaths
  // (via isIgnoredPath) and getDriftUnorderedPaths. Both are documented as
  // reading the same way, so the rule is pinned here once.
  it('matches an exactly-equal path', () => {
    expect(matchesPathPrefix('Code', ['Code'])).toBe(true);
  });

  it('matches anything beneath a declared entry (every entry is a subtree)', () => {
    expect(matchesPathPrefix('Code.S3Bucket', ['Code'])).toBe(true);
    expect(matchesPathPrefix('A.B.C.D', ['A.B'])).toBe(true);
  });

  it('does not match a sibling that merely shares a string prefix', () => {
    expect(matchesPathPrefix('CodeSigningConfigArn', ['Code'])).toBe(false);
  });

  it('does not match a path that is only a PREFIX of a declared entry', () => {
    expect(matchesPathPrefix('A.B', ['A.B.C'])).toBe(false);
  });

  it('does not match against an empty entry list', () => {
    expect(matchesPathPrefix('Code', [])).toBe(false);
  });
});
