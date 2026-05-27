/**
 * Unit tests for the #650 / #668 downstream-consumer enumeration helper.
 *
 * Covers:
 *   - Empty stacks → no consumers
 *   - Multiple consumer stacks → all returned
 *   - Self-import skip (producer importing its own output is invalid)
 *   - Mismatch region → not returned
 *   - Mismatch producer name → not returned
 *   - Unreadable state on one stack → skip + return remaining matches
 *   - Multiple imports on the same consumer → all entries returned
 *   - renderDownstreamConsumers output shape
 *   - #668: walk state.outputReads[] for Fn::GetStackOutput consumers
 *     (schema v8) alongside state.imports[] (schema v4)
 *   - #668: pre-v8 state (no outputReads) degrades to imports-only
 *   - #668: a consumer with BOTH imports and outputReads against the
 *     same producer emits one row per intrinsic kind
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import {
  findDownstreamConsumers,
  renderDownstreamConsumers,
  type DownstreamConsumer,
} from '../../../../src/cli/commands/recreate-downstream-consumers.js';
import type { S3StateBackend } from '../../../../src/state/s3-state-backend.js';
import type {
  StackState,
  StateImportEntry,
  StateOutputReadEntry,
} from '../../../../src/types/state.js';

function st(
  stackName: string,
  region: string,
  imports: StateImportEntry[] | undefined,
  outputReads?: StateOutputReadEntry[]
): StackState {
  return {
    version: 8,
    stackName,
    region,
    resources: {},
    outputs: {},
    ...(imports ? { imports } : {}),
    ...(outputReads ? { outputReads } : {}),
    lastModified: 0,
  };
}

function mockBackend(
  refs: Array<{ stackName: string; region?: string }>,
  states: Map<string, StackState | null>
): S3StateBackend {
  return {
    listStacks: vi.fn(async () => refs),
    getState: vi.fn(async (stackName: string, region: string) => {
      const key = `${stackName}|${region}`;
      const state = states.get(key);
      if (state === undefined) return null;
      if (state === null) throw new Error('state read failed');
      return { state, etag: 'e' };
    }),
  } as unknown as S3StateBackend;
}

describe('findDownstreamConsumers (#650)', () => {
  it('returns empty when no stacks have imports referencing the producer', async () => {
    const backend = mockBackend(
      [
        { stackName: 'StackA', region: 'us-east-1' },
        { stackName: 'StackB', region: 'us-east-1' },
      ],
      new Map([
        ['StackA|us-east-1', st('StackA', 'us-east-1', undefined)],
        ['StackB|us-east-1', st('StackB', 'us-east-1', [])],
      ])
    );
    const out = await findDownstreamConsumers({
      producerStack: 'Producer',
      producerRegion: 'us-east-1',
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });
    expect(out).toEqual([]);
  });

  it('returns every consumer that imports the producer', async () => {
    const backend = mockBackend(
      [
        { stackName: 'Producer', region: 'us-east-1' },
        { stackName: 'StackB', region: 'us-east-1' },
        { stackName: 'StackC', region: 'us-east-1' },
        { stackName: 'StackD', region: 'us-east-1' },
      ],
      new Map([
        ['Producer|us-east-1', st('Producer', 'us-east-1', [])],
        [
          'StackB|us-east-1',
          st('StackB', 'us-east-1', [
            { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'ArnA' },
          ]),
        ],
        [
          'StackC|us-east-1',
          st('StackC', 'us-east-1', [
            { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'ArnB' },
          ]),
        ],
        // Sibling that imports a different producer — should NOT be returned.
        [
          'StackD|us-east-1',
          st('StackD', 'us-east-1', [
            { sourceStack: 'OtherProducer', sourceRegion: 'us-east-1', exportName: 'X' },
          ]),
        ],
      ])
    );
    const out = await findDownstreamConsumers({
      producerStack: 'Producer',
      producerRegion: 'us-east-1',
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });
    expect(out.map((c) => c.consumerStack).sort()).toEqual(['StackB', 'StackC']);
    expect(out.every((c) => c.intrinsic === 'ImportValue')).toBe(true);
  });

  it('skips the producer itself (self-imports are invalid)', async () => {
    const backend = mockBackend(
      [{ stackName: 'Producer', region: 'us-east-1' }],
      new Map([
        [
          'Producer|us-east-1',
          st('Producer', 'us-east-1', [
            { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'SelfArn' },
          ]),
        ],
      ])
    );
    const out = await findDownstreamConsumers({
      producerStack: 'Producer',
      producerRegion: 'us-east-1',
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });
    expect(out).toEqual([]);
  });

  it('does NOT match a producer in a different region (cross-region scope)', async () => {
    const backend = mockBackend(
      [{ stackName: 'StackB', region: 'us-east-1' }],
      new Map([
        [
          'StackB|us-east-1',
          st('StackB', 'us-east-1', [
            { sourceStack: 'Producer', sourceRegion: 'us-west-2', exportName: 'ArnA' },
          ]),
        ],
      ])
    );
    const out = await findDownstreamConsumers({
      producerStack: 'Producer',
      producerRegion: 'us-east-1',
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });
    expect(out).toEqual([]);
  });

  it('soft-fails on unreadable state (returns what was read)', async () => {
    const backend = mockBackend(
      [
        { stackName: 'StackB', region: 'us-east-1' },
        { stackName: 'StackC', region: 'us-east-1' },
      ],
      new Map<string, StackState | null>([
        ['StackB|us-east-1', null], // throws on read
        [
          'StackC|us-east-1',
          st('StackC', 'us-east-1', [
            { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'ArnC' },
          ]),
        ],
      ])
    );
    const out = await findDownstreamConsumers({
      producerStack: 'Producer',
      producerRegion: 'us-east-1',
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });
    expect(out.map((c) => c.consumerStack)).toEqual(['StackC']);
  });

  it('returns multiple matches when a single consumer imports several outputs', async () => {
    const backend = mockBackend(
      [{ stackName: 'StackB', region: 'us-east-1' }],
      new Map([
        [
          'StackB|us-east-1',
          st('StackB', 'us-east-1', [
            { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'ArnA' },
            { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'ArnB' },
            { sourceStack: 'OtherProducer', sourceRegion: 'us-east-1', exportName: 'X' },
          ]),
        ],
      ])
    );
    const out = await findDownstreamConsumers({
      producerStack: 'Producer',
      producerRegion: 'us-east-1',
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });
    expect(out.map((c) => c.exportName).sort()).toEqual(['ArnA', 'ArnB']);
    expect(out.every((c) => c.consumerStack === 'StackB')).toBe(true);
  });

  it('soft-fails on listStacks error (deploy must not abort on transient S3 list failure)', async () => {
    const backend = {
      listStacks: vi.fn(async () => {
        throw new Error('AccessDeniedException on ListObjectsV2');
      }),
      getState: vi.fn(),
    } as unknown as S3StateBackend;
    const out = await findDownstreamConsumers({
      producerStack: 'Producer',
      producerRegion: 'us-east-1',
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });
    expect(out).toEqual([]);
    expect(backend.getState).not.toHaveBeenCalled();
  });

  it('falls back to baseRegion when ref.region is missing (legacy v1 records)', async () => {
    const backend = mockBackend(
      [{ stackName: 'StackB' /* no region */ }],
      new Map([
        [
          'StackB|us-east-1', // resolved via baseRegion
          st('StackB', 'us-east-1', [
            { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'ArnA' },
          ]),
        ],
      ])
    );
    const out = await findDownstreamConsumers({
      producerStack: 'Producer',
      producerRegion: 'us-east-1',
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });
    expect(out.map((c) => c.consumerStack)).toEqual(['StackB']);
  });

  it('walks outputReads[] (#668 schema v8) alongside imports[] and emits GetStackOutput rows', async () => {
    const backend = mockBackend(
      [
        { stackName: 'StackImporter', region: 'us-east-1' },
        { stackName: 'StackReader', region: 'us-east-1' },
      ],
      new Map([
        [
          'StackImporter|us-east-1',
          st('StackImporter', 'us-east-1', [
            { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'ArnA' },
          ]),
        ],
        [
          'StackReader|us-east-1',
          st('StackReader', 'us-east-1', undefined, [
            { sourceStack: 'Producer', sourceRegion: 'us-east-1', outputName: 'ArnB' },
          ]),
        ],
      ])
    );
    const out = await findDownstreamConsumers({
      producerStack: 'Producer',
      producerRegion: 'us-east-1',
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });
    expect(out).toHaveLength(2);
    const importer = out.find((c) => c.intrinsic === 'ImportValue');
    const reader = out.find((c) => c.intrinsic === 'GetStackOutput');
    expect(importer).toEqual({
      consumerStack: 'StackImporter',
      consumerRegion: 'us-east-1',
      exportName: 'ArnA',
      intrinsic: 'ImportValue',
    });
    expect(reader).toEqual({
      consumerStack: 'StackReader',
      consumerRegion: 'us-east-1',
      exportName: 'ArnB',
      intrinsic: 'GetStackOutput',
    });
  });

  it('degrades to imports-only for pre-v8 state (no outputReads field present)', async () => {
    // A v7 state blob written by the previous binary. The new binary
    // reads `outputReads === undefined` and skips that walk; imports
    // still works because v4 already supports it.
    const v7State: StackState = {
      version: 7,
      stackName: 'LegacyConsumer',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      imports: [
        { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'ArnA' },
      ],
      lastModified: 0,
    };
    const backend = mockBackend(
      [{ stackName: 'LegacyConsumer', region: 'us-east-1' }],
      new Map([['LegacyConsumer|us-east-1', v7State]])
    );
    const out = await findDownstreamConsumers({
      producerStack: 'Producer',
      producerRegion: 'us-east-1',
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.intrinsic).toBe('ImportValue');
  });

  it('a consumer reading the producer via BOTH intrinsics emits one row per kind', async () => {
    // Hybrid case: the consumer template has both Fn::ImportValue
    // and Fn::GetStackOutput pointing at the same producer (different
    // outputs). The enumeration must report both so the warn block
    // doesn't hide the GetStackOutput path.
    const backend = mockBackend(
      [{ stackName: 'StackHybrid', region: 'us-east-1' }],
      new Map([
        [
          'StackHybrid|us-east-1',
          st(
            'StackHybrid',
            'us-east-1',
            [{ sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'ArnA' }],
            [{ sourceStack: 'Producer', sourceRegion: 'us-east-1', outputName: 'ArnB' }]
          ),
        ],
      ])
    );
    const out = await findDownstreamConsumers({
      producerStack: 'Producer',
      producerRegion: 'us-east-1',
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.intrinsic).sort()).toEqual(['GetStackOutput', 'ImportValue']);
  });

  it('does NOT match a GetStackOutput consumer in a different region (cross-region scope)', async () => {
    const backend = mockBackend(
      [{ stackName: 'StackReader', region: 'us-east-1' }],
      new Map([
        [
          'StackReader|us-east-1',
          st('StackReader', 'us-east-1', undefined, [
            { sourceStack: 'Producer', sourceRegion: 'us-west-2', outputName: 'ArnA' },
          ]),
        ],
      ])
    );
    const out = await findDownstreamConsumers({
      producerStack: 'Producer',
      producerRegion: 'us-east-1',
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });
    expect(out).toEqual([]);
  });
});

