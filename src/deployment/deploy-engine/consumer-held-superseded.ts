import { displayPhysicalId } from '../../provisioning/secret-physical-id.js';
import type { DeployEngine } from '../deploy-engine.js';
import type { ResourceState, StackState, SupersededResourceRecord } from '../../types/state.js';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import { displayStackName, safeMsg } from '../../utils/display-safe.js';
import { withPrintingSecrets } from '../resource-secrets-scope.js';
import { orphanRecordsPrintingBag } from '../secret-name-needles.js';
import { supersededResourcesOf } from '../superseded-resources.js';

/**
 * go-to-k/cdkd#7017: a superseded entry held for a `cdkd deploy` run's
 * consumers (go-to-k/cdkd#7012) is kept by a LATER deploy while a stack
 * importing this stack's outputs still names it. After a failed run the
 * rolled-back consumer's records hold the old copy's URL or ARN, and a deploy
 * of the producer alone has no consumer in its run to wait for, so its
 * cleanup phase would delete what the consumer uses. CloudFormation never
 * gets here: it refuses the producer update while the export is imported.
 *
 * Only an entry carrying `heldForConsumers` is checked, so a deploy carrying
 * no such entry reads nothing. The check reads every other stack's record
 * (one `listStacks` plus a GET each, as the in-use export scan does) and
 * leans to keeping: a record it cannot read keeps every checked entry.
 */

/**
 * Marks every superseded entry of `host` as held for consumers, before the
 * producer's state save persists them (go-to-k/cdkd#7012's hold). In place:
 * the cleanup pass, `run.supersededEntries` and the carried list hold these
 * same objects, and a removal matches by identity. Answers whether an entry
 * changed.
 */
export function markHeldForConsumers(host: Pick<StackState, 'supersededResources'>): boolean {
  let changed = false;
  for (const entry of supersededResourcesOf(host)) {
    if (entry.heldForConsumers === true) continue;
    entry.heldForConsumers = true;
    changed = true;
  }
  return changed;
}

/**
 * The carried entries a deploy of `stackName` may delete now: all of them but
 * those held for consumers that a stack importing this stack's outputs still
 * names. Each kept one gets one line naming the stacks that name it.
 */
export async function carriedNotHeldByConsumers(
  engine: DeployEngine,
  stackName: string,
  carried: readonly SupersededResourceRecord[],
  /** This stack's live records: a value one of them still carries is no needle. */
  live: Record<string, ResourceState>
): Promise<SupersededResourceRecord[]> {
  const checked = carried.filter((entry) => entry.heldForConsumers === true);
  if (checked.length === 0) return [...carried];
  const holders = await consumersNaming(engine, stackName, checked, live);
  const kept = new Set<SupersededResourceRecord>();
  for (const entry of checked) {
    const names = holders.get(entry);
    if (names === undefined || names.length === 0) continue;
    kept.add(entry);
    const { physicalId, resourceType } = entry.state;
    withPrintingSecrets(orphanRecordsPrintingBag([entry]), () =>
      engine.logger.info(
        safeMsg`  Old ${entry.logicalId} (${displayPhysicalId(resourceType, physicalId)}) was not deleted: ${names.join(', ')} (importing this stack's outputs) still uses it. cdkd keeps it in state; deploy those stacks, and the next deploy of this one deletes it`
      )
    );
  }
  return carried.filter((entry) => !kept.has(entry));
}

