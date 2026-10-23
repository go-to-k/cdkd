/**
 * go-to-k/cdkd#5212: the refactor marker's pure helpers --
 * `refactorMarkerMovesOf`, `readRefactorMarkerOnce` (and its per-process
 * cache), `markerMovesInvolving` / `refactorMarkerRefusalMessage` /
 * `refuseRefactorMarker`, `updateRefactorMarker` and `sameMove`.
 */
import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import {
  refactorMarkerMovesOf,
  readRefactorMarkerOnce,
  resetRefactorMarkerReadsForTest,
  markerMovesInvolving,
  refactorMarkerRefusalMessage,
  refuseRefactorMarker,
  updateRefactorMarker,
  sameMove,
  type RefactorMarkerMove,
  type MarkerVerdict,
} from '../../../src/state/refactor-marker.js';
import { CdkdError } from '../../../src/utils/error-handler.js';

vi.mock('../../../src/utils/logger.js', () => {
  const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...quiet, child: () => quiet }) };
});

const move = (extra: Partial<RefactorMarkerMove> = {}): RefactorMarkerMove => ({
  fromStack: 'S',
  fromRegion: 'r1',
  from: 'Old',
  toStack: 'D',
  toRegion: 'r1',
  to: 'New',
  startedAt: 1,
  ...extra,
});

describe('refactorMarkerMovesOf', () => {
  it.each([
    ['null', null],
    ['a string', 'not-an-object'],
    ['{}', {}],
    ["{moves: 'x'}", { moves: 'x' }],
  ])('%s is malformed', (_label, body) => {
    expect(refactorMarkerMovesOf(body)).toEqual({ moves: [], malformed: true });
  });

  it('keeps valid entries and reports malformed when some are not', () => {
    const valid = move();
    const result = refactorMarkerMovesOf({ moves: [valid, { from: 'onlyFrom' }, 'garbage'] });
    expect(result.moves).toEqual([valid]);
    expect(result.malformed).toBe(true);
  });

  it('reports malformed false when every entry is valid', () => {
    const a = move({ from: 'A' });
    const b = move({ from: 'B' });
    expect(refactorMarkerMovesOf({ moves: [a, b] })).toEqual({ moves: [a, b], malformed: false });
  });
});

describe('readRefactorMarkerOnce', () => {
  beforeEach(() => {
    resetRefactorMarkerReadsForTest();
  });

  it('answers {kind: "none"} with no throw for a backend without getRefactorMarker', async () => {
    const backend = { refactorMarkerKey: () => 'key-a' };
    await expect(readRefactorMarkerOnce(backend)).resolves.toEqual({ kind: 'none' });
  });

  it('answers none on a null marker', async () => {
    const backend = {
      refactorMarkerKey: () => 'key-b',
      getRefactorMarker: vi.fn().mockResolvedValue(null),
    };
    await expect(readRefactorMarkerOnce(backend)).resolves.toEqual({ kind: 'none' });
  });

  it('answers moves on a valid, non-empty marker', async () => {
    const m = move();
    const backend = {
      refactorMarkerKey: () => 'key-c',
      getRefactorMarker: vi.fn().mockResolvedValue({ body: { moves: [m] }, etag: 'e' }),
    };
    await expect(readRefactorMarkerOnce(backend)).resolves.toEqual({ kind: 'moves', moves: [m] });
  });

  it('answers none on a marker whose moves list is empty', async () => {
    const backend = {
      refactorMarkerKey: () => 'key-d',
      getRefactorMarker: vi.fn().mockResolvedValue({ body: { moves: [] }, etag: 'e' }),
    };
    await expect(readRefactorMarkerOnce(backend)).resolves.toEqual({ kind: 'none' });
  });

  it('answers malformed with the key on an unreadable body', async () => {
    const backend = {
      refactorMarkerKey: () => 'key-e',
      getRefactorMarker: vi.fn().mockResolvedValue({ body: 'torn', etag: 'e' }),
    };
    await expect(readRefactorMarkerOnce(backend)).resolves.toEqual({
      kind: 'malformed',
      key: 'key-e',
    });
  });

  it('treats an AccessDenied error as absent', async () => {
    const backend = {
      refactorMarkerKey: () => 'key-f',
      getRefactorMarker: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { name: 'AccessDenied' })),
    };
    await expect(readRefactorMarkerOnce(backend)).resolves.toEqual({ kind: 'none' });
  });

  it('treats a 403 $metadata.httpStatusCode error as absent', async () => {
    const backend = {
      refactorMarkerKey: () => 'key-g',
      getRefactorMarker: vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('denied'), { $metadata: { httpStatusCode: 403 } })
        ),
    };
    await expect(readRefactorMarkerOnce(backend)).resolves.toEqual({ kind: 'none' });
  });

  it('rejects on any other error, and does not cache the failed read', async () => {
    const getRefactorMarker = vi.fn().mockRejectedValue(new Error('boom'));
    const backend = { refactorMarkerKey: () => 'key-h', getRefactorMarker };
    await expect(readRefactorMarkerOnce(backend)).rejects.toThrow('boom');
    await expect(readRefactorMarkerOnce(backend)).rejects.toThrow('boom');
    expect(getRefactorMarker).toHaveBeenCalledTimes(2);
  });

  it('caches a successful read per marker key, and reads each distinct key once', async () => {
    const getA = vi.fn().mockResolvedValue(null);
    const backendA = { refactorMarkerKey: () => 'key-i', getRefactorMarker: getA };
    await readRefactorMarkerOnce(backendA);
    await readRefactorMarkerOnce(backendA);
    expect(getA).toHaveBeenCalledTimes(1);

    const getB = vi.fn().mockResolvedValue(null);
    const backendB = { refactorMarkerKey: () => 'key-j', getRefactorMarker: getB };
    await readRefactorMarkerOnce(backendB);
    expect(getB).toHaveBeenCalledTimes(1);
    expect(getA).toHaveBeenCalledTimes(1);
  });
});

