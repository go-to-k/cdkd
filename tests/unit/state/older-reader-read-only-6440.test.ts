import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  STATE_SCHEMA_VERSIONS_READABLE,
  READ_ONLY_STATE_MARK,
  classifyStateRecordAccess,
  markReadOnlyState,
  readOnlyStateVersionOf,
  type StackState,
} from '../../../src/types/state.js';
import { clearBucketRegionCache } from '../../../src/utils/aws-region-resolver.js';
import { StateError } from '../../../src/utils/error-handler.js';
import { loadStateOrEmpty } from '../../../src/cli/commands/diff-recursive/load-state.js';
import { getSameAccountStackState } from '../../../src/deployment/intrinsic-resolver/stack-state.js';

/**
 * go-to-k/cdkd#6440: an older cdkd may READ a record whose newer schema only
 * added fields (it names a `minReaderVersion` this binary reads), and must not
 * WRITE it. No schema bump: this binary's own records are unchanged.
 *
 * Through the REAL `S3StateBackend` read and save paths, with the S3 client
 * mocked: the default load refuses such a record at the load (before any
 * write), a `readOnly` load returns it marked, and `saveState` refuses any
 * state derived from it before touching S3.
 */
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn(() => ({
    send: vi.fn().mockResolvedValue({ Account: '999999999999' }),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn((input) => ({ ...input })),
}));

vi.mock('../../../src/utils/aws-region-resolver.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/utils/aws-region-resolver.js')
  >('../../../src/utils/aws-region-resolver.js');
  return { ...actual, resolveBucketRegion: vi.fn() };
});

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...fns, child: () => fns }) };
});

