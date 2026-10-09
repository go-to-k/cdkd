/**
 * The stack registry of a state bucket (go-to-k/cdkd#4705): for each top-level
 * stack and region, one marker at `_cdkd-registry/<region>/<stack>.json`
 * naming the ONE state prefix of the bucket that stack belongs to.
 *
 * It replaces the per-command scan of every top-level prefix
 * (`cross-prefix-stack-scan.ts`) with one O(1) read:
 *
 * - a first deploy CLAIMS the marker (`If-None-Match: *`) before its first
 *   provider call; a lost race re-reads it;
 * - every other check (a destructive plan, the settle, the automatic
 *   rollback's keep, destroy, state destroy, rollback) READS it, once per run;
 * - a marker naming THIS prefix answers "clear" with no other request;
 * - a marker naming another prefix X reads X's record and journal and applies
 *   the holder rules (`recordCanOwnResources`): a holder refuses; nothing
 *   there but X's lock is a deploy in progress; nothing at all (no record that
 *   can own a resource, no journal, no lock) is a stale marker: the prefix
 *   scan runs ONCE first (a pair that predates the registry must not hide
 *   behind it), and only a clear answer re-claims it with `If-Match`;
 * - no marker, for a stack already recorded (a record that predates the
 *   registry), pays the prefix scan ONCE: a clear answer then claims it, so
 *   the next command is O(1) again. A first deploy claims without scanning: a
 *   create can no longer adopt another deployment's resource
 *   (`GeneratedNameGuard`), so a first deploy needs no scan to be safe.
 *
 * A 403 on the marker -- or an S3-compatible endpoint that does not implement
 * its conditional write (`NotImplemented`) -- falls back to the scan (the 403
 * contract: warn, and continue on what the scan can see). The registry is a safety check against
 * one stack name under two prefixes of ONE bucket, not an access control.
 */
import {
  CrossPrefixReadError,
  CrossPrefixScanCache,
  isAccessDenied,
  isNotImplemented,
  type CrossPrefixScanResult,
  type CrossPrefixScanTarget,
} from './cross-prefix-stack-scan.js';

/** The S3 error behind a `CrossPrefixReadError` (the error itself otherwise). */
function unwrapReadError(error: unknown): unknown {
  return error instanceof CrossPrefixReadError ? error.cause : error;
}

/** What the guard needs of a state backend. */
export interface RegistryTarget extends CrossPrefixScanTarget {
  getRegistryMarker(
    stackName: string,
    region: string
  ): Promise<{ prefix: string; etag: string } | null>;
  claimRegistryMarker(
    stackName: string,
    region: string,
    ifMatch?: string
  ): Promise<'claimed' | 'conflict'>;
  lockUnderPrefix(prefix: string, stackName: string, region: string): Promise<boolean>;
}

type Marker = { prefix: string; etag: string } | null;

/** The top-level stack of a nested child (`Parent~Child` → `Parent`). */
export function topLevelStackName(stackName: string): string {
  return stackName.split('~')[0]!;
}

/**
 * One command run's answers, memoized per stack and region. `full` and
 * `target` keep {@link CrossPrefixScanCache}'s shape, so every consumer takes
 * either; the scan itself is the fallback held in {@link scan}.
 */
export class CrossPrefixGuard {
  readonly scan: CrossPrefixScanCache;
  private readonly backend: RegistryTarget;
  /** A dry run: read, never claim. */
  private readonly readOnly: boolean;
  private readonly markers = new Map<string, Promise<Marker>>();
  private readonly answers = new Map<string, Promise<CrossPrefixScanResult>>();

  constructor(
    backend: RegistryTarget,
    opts: { readOnly?: boolean; scan?: CrossPrefixScanCache } = {}
  ) {
    this.backend = backend;
    this.readOnly = opts.readOnly === true;
    this.scan = opts.scan ?? new CrossPrefixScanCache(backend);
  }

  /** The scan's scheduler, for a caller that raises a scan's priority. */
  get target(): CrossPrefixScanCache['target'] {
    return this.scan.target;
  }

  /**
   * The answer for `stackName` in `region` (a nested child answers through its
   * top-level stack's marker). `when` is the fallback scan's priority. Never
   * rejects.
   */
  full(
    stackName: string,
    region: string,
    when: 'prestart' | 'now' = 'now'
  ): Promise<CrossPrefixScanResult> {
    const key = JSON.stringify([stackName, region]);
    let answer = this.answers.get(key);
    if (answer === undefined) {
      answer = this.evaluate(stackName, region, false, when);
      this.answers.set(key, answer);
    } else if (when === 'now') {
      this.scan.target.rank(stackName, region, 'now');
    }
    return answer;
  }

  /**
   * A top-level stack's FIRST deploy under this prefix: claim the marker, or
   * act on the one already there. Never scans for a missing marker. Never
   * rejects.
   */
  firstDeploy(stackName: string, region: string): Promise<CrossPrefixScanResult> {
    const key = JSON.stringify([stackName, region]);
    const answer = this.evaluate(stackName, region, true, 'now');
    this.answers.set(key, answer);
    return answer;
  }