describe('markerMovesInvolving / refactorMarkerRefusalMessage / refuseRefactorMarker', () => {
  const m = move();
  const moves: MarkerVerdict = { kind: 'moves', moves: [m] };

  it('involves the source stack in the move region', () => {
    expect(markerMovesInvolving(moves, 'S', 'r1')).toEqual([m]);
  });

  it('involves the destination stack in the move region', () => {
    expect(markerMovesInvolving(moves, 'D', 'r1')).toEqual([m]);
  });

  it('does not involve the source stack in a different region', () => {
    expect(markerMovesInvolving(moves, 'S', 'r2')).toEqual([]);
  });

  it('does not involve an unrelated stack', () => {
    expect(markerMovesInvolving(moves, 'Unrelated', 'r1')).toEqual([]);
  });

  it('refusal message names the command, the stack, the move and the refactor command', () => {
    const message = refactorMarkerRefusalMessage(moves, 'S', 'r1', 'cdkd deploy');
    expect(message).toContain('cdkd deploy');
    expect(message).toContain('S');
    expect(message).toContain('S.Old -> D.New');
    expect(message).toContain("'cdkd refactor S'");
  });

  it('refusal message is undefined for a stack the move does not involve', () => {
    expect(refactorMarkerRefusalMessage(moves, 'Unrelated', 'r1', 'cdkd deploy')).toBeUndefined();
  });

  it('a malformed verdict refuses with text containing "cannot be read"', () => {
    const malformed: MarkerVerdict = { kind: 'malformed', key: 'cdkd/_refactor/pending.json' };
    const message = refactorMarkerRefusalMessage(malformed, 'S', 'r1', 'cdkd deploy');
    expect(message).toContain('cannot be read');
  });

  it('refuseRefactorMarker throws a CdkdError REFACTOR_UNFINISHED for an involved stack', () => {
    expect(() => refuseRefactorMarker(moves, 'S', 'r1', 'cdkd deploy')).toThrow(CdkdError);
    try {
      refuseRefactorMarker(moves, 'S', 'r1', 'cdkd deploy');
      expect.unreachable();
    } catch (error) {
      expect((error as CdkdError).code).toBe('REFACTOR_UNFINISHED');
    }
  });

  it('refuseRefactorMarker throws REFACTOR_UNFINISHED for a malformed verdict too', () => {
    const malformed: MarkerVerdict = { kind: 'malformed', key: 'k' };
    try {
      refuseRefactorMarker(malformed, 'S', 'r1', 'cdkd deploy');
      expect.unreachable();
    } catch (error) {
      expect((error as CdkdError).code).toBe('REFACTOR_UNFINISHED');
      expect((error as CdkdError).message).toContain('cannot be read');
    }
  });

  it('refuseRefactorMarker does not throw for a stack not involved', () => {
    expect(() => refuseRefactorMarker(moves, 'Unrelated', 'r1', 'cdkd deploy')).not.toThrow();
  });
});

