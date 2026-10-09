/**
 * Refuse a CREATE that would adopt an existing resource holding its
 * cdkd-GENERATED name unless this stack's own evidence names that resource
 * (go-to-k/cdkd#4705).
 *
 * The name-adopting SDK types (`NAME_ADOPTING_SDK_CREATE_TYPES`: an SQS queue,
 * an SNS topic, a log group, an alarm, an EventBridge rule, an S3 bucket, an
 * ECS cluster, an ELBv2 load balancer or target group, a state machine) do not
 * fail a create whose name is taken: their create hands the existing resource
 * back, or overwrites it. cdkd's generated names derive from the stack name
 * and logical id alone, so the SAME stack deployed under a second state
 * backend (another prefix, bucket or account's bucket) generates the same
 * names and its creates were handed the first deployment's resources, which
 * its rollback and destroy then deleted.
 *
 * As soon as a deploy's plan is known, {@link GeneratedNameGuard.start} looks
 * every planned generated name of those types up, BATCHED per type and all at
 * once (`ResourceProvider.lookupNames`), so the cost is about one round trip
 * whatever the resource count. Each create then awaits its own answer
 * ({@link GeneratedNameGuard.verdict}):
 *
 * - no holder: create;
 * - a holder this stack's own evidence names -- its state record (any logical
 *   id), its rollback orphans, its rollback journal (a completed op, or a
 *   failed op that recorded a physical id), the create this stack's
 *   create-token ledger recorded before sending it (a crash between the
 *   create and its record), or a resource a destroy of this stack under THIS
 *   prefix kept (`retained.json`) -- take it back, as before;
 * - any other holder: refuse before the create, CloudFormation-style ("already
 *   exists"), naming `cdkd import` and the likely cause;
 * - the lookup refused with 403: warn and create, as before the check (the
 *   403 contract); any other lookup failure refuses.
 *
 * Before any create is sent, the names this deploy is about to take (free, or
 * licensed) are recorded in the create-token ledger in ONE write, so a re-run
 * after a crash finds them as its own.
 *
 * Between the lookup and the create a holder can still appear: the window of
 * two first deploys at the same moment. Within one bucket, the stack registry
 * marker each first deploy claims before its first provider call serializes
 * them; across buckets that window is a documented residual.
 */
import {
  createLookupArn,
  probeFoundSameId,
  replacementCreateAdoptsName,
} from './replacement-name-holder.js';
import { explicitNamePropertyFor, withSkipPrefix } from '../provisioning/resource-name.js';
import {
  LookupEachNameInstead,
  isAccessDeniedError,
  lookupEachName,
} from '../provisioning/name-lookup.js';
import {
  recordAdoptingCreates,
  recordedAdoptingCreates,
} from '../provisioning/providers/create-token-ledger.js';
import type { ResourceChange, ResourceState, StackOrphanRecord } from '../types/state.js';
import type { ProvisionedBy } from '../provisioning/provider-registry.js';
import type { ResourceProvider } from '../types/resource.js';
import type { RollbackJournal } from '../types/rollback-journal.js';
import type { RetainedResource } from '../state/s3-state-backend.js';

/** What a planned create's generated name was found to be. */
export type GeneratedNameVerdict =
  | { kind: 'free' }
  /** A holder this stack's own evidence names (`via`). */
  | { kind: 'licensed'; holder: string; via: LicenseSource }
  /** A holder nothing of this stack names: refuse. */
  | { kind: 'held'; holder: string }
  /** The lookup was refused (403): create, warning once. */
  | { kind: 'unchecked'; error: unknown }
  /** The lookup, or reading this stack's evidence, failed otherwise: refuse. */
  | { kind: 'failed'; error: unknown };

/** Which evidence named a holder. */
export type LicenseSource = 'record' | 'orphan' | 'journal' | 'ledger' | 'retained';

/** One planned create the guard asks about. */
interface Candidate {
  logicalId: string;
  resourceType: string;
  name: string;
  property: string | undefined;
  provider: ResourceProvider;
  properties: Record<string, unknown>;
}

/** What the guard needs from the engine. */
export interface GeneratedNameGuardInput {
  stackName: string;
  region: string;
  changes: Iterable<ResourceChange>;
  /** The router a create uses (`ProviderRegistry.getProviderFor`). */
  providerFor(input: { resourceType: string; properties: Record<string, unknown> }): {
    provider: ResourceProvider;
    provisionedBy: ProvisionedBy;
  };
  /** The stack's loaded state record's resources. */
  records: Readonly<Record<string, ResourceState>>;
  /** The stack's loaded rollback orphans. */
  orphans: readonly StackOrphanRecord[] | undefined;
  /** This stack's rollback journal, read on demand. */
  loadJournal(): Promise<RollbackJournal | null>;
  /** What a destroy of this stack under this prefix kept, read on demand. */
  loadRetained(): Promise<readonly RetainedResource[]>;
  /** The account the ARNs of SNS / Step Functions names are built in. */
  accountInfo(): Promise<{ partition: string; region: string; accountId: string }>;
}

