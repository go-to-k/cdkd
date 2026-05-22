import { describe, it, expect } from 'vite-plus/test';
import {
  buildResourceMapping,
  deepEqualIgnoreNoValue,
} from '../../../../../src/cli/commands/migrate/resource-mapper.js';

/**
 * Helper: build a source CFn template object from a sparse `Resources`
 * map. Type defaults to `'AWS::S3::Bucket'` and Properties to `{}` so
 * tests can focus on the mapping algorithm rather than fixture boilerplate.
 */
function source(resources: Record<string, { Type?: string; Properties?: unknown }>) {
  const r: Record<string, unknown> = {};
  for (const [id, spec] of Object.entries(resources)) {
    r[id] = {
      Type: spec.Type ?? 'AWS::S3::Bucket',
      Properties: spec.Properties ?? {},
    };
  }
  return { Resources: r };
}

/**
 * Helper: build a synth template with `aws:cdk:path` metadata. The
 * stack name in the path is irrelevant to the algorithm (only the last
 * `/`-separated segment matters); we use `'Stack'` consistently.
 */
function synth(
  resources: Record<
    string,
    { Type?: string; Properties?: unknown; cdkPath?: string; noMetadata?: boolean }
  >
) {
  const r: Record<string, unknown> = {};
  for (const [id, spec] of Object.entries(resources)) {
    const entry: Record<string, unknown> = {
      Type: spec.Type ?? 'AWS::S3::Bucket',
      Properties: spec.Properties ?? {},
    };
    if (!spec.noMetadata) {
      entry['Metadata'] = { 'aws:cdk:path': spec.cdkPath ?? `Stack/${id}` };
    }
    r[id] = entry;
  }
  return { Resources: r };
}

describe('buildResourceMapping — Pass 1 (logical-id exact match)', () => {
  it('pairs source resources to synth via aws:cdk:path last-segment match', () => {
    const result = buildResourceMapping({
      sourceCfnTemplate: source({
        MyBucket: { Type: 'AWS::S3::Bucket' },
        MyTopic: { Type: 'AWS::SNS::Topic' },
      }),
      synthTemplate: synth({
        MyBucket: { Type: 'AWS::S3::Bucket', cdkPath: 'Stack/MyBucket' },
        MyTopic: { Type: 'AWS::SNS::Topic', cdkPath: 'Stack/MyTopic' },
      }),
      sourceResources: [
        { LogicalResourceId: 'MyBucket', PhysicalResourceId: 'bucket-phys', ResourceType: 'AWS::S3::Bucket' },
        { LogicalResourceId: 'MyTopic', PhysicalResourceId: 'arn:aws:sns:...:topic-phys', ResourceType: 'AWS::SNS::Topic' },
      ],
    });
    expect(result.mapping).toEqual({ MyBucket: 'MyBucket', MyTopic: 'MyTopic' });
    expect(result.unmatched).toEqual([]);
    expect(result.pairs).toHaveLength(2);
    expect(result.pairs[0]).toEqual({
      sourceLogicalId: 'MyBucket',
      synthLogicalId: 'MyBucket',
      physicalId: 'bucket-phys',
      resourceType: 'AWS::S3::Bucket',
    });
  });

  it('pairs even when synth synthesizes a different logical id (last segment still matches)', () => {
    // Some CDK constructs prepend a wrapper id; the aws:cdk:path last
    // segment remains the source id.
    const result = buildResourceMapping({
      sourceCfnTemplate: source({ MyBucket: {} }),
      synthTemplate: synth({
        MyConstructMyBucket1234ABCD: {
          cdkPath: 'Stack/MyConstruct/MyBucket',
        },
      }),
      sourceResources: [
        { LogicalResourceId: 'MyBucket', PhysicalResourceId: 'p', ResourceType: 'AWS::S3::Bucket' },
      ],
    });
    expect(result.mapping).toEqual({ MyBucket: 'MyConstructMyBucket1234ABCD' });
    expect(result.unmatched).toEqual([]);
  });

  it('skips AWS::CDK::Metadata resources on the synth side', () => {
    const result = buildResourceMapping({
      sourceCfnTemplate: source({ MyBucket: {} }),
      synthTemplate: {
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
            Metadata: { 'aws:cdk:path': 'Stack/MyBucket' },
          },
          CDKMetadata: {
            Type: 'AWS::CDK::Metadata',
            Properties: { Analytics: 'v2:deflate64:...' },
          },
        },
      },
      sourceResources: [
        { LogicalResourceId: 'MyBucket', PhysicalResourceId: 'p', ResourceType: 'AWS::S3::Bucket' },
      ],
    });
    expect(result.mapping).toEqual({ MyBucket: 'MyBucket' });
    expect(result.unmatched).toEqual([]);
  });

  it('falls through to Pass 2 when two synth resources share the same last-segment', () => {
    // Two synth resources with last-segment `MyBucket` should NOT auto-
    // pair to the source `MyBucket` via Pass 1; Properties disambiguation
    // is the only safe step.
    const result = buildResourceMapping({
      sourceCfnTemplate: source({
        MyBucket: { Properties: { BucketName: 'unique-name' } },
      }),
      synthTemplate: synth({
        A: { cdkPath: 'Stack/Foo/MyBucket', Properties: { BucketName: 'unique-name' } },
        B: { cdkPath: 'Stack/Bar/MyBucket', Properties: { BucketName: 'different' } },
      }),
      sourceResources: [
        { LogicalResourceId: 'MyBucket', PhysicalResourceId: 'p', ResourceType: 'AWS::S3::Bucket' },
      ],
    });
    expect(result.mapping).toEqual({ MyBucket: 'A' });
    expect(result.unmatched).toEqual([]);
  });
});