describe('updateRefactorMarker', () => {
  function fakeWriter(getImpl: () => unknown, saveImpl: () => unknown) {
    return { getRefactorMarker: vi.fn(getImpl), saveRefactorMarker: vi.fn(saveImpl) };
  }

  it('appends a move onto an absent marker, saving with etag null', async () => {
    const b = fakeWriter(
      () => Promise.resolve(null),
      () => Promise.resolve('saved')
    );
    const m = move();
    await updateRefactorMarker(b as never, (moves) => [...moves, m]);
    expect(b.saveRefactorMarker).toHaveBeenCalledWith({ moves: [m] }, null);
  });

  it('removes a move, saving with the read etag', async () => {
    const a = move({ from: 'A' });
    const keep = move({ from: 'B' });
    const b = fakeWriter(
      () => Promise.resolve({ body: { moves: [a, keep] }, etag: '"e1"' }),
      () => Promise.resolve('saved')
    );
    await updateRefactorMarker(b as never, (moves) => moves.filter((x) => x.from !== 'A'));
    expect(b.saveRefactorMarker).toHaveBeenCalledWith({ moves: [keep] }, '"e1"');
  });

  it('retries once on a conflict, then saves', async () => {
    const getRefactorMarker = vi
      .fn()
      .mockResolvedValueOnce({ body: { moves: [] }, etag: '"e1"' })
      .mockResolvedValueOnce({ body: { moves: [] }, etag: '"e2"' });
    const saveRefactorMarker = vi.fn().mockResolvedValueOnce('conflict').mockResolvedValueOnce('saved');
    const b = { getRefactorMarker, saveRefactorMarker };
    await updateRefactorMarker(b as never, (moves) => [...moves, move()]);
    expect(getRefactorMarker).toHaveBeenCalledTimes(2);
    expect(saveRefactorMarker).toHaveBeenCalledTimes(2);
  });

  it('gives up with REFACTOR_STATE_CHANGED after 5 conflicts', async () => {
    const b = fakeWriter(
      () => Promise.resolve({ body: { moves: [] }, etag: '"e"' }),
      () => Promise.resolve('conflict')
    );
    const err = await updateRefactorMarker(b as never, (moves) => moves).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdkdError);
    expect((err as CdkdError).code).toBe('REFACTOR_STATE_CHANGED');
    expect(b.saveRefactorMarker).toHaveBeenCalledTimes(5);
  });

  it('refuses REFACTOR_REFUSED on a malformed body, without saving', async () => {
    const b = fakeWriter(
      () => Promise.resolve({ body: 'torn', etag: '"e"' }),
      () => Promise.resolve('saved')
    );
    const err = await updateRefactorMarker(b as never, (moves) => moves).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdkdError);
    expect((err as CdkdError).code).toBe('REFACTOR_REFUSED');
    expect(b.saveRefactorMarker).not.toHaveBeenCalled();
  });
});

describe('sameMove', () => {
  it('compares fromStack/fromRegion/from only', () => {
    const a = { fromStack: 'S', fromRegion: 'r', from: 'A' };
    const sameTriple = { fromStack: 'S', fromRegion: 'r', from: 'A', toStack: 'D2', to: 'Other' };
    expect(sameMove(a, sameTriple)).toBe(true);
  });

  it('is false when `from` differs', () => {
    const a = { fromStack: 'S', fromRegion: 'r', from: 'A' };
    const b = { fromStack: 'S', fromRegion: 'r', from: 'B' };
    expect(sameMove(a, b)).toBe(false);
  });

  it('is false when fromRegion differs', () => {
    const a = { fromStack: 'S', fromRegion: 'r1', from: 'A' };
    const b = { fromStack: 'S', fromRegion: 'r2', from: 'A' };
    expect(sameMove(a, b)).toBe(false);
  });

  it('is false when fromStack differs', () => {
    const a = { fromStack: 'S1', fromRegion: 'r', from: 'A' };
    const b = { fromStack: 'S2', fromRegion: 'r', from: 'A' };
    expect(sameMove(a, b)).toBe(false);
  });
});
