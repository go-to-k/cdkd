/**
 * go-to-k/cdkd#4705: what this stack, under THIS state prefix, kept before
 * `retained.json` existed -- the license a redeploy needs after a destroy (or
 * a deploy that removed a Retain resource) run by an older cdkd. Read only when
 * this prefix has no `retained.json` for the stack at all: this cdkd writes one
 * on every destroy and orphan (an empty one included), which ends this
 * license.
 *
 * Two sources, both this prefix's own:
 *
 * - the stack's EARLIER records (the newest 10 noncurrent versions of its
 *   `state.json`; a versioned bucket and `s3:ListBucketVersions` /
 *   `s3:GetObjectVersion`): a resource recorded with a Retain
 *   `DeletionPolicy` and a physical id, kept no earlier than that version was
 *   written;
 * - its deployment event history (the newest 20 runs, no extra permission): a
 *   `RESOURCE_RETAINED` row for a logical id whose physical id an earlier
 *   `RESOURCE_SUCCEEDED` row of the same logical id and type recorded, kept at
 *   the retained row's time. The retained row carries no physical id, so it
 *   alone proves nothing. A nested child's rows land in its TOP-LEVEL stack's
 *   runs, under the child's own `Parent~Child` name.
 *
 * Either names the very physical id; the guard licenses a holder only when it
 * is that id, of the same type and logical id, and (for a type that reports
 * one) created no later than it was kept.
 */
import { shouldRetainResource } from '../types/state.js';
import { injectiveKey } from '../state/record-keys.js';
import type { DeploymentEvent } from '../types/deployment-events.js';
import type { EarlierStateRecord } from '../state/earlier-state-versions.js';
import type { KeptInHistory } from './generated-name-guard.js';

/** Resources an earlier record kept: Retain policy and a physical id. */
export function keptInEarlierRecords(records: readonly EarlierStateRecord[]): KeptInHistory[] {
  const out: KeptInHistory[] = [];
  for (const record of records) {
    for (const [logicalId, raw] of Object.entries(record.resources)) {
      if (raw === null || typeof raw !== 'object') continue;
      const r = raw as { resourceType?: unknown; physicalId?: unknown; deletionPolicy?: unknown };
      if (typeof r.resourceType !== 'string' || typeof r.physicalId !== 'string') continue;
      if (r.physicalId === '') continue;
      if (!shouldRetainResource(r.deletionPolicy as Parameters<typeof shouldRetainResource>[0]))
        continue;
      out.push({
        logicalId,
        resourceType: r.resourceType,
        physicalId: r.physicalId,
        ...(record.writtenAt !== undefined && { keptAt: record.writtenAt }),
      });
    }
  }
  return out;
}

/**
 * Resources `stackName`'s event history shows it created and later kept.
 * `runs` oldest first, each run's events in order.
 */
export function keptInEventHistory(
  runs: ReadonlyArray<readonly DeploymentEvent[]>,
  stackName: string
): KeptInHistory[] {
  const made = new Map<string, { resourceType: string; physicalId: string }>();
  const out: KeptInHistory[] = [];
  for (const events of runs) {
    for (const e of events) {
      if (e.stackName !== stackName || typeof e.logicalId !== 'string') continue;
      if (typeof e.resourceType !== 'string') continue;
      if (
        e.eventType === 'RESOURCE_SUCCEEDED' &&
        (e.operation === 'CREATE' || e.operation === 'UPDATE') &&
        typeof e.physicalId === 'string' &&
        e.physicalId !== ''
      ) {
        made.set(e.logicalId, { resourceType: e.resourceType, physicalId: e.physicalId });
      } else if (e.eventType === 'RESOURCE_RETAINED') {
        const m = made.get(e.logicalId);
        if (m !== undefined && m.resourceType === e.resourceType) {
          const keptAt = Date.parse(e.timestamp);
          out.push({
            logicalId: e.logicalId,
            ...m,
            ...(Number.isFinite(keptAt) && { keptAt }),
          });
        }
      }
    }
  }
  return out;
}

