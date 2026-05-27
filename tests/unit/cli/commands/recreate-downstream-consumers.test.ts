/**
 * Unit tests for the #650 downstream-consumer enumeration helper.
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
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import {
  findDownstreamConsumers,
  renderDownstreamConsumers,
  type DownstreamConsumer,
} from '../../../../src/cli/commands/recreate-downstream-consumers.js';
import type { S3StateBackend } from '../../../../src/state/s3-state-backend.js';
import type { StackState, StateImportEntry } from '../../../../src/types/state.js';

function st(
  stackName: string,
  region: string,
  imports: StateImportEntry[] | undefined
): StackState {
  return {
    version: 7,
    stackName,
    region,
    resources: {},
    outputs: {},
    ...(imports ? { imports } : {}),
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
});