/** Entry to the display names of the consumer stacks whose records name it. */
async function consumersNaming(
  engine: DeployEngine,
  stackName: string,
  entries: readonly SupersededResourceRecord[],
  live: Record<string, ResourceState>
): Promise<Map<SupersededResourceRecord, string[]>> {
  const region = canonicalizeRegion(engine.stackRegion);
  const holders = new Map<SupersededResourceRecord, string[]>();
  const holdAll = (why: string): Map<SupersededResourceRecord, string[]> => {
    for (const entry of entries) holders.set(entry, [...(holders.get(entry) ?? []), why]);
    return holders;
  };
  let refs: Awaited<ReturnType<DeployEngine['stateBackend']['listStacks']>>;
  try {
    refs = await engine.stateBackend.listStacks();
  } catch {
    return holdAll('a stack cdkd could not list');
  }
  // A value a live record still carries (the VPC id an old security group
  // shared with the new one, a region-wide hosted zone id) names no OLD copy:
  // a consumer that moved still spells it.
  const shared = new Set(Object.values(live ?? {}).flatMap((record) => needlesOf(record)));
  const needles = new Map(
    entries.map(
      (entry) => [entry, needlesOf(entry.state).filter((needle) => !shared.has(needle))] as const
    )
  );
  const readOne = async (ref: (typeof refs)[number]): Promise<void> => {
    const refRegion = ref.region ?? engine.stackRegion;
    if (ref.stackName === stackName && canonicalizeRegion(refRegion) === region) return;
    const display = displayStackName(ref.stackName);
    let state: StackState | undefined;
    try {
      state = (await engine.stateBackend.getState(ref.stackName, refRegion, { readOnly: true }))
        ?.state;
    } catch {
      holdAll(`${display} (its state could not be read)`);
      return;
    }
    if (state === undefined || !readsFrom(state, stackName, region)) return;
    const leaves = leafStrings(state.resources);
    for (const [entry, own] of needles) {
      if (own.some((needle) => leaves.some((leaf) => names(leaf, needle)))) {
        holders.set(entry, [...(holders.get(entry) ?? []), display]);
      }
    }
  };
  // At most READ_CONCURRENCY reads at once over a large bucket.
  for (let at = 0; at < refs.length; at += READ_CONCURRENCY) {
    await Promise.all(refs.slice(at, at + READ_CONCURRENCY).map(readOne));
  }
  return holders;
}

const READ_CONCURRENCY = 16;

/** A plain stack name, as CloudFormation allows; anything else was redacted at persist. */
const PLAIN_STACK_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

/**
 * Whether `state` imports (or reads with `Fn::GetStackOutput`) the producer's
 * outputs. An output read's `sourceStack` is template-derived and may be
 * redacted at persist (`***`, a dynamic reference): one that is no plain stack
 * name may read this producer, so it counts.
 */
function readsFrom(state: StackState, producer: string, region: string): boolean {
  const named = (ref: { sourceStack?: unknown; sourceRegion?: unknown }): boolean =>
    ref.sourceStack === producer &&
    typeof ref.sourceRegion === 'string' &&
    canonicalizeRegion(ref.sourceRegion) === region;
  const isRef = (ref: unknown): ref is { sourceStack?: unknown; sourceRegion?: unknown } =>
    typeof ref === 'object' && ref !== null;
  return (
    (state.imports ?? []).some((ref) => isRef(ref) && named(ref)) ||
    (state.outputReads ?? []).some(
      (ref) =>
        isRef(ref) &&
        (named(ref) ||
          typeof ref.sourceStack !== 'string' ||
          !PLAIN_STACK_NAME.test(ref.sourceStack))
    )
  );
}

/**
 * What a consumer holding the old copy would spell: its physical id and its
 * recorded string attributes (an ARN, a name), each long enough not to match
 * by chance.
 */
function needlesOf(record: ResourceState): string[] {
  const out = new Set<string>([record.physicalId]);
  for (const value of Object.values(record.attributes ?? {})) {
    if (typeof value === 'string' && value.length >= 8 && !/^\d+$/.test(value)) out.add(value);
  }
  return [...out].filter((needle) => needle !== '');
}

function leafStrings(resources: Record<string, ResourceState>): string[] {
  const out: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 64) return;
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const item of value) walk(item, depth + 1);
    else if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) walk(item, depth + 1);
    }
  };
  for (const record of Object.values(resources ?? {})) {
    if (typeof record === 'object' && record !== null) walk(record.properties, 0);
  }
  return out;
}

/** `leaf` is `needle`, or holds it as a whole token (`arn:...:q1/*`, never `q10`). */
function names(leaf: string, needle: string): boolean {
  for (let at = leaf.indexOf(needle); at !== -1; at = leaf.indexOf(needle, at + 1)) {
    const before = at === 0 ? '' : leaf[at - 1]!;
    const after = leaf[at + needle.length] ?? '';
    if (!/[A-Za-z0-9_-]/.test(before) && !/[A-Za-z0-9_-]/.test(after)) return true;
  }
  return false;
}
