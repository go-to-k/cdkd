import { describe, it, expect, vi } from 'vite-plus/test';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import type {
  ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { ExportIndexStore } from '../../../src/state/export-index-store.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StateImportEntry } from '../../../src/types/state.js';

/**
 * Helper: build a barely-functional ExportIndexStore mock with the
 * specific surface the resolver consults (`lookup` + `patchEntry`).
 */
function mockIndex(
  hits: Record<string, { value: unknown; producerStack: string; producerRegion: string }>,
  opts: { lookupThrows?: Error } = {}
): { store: ExportIndexStore; patches: Array<{ name: string; entry: unknown }> } {
  const patches: Array<{ name: string; entry: unknown }> = [];
  const store: Partial<ExportIndexStore> = {
    lookup: vi.fn(async (name: string) => {
      if (opts.lookupThrows) throw opts.lookupThrows;
      return hits[name];
    }),
    patchEntry: vi.fn(async (name: string, entry: unknown) => {
      patches.push({ name, entry });
    }),
  };
  return { store: store as ExportIndexStore, patches };
}

/**
 * Helper: build a state backend mock for fallback-scan tests.
 */
function mockBackend(stacks: Array<{ stackName: string; region: string; outputs: Record<string, unknown> }>): S3StateBackend {
  return {
    listStacks: vi.fn(async () =>
      stacks.map((s) => ({ stackName: s.stackName, region: s.region }))
    ),
    getState: vi.fn(async (stackName: string, _region: string) => {
      const found = stacks.find((s) => s.stackName === stackName);
      if (!found) return null;
      return {
        state: {
          version: 4,
          stackName: found.stackName,
          region: found.region,
          resources: {},
          outputs: found.outputs,
          lastModified: 1,
        },
        etag: 'e',
      };
    }),
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

describe('IntrinsicFunctionResolver - Fn::ImportValue index path', () => {
  it('returns from the index on hit without scanning state', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const { store } = mockIndex({
      BucketArn: { value: 'arn:hit', producerStack: 'Producer', producerRegion: 'us-east-1' },
    });
    const backend = mockBackend([]);
    const recorded: StateImportEntry[] = [];

    const result = await resolver.resolve(
      { 'Fn::ImportValue': 'BucketArn' },
      buildContext({
        stateBackend: backend,
        exportIndex: store,
        recordedImports: recorded,
      })
    );

    expect(result).toBe('arn:hit');
    // listStacks should NOT be called on the hot path
    expect((backend.listStacks as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
    // Import recorded for strong-ref bookkeeping
    expect(recorded).toEqual([
      { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'BucketArn' },
    ]);
  });

  it('falls back to state scan on index miss and patches the entry', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const { store, patches } = mockIndex({}); // empty index
    const backend = mockBackend([
      { stackName: 'Producer', region: 'us-east-1', outputs: { BucketArn: 'arn:from-state' } },
    ]);
    const recorded: StateImportEntry[] = [];

    const result = await resolver.resolve(
      { 'Fn::ImportValue': 'BucketArn' },
      buildContext({
        stateBackend: backend,
        exportIndex: store,
        recordedImports: recorded,
      })
    );

    expect(result).toBe('arn:from-state');
    // listStacks WAS called for the fallback scan
    expect((backend.listStacks as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    // patchEntry was called for write-through
    // (we wait a microtask since patchEntry is fire-and-forget via .catch)
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(patches).toHaveLength(1);
    expect(patches[0]).toEqual({
      name: 'BucketArn',
      entry: {
        value: 'arn:from-state',
        producerStack: 'Producer',
        producerRegion: 'us-east-1',
      },
    });
    // Import recorded regardless of which path resolved it
    expect(recorded).toEqual([
      { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'BucketArn' },
    ]);
  });

  it('falls back to state scan when index throws (defensive degradation)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const { store } = mockIndex(
      {},
      { lookupThrows: new Error('index file IAM denied') }
    );
    const backend = mockBackend([
      { stackName: 'Producer', region: 'us-east-1', outputs: { Foo: 'v' } },
    ]);

    const result = await resolver.resolve(
      { 'Fn::ImportValue': 'Foo' },
      buildContext({ stateBackend: backend, exportIndex: store })
    );

    expect(result).toBe('v');
  });

  it('skips index entries owned by the consumer itself (self-reference)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    // Index entry claims Consumer publishes BucketArn — but we're in
    // Consumer's context. Self-reference must be ignored.
    const { store } = mockIndex({
      BucketArn: { value: 'self-arn', producerStack: 'Consumer', producerRegion: 'us-east-1' },
    });
    // Fallback scan finds the real producer.
    const backend = mockBackend([
      { stackName: 'Producer', region: 'us-east-1', outputs: { BucketArn: 'real-arn' } },
    ]);

    const result = await resolver.resolve(
      { 'Fn::ImportValue': 'BucketArn' },
      buildContext({
        stateBackend: backend,
        exportIndex: store,
        stackName: 'Consumer',
      })
    );

    expect(result).toBe('real-arn');
  });

  it('does not record an import when recordedImports is absent (backwards compat)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const { store } = mockIndex({
      X: { value: 'v', producerStack: 'P', producerRegion: 'us-east-1' },
    });
    const backend = mockBackend([]);

    const result = await resolver.resolve(
      { 'Fn::ImportValue': 'X' },
      buildContext({ stateBackend: backend, exportIndex: store })
    );

    expect(result).toBe('v');
    // No throw, no record, just resolve normally
  });

  it('deduplicates recordedImports when the same export is resolved twice', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const { store } = mockIndex({
      X: { value: 'v', producerStack: 'P', producerRegion: 'us-east-1' },
    });
    const backend = mockBackend([]);
    const recorded: StateImportEntry[] = [];

    await resolver.resolve(
      { 'Fn::ImportValue': 'X' },
      buildContext({ stateBackend: backend, exportIndex: store, recordedImports: recorded })
    );
    await resolver.resolve(
      { 'Fn::ImportValue': 'X' },
      buildContext({ stateBackend: backend, exportIndex: store, recordedImports: recorded })
    );

    expect(recorded).toHaveLength(1);
  });

  it('works without an exportIndex (pre-PR fallback path stays intact)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const backend = mockBackend([
      { stackName: 'Producer', region: 'us-east-1', outputs: { Foo: 'fallback-v' } },
    ]);
    const recorded: StateImportEntry[] = [];

    const result = await resolver.resolve(
      { 'Fn::ImportValue': 'Foo' },
      buildContext({ stateBackend: backend, recordedImports: recorded })
    );

    expect(result).toBe('fallback-v');
    // Even without the index, recordedImports is still populated
    // (the deploy engine relies on this for state.imports[] persistence)
    expect(recorded).toEqual([
      { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'Foo' },
    ]);
  });
});
