/**
 * The refactor marker (go-to-k/cdkd#5212): `{prefix}/_refactor/pending.json`,
 * the moves between stacks a `cdkd refactor` has started and not finished.
 *
 * A move writes two state records, which no single S3 write can cover. The
 * source record's own `pendingMovesOut` guards the SOURCE stack, but a deploy
 * of the DESTINATION reads only the destination's record and would create the
 * resource a second time. This marker is written before either record and
 * removed after both, and a deploy / destroy run reads it once (beside its
 * first state read, so it adds no wait) and refuses any stack a listed move
 * involves. Ids only, never a value.
 */
import { CdkdError } from '../utils/error-handler.js';
import { markNonRetryable } from '../deployment/retryable-errors.js';
import { safeMsg } from '../utils/display-safe.js';
import { getLogger } from '../utils/logger.js';
import type { S3StateBackend } from './s3-state-backend.js';

/** One unfinished move between two stacks of a state prefix. */
export interface RefactorMarkerMove {
  fromStack: string;
  fromRegion: string;
  from: string;
  toStack: string;
  toRegion: string;
  to: string;
  startedAt: number;
}

/** The marker's moves, or `malformed` when its body cannot be read as such. */
export function refactorMarkerMovesOf(body: unknown): {
  moves: RefactorMarkerMove[];
  malformed: boolean;
} {
  const raw = (body as { moves?: unknown } | null | undefined)?.moves;
  if (body === null || typeof body !== 'object' || !Array.isArray(raw)) {
    return { moves: [], malformed: true };
  }
  const moves: RefactorMarkerMove[] = [];
  let malformed = false;
  for (const m of raw) {
    if (
      m !== null &&
      typeof m === 'object' &&
      ['fromStack', 'fromRegion', 'from', 'toStack', 'toRegion', 'to'].every(
        (k) => typeof (m as Record<string, unknown>)[k] === 'string'
      )
    ) {
      moves.push(m as RefactorMarkerMove);
    } else {
      malformed = true;
    }
  }
  return { moves, malformed };
}

type MarkerBackend = Pick<S3StateBackend, 'getRefactorMarker' | 'refactorMarkerKey'>;

/** What a guarded command learned from the marker, once per run. */
export type MarkerVerdict =
  | { kind: 'none' }
  | { kind: 'moves'; moves: RefactorMarkerMove[] }
  | { kind: 'malformed'; key: string };

/**
 * One read per marker key per process: every stack of a deploy or destroy run
 * shares it. Keyed by the backend's marker key, so two state prefixes in one
 * run each read their own.
 */
const reads = new Map<string, Promise<MarkerVerdict>>();

/**
 * The marker's verdict for this run. A read refused for lack of permission is
 * treated as no marker, with a debug line: a principal whose policy is scoped
 * to its own stacks' keys must keep deploying, and such a principal cannot
 * write the marker either. Any other failure propagates, as a state read's
 * would.
 */
export function readRefactorMarkerOnce(backend: Partial<MarkerBackend>): Promise<MarkerVerdict> {
  // A backend that cannot hold the marker (an embedder's own implementation)
  // has no move in progress to report.
  if (
    typeof backend.getRefactorMarker !== 'function' ||
    typeof backend.refactorMarkerKey !== 'function'
  ) {
    return Promise.resolve({ kind: 'none' });
  }
  const getRefactorMarker = backend.getRefactorMarker.bind(backend);
  const key = backend.refactorMarkerKey();
  let pending = reads.get(key);
  if (pending === undefined) {
    pending = (async (): Promise<MarkerVerdict> => {
      let marker: Awaited<ReturnType<MarkerBackend['getRefactorMarker']>>;
      try {
        marker = await getRefactorMarker();
      } catch (error) {
        const name = (error as { name?: string; Code?: string }).name;
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        if (name === 'AccessDenied' || status === 403) {
          getLogger().debug(
            safeMsg`Refactor marker ${key} is not readable (access denied); treating it as absent.`
          );
          return { kind: 'none' };
        }
        throw error;
      }
      if (marker === null) return { kind: 'none' };
      const { moves, malformed } = refactorMarkerMovesOf(marker.body);
      if (malformed) return { kind: 'malformed', key };
      return moves.length === 0 ? { kind: 'none' } : { kind: 'moves', moves };
    })();
    reads.set(key, pending);
    // A failed read is not cached: the next stack retries it.
    pending.catch(() => reads.delete(key));
  }
  return pending;
}