/** What {@link loadKeptInHistory} reads. */
export interface KeptInHistorySources {
  earlierStateResources(stackName: string, region: string): Promise<EarlierStateRecord[]>;
  listRuns(stackName: string, region: string): Promise<ReadonlyArray<{ runId: string }>>;
  readRunEvents(
    stackName: string,
    region: string,
    runId: string
  ): Promise<DeploymentEvent[] | null>;
}

/**
 * Both sources, each best-effort (an unreadable one licenses nothing): at
 * most 10 earlier record versions and the 20 runs the history keeps -- for a
 * nested child, its top-level stack's runs.
 */
export async function loadKeptInHistory(
  sources: KeptInHistorySources,
  stackName: string,
  region: string
): Promise<KeptInHistory[]> {
  const [records, runs] = await Promise.all([
    sources.earlierStateResources(stackName, region).catch(() => []),
    readRecentRuns(sources, stackName, region),
  ]);
  return [...keptInEarlierRecords(records), ...keptInEventHistory(runs, stackName)];
}

/**
 * go-to-k/cdkd#5760: what a lifetime whose record is gone actually KEPT, for
 * the first deploy's warning. Stricter than {@link keptInEarlierRecords} (a
 * license, where a non-holder costs nothing): each physical id is judged at
 * its LAST appearance, `records` newest first. In the newest record it was
 * kept by the destroy if its `DeletionPolicy` retains; in an older one it left
 * by a template removal (the same rule) or, when the next record holds its
 * logical id under another physical id, by a replacement, kept only under a
 * retaining `UpdateReplacePolicy`.
 */
export function keptWhenRecordsEnded(records: readonly EarlierStateRecord[]): KeptInHistory[] {
  const seen = new Set<string>();
  const out: KeptInHistory[] = [];
  records.forEach((record, i) => {
    const newer = i === 0 ? undefined : records[i - 1]!.resources;
    for (const [logicalId, raw] of Object.entries(record.resources)) {
      if (raw === null || typeof raw !== 'object') continue;
      const r = raw as {
        resourceType?: unknown;
        physicalId?: unknown;
        deletionPolicy?: unknown;
        updateReplacePolicy?: unknown;
      };
      if (typeof r.resourceType !== 'string' || typeof r.physicalId !== 'string') continue;
      if (r.physicalId === '') continue;
      const key = injectiveKey(r.resourceType, r.physicalId);
      if (seen.has(key)) continue; // a newer record judged it
      seen.add(key);
      const next = newer?.[logicalId] as { physicalId?: unknown } | null | undefined;
      const replaced = next !== undefined && next !== null && typeof next === 'object';
      // Still under the same id in the next record cannot happen here: that
      // record's own entry was judged first.
      const policy = replaced ? r.updateReplacePolicy : r.deletionPolicy;
      if (!shouldRetainResource(policy as Parameters<typeof shouldRetainResource>[0])) continue;
      out.push({
        logicalId,
        resourceType: r.resourceType,
        physicalId: r.physicalId,
        ...(record.writtenAt !== undefined && { keptAt: record.writtenAt }),
      });
    }
  });
  return out;
}

/**
 * The first deploy's warning source (go-to-k/cdkd#5760): what the earlier
 * records and the event history show was kept, each resource once.
 * Best-effort like {@link loadKeptInHistory}.
 */
