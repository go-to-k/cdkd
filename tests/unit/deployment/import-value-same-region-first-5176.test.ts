import { describe, it, expect, vi } from 'vite-plus/test';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { ResolverContext } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { ExportIndexStore } from '../../../src/state/export-index-store.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { StateImportEntry } from '../../../src/types/state.js';

/**
 * Issue [#5176](https://github.com/go-to-k/cdkd/issues/5176): two CDK Stages
 * sharing a stackName in two regions publish the SAME export names
 * (`Db:ExportsOutputRef...`), and the run's one exports index keeps the later
 * deploy's entry. A consumer must bind the producer in its OWN region, never
 * the other Stage's value; a cross-region import with no same-region producer
 * still resolves as before (#1934 / #2109).
 */

type Entry = { value: unknown; producerStack: string; producerRegion: string };

function index(hits: Record<string, Entry>): ExportIndexStore {
  return {
    lookup: vi.fn(async (name: string) => hits[name]),
    patchEntry: vi.fn(async () => true),
  } as unknown as ExportIndexStore;
}

/** Records keyed `<stack>@<region>`; every `getState` is counted. */
function backend(records: Record<string, Record<string, unknown>>): S3StateBackend & {
  getState: ReturnType<typeof vi.fn>;
  listStacks: ReturnType<typeof vi.fn>;
} {
  return {
    listStacks: vi.fn(async () =>
      Object.keys(records).map((key) => {
        const [stackName, region] = key.split('@');
        return { stackName, region };
      })
    ),
    getState: vi.fn(async (stackName: string, region: string) => {
      const outputs = records[`${stackName}@${region}`];
      if (!outputs) return null;
      return {
        state: {
          version: 13,
          stackName,
          region,
          resources: {},
          outputs,
          exportNames: Object.keys(outputs),
          lastModified: 1,
        },
        etag: 'e',
      };
    }),
  } as never;
}

function context(overrides: Partial<ResolverContext>): ResolverContext {
  return { template: { Resources: {} }, resources: {}, stackName: 'Consumer', ...overrides };
}

const EXPORT = 'Db:ExportsOutputRefQueue';

describe('Fn::ImportValue binds the producer in the consumer region first (#5176)', () => {
  it('a same-region index hit makes NO state read at all (single-region apps unchanged)', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const state = backend({ 'Db@us-east-1': { [EXPORT]: 'east-queue' } });
    const result = await resolver.resolve(
      { 'Fn::ImportValue': EXPORT },
      context({
        stateBackend: state,
        exportIndex: index({
          [EXPORT]: { value: 'east-queue', producerStack: 'Db', producerRegion: 'us-east-1' },
        }),
      })
    );
    expect(result).toBe('east-queue');
    expect(state.getState).toHaveBeenCalledTimes(0);
    expect(state.listStacks).toHaveBeenCalledTimes(0);
  });

  it("takes this region's record when the index holds the same-named producer of another region", async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const state = backend({
      'Db@us-east-1': { [EXPORT]: 'east-queue' },
      'Db@us-west-2': { [EXPORT]: 'west-queue' },
    });
    const recorded: StateImportEntry[] = [];
    const result = await resolver.resolve(
      { 'Fn::ImportValue': EXPORT },
      context({
        stateBackend: state,
        // us-west-2 deployed last and replaced us-east-1's entry.
        exportIndex: index({
          [EXPORT]: { value: 'west-queue', producerStack: 'Db', producerRegion: 'us-west-2' },
        }),
        recordedImports: recorded,
      })
    );
    expect(result).toBe('east-queue');
    // Exactly the one extra read, of this region's record of that name.
    expect(state.getState.mock.calls).toEqual([['Db', 'us-east-1']]);
    expect(state.listStacks).toHaveBeenCalledTimes(0);
    expect(recorded).toEqual([
      { sourceStack: 'Db', sourceRegion: 'us-east-1', exportName: EXPORT },
    ]);
  });

  it('keeps a cross-region import when this region has no producer of the name', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const state = backend({ 'Db@us-west-2': { [EXPORT]: 'west-queue' } });
    const result = await resolver.resolve(
      { 'Fn::ImportValue': EXPORT },
      context({
        stateBackend: state,
        exportIndex: index({
          [EXPORT]: { value: 'west-queue', producerStack: 'Db', producerRegion: 'us-west-2' },
        }),
      })
    );
    expect(result).toBe('west-queue');
    expect(state.getState.mock.calls).toEqual([['Db', 'us-east-1']]);
  });

  it('keeps a cross-region import when this region\'s record does not export the name', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const state = backend({
      'Db@us-east-1': { Other: 'x' },
      'Db@us-west-2': { [EXPORT]: 'west-queue' },
    });
    const result = await resolver.resolve(
      { 'Fn::ImportValue': EXPORT },
      context({
        stateBackend: state,
        exportIndex: index({
          [EXPORT]: { value: 'west-queue', producerStack: 'Db', producerRegion: 'us-west-2' },
        }),
      })
    );
    expect(result).toBe('west-queue');
  });

  it('the index-miss scan prefers this region even when another region is listed first', async () => {
    const resolver = new IntrinsicFunctionResolver('us-west-2');
    // Listing order puts us-east-1 first.
    const state = backend({
      'Db@us-east-1': { [EXPORT]: 'east-queue' },
      'Db@us-west-2': { [EXPORT]: 'west-queue' },
    });
    const result = await resolver.resolve(
      { 'Fn::ImportValue': EXPORT },
      context({ stateBackend: state, exportIndex: index({}) })
    );
    expect(result).toBe('west-queue');
    // The first read is this region's, and it ends the scan.
    expect(state.getState.mock.calls).toEqual([['Db', 'us-west-2']]);
  });

  it('the scan still finds a producer only another region holds', async () => {
    const resolver = new IntrinsicFunctionResolver('us-west-2');
    const state = backend({ 'Db@us-east-1': { [EXPORT]: 'east-queue' } });
    const result = await resolver.resolve(
      { 'Fn::ImportValue': EXPORT },
      context({ stateBackend: state, exportIndex: index({}) })
    );
    expect(result).toBe('east-queue');
  });

  it('keeps the cross-region entry when the same-region read fails', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const state = backend({});
    state.getState.mockRejectedValueOnce(new Error('SlowDown'));
    const result = await resolver.resolve(
      { 'Fn::ImportValue': EXPORT },
      context({
        stateBackend: state,
        exportIndex: index({
          [EXPORT]: { value: 'west-queue', producerStack: 'Db', producerRegion: 'us-west-2' },
        }),
      })
    );
    expect(result).toBe('west-queue');
    expect(state.getState.mock.calls).toEqual([['Db', 'us-east-1']]);
  });
});
