import { describe, it, expect, vi } from 'vite-plus/test';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { ResolverContext } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { ExportIndexStore } from '../../../src/state/export-index-store.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StateImportEntry } from '../../../src/types/state.js';

/**
 * Helper: build a minimal per-region ExportIndexStore mock. The
 * cross-region resolver consults `lookup` only.
 */
function mockIndex(
  hits: Record<string, { value: unknown; producerStack: string; producerRegion: string }>,
  opts: { throws?: Error } = {}
): ExportIndexStore {
  const store: Partial<ExportIndexStore> = {
    lookup: vi.fn(async (name: string) => {
      if (opts.throws) throw opts.throws;
      return hits[name];
    }),
    patchEntry: vi.fn(async () => undefined),
  };
  return store as ExportIndexStore;
}

/**
 * Helper: empty state backend so the same-region fallback scan finds
 * nothing (every test in this file exercises the cross-region path
 * AFTER the same-region miss).
 */
function emptyBackend(): S3StateBackend {
  return {
    listStacks: vi.fn(async () => []),
    getState: vi.fn(async () => null),
  } as unknown as S3StateBackend;
}

function buildContext(overrides: Partial<ResolverContext>): ResolverContext {
  const template: CloudFormationTemplate = { Resources: {} };
  return {
    template,
    resources: {},
    stackName: 'Consumer',
    ...overrides,
  };
}

