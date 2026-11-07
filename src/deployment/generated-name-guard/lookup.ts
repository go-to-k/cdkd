import { createLookupArn, probeFoundSameId } from '../replacement-name-holder.js';
import { withSkipPrefix } from '../../provisioning/resource-name.js';
import { lookupEachName } from '../../provisioning/name-lookup.js';
import type { Candidate, GeneratedNameGuardInput, LicenseSource } from './types.js';

/** Per-name reads through `import()` at once, per type (SNS's API is the strictest). */
const PER_NAME_CONCURRENCY: Readonly<Record<string, number>> = { 'AWS::SNS::Topic': 4 };
const DEFAULT_PER_NAME_CONCURRENCY = 10;

/**
 * S3's answer for a bucket that exists in another region: 301
 * PermanentRedirect (SDK v3 surfaces a HEAD's as a synthetic `Unknown` error
 * carrying the 301 status).
 */
function isPermanentRedirect(error: unknown): boolean {
  const e = error as {
    name?: unknown;
    $metadata?: { httpStatusCode?: unknown };
    $response?: { statusCode?: unknown };
  } | null;
  return (
    e?.name === 'PermanentRedirect' ||
    e?.$metadata?.httpStatusCode === 301 ||
    e?.$response?.statusCode === 301
  );
}

/** Every candidate's holder (by logical id), and the types whose lookup failed. */
export async function lookupAll(
  input: GeneratedNameGuardInput,
  candidates: readonly Candidate[]
): Promise<{ found: Map<string, string>; typeFailures: Map<string, unknown> }> {
  const byType = new Map<string, Candidate[]>();
  for (const c of candidates)
    byType.set(c.resourceType, [...(byType.get(c.resourceType) ?? []), c]);
  const found = new Map<string, string>();
  const typeFailures = new Map<string, unknown>();
  await Promise.all(
    [...byType].map(async ([resourceType, group]) => {
      try {
        const holders = await lookupType(input, resourceType, group);
        for (const c of group) {
          const holder = holders.get(c.name);
          if (holder !== undefined) found.set(c.logicalId, holder);
        }
      } catch (error) {
        typeFailures.set(resourceType, error);
      }
    })
  );
  return { found, typeFailures };
}

/** This stack's evidence of the resources it holds or made. */
export interface Evidence {
  namedBy(
    resourceType: string,
    holder: string
  ): { via: LicenseSource; keptAt?: number } | undefined;
  /** No `retained.json` at all: this cdkd never destroyed or orphaned the stack here. */
  retainedAbsent: boolean;
}

export async function loadEvidence(input: GeneratedNameGuardInput): Promise<Evidence> {
  // go-to-k/cdkd#5064: on a stack with an instance id what left the stack
  // licenses nothing, so `retained.json` is not read for it.
  const kept = input.newScheme !== true;
  const [journal, retained] = await Promise.all([
    input.loadJournal(),
    kept ? input.loadRetained() : Promise.resolve([]),
  ]);
  const sources: Array<{ via: LicenseSource; type: string; id: string; keptAt?: number }> = [];
  for (const record of Object.values(input.records)) {
    if (typeof record?.physicalId === 'string')
      sources.push({ via: 'record', type: record.resourceType, id: record.physicalId });
  }
  for (const orphan of kept ? (input.orphans ?? []) : []) {
    const s = orphan.state;
    if (typeof s?.physicalId === 'string')
      sources.push({ via: 'orphan', type: s.resourceType, id: s.physicalId });
  }
  for (const segment of journal?.segments ?? []) {
    for (const op of [...(segment.operations ?? []), ...(segment.failedOperations ?? [])]) {
      if (typeof op.physicalId === 'string' && op.physicalId !== '') {
        sources.push({ via: 'journal', type: op.resourceType, id: op.physicalId });
      }
    }
  }
  for (const r of retained ?? []) {
    sources.push({
      via: 'retained',
      type: r.resourceType,
      id: r.physicalId,
      ...(r.keptAt !== undefined && { keptAt: r.keptAt }),
    });
  }
  return {
    retainedAbsent: retained === null,
    namedBy: (resourceType, holder) => {
      const hit = sources.find(
        (s) => s.type === resourceType && probeFoundSameId(resourceType, s.id, holder)
      );
      return hit === undefined
        ? undefined
        : { via: hit.via, ...(hit.keptAt !== undefined && { keptAt: hit.keptAt }) };
    },
  };
}

/**
 * One type's holders, name → physical id: the provider's batch
 * (`lookupNames`), or, when it has none or asks for it, per-name lookups
 * through its `import()`, bounded. Throws when it cannot tell.
 */
async function lookupType(
  input: GeneratedNameGuardInput,
  resourceType: string,
  group: readonly Candidate[]
): Promise<Map<string, string>> {
  const provider = group[0]!.provider;
  const names = group.map((c) => c.name);
  // The lookups run with the stack-name prefix rule OFF: each name is the
  // one `create()` sends already, which a provider whose lookup re-derives a
  // template name (ELBv2) must not prefix a second time.
  return withSkipPrefix(true, async () => {
    if (provider.lookupNames !== undefined) {
      return provider.lookupNames(resourceType, names, {
        region: input.region,
        stackName: input.stackName,
        propertiesByName: new Map(group.map((c) => [c.name, c.properties])),
      });
    }
    const lookup = provider.import?.bind(provider);
    if (lookup === undefined) return new Map();
    const byName = new Map(group.map((c) => [c.name, c]));
    const account = ['AWS::SNS::Topic', 'AWS::StepFunctions::StateMachine'].includes(resourceType)
      ? await input.accountInfo()
      : undefined;
    const concurrency = PER_NAME_CONCURRENCY[resourceType] ?? DEFAULT_PER_NAME_CONCURRENCY;
    return lookupEachName(names, `${resourceType}:import`, concurrency, async (name) => {
      const c = byName.get(name)!;
      const arn = account !== undefined ? createLookupArn(resourceType, name, account) : undefined;
      if (arn !== undefined && 'unbuildable' in arn) {
        throw new Error(`cannot build the ARN ${resourceType} name ${name} would take`);
      }
      // A 403 (S3 answers it for a bucket ANOTHER account owns, too) throws:
      // the 403 contract, unchecked (warn and create), never silently free.
      let found: Awaited<ReturnType<typeof lookup>>;
      try {
        found = await lookup({
          logicalId: c.logicalId,
          resourceType,
          stackName: input.stackName,
          region: input.region,
          properties:
            c.property === undefined ? c.properties : { ...c.properties, [c.property]: name },
          ...(arn !== undefined && { knownPhysicalId: arn.arn }),
        });
      } catch (error) {
        // Review H-7: S3's 301 for HeadBucket is a bucket of that name in
        // another region -- the name is held, not unreadable.
        if (resourceType === 'AWS::S3::Bucket' && isPermanentRedirect(error)) return name;
        throw error;
      }
      return found?.physicalId;
    });
  });
}