/** Look-ups by name above this many at once wait their turn, per type. */
const PER_NAME_CONCURRENCY = 10;

/** One deploy's guard. */
export class GeneratedNameGuard {
  private readonly verdicts = new Map<string, Promise<GeneratedNameVerdict>>();
  /** The candidates by logical id, for a create that asks. */
  private readonly candidates = new Map<string, Candidate>();

  private constructor() {}

  /**
   * Start every lookup for the plan's CREATE rows of the name-adopting types
   * whose name cdkd generates. `undefined` when there is none: nothing is
   * read or written. Never rejects (each verdict carries its failure).
   */
  static start(input: GeneratedNameGuardInput): GeneratedNameGuard | undefined {
    const candidates: Candidate[] = [];
    for (const change of input.changes) {
      if (change.changeType !== 'CREATE') continue;
      const properties = (change.desiredProperties ?? {}) as Record<string, unknown>;
      let decision: { provider: ResourceProvider; provisionedBy: ProvisionedBy };
      try {
        decision = input.providerFor({ resourceType: change.resourceType, properties });
      } catch {
        continue;
      }
      if (!replacementCreateAdoptsName(change.resourceType, decision.provisionedBy)) continue;
      const name = decision.provider.generatedCreateName?.(
        change.resourceType,
        change.logicalId,
        properties
      );
      if (name === undefined) continue;
      candidates.push({
        logicalId: change.logicalId,
        resourceType: change.resourceType,
        name,
        property: explicitNamePropertyFor(change.resourceType),
        provider: decision.provider,
        properties,
      });
    }
    if (candidates.length === 0) return undefined;
    const guard = new GeneratedNameGuard();
    for (const c of candidates) guard.candidates.set(c.logicalId, c);
    const all = guard
      .run(input, candidates)
      .catch(
        (error: unknown) =>
          new Map<string, GeneratedNameVerdict>(
            candidates.map((c) => [c.logicalId, { kind: 'failed', error }])
          )
      );
    for (const c of candidates) {
      guard.verdicts.set(
        c.logicalId,
        all.then((verdicts) => verdicts.get(c.logicalId) ?? { kind: 'free' })
      );
    }
    return guard;
  }

  /** The verdict for `logicalId`'s create, or `undefined` when it was not asked about. */
  verdict(logicalId: string): Promise<GeneratedNameVerdict> | undefined {
    return this.verdicts.get(logicalId);
  }

  /** The generated name and its property, for `logicalId`'s create. */
  candidate(logicalId: string): { name: string; property: string | undefined } | undefined {
    const c = this.candidates.get(logicalId);
    return c === undefined ? undefined : { name: c.name, property: c.property };
  }

  /**
   * The logical ids whose create took back a resource a destroy of this stack
   * kept (`retained.json`): cleared from that record once the deploy saved
   * its state.
   */
  async readoptedFromRetained(): Promise<string[]> {
    const out: string[] = [];
    for (const [logicalId, verdict] of this.verdicts) {
      const v = await verdict;
      if (v.kind === 'licensed' && v.via === 'retained') out.push(logicalId);
    }
    return out;
  }

