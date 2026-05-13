import { describe, it, expect, vi } from 'vite-plus/test';
import { scanActiveConsumers } from '../../../src/cli/commands/destroy-runner.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { StackState, StateImportEntry } from '../../../src/types/state.js';

/**
 * Helper: produce a fake state-backend with `listStacks` / `getState`
 * answering canned StackState payloads keyed by `(stackName, region)`.
 */
function mockBackend(
  records: Array<{ stackName: string; region: string; imports?: StateImportEntry[] }>
): S3StateBackend {
  return {
    listStacks: vi.fn(async () =>
      records.map((r) => ({ stackName: r.stackName, region: r.region }))
    ),
    getState: vi.fn(async (stackName: string, region: string) => {
      const found = records.find((r) => r.stackName === stackName && r.region === region);
      if (!found) return null;
      const state: StackState = {
        version: 4,
        stackName: found.stackName,
        region: found.region,
        resources: {},
        outputs: {},
        ...(found.imports && { imports: found.imports }),
        lastModified: 1,
      };
      return { state, etag: 'e' };
    }),
  } as unknown as S3StateBackend;
}

describe('scanActiveConsumers (strong-reference check)', () => {
  it('returns empty when no consumer references the producer', async () => {
    const backend = mockBackend([
      { stackName: 'Producer', region: 'us-east-1' },
      { stackName: 'Unrelated', region: 'us-east-1' },
    ]);
    const consumers = await scanActiveConsumers('Producer', 'us-east-1', {
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });
    expect(consumers).toEqual([]);
  });

  it('detects a single consumer importing one export', async () => {
    const backend = mockBackend([
      { stackName: 'Producer', region: 'us-east-1' },
      {
        stackName: 'Consumer',
        region: 'us-east-1',
        imports: [
          { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'BucketArn' },
        ],
      },
    ]);
    const consumers = await scanActiveConsumers('Producer', 'us-east-1', {
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });
    expect(consumers).toEqual([
      { consumerStack: 'Consumer', consumerRegion: 'us-east-1', exportName: 'BucketArn' },
    ]);
  });

  it('detects multiple consumers importing the same export', async () => {
    const importRef: StateImportEntry = {
      sourceStack: 'Producer',
      sourceRegion: 'us-east-1',
      exportName: 'BucketArn',
    };
    const backend = mockBackend([
      { stackName: 'Producer', region: 'us-east-1' },
      { stackName: 'C1', region: 'us-east-1', imports: [importRef] },
      { stackName: 'C2', region: 'us-east-1', imports: [importRef] },
    ]);
    const consumers = await scanActiveConsumers('Producer', 'us-east-1', {
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });
    expect(consumers.map((c) => c.consumerStack).sort()).toEqual(['C1', 'C2']);
  });

  it('detects multiple imports from one consumer', async () => {
    const backend = mockBackend([
      { stackName: 'Producer', region: 'us-east-1' },
      {
        stackName: 'C1',
        region: 'us-east-1',
        imports: [
          { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'BucketArn' },
          { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'TopicArn' },
        ],
      },
    ]);
    const consumers = await scanActiveConsumers('Producer', 'us-east-1', {
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });
    expect(consumers).toEqual([
      { consumerStack: 'C1', consumerRegion: 'us-east-1', exportName: 'BucketArn' },
      { consumerStack: 'C1', consumerRegion: 'us-east-1', exportName: 'TopicArn' },
    ]);
  });

  it('ignores imports from a different region (no cross-region collision)', async () => {
    const backend = mockBackend([
      { stackName: 'Producer', region: 'us-east-1' },
      {
        stackName: 'WrongRegionConsumer',
        region: 'us-east-1',
        imports: [
          {
            sourceStack: 'Producer',
            sourceRegion: 'us-west-2', // different region
            exportName: 'BucketArn',
          },
        ],
      },
    ]);
    const consumers = await scanActiveConsumers('Producer', 'us-east-1', {
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });
    expect(consumers).toEqual([]);
  });

  it('skips the producer’s own state (self-reference protection)', async () => {
    const backend = mockBackend([
      {
        stackName: 'Producer',
        region: 'us-east-1',
        imports: [
          // pathological: a stack importing its own export. Self-skip
          // must apply regardless of the recorded reference.
          { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'X' },
        ],
      },
    ]);
    const consumers = await scanActiveConsumers('Producer', 'us-east-1', {
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });
    expect(consumers).toEqual([]);
  });

  it('does not throw when one state file is unreadable (skips, continues)', async () => {
    const backend: S3StateBackend = {
      listStacks: vi.fn(async () => [
        { stackName: 'Producer', region: 'us-east-1' },
        { stackName: 'Good', region: 'us-east-1' },
        { stackName: 'Bad', region: 'us-east-1' },
      ]),
      getState: vi.fn(async (stackName: string, _region: string) => {
        if (stackName === 'Bad') throw new Error('S3 read failed');
        if (stackName === 'Good') {
          return {
            state: {
              version: 4,
              stackName: 'Good',
              region: 'us-east-1',
              resources: {},
              outputs: {},
              imports: [
                {
                  sourceStack: 'Producer',
                  sourceRegion: 'us-east-1',
                  exportName: 'BucketArn',
                },
              ],
              lastModified: 1,
            } as StackState,
            etag: 'e',
          };
        }
        return null;
      }),
    } as unknown as S3StateBackend;

    const consumers = await scanActiveConsumers('Producer', 'us-east-1', {
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });

    // Good still surfaces; Bad is swallowed.
    expect(consumers).toEqual([
      { consumerStack: 'Good', consumerRegion: 'us-east-1', exportName: 'BucketArn' },
    ]);
  });

  it('treats legacy (region=undefined) state as the caller’s baseRegion', async () => {
    // version 1 state never recorded region. We pass baseRegion as the
    // fallback so destroy-time checks remain consistent with deploy-side
    // resolver semantics.
    const backend: S3StateBackend = {
      listStacks: vi.fn(async () => [
        { stackName: 'Producer', region: 'us-east-1' },
        { stackName: 'LegacyC', region: undefined as unknown as string },
      ]),
      getState: vi.fn(async (stackName: string, _region: string) => {
        if (stackName === 'LegacyC') {
          return {
            state: {
              version: 1,
              stackName: 'LegacyC',
              resources: {},
              outputs: {},
              imports: [
                {
                  sourceStack: 'Producer',
                  sourceRegion: 'us-east-1',
                  exportName: 'BucketArn',
                },
              ],
              lastModified: 1,
            } as StackState,
            etag: 'e',
          };
        }
        return null;
      }),
    } as unknown as S3StateBackend;

    const consumers = await scanActiveConsumers('Producer', 'us-east-1', {
      stateBackend: backend,
      baseRegion: 'us-east-1',
    });
    expect(consumers).toEqual([
      { consumerStack: 'LegacyC', consumerRegion: 'us-east-1', exportName: 'BucketArn' },
    ]);
  });
});
