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
import { isAccessDeniedError, lookupEachName } from '../provisioning/name-lookup.js';
import {
  dropAdoptingCreates,
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
export type LicenseSource = 'record' | 'orphan' | 'journal' | 'ledger' | 'retained' | 'history';

/** One planned create the guard asks about. */
interface Candidate {
  logicalId: string;
  resourceType: string;
  name: string;
  property: string | undefined;
  provider: ResourceProvider;
  properties: Record<string, unknown>;
  /**
   * Its lookup needs a value only known once the create's properties resolve
   * (an EventBridge rule's `EventBusName` given as an intrinsic): it runs at
   * the create, never against a guessed default.
   */
  deferred: boolean;
}

/** A resource this stack's own event history shows it created, then kept. */
export interface KeptInHistory {
  logicalId: string;
  resourceType: string;
  physicalId: string;
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
  /**
   * What this prefix's own deployment event history shows this stack created
   * and then kept (a destroy by a cdkd that wrote no `retained.json`), read
   * only when a held name is licensed by nothing else.
   */
  loadKeptInHistory?(): Promise<readonly KeptInHistory[]>;
  /** The account the ARNs of SNS / Step Functions names are built in. */
  accountInfo(): Promise<{ partition: string; region: string; accountId: string }>;
}

/** Look-ups by name above this many at once wait their turn, per type. */
const PER_NAME_CONCURRENCY = 10;

/**
 * One deploy's guard.
 *
 * Reads only, until a create is about to be sent: the lookups start at plan
 * time ({@link GeneratedNameGuard.start}), but a name is recorded in the
 * create-token ledger as this stack's INTENT only by {@link admit}, right
 * before its create -- after the approval prompt and the destructive-plan
 * check, under the deploy's lock -- in one write per wave of creates. The
 * deploy's `finally` ({@link settle}, still under the lock) drops every
 * intent whose create was not sent, or whose create returned (its resource is
 * then in the record, or the rollback deleted it): only a create that was sent
 * and never came back -- a crash, a hang, a failure after AWS made it -- keeps
 * its intent, which licenses the re-run taking that resource back.
 */
export class GeneratedNameGuard {
  private readonly verdicts = new Map<string, Promise<GeneratedNameVerdict>>();
  /** The candidates by logical id, for a create that asks. */
  private readonly candidates = new Map<string, Candidate>();
  /** Intents this deploy wrote, by logical id. */
  private readonly recorded = new Set<string>();
  /** Creates sent, and creates that returned a resource. */
  private readonly sent = new Set<string>();
  private readonly returned = new Set<string>();
  private queued: Candidate[] = [];
  private flushing: Promise<void> | undefined;
  private recordedRead:
    | Promise<ReadonlyMap<string, { resourceType: string; name: string }> | undefined>
    | undefined;

  private readonly input: GeneratedNameGuardInput;

  private constructor(input: GeneratedNameGuardInput) {
    this.input = input;
  }

  /**
   * Start every lookup for the plan's CREATE rows of the name-adopting types
   * whose name cdkd generates. `undefined` when there is none: nothing is
   * read or written. Never rejects (each verdict carries its failure). Writes
   * nothing.
   */
  static start(input: GeneratedNameGuardInput): GeneratedNameGuard | undefined {
    const candidates: Candidate[] = [];
    for (const change of input.changes) {
      if (change.changeType !== 'CREATE') continue;
      const properties = (change.desiredProperties ?? {}) as Record<string, unknown>;
      let decision: { provider: ResourceProvider; provisionedBy: ProvisionedBy };
      let name: string | undefined;
      let deferred = false;
      try {
        decision = input.providerFor({ resourceType: change.resourceType, properties });
        if (!replacementCreateAdoptsName(change.resourceType, decision.provisionedBy)) continue;
        // A malformed or unresolved name property is the create's problem to
        // report, never a crash of the whole deploy here.
        name = decision.provider.generatedCreateName?.(
          change.resourceType,
          change.logicalId,
          properties
        );
        deferred =
          decision.provider.lookupNeedsResolvedProperties?.(change.resourceType, properties) ===
          true;
      } catch {
        continue;
      }
      if (typeof name !== 'string' || name === '') continue;
      candidates.push({
        logicalId: change.logicalId,
        resourceType: change.resourceType,
        name,
        property: explicitNamePropertyFor(change.resourceType),
        provider: decision.provider,
        properties,
        deferred,
      });
    }
    if (candidates.length === 0) return undefined;
    const guard = new GeneratedNameGuard(input);
    for (const c of candidates) guard.candidates.set(c.logicalId, c);
    guard.ask(candidates.filter((c) => !c.deferred));
    return guard;
  }

  /** Look `candidates` up together and file each one's verdict. */
  private ask(candidates: readonly Candidate[]): void {
    if (candidates.length === 0) return;
    const all = this.run(candidates).catch(
      (error: unknown) =>
        new Map<string, GeneratedNameVerdict>(
          candidates.map((c) => [c.logicalId, { kind: 'failed', error }])
        )
    );
    for (const c of candidates) {
      this.verdicts.set(
        c.logicalId,
        all.then((verdicts) => verdicts.get(c.logicalId) ?? { kind: 'free' })
      );
    }
  }

  /** The plan-time verdict for `logicalId`'s create, or `undefined` when it was not asked about. */
  verdict(logicalId: string): Promise<GeneratedNameVerdict> | undefined {
    return this.verdicts.get(logicalId);
  }

  /** The generated name and its property, for `logicalId`'s create. */
  candidate(logicalId: string): { name: string; property: string | undefined } | undefined {
    const c = this.candidates.get(logicalId);
    return c === undefined ? undefined : { name: c.name, property: c.property };
  }

  /**
   * The verdict `logicalId`'s create acts on, called right before it is sent
   * with its RESOLVED properties: a deferred lookup runs now; a name the
   * create may take (free, or licensed) is then recorded as this stack's
   * intent, in one write shared by the creates admitted together. A write
   * that fails turns the verdict into `failed` (refuse: a create sent
   * unrecorded could not be taken back after a crash). `undefined` when the
   * create was not asked about.
   */
  async admit(
    logicalId: string,
    resolvedProperties: Record<string, unknown>
  ): Promise<GeneratedNameVerdict | undefined> {
    const c = this.candidates.get(logicalId);
    if (c === undefined) return undefined;
    if (c.deferred && !this.verdicts.has(logicalId)) {
      this.ask([{ ...c, properties: resolvedProperties, deferred: false }]);
    }
    const verdict = await this.verdicts.get(logicalId)!;
    if (verdict.kind !== 'free' && verdict.kind !== 'licensed') return verdict;
    try {
      await this.recordIntent(c);
    } catch (error) {
      return { kind: 'failed', error };
    }
    return verdict;
  }

  /** `logicalId`'s create is being sent now. */
  noteSent(logicalId: string): void {
    if (this.candidates.has(logicalId)) this.sent.add(logicalId);
  }

  /** `logicalId`'s create returned its resource. */
  noteReturned(logicalId: string): void {
    if (this.candidates.has(logicalId)) this.returned.add(logicalId);
  }

  /**
   * The deploy is over (any outcome; called under its lock): drop the
   * intents this deploy wrote whose create was not sent, or returned. Never
   * throws.
   */
  async settle(): Promise<void> {
    if (this.flushing !== undefined) await this.flushing.catch(() => undefined);
    const drop = [...this.recorded].filter((id) => !this.sent.has(id) || this.returned.has(id));
    if (drop.length > 0) await dropAdoptingCreates(drop);
  }

  /**
   * The logical ids whose create took back a resource a destroy of this stack
   * kept (`retained.json`): cleared from that record once the deploy saved
   * its state.
   */
  async readoptedFromRetained(): Promise<string[]> {
    const out: string[] = [];
    for (const [logicalId, verdict] of this.verdicts) {
      if (!this.returned.has(logicalId)) continue;
      const v = await verdict;
      if (v.kind === 'licensed' && (v.via === 'retained' || v.via === 'history'))
        out.push(logicalId);
    }
    return out;
  }

  /** Queue `c`'s intent for the next write; resolves once it is stored. */
  private recordIntent(c: Candidate): Promise<void> {
    if (this.recorded.has(c.logicalId)) return Promise.resolve();
    this.queued.push(c);
    if (this.flushing === undefined) {
      const flush = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
        const batch = this.queued;
        this.queued = [];
        if (this.flushing === flush) this.flushing = undefined;
        await recordAdoptingCreates(
          batch.map((b) => ({ logicalId: b.logicalId, resourceType: b.resourceType, name: b.name }))
        );
        for (const b of batch) this.recorded.add(b.logicalId);
      });
      this.flushing = flush;
    }
    return this.flushing;
  }

  /** This stack's recorded intents (the ledger), read once. */
  private recordedIntents(): Promise<
    ReadonlyMap<string, { resourceType: string; name: string }> | undefined
  > {
    this.recordedRead ??= recordedAdoptingCreates();
    return this.recordedRead;
  }

  private async run(candidates: readonly Candidate[]): Promise<Map<string, GeneratedNameVerdict>> {
    const input = this.input;
    const out = new Map<string, GeneratedNameVerdict>();
    // The ledger's recorded intents are read alongside the lookups: a crash
    // re-run's license is among them.
    const recorded = this.recordedIntents().then(
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

    const unlicensed: Candidate[] = [];
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
      if (!recordedResult.ok) {
        out.set(c.logicalId, { kind: 'failed', error: recordedResult.error });
        continue;
      }
      const intent = recordedResult.value?.get(c.logicalId);
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
      if (via !== undefined) {
        out.set(c.logicalId, { kind: 'licensed', holder, via });
        continue;
      }
      out.set(c.logicalId, { kind: 'held', holder });
      unlicensed.push(c);
    }

    // A destroy by a cdkd that wrote no `retained.json` left only its event
    // history: read it only now, for the names nothing else licenses.
    if (unlicensed.length > 0 && input.loadKeptInHistory !== undefined) {
      let kept: readonly KeptInHistory[];
      try {
        kept = await input.loadKeptInHistory();
      } catch {
        // Unreadable history licenses nothing: the held verdict stands.
        kept = [];
      }
      for (const c of unlicensed) {
        const holder = found.get(c.logicalId)!;
        if (
          kept.some(
            (k) =>
              k.logicalId === c.logicalId &&
              k.resourceType === c.resourceType &&
              probeFoundSameId(c.resourceType, k.physicalId, holder)
          )
        ) {
          out.set(c.logicalId, { kind: 'licensed', holder, via: 'history' });
        }
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
    return lookupEachName(names, `${resourceType}:import`, PER_NAME_CONCURRENCY, async (name) => {
      const c = byName.get(name)!;
      const arn = account !== undefined ? createLookupArn(resourceType, name, account) : undefined;
      if (arn !== undefined && 'unbuildable' in arn) {
        throw new Error(`cannot build the ARN ${resourceType} name ${name} would take`);
      }
      // A 403 (S3 answers it for a bucket ANOTHER account owns, too) throws:
      // the 403 contract, unchecked (warn and create), never silently free.
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
    });
  });
}