describe('renderDownstreamConsumers (#650)', () => {
  function c(overrides: Partial<DownstreamConsumer> = {}): DownstreamConsumer {
    return {
      consumerStack: 'StackB',
      consumerRegion: 'us-east-1',
      exportName: 'ProducerArn',
      intrinsic: 'ImportValue',
      ...overrides,
    };
  }

  it('returns null on empty input (caller skips the subsection)', () => {
    expect(renderDownstreamConsumers('Producer', [])).toBe(null);
  });

  it('renders a header + one line per consumer', () => {
    const rendered = renderDownstreamConsumers('Producer', [
      c(),
      c({ consumerStack: 'StackC', exportName: 'OtherArn' }),
    ]);
    expect(rendered).not.toBe(null);
    expect(rendered!).toContain("Downstream consumers of Producer's outputs");
    expect(rendered!).toContain('- StackB (us-east-1) reads ProducerArn via Fn::ImportValue');
    expect(rendered!).toContain('- StackC (us-east-1) reads OtherArn via Fn::ImportValue');
  });

  it('renders Fn::GetStackOutput rows distinct from Fn::ImportValue (#668)', () => {
    const rendered = renderDownstreamConsumers('Producer', [
      c({ consumerStack: 'StackB', exportName: 'ArnA', intrinsic: 'ImportValue' }),
      c({ consumerStack: 'StackR', exportName: 'ArnB', intrinsic: 'GetStackOutput' }),
    ]);
    expect(rendered).not.toBe(null);
    expect(rendered!).toContain('- StackB (us-east-1) reads ArnA via Fn::ImportValue');
    expect(rendered!).toContain('- StackR (us-east-1) reads ArnB via Fn::GetStackOutput');
  });
});
