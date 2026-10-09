/**
 * go-to-k/cdkd#4705: what this stack, under THIS state prefix, kept before
 * `retained.json` existed -- the license a redeploy needs after a destroy (or
 * a deploy that removed a Retain resource) run by an older cdkd.
 *
 * Two sources, both this prefix's own, read only when a held name is licensed
 * by nothing else:
 *
 * - the stack's EARLIER records (noncurrent versions of its `state.json` on a
 *   versioned bucket): a resource recorded with a Retain `DeletionPolicy` and
 *   a physical id;
 * - its deployment event history: a `RESOURCE_RETAINED` row for a logical id
 *   whose physical id an earlier `RESOURCE_SUCCEEDED` row of the same logical
 *   id and type recorded. The retained row carries no physical id, so it alone
 *   proves nothing; the history keeps the newest 20 runs, so a create older
 *   than that is not seen here.
 *
 * Either one names the very physical id; the guard licenses a holder only when
 * it is that id (`probeFoundSameId`), of the same type and logical id.
 */
import { shouldRetainResource } from '../types/state.js';
import type { DeploymentEvent } from '../types/deployment-events.js';
import type { KeptInHistory } from './generated-name-guard.js';

/** Resources an earlier record kept: Retain policy and a physical id. */
export function keptInEarlierRecords(
  records: ReadonlyArray<Record<string, unknown>>
): KeptInHistory[] {
  const out: KeptInHistory[] = [];
  for (const resources of records) {
    for (const [logicalId, raw] of Object.entries(resources)) {
      if (raw === null || typeof raw !== 'object') continue;
      const r = raw as { resourceType?: unknown; physicalId?: unknown; deletionPolicy?: unknown };
      if (typeof r.resourceType !== 'string' || typeof r.physicalId !== 'string') continue;
      if (r.physicalId === '') continue;
      if (!shouldRetainResource(r.deletionPolicy as Parameters<typeof shouldRetainResource>[0]))
        continue;
      out.push({ logicalId, resourceType: r.resourceType, physicalId: r.physicalId });
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
          out.push({ logicalId: e.logicalId, ...m });
        }
      }
    }
  }
  return out;
}

/** What {@link loadKeptInHistory} reads. */
export interface KeptInHistorySources {
  earlierStateResources(stackName: string, region: string): Promise<Array<Record<string, unknown>>>;
  listRuns(stackName: string, region: string): Promise<ReadonlyArray<{ runId: string }>>;
  readRunEvents(
    stackName: string,
    region: string,
    runId: string
  ): Promise<DeploymentEvent[] | null>;
}

/**
 * Both sources, each best-effort (an unreadable one licenses nothing): at
 * most 10 earlier record versions and the 20 runs the history keeps.
 */
export async function loadKeptInHistory(
  sources: KeptInHistorySources,
  stackName: string,
  region: string
): Promise<KeptInHistory[]> {
  const [records, runs] = await Promise.all([
    sources.earlierStateResources(stackName, region).catch(() => []),
    (async () => {
      const listed = (await sources.listRuns(stackName, region)).slice(0, 20);
      const read = await Promise.all(
        listed.map((r) => sources.readRunEvents(stackName, region, r.runId).catch(() => null))
      );
      // `listRuns` is newest first.
      return read.filter((e): e is DeploymentEvent[] => e !== null).reverse();
    })().catch(() => [] as DeploymentEvent[][]),
  ]);
  return [...keptInEarlierRecords(records), ...keptInEventHistory(runs, stackName)];
}