  private async run(
    input: GeneratedNameGuardInput,
    candidates: readonly Candidate[]
  ): Promise<Map<string, GeneratedNameVerdict>> {
    const out = new Map<string, GeneratedNameVerdict>();
    // The ledger's recorded creates are read alongside the lookups: the one
    // write below needs them, and a crash re-run's license is among them.
    const recorded = recordedAdoptingCreates().then(
      (r) => ({ ok: true as const, value: r }),
      (error: unknown) => ({ ok: false as const, error })
    );
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

    // Evidence is read only when some name is held.
    let evidence: Evidence | { error: unknown } | undefined;
    if (found.size > 0) {
      evidence = await loadEvidence(input).catch((error: unknown) => ({ error }));
    }
    const recordedResult = await recorded;
    const intents = recordedResult.ok ? recordedResult.value : undefined;

    for (const c of candidates) {
      const failure = typeFailures.get(c.resourceType);
      if (failure !== undefined) {
        out.set(
          c.logicalId,
          isAccessDeniedError(failure)
            ? { kind: 'unchecked', error: failure }
            : { kind: 'failed', error: failure }
        );
        continue;
      }
      const holder = found.get(c.logicalId);
      if (holder === undefined) {
        out.set(c.logicalId, { kind: 'free' });
        continue;
      }
      // A crash between this create and its record: the ledger recorded it.
      const intent = intents?.get(c.logicalId);
      if (
        intent !== undefined &&
        intent.resourceType === c.resourceType &&
        intent.name === c.name
      ) {
        out.set(c.logicalId, { kind: 'licensed', holder, via: 'ledger' });
        continue;
      }
      if (evidence === undefined || 'error' in evidence) {
        out.set(c.logicalId, {
          kind: 'failed',
          error:
            evidence !== undefined && 'error' in evidence
              ? evidence.error
              : new Error('no evidence'),
        });
        continue;
      }
      const via = evidence.namedBy(c.resourceType, holder);
      out.set(
        c.logicalId,
        via === undefined ? { kind: 'held', holder } : { kind: 'licensed', holder, via }
      );
    }

    // ONE ledger write, before any create is sent: the names this deploy is
    // about to take. A name refused here is never recorded, so a re-run is
    // refused too. When the ledger cannot be read or written, the creates
    // that would rely on it are refused rather than sent unrecorded.
    const toRecord = candidates.filter((c) => {
      const v = out.get(c.logicalId)!;
      return v.kind === 'free' || v.kind === 'licensed';
    });
    if (toRecord.length > 0) {
      try {
        if (!recordedResult.ok) throw recordedResult.error;
        await recordAdoptingCreates(
          toRecord.map((c) => ({
            logicalId: c.logicalId,
            resourceType: c.resourceType,
            name: c.name,
          }))
        );
      } catch (error) {
        for (const c of toRecord) out.set(c.logicalId, { kind: 'failed', error });
      }
    }
    return out;
  }
}

/** This stack's evidence of the resources it holds or made. */
interface Evidence {
  namedBy(resourceType: string, holder: string): LicenseSource | undefined;
}

async function loadEvidence(input: GeneratedNameGuardInput): Promise<Evidence> {
  const [journal, retained] = await Promise.all([input.loadJournal(), input.loadRetained()]);
  const sources: Array<[LicenseSource, string, string]> = [];
  for (const record of Object.values(input.records)) {
    if (typeof record?.physicalId === 'string')
      sources.push(['record', record.resourceType, record.physicalId]);
  }
  for (const orphan of input.orphans ?? []) {
    const s = orphan.state;
    if (typeof s?.physicalId === 'string') sources.push(['orphan', s.resourceType, s.physicalId]);
  }
  for (const segment of journal?.segments ?? []) {
    for (const op of segment.operations ?? []) {
      if (typeof op.physicalId === 'string' && op.physicalId !== '') {
        sources.push(['journal', op.resourceType, op.physicalId]);
      }
    }
    for (const op of segment.failedOperations ?? []) {
      if (typeof op.physicalId === 'string' && op.physicalId !== '') {
        sources.push(['journal', op.resourceType, op.physicalId]);
      }
    }
  }
  for (const r of retained) sources.push(['retained', r.resourceType, r.physicalId]);
  return {
    namedBy: (resourceType, holder) =>
      sources.find(
        ([, type, id]) => type === resourceType && probeFoundSameId(resourceType, id, holder)
      )?.[0],
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
      try {
        return await provider.lookupNames(resourceType, names, {
          region: input.region,
          stackName: input.stackName,
          propertiesByName: new Map(group.map((c) => [c.name, c.properties])),
        });
      } catch (error) {
        if (!(error instanceof LookupEachNameInstead)) throw error;
      }
    }
    const lookup = provider.import?.bind(provider);
    if (lookup === undefined) return new Map();
    const byName = new Map(group.map((c) => [c.name, c]));
    const account = ['AWS::SNS::Topic', 'AWS::StepFunctions::StateMachine'].includes(resourceType)
      ? await input.accountInfo()
      : undefined;
    return lookupEachName(names, `${resourceType}:import`, PER_NAME_CONCURRENCY, async (name) => {
      const c = byName.get(name)!;
      const arn = account !== undefined ? createLookupArn(resourceType, name, account) : undefined;
      if (arn !== undefined && 'unbuildable' in arn) {
        throw new Error(`cannot build the ARN ${resourceType} name ${name} would take`);
      }
      try {
        const found = await lookup({
          logicalId: c.logicalId,
          resourceType,
          stackName: input.stackName,
          region: input.region,
          properties:
            c.property === undefined ? c.properties : { ...c.properties, [c.property]: name },
          ...(arn !== undefined && { knownPhysicalId: arn.arn }),
        });
        return found?.physicalId;
      } catch (error) {
        // S3 answers 403 for a bucket ANOTHER account owns: its create then
        // fails with BucketAlreadyExists, which adopts nothing.
        if (resourceType === 'AWS::S3::Bucket' && isAccessDeniedError(error)) return undefined;
        throw error;
      }
    });
  });
}
