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
  const runsOf = stackName.split('~')[0]!;
  const [records, runs] = await Promise.all([
    sources.earlierStateResources(stackName, region).catch(() => []),
    (async () => {
      const listed = (await sources.listRuns(runsOf, region)).slice(0, 20);
      const read = await Promise.all(
        listed.map((r) => sources.readRunEvents(runsOf, region, r.runId).catch(() => null))
      );
      // `listRuns` is newest first.
      return read.filter((e): e is DeploymentEvent[] => e !== null).reverse();
    })().catch(() => [] as DeploymentEvent[][]),
  ]);
  return [...keptInEarlierRecords(records), ...keptInEventHistory(runs, stackName)];
}