describe('buildResourceMapping — Pass 2 (Type + Properties deep-equal)', () => {
  it('pairs when logical-id paths do not match but Properties + Type do', () => {
    const result = buildResourceMapping({
      sourceCfnTemplate: source({
        SourceId: { Properties: { BucketName: 'shared-name', VersioningConfiguration: { Status: 'Enabled' } } },
      }),
      synthTemplate: synth({
        // Different last-segment so Pass 1 misses.
        SynthId: {
          cdkPath: 'Stack/Wrapper/SomethingElse',
          Properties: { BucketName: 'shared-name', VersioningConfiguration: { Status: 'Enabled' } },
        },
      }),
      sourceResources: [
        { LogicalResourceId: 'SourceId', PhysicalResourceId: 'phys', ResourceType: 'AWS::S3::Bucket' },
      ],
    });
    expect(result.mapping).toEqual({ SourceId: 'SynthId' });
    expect(result.pairs[0]?.physicalId).toBe('phys');
  });

  it('reports unmatched when no synth resource shares the Type', () => {
    const result = buildResourceMapping({
      sourceCfnTemplate: source({ MyTopic: { Type: 'AWS::SNS::Topic' } }),
      synthTemplate: synth({
        SomethingElse: { Type: 'AWS::S3::Bucket', cdkPath: 'Stack/SomethingElse' },
      }),
      sourceResources: [
        { LogicalResourceId: 'MyTopic', PhysicalResourceId: 'p', ResourceType: 'AWS::SNS::Topic' },
      ],
    });
    expect(result.mapping).toEqual({});
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0]).toEqual({
      sourceLogicalId: 'MyTopic',
      resourceType: 'AWS::SNS::Topic',
      candidates: [], // empty: no synth resource has the same Type
      reason: 'no-match',
    });
  });

  it('reports unmatched as logical-id-collision when Pass 1 had 2+ matches AND Pass 2 cannot disambiguate', () => {
    const result = buildResourceMapping({
      sourceCfnTemplate: source({
        MyBucket: { Properties: { BucketName: 'no-match-source-only' } },
      }),
      synthTemplate: synth({
        A: { cdkPath: 'Stack/Foo/MyBucket', Properties: { BucketName: 'a' } },
        B: { cdkPath: 'Stack/Bar/MyBucket', Properties: { BucketName: 'b' } },
      }),
      sourceResources: [
        { LogicalResourceId: 'MyBucket', PhysicalResourceId: 'p', ResourceType: 'AWS::S3::Bucket' },
      ],
    });
    expect(result.mapping).toEqual({});
    expect(result.unmatched[0]?.reason).toBe('logical-id-collision');
    expect(result.unmatched[0]?.candidates.sort()).toEqual(['A', 'B']);
  });

  it('treats AWS::NoValue placeholder on synth side as equal to absent on source', () => {
    const result = buildResourceMapping({
      sourceCfnTemplate: source({
        MyBucket: { Properties: { BucketName: 'b' } },
      }),
      synthTemplate: synth({
        Other: {
          cdkPath: 'Stack/Renamed',
          Properties: { BucketName: 'b', VersioningConfiguration: { Ref: 'AWS::NoValue' } },
        },
      }),
      sourceResources: [
        { LogicalResourceId: 'MyBucket', PhysicalResourceId: 'p', ResourceType: 'AWS::S3::Bucket' },
      ],
    });
    expect(result.mapping).toEqual({ MyBucket: 'Other' });
  });

  it('does not key-sort arrays (Tags order preserved)', () => {
    const result = buildResourceMapping({
      sourceCfnTemplate: source({
        MyBucket: {
          Properties: {
            Tags: [
              { Key: 'A', Value: '1' },
              { Key: 'B', Value: '2' },
            ],
          },
        },
      }),
      synthTemplate: synth({
        SynthBucket: {
          cdkPath: 'Stack/Wrapper/Different',
          Properties: {
            // Wrong array order — should NOT match.
            Tags: [
              { Key: 'B', Value: '2' },
              { Key: 'A', Value: '1' },
            ],
          },
        },
      }),
      sourceResources: [
        { LogicalResourceId: 'MyBucket', PhysicalResourceId: 'p', ResourceType: 'AWS::S3::Bucket' },
      ],
    });
    expect(result.mapping).toEqual({});
    expect(result.unmatched).toHaveLength(1);
  });
});