function makeClient(): { send: ReturnType<typeof vi.fn> } & Record<string, unknown> {
  return {
    send: vi.fn(),
    destroy: vi.fn(),
    config: {
      region: () => Promise.resolve('us-east-1'),
      credentials: () =>
        Promise.resolve({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake-secret' }),
    },
  };
}

/** A record a future cdkd writes at schema 19, whose bump only added `futureField`. */
const newerRecord = (extra: Record<string, unknown> = {}) => ({
  version: 19,
  minReaderVersion: 17,
  stackName: 'S',
  region: 'us-east-1',
  resources: {
    R: {
      physicalId: 'q',
      resourceType: 'AWS::SQS::Queue',
      properties: {},
      futureResourceField: { a: 1 },
    },
  },
  outputs: { Out: 'v' },
  futureField: ['kept'],
  lastModified: 0,
  ...extra,
});

describe('classifyStateRecordAccess (go-to-k/cdkd#6440)', () => {
  it('every readable version, and an absent one, is writable whatever minReaderVersion says', () => {
    for (const v of STATE_SCHEMA_VERSIONS_READABLE) {
      expect(classifyStateRecordAccess(v, undefined)).toEqual({ kind: 'writable' });
      expect(classifyStateRecordAccess(v, 999)).toEqual({ kind: 'writable' });
    }
    expect(classifyStateRecordAccess(undefined, undefined)).toEqual({ kind: 'writable' });
  });

  it.each([
    [19, 17],
    [20, 16],
    [40, 1],
  ])('version %s naming readable minReaderVersion %s is read-only', (version, min) => {
    expect(classifyStateRecordAccess(version, min)).toEqual({ kind: 'read-only', version });
  });

  it.each([
    ['no minReaderVersion', 19, undefined],
    ['a minReaderVersion this binary does not read', 20, 19],
    ['a string minReaderVersion', 19, '17'],
    ['a zero minReaderVersion', 19, 0],
    ['a non-integer version', 19.5, 17],
    ['a string version', '19', 17],
    ['a null version', null, 17],
    ['a version past a safe integer', 2 ** 53, 17],
    ['a version below 1', 0, 1],
    ['a negative version', -1, 1],
  ])('%s is unsupported', (_label, version, min) => {
    expect(classifyStateRecordAccess(version, min)).toEqual({ kind: 'unsupported' });
  });
});

describe('S3StateBackend with a newer-but-readable record (go-to-k/cdkd#6440)', () => {
  let client: ReturnType<typeof makeClient>;
  let backend: S3StateBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearBucketRegionCache();
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');
    client = makeClient();
    backend = new S3StateBackend(
      client as unknown as S3Client,
      { bucket: 'b', prefix: 'cdkd' },
      { region: 'us-east-1' }
    );
  });

  const serve = (body: string): void => {
    client.send.mockResolvedValueOnce({
      Body: { transformToString: () => Promise.resolve(body) },
      ETag: '"e"',
    });
  };

  const putBodies = (): string[] =>
    client.send.mock.calls
      .map(([command]) => (command as { input?: { Body?: unknown } }).input?.Body)
      .filter((b): b is string => typeof b === 'string');

  it('a default (writer) load refuses it, naming the newer version and the upgrade', async () => {
    serve(JSON.stringify(newerRecord()));
    const caught = await backend.getState('S', 'us-east-1').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(StateError);
    const message = (caught as Error).message;
    expect(message).toContain('written by a newer cdkd (state schema version 19)');
    expect(message).toContain('can read it but must not write it');
    expect(message).toContain('Upgrade cdkd to a version that supports schema 19.');
    // One GET, nothing written.
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('a readOnly load returns the record unchanged, unknown fields included, marked read-only', async () => {
    serve(JSON.stringify(newerRecord()));
    const got = await backend.getState('S', 'us-east-1', { readOnly: true });
    expect(got?.etag).toBe('"e"');
    const state = got!.state as unknown as Record<string, unknown>;
    expect(JSON.parse(JSON.stringify(state))).toEqual(newerRecord());
    expect(readOnlyStateVersionOf(got!.state)).toBe(19);
    expect((got!.state as unknown as Record<symbol, unknown>)[READ_ONLY_STATE_MARK]).toBe(19);
    // The mark is a symbol key, so no serialization carries it.
    expect(JSON.stringify(state)).not.toContain('readOnly');
  });

  it('a newer record naming no readable minReaderVersion is refused even read-only, as today', async () => {
    for (const body of [
      newerRecord({ minReaderVersion: undefined }),
      newerRecord({ minReaderVersion: 19 }),
    ]) {
      serve(JSON.stringify(body));
      const caught = await backend
        .getState('S', 'us-east-1', { readOnly: true })
        .catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(StateError);
      expect((caught as Error).message).toMatch(/Unsupported state schema version 19/);
      expect((caught as Error).message).toMatch(/Upgrade cdkd/);
    }
  });

  it('the legacy-key fallback honors the same option', async () => {
    client.send.mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
    serve(JSON.stringify(newerRecord()));
    const caught = await backend.getState('S', 'us-east-1').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(StateError);
    expect((caught as Error).message).toContain('state schema version 19');

    client.send.mockRejectedValueOnce(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
    serve(JSON.stringify(newerRecord()));
    const got = await backend.getState('S', 'us-east-1', { readOnly: true });
    expect(got?.migrationPending).toBe(true);
    expect(readOnlyStateVersionOf(got!.state)).toBe(19);
  });

  it.each([
    ['the loaded record itself', (s: StackState) => s],
    ['a spread copy', (s: StackState) => ({ ...s, lastModified: 1 })],
    [
      'a spread copy restamped at this binary’s version (the mark survives the spread)',
      (s: StackState) => ({ ...s, version: STATE_SCHEMA_VERSION_CURRENT }),
    ],
    [
      'a structuredClone copy (the mark is lost, the version is not)',
      (s: StackState) => structuredClone(s),
    ],
  ])('saveState refuses %s before any S3 call', async (_label, derive) => {
    serve(JSON.stringify(newerRecord()));
    const got = await backend.getState('S', 'us-east-1', { readOnly: true });
    client.send.mockClear();
    const caught = await backend
      .saveState('S', 'us-east-1', derive(got!.state), { expectedEtag: '"e"' })
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(StateError);
    const message = (caught as Error).message;
    expect(message).toContain('Refusing to save state for stack');
    expect(message).toContain('written by a newer cdkd (state schema version 19)');
    expect(message).toContain('Upgrade cdkd to a version that supports schema 19.');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('an ordinary save writes no minReaderVersion, so this binary’s records are unchanged', async () => {
    client.send.mockResolvedValue({ ETag: '"new"' });
    const state: StackState = {
      version: 16,
      stackName: 'S',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      lastModified: 0,
    };
    await backend.saveState('S', 'us-east-1', state, { expectedEtag: '"e"' });
    // A stray field (no cdkd writes it at a readable version) is dropped too:
    // what this binary writes is read by a reader of the version it stamps.
    await backend.saveState('S', 'us-east-1', { ...state, minReaderVersion: 1 }, {
      expectedEtag: '"e"',
    });
    const bodies = putBodies();
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toBe(
      JSON.stringify(
        { ...state, version: 16, stackName: 'S', region: 'us-east-1' },
        null,
        2
      )
    );
    expect(bodies[1]).toBe(bodies[0]);
  });
});

describe('read-only consumers load read-only (go-to-k/cdkd#6440)', () => {
  const readOnlyRecord = (): StackState =>
    markReadOnlyState(newerRecord() as unknown as StackState, 19);

  /** A backend that returns the newer record ONLY to a read-only load, as the real one does. */
  const fakeBackend = () => {
    const getState = vi.fn(
      async (_stack: string, _region: string, options?: { readOnly?: boolean }) => {
        if (options?.readOnly !== true) throw new StateError('writer load');
        return { state: readOnlyRecord(), etag: '"e"' };
      }
    );
    return { getState };
  };

  it('cdkd diff previews the record and reports that cdkd deploy refuses it', async () => {
    const backend = fakeBackend();
    const result = await loadStateOrEmpty('S', 'us-east-1', backend as never, undefined);
    expect(backend.getState).toHaveBeenCalledWith('S', 'us-east-1', { readOnly: true });
    expect(result.found).toBe(true);
    expect(Object.keys(result.state.resources)).toEqual(['R']);
    expect(result.deployRefusals).toEqual([
      'The state record was written by a newer cdkd (state schema version 19). ' +
        "This preview read it; 'cdkd deploy' with this cdkd binary refuses to write it. " +
        'Upgrade cdkd to a version that supports schema 19.',
    ]);
  });

  it('cdkd diff reports no such refusal for an ordinary record', async () => {
    const getState = vi.fn(async () => ({
      state: { ...newerRecord(), version: 17, minReaderVersion: undefined } as unknown as StackState,
      etag: '"e"',
    }));
    const result = await loadStateOrEmpty('S', 'us-east-1', { getState } as never, undefined);
    expect(result.deployRefusals).toEqual([]);
  });

  it('Fn::GetStackOutput reads the producer read-only', async () => {
    const backend = fakeBackend();
    const got = await getSameAccountStackState('P', 'us-east-1', {
      stateBackend: backend,
    } as never);
    expect(backend.getState).toHaveBeenCalledWith('P', 'us-east-1', { readOnly: true });
    expect(got?.state.outputs).toEqual({ Out: 'v' });
  });
});