export async function loadKeptForWarning(
  sources: KeptInHistorySources,
  stackName: string,
  region: string
): Promise<KeptInHistory[]> {
  const [records, runs] = await Promise.all([
    sources.earlierStateResources(stackName, region).catch(() => []),
    readRecentRuns(sources, stackName, region),
  ]);
  // A kept resource a LATER run made again (an older cdkd took it back) was
  // managed afterwards: only a later retained row says it was kept again.
  const lastMadeAt = new Map<string, number>();
  for (const events of runs) {
    for (const e of events) {
      if (e.stackName !== stackName || typeof e.physicalId !== 'string') continue;
      if (typeof e.resourceType !== 'string') continue;
      if (e.eventType !== 'RESOURCE_SUCCEEDED') continue;
      if (e.operation !== 'CREATE' && e.operation !== 'UPDATE') continue;
      const at = Date.parse(e.timestamp);
      if (Number.isFinite(at)) lastMadeAt.set(injectiveKey(e.resourceType, e.physicalId), at);
    }
  }
  const fromEvents = keptInEventHistory(runs, stackName).filter(
    (k) =>
      k.keptAt === undefined ||
      (lastMadeAt.get(injectiveKey(k.resourceType, k.physicalId)) ?? -Infinity) <= k.keptAt
  );
  const seen = new Set<string>();
  const out: KeptInHistory[] = [];
  for (const k of [...keptWhenRecordsEnded(records), ...fromEvents]) {
    const key = injectiveKey(k.resourceType, k.physicalId);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
  }
  return out;
}

/**
 * The 20 runs the history keeps, oldest first, each best-effort -- for a
 * nested child, its top-level stack's runs.
 */
async function readRecentRuns(
  sources: Pick<KeptInHistorySources, 'listRuns' | 'readRunEvents'>,
  stackName: string,
  region: string
): Promise<DeploymentEvent[][]> {
  const runsOf = stackName.split('~')[0]!;
  return (async () => {
    const listed = (await sources.listRuns(runsOf, region)).slice(0, 20);
    const read = await Promise.all(
      listed.map((r) => sources.readRunEvents(runsOf, region, r.runId).catch(() => null))
    );
    // `listRuns` is newest first.
    return read.filter((e): e is DeploymentEvent[] => e !== null).reverse();
  })().catch(() => [] as DeploymentEvent[][]);
}

/**
 * How a rollback's event reason opens when `UpdateReplacePolicy: Retain` kept
 * a replacement's NEW copy (`retainedSurvivorMessages`, which builds it from
 * this). Shared, so the reader below cannot drift from the writer.
 */
export const RETAINED_SURVIVOR_REASON_PREFIX =
  "UpdateReplacePolicy: Retain kept the replacement's new";

/** A replacement's new copy a rollback kept, untracked (go-to-k/cdkd#5143). */
export interface RollbackRetainedCopy {
  logicalId: string;
  resourceType: string;
  /** As the event recorded it: masked where it spelled a secret. */
  physicalId: string;
}

/**
 * The copies `stackName`'s rollbacks kept under `UpdateReplacePolicy: Retain`,
 * from the runs' `ROLLBACK_RESOURCE_SUCCEEDED` events that name the survivor.
 */
export function rollbackRetainedInEventHistory(
  runs: ReadonlyArray<readonly DeploymentEvent[]>,
  stackName: string
): RollbackRetainedCopy[] {
  const out: RollbackRetainedCopy[] = [];
  for (const events of runs) {
    for (const e of events) {
      if (e.stackName !== stackName || e.eventType !== 'ROLLBACK_RESOURCE_SUCCEEDED') continue;
      if (typeof e.logicalId !== 'string' || typeof e.resourceType !== 'string') continue;
      if (typeof e.physicalId !== 'string' || e.physicalId === '') continue;
      if (typeof e.reason !== 'string' || !e.reason.startsWith(RETAINED_SURVIVOR_REASON_PREFIX)) {
        continue;
      }
      out.push({ logicalId: e.logicalId, resourceType: e.resourceType, physicalId: e.physicalId });
    }
  }
  return out;
}

/** {@link rollbackRetainedInEventHistory} over the runs the history keeps. */
export async function loadRollbackRetainedCopies(
  sources: Pick<KeptInHistorySources, 'listRuns' | 'readRunEvents'>,
  stackName: string,
  region: string
): Promise<RollbackRetainedCopy[]> {
  return rollbackRetainedInEventHistory(
    await readRecentRuns(sources, stackName, region),
    stackName
  );
}