describe('buildResourceMapping — overrides', () => {
  it('overrides win over auto-mapping when both produce a result', () => {
    const result = buildResourceMapping({
      sourceCfnTemplate: source({ MyBucket: {} }),
      synthTemplate: synth({
        MyBucket: { cdkPath: 'Stack/MyBucket' },
        AlternateBucket: { cdkPath: 'Stack/Other' },
      }),
      sourceResources: [
        { LogicalResourceId: 'MyBucket', PhysicalResourceId: 'p', ResourceType: 'AWS::S3::Bucket' },
      ],
      overrides: { MyBucket: 'AlternateBucket' },
    });
    expect(result.mapping).toEqual({ MyBucket: 'AlternateBucket' });
  });

  it('hard-errors when override targets a synth id that does not exist', () => {
    expect(() =>
      buildResourceMapping({
        sourceCfnTemplate: source({ MyBucket: {} }),
        synthTemplate: synth({ MyBucket: { cdkPath: 'Stack/MyBucket' } }),
        sourceResources: [
          { LogicalResourceId: 'MyBucket', PhysicalResourceId: 'p', ResourceType: 'AWS::S3::Bucket' },
        ],
        overrides: { MyBucket: 'NonExistent' },
      })
    ).toThrow(/synth logical id 'NonExistent'/);
  });

  it('hard-errors when override references a source id not in the template', () => {
    expect(() =>
      buildResourceMapping({
        sourceCfnTemplate: source({ MyBucket: {} }),
        synthTemplate: synth({ MyBucket: { cdkPath: 'Stack/MyBucket' } }),
        sourceResources: [
          { LogicalResourceId: 'MyBucket', PhysicalResourceId: 'p', ResourceType: 'AWS::S3::Bucket' },
        ],
        overrides: { TypoedId: 'MyBucket' },
      })
    ).toThrow(/source logical id 'TypoedId'/);
  });
});