describe('IntrinsicFunctionResolver - Fn::ImportValue cross-region fallback', () => {
  it('resolves a same-region miss against a single configured foreign region', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const sameRegionIndex = mockIndex({}); // miss
    const crossRegion = new Map<string, ExportIndexStore>([
      [
        'us-west-2',
        mockIndex({
          BucketArn: {
            value: 'arn:cross',
            producerStack: 'Producer',
            producerRegion: 'us-west-2',
          },
        }),
      ],
    ]);
    const recorded: StateImportEntry[] = [];

    const result = await resolver.resolve(
      { 'Fn::ImportValue': 'BucketArn' },
      buildContext({
        stateBackend: emptyBackend(),
        exportIndex: sameRegionIndex,
        crossRegionExportIndexes: crossRegion,
        recordedImports: recorded,
      })
    );

    expect(result).toBe('arn:cross');
    // Strong-ref bookkeeping records the producer's region — load-bearing
    // for the v4 destroy-time scan.
    expect(recorded).toEqual([
      { sourceStack: 'Producer', sourceRegion: 'us-west-2', exportName: 'BucketArn' },
    ]);
  });

  it('throws ambiguity error when the same export name resolves in two foreign regions', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const crossRegion = new Map<string, ExportIndexStore>([
      [
        'us-west-2',
        mockIndex({
          BucketArn: {
            value: 'arn:west',
            producerStack: 'ProducerWest',
            producerRegion: 'us-west-2',
          },
        }),
      ],
      [
        'eu-west-1',
        mockIndex({
          BucketArn: {
            value: 'arn:eu',
            producerStack: 'ProducerEu',
            producerRegion: 'eu-west-1',
          },
        }),
      ],
    ]);

    await expect(
      resolver.resolve(
        { 'Fn::ImportValue': 'BucketArn' },
        buildContext({
          stateBackend: emptyBackend(),
          exportIndex: mockIndex({}),
          crossRegionExportIndexes: crossRegion,
        })
      )
    ).rejects.toThrow(/ambiguous/);

    // The error message should name BOTH regions for actionability.
    try {
      await resolver.resolve(
        { 'Fn::ImportValue': 'BucketArn' },
        buildContext({
          stateBackend: emptyBackend(),
          exportIndex: mockIndex({}),
          crossRegionExportIndexes: crossRegion,
        })
      );
      expect.fail('expected to throw');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain('us-west-2');
      expect(msg).toContain('eu-west-1');
      expect(msg).toContain('ProducerWest');
      expect(msg).toContain('ProducerEu');
      expect(msg).toContain('Fn::GetStackOutput');
    }
  });

  it('does NOT fall back cross-region when same-region resolve hits', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const sameRegionIndex = mockIndex({
      BucketArn: {
        value: 'arn:same',
        producerStack: 'Local',
        producerRegion: 'us-east-1',
      },
    });
    const lookupSpy = vi.fn(async () => ({
      value: 'arn:cross',
      producerStack: 'Foreign',
      producerRegion: 'us-west-2',
    }));
    const foreignIndex: Partial<ExportIndexStore> = {
      lookup: lookupSpy as unknown as ExportIndexStore['lookup'],
    };
    const crossRegion = new Map<string, ExportIndexStore>([
      ['us-west-2', foreignIndex as ExportIndexStore],
    ]);

    const result = await resolver.resolve(
      { 'Fn::ImportValue': 'BucketArn' },
      buildContext({
        stateBackend: emptyBackend(),
        exportIndex: sameRegionIndex,
        crossRegionExportIndexes: crossRegion,
      })
    );

    expect(result).toBe('arn:same');
    // Foreign region must NOT have been consulted — short-circuit on
    // same-region hit is load-bearing for the cost / blast-radius
    // promise of opt-in cross-region.
    expect(lookupSpy.mock.calls.length).toBe(0);
  });

  it('throws same-region-only error (with hint) when no flag is set and no resolve hits', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');

    await expect(
      resolver.resolve(
        { 'Fn::ImportValue': 'Missing' },
        buildContext({
          stateBackend: emptyBackend(),
          exportIndex: mockIndex({}),
          // No crossRegionExportIndexes — exercises the pre-PR default.
        })
      )
    ).rejects.toThrow(/--import-value-cross-region/);
  });

  it('skips a foreign region whose lookup throws and still resolves via another foreign region', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const crossRegion = new Map<string, ExportIndexStore>([
      // First region's index throws — degrade gracefully (warn) and keep going.
      ['us-west-2', mockIndex({}, { throws: new Error('IAM AccessDenied') })],
      [
        'eu-west-1',
        mockIndex({
          BucketArn: {
            value: 'arn:eu',
            producerStack: 'ProducerEu',
            producerRegion: 'eu-west-1',
          },
        }),
      ],
    ]);

    const result = await resolver.resolve(
      { 'Fn::ImportValue': 'BucketArn' },
      buildContext({
        stateBackend: emptyBackend(),
        exportIndex: mockIndex({}),
        crossRegionExportIndexes: crossRegion,
      })
    );

    expect(result).toBe('arn:eu');
  });

  it('skips a cross-region index entry owned by the consumer itself (self-reference)', async () => {
    // Defense in depth: if a foreign region's index happens to claim
    // an entry whose producerStack == the consumer stack (stale data
    // or shared logical id), don't return it.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const crossRegion = new Map<string, ExportIndexStore>([
      [
        'us-west-2',
        mockIndex({
          BucketArn: {
            value: 'self',
            producerStack: 'Consumer',
            producerRegion: 'us-west-2',
          },
        }),
      ],
    ]);

    await expect(
      resolver.resolve(
        { 'Fn::ImportValue': 'BucketArn' },
        buildContext({
          stateBackend: emptyBackend(),
          exportIndex: mockIndex({}),
          crossRegionExportIndexes: crossRegion,
          stackName: 'Consumer',
        })
      )
    ).rejects.toThrow(/not found/);
  });

  it('does nothing when crossRegionExportIndexes is an empty map', async () => {
    // Edge case: the deploy CLI strips the consumer's own region from
    // the list, which can leave the user passing `--import-value-cross-region`
    // with an empty effective set. Behavior must be identical to "flag
    // not passed".
    const resolver = new IntrinsicFunctionResolver('us-east-1');

    await expect(
      resolver.resolve(
        { 'Fn::ImportValue': 'Missing' },
        buildContext({
          stateBackend: emptyBackend(),
          exportIndex: mockIndex({}),
          crossRegionExportIndexes: new Map(),
        })
      )
    ).rejects.toThrow(/not found/);
  });
});
