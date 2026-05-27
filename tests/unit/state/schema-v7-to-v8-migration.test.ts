import { describe, it, expect } from 'vite-plus/test';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  STATE_SCHEMA_VERSIONS_READABLE,
  type StackState,
  type StateOutputReadEntry,
} from '../../../src/types/state.js';

/**
 * Schema v8 — `StackState.outputReads[]` for `Fn::GetStackOutput`
 * downstream-consumer enumeration (issue
 * [#668](https://github.com/go-to-k/cdkd/issues/668)).
 *
 * The integ test `tests/integration/schema-v7-to-v8-migration/` proves
 * the transparent auto-migration round-trip against real AWS (markgate's
 * `integ-schema-migration` gate enforces it on merge). This unit test
 * pins the in-memory contract:
 *
 *   - the version literal type includes 8
 *   - the readable-version set accepts every prior version + 8
 *   - reading a v7 state with no `outputReads` is allowed (degrades to
 *     "no GetStackOutput consumers known" — matches v4 imports[] policy)
 *   - JSON round-trip preserves `outputReads` when present, omits it
 *     when undefined (no spurious nulls or empty arrays)
 *   - v8 writers emit `version: 8` (= STATE_SCHEMA_VERSION_CURRENT)
 */
describe('State schema v8 — outputReads for Fn::GetStackOutput enumeration', () => {
  it('current schema version is at least 8 (subsequent bumps may carry this forward)', () => {
    expect(STATE_SCHEMA_VERSION_CURRENT).toBeGreaterThanOrEqual(8);
  });

  it('readers accept every prior version + v8', () => {
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(1);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(2);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(3);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(4);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(5);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(6);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(7);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(8);
  });

  it('a v7 state blob (no outputReads) deserializes cleanly and the field is undefined', () => {
    // Real-world shape: an existing user has a v7 state file on disk.
    // The v8 binary reads it, sees `outputReads === undefined`, and
    // the next write upgrades to v8 silently. Enumeration degrades to
    // imports-only for the legacy state.
    const v7Blob = JSON.stringify({
      version: 7,
      stackName: 'LegacyV7Stack',
      region: 'us-east-1',
      resources: {
        MyParam: {
          physicalId: '/legacy/param',
          resourceType: 'AWS::SSM::Parameter',
          properties: {},
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
        },
      },
      outputs: { ParamArn: 'arn:aws:ssm:us-east-1:1234567890:parameter/legacy/param' },
      imports: [
        { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'ProducerArn' },
      ],
      lastModified: 1717024800000,
    });
    const parsed = JSON.parse(v7Blob) as StackState;
    expect(parsed.version).toBe(7);
    expect(parsed.outputReads).toBeUndefined();
    expect(parsed.imports).toBeDefined();
  });

  it('a v8 state blob round-trips outputReads through JSON', () => {
    const entry: StateOutputReadEntry = {
      sourceStack: 'Producer',
      sourceRegion: 'us-west-2',
      outputName: 'ProducerArn',
    };
    const v8State: StackState = {
      version: 8,
      stackName: 'ConsumerStack',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      outputReads: [entry],
      lastModified: 1717024800000,
    };
    const round = JSON.parse(JSON.stringify(v8State)) as StackState;
    expect(round.version).toBe(8);
    expect(round.outputReads).toEqual([entry]);
  });

  it('a v8 state blob with both imports and outputReads serializes both', () => {
    const v8State: StackState = {
      version: 8,
      stackName: 'MixedConsumer',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      imports: [
        { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'ProducerExportName' },
      ],
      outputReads: [
        { sourceStack: 'Producer', sourceRegion: 'us-east-1', outputName: 'ProducerOutputName' },
      ],
      lastModified: 0,
    };
    const round = JSON.parse(JSON.stringify(v8State)) as StackState;
    expect(round.imports).toHaveLength(1);
    expect(round.outputReads).toHaveLength(1);
    expect(round.outputReads?.[0]?.outputName).toBe('ProducerOutputName');
  });

  it('JSON.stringify omits undefined outputReads (legacy v7 shape stays v7-shaped on rewrite of an empty consumer)', () => {
    // A v8 binary deploying a stack that resolves zero Fn::GetStackOutput
    // references must NOT emit `outputReads: []` — the deploy-engine
    // persists the field only when the bag is non-empty (mirrors the
    // imports[] policy). So a no-GetStackOutput stack's serialized
    // form on the wire is byte-identical to v7 except for `version: 8`.
    const v8State: StackState = {
      version: 8,
      stackName: 'NoGetStackOutputRefs',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      lastModified: 0,
    };
    const serialized = JSON.stringify(v8State);
    expect(serialized).not.toContain('outputReads');
  });

  it('a single producer with multiple distinct output names yields multiple StateOutputReadEntry rows', () => {
    // Same (sourceStack, sourceRegion) appearing with two different
    // outputNames must not be deduped — they describe two distinct
    // consumer references.
    const entries: StateOutputReadEntry[] = [
      { sourceStack: 'Producer', sourceRegion: 'us-east-1', outputName: 'OutA' },
      { sourceStack: 'Producer', sourceRegion: 'us-east-1', outputName: 'OutB' },
    ];
    const v8State: StackState = {
      version: 8,
      stackName: 'C',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      outputReads: entries,
      lastModified: 0,
    };
    const round = JSON.parse(JSON.stringify(v8State)) as StackState;
    expect(round.outputReads).toHaveLength(2);
    expect(round.outputReads?.map((e) => e.outputName)).toEqual(['OutA', 'OutB']);
  });
});