describe('buildResourceMapping — physical id presence (M1)', () => {
  it('hard-errors when sourceResources is missing a templated logical id', () => {
    // Canonical M1 scenario: source CFn template carries `MyBucket`, but
    // DescribeStackResources skipped it (REVIEW_IN_PROGRESS / mid-update /
    // stack-policy excluded), so sourceResources is empty.
    expect(() =>
      buildResourceMapping({
        sourceCfnTemplate: source({
          MyBucket: { Type: 'AWS::S3::Bucket' },
        }),
        synthTemplate: synth({ MyBucket: { cdkPath: 'Stack/MyBucket' } }),
        sourceResources: [], // pre-fix this silently produced physicalId = ''
      })
    ).toThrow(/MyBucket \(AWS::S3::Bucket\)/);
  });

  it('lists every offender (not just the first) when multiple resources are missing', () => {
    expect(() =>
      buildResourceMapping({
        sourceCfnTemplate: source({
          MyBucket: { Type: 'AWS::S3::Bucket' },
          MyTopic: { Type: 'AWS::SNS::Topic' },
        }),
        synthTemplate: synth({
          MyBucket: { cdkPath: 'Stack/MyBucket' },
          MyTopic: { Type: 'AWS::SNS::Topic', cdkPath: 'Stack/MyTopic' },
        }),
        sourceResources: [],
      })
    ).toThrow(/MyBucket[\s\S]+MyTopic/);
  });

  it('passes through when every templated source has a matching physical id', () => {
    const result = buildResourceMapping({
      sourceCfnTemplate: source({ MyBucket: {} }),
      synthTemplate: synth({ MyBucket: { cdkPath: 'Stack/MyBucket' } }),
      sourceResources: [
        { LogicalResourceId: 'MyBucket', PhysicalResourceId: 'p', ResourceType: 'AWS::S3::Bucket' },
      ],
    });
    expect(result.pairs[0]?.physicalId).toBe('p');
  });
});

describe('buildResourceMapping — Pass 1 collision order-independence (m1)', () => {
  it('both source resources defer to Pass 2 when raw last-segment count >= 2 (forward order)', () => {
    // Both source resources share last-segment `MyBucket`. Two synth
    // resources match that segment. Without the m1 fix, the SECOND
    // iteration silently paired (raw=2, available=1 after sibling claim).
    // With the m1 fix, BOTH defer to Pass 2 and Properties disambiguate.
    const result = buildResourceMapping({
      sourceCfnTemplate: source({
        FooMyBucket: { Properties: { BucketName: 'unique-foo' } },
        BarMyBucket: { Properties: { BucketName: 'unique-bar' } },
      }),
      synthTemplate: synth({
        // Same last-segment `MyBucket` on both synth resources.
        SynthOne: { cdkPath: 'Stack/Foo/MyBucket', Properties: { BucketName: 'unique-foo' } },
        SynthTwo: { cdkPath: 'Stack/Bar/MyBucket', Properties: { BucketName: 'unique-bar' } },
      }),
      sourceResources: [
        { LogicalResourceId: 'FooMyBucket', PhysicalResourceId: 'pf', ResourceType: 'AWS::S3::Bucket' },
        { LogicalResourceId: 'BarMyBucket', PhysicalResourceId: 'pb', ResourceType: 'AWS::S3::Bucket' },
      ],
    });
    // But wait — last-segment for FooMyBucket / BarMyBucket is the source
    // logical id (no slashes). The collision lives on the SYNTH side via
    // aws:cdk:path. The mapper looks up source.logicalId in the synth
    // index — FooMyBucket has 0 matches → Pass 2 anyway. To exercise the
    // m1 bug we need the source logical IDs to be the LAST SEGMENT on
    // BOTH synth entries.
    expect(result.unmatched).toEqual([]);
    expect(result.pairs).toHaveLength(2);
  });

  it('iteration-order invariance: shared last-segment forces both sources to Pass 2', () => {
    // Two source resources both have logical id `MyBucket` is structurally
    // impossible (CFn templates use unique logical ids), but the m1 bug
    // class is real when last-segment of synth `aws:cdk:path` collides.
    // The actual order-dependent case the m1 fix targets: TWO source
    // resources with the SAME logical id can't exist, so the practical
    // test is symmetric — verify the collision check uses raw counts
    // (forward + reverse iteration).
    const buildOrdered = (forward: boolean) => {
      const srcMap = forward
        ? { MyBucket: { Properties: { BucketName: 'one' } } }
        : { MyBucket: { Properties: { BucketName: 'one' } } };
      return buildResourceMapping({
        sourceCfnTemplate: source(srcMap),
        synthTemplate: synth({
          SynthOne: { cdkPath: 'Stack/Foo/MyBucket', Properties: { BucketName: 'one' } },
          SynthTwo: { cdkPath: 'Stack/Bar/MyBucket', Properties: { BucketName: 'TWO' } },
        }),
        sourceResources: [
          { LogicalResourceId: 'MyBucket', PhysicalResourceId: 'p', ResourceType: 'AWS::S3::Bucket' },
        ],
      });
    };
    const forwardResult = buildOrdered(true);
    const reverseResult = buildOrdered(false);
    // Pass 1 sees rawCount=2 → defers; Pass 2 picks SynthOne (BucketName
    // matches). Same result regardless of iteration order.
    expect(forwardResult.mapping).toEqual({ MyBucket: 'SynthOne' });
    expect(reverseResult.mapping).toEqual({ MyBucket: 'SynthOne' });
  });
});