  private marker(top: string, region: string, fresh = false): Promise<Marker> {
    const key = JSON.stringify([top, region]);
    let read = fresh ? undefined : this.markers.get(key);
    if (read === undefined) {
      read = this.backend.getRegistryMarker(top, region);
      this.markers.set(key, read);
    }
    return read;
  }

  private async evaluate(
    stackName: string,
    region: string,
    firstDeploy: boolean,
    when: 'prestart' | 'now'
  ): Promise<CrossPrefixScanResult> {
    const top = topLevelStackName(stackName);
    // A dry run reads the registry but never writes it; a child never claims
    // its top-level stack's marker.
    const claimable = top === stackName && !this.readOnly;
    // At most one re-read after a lost conditional write.
    for (let attempt = 0; attempt < 2; attempt++) {
      let marker: Marker;
      try {
        marker = await this.marker(top, region, attempt > 0);
      } catch (error) {
        return this.fallback(stackName, region, when, error);
      }

      if (marker === null) {
        if (firstDeploy) {
          if (!claimable) return { kind: 'clear' };
          const claimed = await this.claim(top, region);
          if (claimed === 'conflict') continue;
          if (claimed !== 'claimed') return this.fallback(stackName, region, when, claimed.error);
          return { kind: 'clear' };
        }
        // A record that predates the registry: the scan, once, then a claim.
        const scanned = await this.scan.full(stackName, region, when);
        if (scanned.kind === 'clear' && claimable) {
          const claimed = await this.claim(top, region);
          if (claimed === 'conflict') continue;
        }
        return scanned;
      }

      if (marker.prefix === this.backend.prefix) return { kind: 'clear' };

      let held: Awaited<ReturnType<RegistryTarget['recordUnderPrefix']>>;
      let locked: boolean;
      try {
        held = await this.backend.recordUnderPrefix(marker.prefix, stackName, region);
        locked =
          held === 'holder'
            ? false
            : await this.backend.lockUnderPrefix(marker.prefix, top, region);
      } catch (error) {
        return isAccessDenied(error)
          ? { kind: 'denied', error, stage: 'probe' }
          : { kind: 'failed', error };
      }
      if (held === 'holder') return { kind: 'found', prefixes: [marker.prefix] };
      if (locked) return { kind: 'in-progress', prefix: marker.prefix };
      const stale = held === 'empty' ? [marker.prefix] : [];
      // Nothing there that can own a resource, no journal, no lock: a stale
      // marker. Before taking it over, the one-time scan: a pair that
      // predates the registry (two other prefixes recording this stack) must
      // not become invisible behind a marker this prefix now holds.
      const scanned = await this.scan.full(stackName, region, when);
      if (scanned.kind !== 'clear') return scanned;
      const allStale = [...new Set([...stale, ...(scanned.stale ?? [])])];
      const answer: CrossPrefixScanResult = {
        kind: 'clear',
        ...(allStale.length > 0 && { stale: allStale }),
      };
      // A child does not claim its top-level stack's marker.
      if (!claimable) return answer;
      const claimed = await this.claim(top, region, marker.etag);
      if (claimed === 'conflict') continue;
      return answer;
    }
    // Two lost races in a row: another deploy keeps rewriting it.
    return {
      kind: 'failed',
      error: new CrossPrefixReadError(
        `_cdkd-registry/${region}/${top}.json`,
        Object.assign(new Error('the marker changed twice while cdkd was claiming it'), {
          name: 'ConcurrentClaim',
        })
      ),
    };
  }

  private async claim(
    top: string,
    region: string,
    ifMatch?: string
  ): Promise<'claimed' | 'conflict' | { error: unknown }> {
    try {
      const result = await this.backend.claimRegistryMarker(top, region, ifMatch);
      if (result === 'claimed') {
        this.markers.set(
          JSON.stringify([top, region]),
          Promise.resolve({ prefix: this.backend.prefix, etag: '' })
        );
      }
      return result;
    } catch (error) {
      return { error };
    }
  }

  /**
   * The marker cannot be used: the scan answers instead. A 403 on it is
   * reported (unless the scan refuses or reports its own 403); any other
   * failure refuses, as an unreadable marker proves nothing.
   */
  private async fallback(
    stackName: string,
    region: string,
    when: 'prestart' | 'now',
    error: unknown
  ): Promise<CrossPrefixScanResult> {
    // A 403, or an S3-compatible endpoint without conditional writes
    // (`NotImplemented`): the registry cannot be used, the scan answers.
    if (!isAccessDenied(error) && !isNotImplemented(unwrapReadError(error))) {
      return { kind: 'failed', error };
    }
    const scanned = await this.scan.full(stackName, region, when);
    return scanned.kind === 'clear'
      ? { kind: 'denied', error, stage: 'registry', ...(scanned.stale && { stale: scanned.stale }) }
      : scanned;
  }
}
