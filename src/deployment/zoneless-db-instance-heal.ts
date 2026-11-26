import type { CloudFormationTemplate } from '../types/resource.js';
import type { ResourceState } from '../types/state.js';
import { isReadableBag } from '../types/state.js';
import { hasAddressablePhysicalId } from '../state/malformed-resources-bag.js';
import { safeMsg } from '../utils/display-safe.js';

/** The zone a DB instance runs in, read from AWS by its identifier; rejects on a failed read. */
export type LiveDbInstanceZoneReader = (identifier: string) => Promise<string | undefined>;

const DB_INSTANCE = 'AWS::RDS::DBInstance';

const blank = (value: unknown): boolean => value === undefined || value === null || value === '';

/**
 * Before the diff (go-to-k/cdkd#7057): an `AWS::RDS::DBInstance` record
 * written before #5640, while `--prefer-sdk-route` kept `AvailabilityZone` out
 * of it, holds no zone where the template declares one. Since #7044 the
 * replacement rule reads that as a zone ADDED, a replacement the stateful
 * guard then refuses on every deploy, although CloudFormation (whose previous
 * model holds the zone) sees no change.
 *
 * The rule alone cannot tell that record from one whose template newly
 * declares a zone, so the instance answers: for a record in exactly that shape
 * (no zone recorded, a zone declared and resolved to text), the zone the
 * record's drift baseline holds, else ONE live `DescribeDBInstances`, is
 * compared with the declared zone. Equal: the record takes the zone in memory,
 * so the diff sees no change and the deploy's save persists it, and later
 * deploys read nothing. Different, unreadable, or no reader: the record is
 * left as it was, and the replacement (and its refusal) stands.
 *
 * Where this gives way to parity: a template that newly declares the zone the
 * instance already runs in is a replacement in CloudFormation
 * (`isAvailabilityZoneChangeMutable` compares models, not AWS). Here it is no
 * change, since the replacement would land the database where it already is,
 * and the two records cannot be told apart otherwise.
 *
 * Any other record makes no call and resolves nothing (the #6438 performance
 * rule: an ordinary deploy pays nothing). Records are replaced, never edited
 * in place. Returns the healed logical ids.
 */
export async function healZonelessDbInstanceRecords(input: {
  resources: Record<string, ResourceState>;
  template: CloudFormationTemplate;
  /** The diff's own best-effort resolver, so the zone compared is the one the diff compares. */
  resolve: (value: unknown) => Promise<unknown>;
  /** Omitted: nothing is read, and only a drift baseline can prove the zone. */
  readLiveZone?: LiveDbInstanceZoneReader | undefined;
  log: (line: string) => void;
}): Promise<string[]> {
  const { resources, template, resolve, readLiveZone, log } = input;
  const candidates: [string, ResourceState, unknown][] = [];
  for (const [logicalId, record] of Object.entries(resources)) {
    if (record?.resourceType !== DB_INSTANCE) continue;
    const declared = template.Resources?.[logicalId];
    if (declared?.Type !== DB_INSTANCE || !isReadableBag(declared.Properties)) continue;
    if (!isReadableBag(record.properties)) continue;
    if (!blank(record.properties['AvailabilityZone'])) continue;
    const declaredZone = declared.Properties!['AvailabilityZone'];
    if (blank(declaredZone)) continue;
    candidates.push([logicalId, record, declaredZone]);
  }
  if (candidates.length === 0) return [];

  const healed = await Promise.all(
    candidates.map(async ([logicalId, record, declaredZone]) => {
      let desired: unknown;
      try {
        desired = await resolve(structuredClone(declaredZone));
      } catch {
        return undefined;
      }
      if (typeof desired !== 'string' || desired === '') return undefined;
      const observed = isReadableBag(record.observedProperties)
        ? record.observedProperties!['AvailabilityZone']
        : undefined;
      let live: string | undefined = observed === desired ? desired : undefined;
      if (live === undefined) {
        if (readLiveZone === undefined || !hasAddressablePhysicalId(record)) return undefined;
        try {
          live = await readLiveZone(record.physicalId);
        } catch (error) {
          log(
            safeMsg`${logicalId}: its state record holds no AvailabilityZone and the instance's zone could not be read (${error instanceof Error ? error.name : 'error'}); the declared zone is compared as added`
          );
          return undefined;
        }
        if (live !== desired) {
          log(
            safeMsg`${logicalId}: its state record holds no AvailabilityZone and the instance runs in ${live ?? 'no reported zone'}, not the declared ${desired}; the declared zone is compared as added`
          );
          return undefined;
        }
      }
      resources[logicalId] = {
        ...record,
        properties: { ...record.properties, AvailabilityZone: live },
      };
      log(
        safeMsg`${logicalId}: its state record holds no AvailabilityZone and the instance runs in the declared ${live}; recorded, not a change`
      );
      return logicalId;
    })
  );
  return healed.filter((id): id is string => id !== undefined);
}