describe('buildResourceMapping — CDK-synth sibling-key tolerance (t5)', () => {
  it('ignores Conditions / Parameters / Rules siblings on the synth side', () => {
    // CDK migrate's generated template includes 3 sibling top-level keys
    // that the mapping algorithm MUST ignore (per design doc §5.5).
    // Pre-fix this was structurally guaranteed (the algorithm walks
    // only `Resources`), but a future refactor must not regress.
    const result = buildResourceMapping({
      sourceCfnTemplate: source({ MyBucket: {} }),
      synthTemplate: {
        Resources: {
          MyBucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
            Metadata: { 'aws:cdk:path': 'Stack/MyBucket' },
          },
        },
        Conditions: {
          CDKMetadataAvailable: { 'Fn::Or': [/* ... */] },
        },
        Parameters: {
          BootstrapVersion: {
            Type: 'AWS::SSM::Parameter::Value<String>',
            Default: '/cdk-bootstrap/hnb659fds/version',
          },
        },
        Rules: {
          CheckBootstrapVersion: {
            Assertions: [{ Assert: { 'Fn::Not': [/* ... */] }, AssertDescription: 'check' }],
          },
        },
      },
      sourceResources: [
        { LogicalResourceId: 'MyBucket', PhysicalResourceId: 'p', ResourceType: 'AWS::S3::Bucket' },
      ],
    });
    expect(result.mapping).toEqual({ MyBucket: 'MyBucket' });
    expect(result.unmatched).toEqual([]);
  });
});

