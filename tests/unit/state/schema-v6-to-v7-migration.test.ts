import { describe, it, expect } from 'vite-plus/test';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  STATE_SCHEMA_VERSIONS_READABLE,
  type ResourceState,
  type StackState,
} from '../../../src/types/state.js';

/**
 * Schema v7 — `ResourceState.provisionedBy: 'sdk' | 'cc-api'` per-resource
 * field for the Cloud Control API greenfield fallback (issue
 * [#614](https://github.com/go-to-k/cdkd/issues/614)).
 *
 * The integ test `tests/integration/schema-v6-to-v7-migration/` proves the
 * transparent auto-migration round-trip against real AWS (markgate's
 * `integ-schema-migration` gate enforces it on merge). This unit test
 * pins the in-memory contract:
 *
 *   - the version literal type includes 7
 *   - the readable-version set accepts every prior version + 7
 *   - reading a v6 state with no `provisionedBy` on resources is allowed
 *     (degrades to "legacy SDK" semantics, matches behavior pre-#614)
 *   - JSON round-trip preserves `provisionedBy` when present, omits
 *     it when undefined (no spurious nulls)
 *   - v7 writers emit `version: 7` (= STATE_SCHEMA_VERSION_CURRENT)
 */
describe('State schema v7 — provisionedBy for Cloud Control auto-routing', () => {
  it('current schema version is 7', () => {
    expect(STATE_SCHEMA_VERSION_CURRENT).toBe(7);
  });

  it('readers accept every prior version + v7', () => {
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(1);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(2);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(3);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(4);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(5);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(6);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(7);
  });

  it('a v6 state blob (no provisionedBy on resources) deserializes cleanly and resources default to undefined', () => {
    // Real-world shape: an existing user has a v6 state file on disk. The
    // v7 binary reads it, treats every resource as legacy SDK (the
    // `provisionedBy === undefined` arm in `getProviderFor`), and the
    // next write upgrades to v7 silently.
    const v6Blob = JSON.stringify({
      version: 6,
      stackName: 'LegacyStack',
      region: 'us-east-1',
      resources: {
        MyBucket: {
          physicalId: 'my-bucket-12345',
          resourceType: 'AWS::S3::Bucket',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 1717024800000,
    });
    const parsed = JSON.parse(v6Blob) as StackState;
    expect(parsed.version).toBe(6);
    const myBucket = parsed.resources['MyBucket']!;
    expect(myBucket.provisionedBy).toBeUndefined();
    // The legacy-default behavior is documented in the v7 schema notes:
    // absent provisionedBy === SDK Provider semantics.
  });

  it('a v7 state blob round-trips provisionedBy: cc-api through JSON', () => {
    const v7State: StackState = {
      version: 7,
      stackName: 'CcManagedStack',
      region: 'us-east-1',
      resources: {
        MyLambda: {
          physicalId: 'arn:aws:lambda:us-east-1:1234567890:function:foo',
          resourceType: 'AWS::Lambda::Function',
          properties: { LoggingConfig: { LogFormat: 'JSON' } },
          attributes: {},
          dependencies: [],
          provisionedBy: 'cc-api',
        },
      },
      outputs: {},
      lastModified: 1717024800000,
    };

    const round = JSON.parse(JSON.stringify(v7State)) as StackState;
    expect(round.version).toBe(7);
    expect(round.resources['MyLambda']?.provisionedBy).toBe('cc-api');
  });

  it('a v7 state blob round-trips provisionedBy: sdk through JSON', () => {
    const v7State: StackState = {
      version: 7,
      stackName: 'MixedStack',
      region: 'us-east-1',
      resources: {
        MyBucket: {
          physicalId: 'my-bucket-12345',
          resourceType: 'AWS::S3::Bucket',
          properties: {},
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        },
      },
      outputs: {},
      lastModified: 0,
    };
    const round = JSON.parse(JSON.stringify(v7State)) as StackState;
    expect(round.resources['MyBucket']?.provisionedBy).toBe('sdk');
  });

  it('JSON.stringify omits undefined provisionedBy (legacy v6 shape stays v6-shaped)', () => {
    const r: ResourceState = {
      physicalId: 'phys',
      resourceType: 'AWS::S3::Bucket',
      properties: {},
      attributes: {},
      dependencies: [],
      provisionedBy: undefined,
    };
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain('provisionedBy');
  });

  it('the type-system only accepts the documented enum values', () => {
    // Compile-time assertion: TypeScript would reject 'aws-sdk' / 'cloud-control' / 'unknown'
    // here at type-check time. Runtime: the field is just a string, but the
    // assertion documents the allowed values.
    const sdk: ResourceState['provisionedBy'] = 'sdk';
    const cc: ResourceState['provisionedBy'] = 'cc-api';
    const absent: ResourceState['provisionedBy'] = undefined;
    expect([sdk, cc, absent]).toEqual(['sdk', 'cc-api', undefined]);
  });

  it('a heterogeneous v7 state mixes sdk- and cc-managed resources in one stack', () => {
    // Per #614 §2 — the state file becomes heterogeneous; siblings stay
    // SDK while a silent-drop-property-using resource flips to CC.
    const heterogeneous: StackState = {
      version: 7,
      stackName: 'Mixed',
      region: 'us-east-1',
      resources: {
        SdkResource: {
          physicalId: 'phys-sdk',
          resourceType: 'AWS::SQS::Queue',
          properties: {},
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        },
        CcResource: {
          physicalId: 'phys-cc',
          resourceType: 'AWS::Lambda::Function',
          properties: {},
          attributes: {},
          dependencies: [],
          provisionedBy: 'cc-api',
        },
      },
      outputs: {},
      lastModified: 0,
    };
    expect(heterogeneous.resources['SdkResource']?.provisionedBy).toBe('sdk');
    expect(heterogeneous.resources['CcResource']?.provisionedBy).toBe('cc-api');
  });
});
