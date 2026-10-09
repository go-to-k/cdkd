/**
 * go-to-k/cdkd#4705: the stack's retained-resource record (`retained.json`)
 * -- what this stack, under this prefix, let go of while it still exists
 * (`DeletionPolicy: Retain` on a destroy, or on a deploy that removes the
 * resource) and a later create of the same stack here may take back by its
 * generated name. Shared by `cdkd destroy` and the deploy engine.
 */
import type { RetainedResource, S3StateBackend } from '../state/s3-state-backend.js';
import { RetainedTimeUnconfirmedError } from '../state/retained-time.js';
import type { ResourceState } from '../types/state.js';
import { replacementCreateAdoptsName } from './replacement-name-holder.js';
import { explicitNamePropertyFor } from '../provisioning/resource-name.js';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { displayStackName, safeMsg } from '../utils/display-safe.js';

/**
 * go-to-k/cdkd#4705: whether a kept resource is one a later create of the
 * stack would take back by name -- a name-adopting SDK type whose record
 * carries no template name (its name is cdkd-generated), with a physical id.
 */
export function keptForReadoption(resource: ResourceState): resource is ResourceState & {
  physicalId: string;
} {
  if (!replacementCreateAdoptsName(resource.resourceType, resource.provisionedBy)) return false;
  if (typeof resource.physicalId !== 'string' || resource.physicalId === '') return false;
  const property = explicitNamePropertyFor(resource.resourceType);
  const properties = resource.properties as Record<string, unknown> | undefined;
  return property === undefined || !properties?.[property];
}

/**
 * go-to-k/cdkd#4705: merge `kept` into the stack's retained-resource record
 * under this prefix (`S3StateBackend.saveRetainedResources`), replacing an
 * earlier entry of the same logical id. With nothing kept and no record yet,
 * the empty record is written: the tombstone that tells a later deploy this
 * cdkd destroyed the stack here, so an older cdkd's history licenses nothing
 * (review D-1). Best-effort: a failure is warned -- to record a kept
 * resource (the next deploy's create of it is then refused with the
 * `cdkd import` remedy), or to write the tombstone (an older cdkd's history
 * then still licenses).
 */
export async function recordRetainedForReadoption(
  backend: Pick<
    S3StateBackend,
    'loadRetainedRecord' | 'saveRetainedResources' | 'ensureRetainedTombstone'
  >,
  stackName: string,
  region: string,
  kept: readonly RetainedResource[],
  logger: { warn(message: string): void },
  /** The record, read already (review H-1/H-2: the read is started early). */
  earlier?: Promise<readonly RetainedResource[] | null>
): Promise<void> {
  if (kept.length === 0) {
    try {
      await backend.ensureRetainedTombstone(stackName, region);
    } catch (error) {
      logger.warn(
        safeMsg`Could not write the empty kept-resource record of ${displayStackName(stackName)} ` +
          safeMsg`(${describeAwsFailure(error).summary}). Until one exists, a later deploy here may ` +
          `take back a resource an older cdkd kept; 'cdkd state orphan' writes it.`
      );
    }
    return;
  }
  try {
    const keptIds = new Set(kept.map((k) => k.logicalId));
    // An unreadable record is not overwritten: what it lists would be lost.
    const before = (await (earlier ?? backend.loadRetainedRecord(stackName, region))) ?? [];
    await backend.saveRetainedResources(stackName, region, [
      ...before.filter((e) => !keptIds.has(e.logicalId)),
      ...kept,
    ]);
  } catch (error) {
    if (error instanceof RetainedTimeUnconfirmedError) {
      logger.warn(
        safeMsg`Recorded the ${String(kept.length)} kept resource(s) of ${displayStackName(stackName)} ` +
          safeMsg`a later deploy takes back by name, but their time could not be confirmed from S3 ` +
          safeMsg`(${describeAwsFailure(error.cause).summary}); they carry this machine's clock instead.`
      );
      return;
    }
    logger.warn(
      safeMsg`Could not record the ${String(kept.length)} kept resource(s) of ${displayStackName(stackName)} ` +
        safeMsg`a later deploy takes back by name (${describeAwsFailure(error).summary}). That deploy ` +
        `refuses to create them over the kept ones; adopt them with 'cdkd import' then.`
    );
  }
}

/**
 * go-to-k/cdkd#4705 review H-1/H-2: the resources one deploy or destroy keeps,
 * recorded in ONE write when it ends rather than a read-merge-write each.
 * The record's read starts with the first entry (off the critical path), so
 * the flush costs the write and S3's time stamp. A crash before the flush
 * leaves those resources unrecorded: their later re-create is refused with
 * the `cdkd import` remedy, the safe direction.
 */
export class KeptForReadoption {
  private entries: RetainedResource[] = [];
  private earlier: Promise<readonly RetainedResource[] | null> | undefined;

  private readonly backend: Pick<
    S3StateBackend,
    'loadRetainedRecord' | 'saveRetainedResources' | 'ensureRetainedTombstone'
  >;
  private readonly stackName: string;
  private readonly region: string;
  private readonly logger: { warn(message: string): void };

  constructor(
    backend: Pick<
      S3StateBackend,
      'loadRetainedRecord' | 'saveRetainedResources' | 'ensureRetainedTombstone'
    >,
    stackName: string,
    region: string,
    logger: { warn(message: string): void }
  ) {
    this.backend = backend;
    this.stackName = stackName;
    this.region = region;
    this.logger = logger;
  }

  get size(): number {
    return this.entries.length;
  }

  add(entry: RetainedResource): void {
    this.entries.push(entry);
    if (this.earlier === undefined) {
      this.earlier = Promise.resolve().then(() =>
        this.backend.loadRetainedRecord(this.stackName, this.region)
      );
      this.earlier.catch(() => undefined);
    }
  }

  /** Record what was added since the last flush, in one write. Never throws. */
  async flush(): Promise<void> {
    if (this.entries.length === 0) return;
    const kept = this.entries;
    const earlier = this.earlier;
    this.entries = [];
    this.earlier = undefined;
    await recordRetainedForReadoption(
      this.backend,
      this.stackName,
      this.region,
      kept,
      this.logger,
      earlier
    );
  }
}
