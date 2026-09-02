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
function mockBackend(
  stacks: Array<{
    stackName: string;
    region: string;
    outputs: Record<string, unknown>;
    /** Omitted = a pre-v9 record (issue #2193): every output key importable. */
    exportNames?: string[];
  }>
): S3StateBackend {
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
          ...(found.exportNames !== undefined && { exportNames: found.exportNames }),
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

  it('the state scan does NOT match a plain Output name on a v9 record (#2193)', async () => {
    // `Fn::ImportValue: BucketArn` with no such export anywhere: the only
    // stack holding a `BucketArn` key declares it as a plain output. CFn
    // rejects the template; pre-fix cdkd bound the import to it.
    const resolver = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
    const backend = mockBackend([
      { stackName: 'Decoy', region: 'us-east-1', outputs: { BucketArn: 'arn:decoy' }, exportNames: [] },
    ]);

    await expect(
      resolver.resolve(
        { 'Fn::ImportValue': 'BucketArn' },
        buildContext({ stateBackend: backend, recordedImports: [] })
      )
    ).rejects.toThrow(/export 'BucketArn' not found in any stack/);
  });

  it('the state scan skips a same-named plain Output in an EARLIER stack and binds to the real exporter (#2193)', async () => {
    // The shadowing shape: the decoy is listed FIRST, so a first-match scan
    // over every key returned `arn:decoy` before ever reaching the producer.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const backend = mockBackend([
      { stackName: 'Decoy', region: 'us-east-1', outputs: { VpcId: 'vpc-decoy' }, exportNames: [] },
      {
        stackName: 'Producer',
        region: 'us-east-1',
        outputs: { VpcId: 'vpc-prod', 'prod:VpcId': 'vpc-prod' },
        exportNames: ['prod:VpcId'],
      },
    ]);
    const recorded: StateImportEntry[] = [];

    // The plain name is not importable even though BOTH stacks hold the key...
    const resolverNoCfn = new IntrinsicFunctionResolver('us-east-1', { cfnFallback: false });
    await expect(
      resolverNoCfn.resolve(
        { 'Fn::ImportValue': 'VpcId' },
        buildContext({ stateBackend: backend, recordedImports: [] })
      )
    ).rejects.toThrow(/not found in any stack/);

    // ... and the export resolves to its one producer.
    const result = await resolver.resolve(
      { 'Fn::ImportValue': 'prod:VpcId' },
      buildContext({ stateBackend: backend, recordedImports: recorded })
    );
    expect(result).toBe('vpc-prod');
    expect(recorded).toEqual([
      { sourceStack: 'Producer', sourceRegion: 'us-east-1', exportName: 'prod:VpcId' },
    ]);
  });

  it('the state scan still matches every key of a pre-v9 record (legacy rule until it redeploys)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const backend = mockBackend([
      // No `exportNames` on record: nothing says which key is the export.
      { stackName: 'Legacy', region: 'us-east-1', outputs: { BucketArn: 'arn:legacy' } },
    ]);

    const result = await resolver.resolve(
      { 'Fn::ImportValue': 'BucketArn' },
      buildContext({ stateBackend: backend, recordedImports: [] })
    );
    expect(result).toBe('arn:legacy');
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

  // Issue #2274: a producer's `state.outputs` entry can hold the redaction
  // MASK, because that output resolved a `NoEcho` custom resource's `Data`.
  // The consumer would otherwise import the literal `***` and write it to AWS,
  // which is the same data-corruption direction `drift --revert` and the
  // rollback replay refuse. The resolver RECORDS the read (it does not throw —
  // the diff path must stay stable); the deploy engine reads the bag after
  // `resolve()` and refuses to provision.
  describe('a REDACTED producer output', () => {
    it('records the read, naming the export and the producer', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const backend = mockBackend([
        { stackName: 'Producer', region: 'us-east-1', outputs: { Token: '***' } },
      ]);
      const redactedAttributeReads: string[] = [];

      const result = await resolver.resolve(
        { 'Fn::ImportValue': 'Token' },
        buildContext({ stateBackend: backend, recordedImports: [], redactedAttributeReads })
      );

      // The value is still RETURNED — refusing here would fail the diff pass,
      // which resolves the same leaf and must keep reporting NO_CHANGE for an
      // untouched stack.
      expect(result).toBe('***');
      expect(redactedAttributeReads).toHaveLength(1);
      expect(redactedAttributeReads[0]).toContain("Fn::ImportValue 'Token'");
      expect(redactedAttributeReads[0]).toContain('Producer');
    });

    it('records NOTHING for an ordinary producer output (the negative case)', async () => {
      const resolver = new IntrinsicFunctionResolver('us-east-1');
      const backend = mockBackend([
        { stackName: 'Producer', region: 'us-east-1', outputs: { Token: 'ordinary-value' } },
      ]);
      const redactedAttributeReads: string[] = [];

      const result = await resolver.resolve(
        { 'Fn::ImportValue': 'Token' },
        buildContext({ stateBackend: backend, recordedImports: [], redactedAttributeReads })
      );

      expect(result).toBe('ordinary-value');
      expect(redactedAttributeReads).toEqual([]);
    });
  });
});