/** Test seam: forget every cached read. */
export function resetRefactorMarkerReadsForTest(): void {
  reads.clear();
}

/** The moves of `verdict` that involve `stackName` in `region`, as source or destination. */
export function markerMovesInvolving(
  verdict: MarkerVerdict,
  stackName: string,
  region: string
): RefactorMarkerMove[] {
  if (verdict.kind !== 'moves') return [];
  return verdict.moves.filter(
    (m) =>
      (m.fromStack === stackName && m.fromRegion === region) ||
      (m.toStack === stackName && m.toRegion === region)
  );
}

/** The refusal text for a stack an unfinished move involves, or undefined. */
export function refactorMarkerRefusalMessage(
  verdict: MarkerVerdict,
  stackName: string,
  region: string,
  command: string
): string | undefined {
  if (verdict.kind === 'malformed') {
    return (
      safeMsg`${command} refused stack ${stackName} (${region}): the cdkd refactor marker ` +
      safeMsg`${verdict.key} cannot be read, so whether a move involving this stack is ` +
      'unfinished is unknown. Inspect it in the state bucket; run cdkd refactor to finish the ' +
      'moves it lists, or delete it once no move is in progress.'
    );
  }
  const involved = markerMovesInvolving(verdict, stackName, region);
  if (involved.length === 0) return undefined;
  const sources = [...new Set(involved.map((m) => m.fromStack))];
  return (
    safeMsg`${command} refused stack ${stackName} (${region}): a cdkd refactor moving ` +
    safeMsg`${involved.map((m) => `${m.fromStack}.${m.from} -> ${m.toStack}.${m.to}`).join(', ')} ` +
    'did not finish, and acting on this stack now could delete a resource another stack ' +
    'owns or create it a second time. Run ' +
    safeMsg`'cdkd refactor ${sources.join(' ')}' to finish the move, then re-run.`
  );
}

/** Refuse a stack an unfinished move in the marker involves. */
export function refuseRefactorMarker(
  verdict: MarkerVerdict,
  stackName: string,
  region: string,
  command: string
): void {
  const message = refactorMarkerRefusalMessage(verdict, stackName, region, command);
  if (message === undefined) return;
  throw markNonRetryable(new CdkdError(message, 'REFACTOR_UNFINISHED'));
}

type MarkerWriter = Pick<S3StateBackend, 'getRefactorMarker' | 'saveRefactorMarker'>;

/**
 * Read-modify-write the marker, conditional on the version read, retrying a
 * lost race with another run (a few times; each attempt is one GET and one
 * PUT). A marker that cannot be read as moves refuses: rewriting it would
 * drop what it records.
 */
export async function updateRefactorMarker(
  backend: MarkerWriter,
  update: (moves: RefactorMarkerMove[]) => RefactorMarkerMove[]
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await backend.getRefactorMarker();
    let moves: RefactorMarkerMove[] = [];
    if (current !== null) {
      const parsed = refactorMarkerMovesOf(current.body);
      if (parsed.malformed) {
        throw new CdkdError(
          'The cdkd refactor marker (_refactor/pending.json under the state prefix) cannot be ' +
            'read, so cdkd refactor will not rewrite it. Inspect it in the state bucket; delete ' +
            'it once no move is in progress.',
          'REFACTOR_REFUSED'
        );
      }
      moves = parsed.moves;
    }
    const outcome = await backend.saveRefactorMarker(
      { moves: update(moves) },
      current === null ? null : current.etag
    );
    if (outcome === 'saved') return;
  }
  throw new CdkdError(
    'The cdkd refactor marker kept changing under concurrent refactors; re-run cdkd refactor.',
    'REFACTOR_STATE_CHANGED'
  );
}

/** Whether two moves name the same record leaving the same source. */
export function sameMove(
  a: Pick<RefactorMarkerMove, 'fromStack' | 'fromRegion' | 'from'>,
  b: Pick<RefactorMarkerMove, 'fromStack' | 'fromRegion' | 'from'>
): boolean {
  return a.fromStack === b.fromStack && a.fromRegion === b.fromRegion && a.from === b.from;
}