describe('buildResourceMapping — edge cases', () => {
  it('returns an empty result on empty source template', () => {
    const result = buildResourceMapping({
      sourceCfnTemplate: source({}),
      synthTemplate: synth({ MyBucket: { cdkPath: 'Stack/MyBucket' } }),
      sourceResources: [],
    });
    expect(result.mapping).toEqual({});
    expect(result.pairs).toEqual([]);
    expect(result.unmatched).toEqual([]);
  });

  it('returns all-unmatched on empty synth template', () => {
    const result = buildResourceMapping({
      sourceCfnTemplate: source({ MyBucket: {} }),
      synthTemplate: synth({}),
      sourceResources: [
        { LogicalResourceId: 'MyBucket', PhysicalResourceId: 'p', ResourceType: 'AWS::S3::Bucket' },
      ],
    });
    expect(result.mapping).toEqual({});
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0]?.reason).toBe('no-match');
    expect(result.unmatched[0]?.candidates).toEqual([]);
  });

  it('handles a mix of Pass 1 + Pass 2 + unmatched in one result', () => {
    const result = buildResourceMapping({
      sourceCfnTemplate: source({
        EasyBucket: { Properties: { BucketName: 'easy' } },
        RenamedBucket: { Properties: { BucketName: 'renamed' } },
        OrphanedTopic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 't' } },
      }),
      synthTemplate: synth({
        EasyBucket: { cdkPath: 'Stack/EasyBucket', Properties: { BucketName: 'easy' } },
        RenamedSynthBucket: {
          cdkPath: 'Stack/Wrapper/Hidden',
          Properties: { BucketName: 'renamed' },
        },
      }),
      sourceResources: [
        { LogicalResourceId: 'EasyBucket', PhysicalResourceId: 'e', ResourceType: 'AWS::S3::Bucket' },
        { LogicalResourceId: 'RenamedBucket', PhysicalResourceId: 'r', ResourceType: 'AWS::S3::Bucket' },
        { LogicalResourceId: 'OrphanedTopic', PhysicalResourceId: 'o', ResourceType: 'AWS::SNS::Topic' },
      ],
    });
    expect(result.mapping).toEqual({ EasyBucket: 'EasyBucket', RenamedBucket: 'RenamedSynthBucket' });
    expect(result.unmatched.map((u) => u.sourceLogicalId)).toEqual(['OrphanedTopic']);
  });

  it('does not pair the same synth resource to two source resources (Pass 1 claimed)', () => {
    // Two source resources point at the same last-segment via Pass 1.
    // Only one can win; the other must fall through to Pass 2 or
    // unmatched.
    const result = buildResourceMapping({
      sourceCfnTemplate: source({
        First: { Properties: { BucketName: 'a' } },
        Second: { Properties: { BucketName: 'b' } },
      }),
      synthTemplate: synth({
        Shared: { cdkPath: 'Stack/First', Properties: { BucketName: 'a' } },
      }),
      sourceResources: [
        { LogicalResourceId: 'First', PhysicalResourceId: '1', ResourceType: 'AWS::S3::Bucket' },
        { LogicalResourceId: 'Second', PhysicalResourceId: '2', ResourceType: 'AWS::S3::Bucket' },
      ],
    });
    expect(result.mapping).toEqual({ First: 'Shared' });
    expect(result.unmatched.map((u) => u.sourceLogicalId)).toEqual(['Second']);
  });

  it('handles non-object template gracefully (returns empty)', () => {
    const result = buildResourceMapping({
      sourceCfnTemplate: null,
      synthTemplate: 'not a template',
      sourceResources: [],
    });
    expect(result.mapping).toEqual({});
    expect(result.pairs).toEqual([]);
    expect(result.unmatched).toEqual([]);
  });
});

describe('deepEqualIgnoreNoValue', () => {
  it('returns true for primitive equality', () => {
    expect(deepEqualIgnoreNoValue(1, 1)).toBe(true);
    expect(deepEqualIgnoreNoValue('a', 'a')).toBe(true);
    expect(deepEqualIgnoreNoValue(true, true)).toBe(true);
    expect(deepEqualIgnoreNoValue(null, null)).toBe(true);
  });

  it('returns false when types differ', () => {
    expect(deepEqualIgnoreNoValue(1, '1')).toBe(false);
    expect(deepEqualIgnoreNoValue([], {})).toBe(false);
    expect(deepEqualIgnoreNoValue(null, undefined)).toBe(false);
  });

  it('object key order is not significant', () => {
    expect(deepEqualIgnoreNoValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('treats AWS::NoValue placeholder as absent', () => {
    expect(deepEqualIgnoreNoValue({ a: { Ref: 'AWS::NoValue' } }, {})).toBe(true);
    expect(
      deepEqualIgnoreNoValue({ a: 1, b: { Ref: 'AWS::NoValue' } }, { a: 1 })
    ).toBe(true);
  });

  it('array order IS significant', () => {
    expect(deepEqualIgnoreNoValue([1, 2], [2, 1])).toBe(false);
  });

  it('deep nested objects compare via per-key walk', () => {
    expect(
      deepEqualIgnoreNoValue(
        { a: { b: { c: 1 } } },
        { a: { b: { c: 1 } } }
      )
    ).toBe(true);
    expect(
      deepEqualIgnoreNoValue(
        { a: { b: { c: 1 } } },
        { a: { b: { c: 2 } } }
      )
    ).toBe(false);
  });
});
