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
 * every planned generated name of those types up -- an EXACT read by name
 * (`ResourceProvider.lookupNames`, else `import()` per name), never an
 * eventually consistent listing -- all at once, so the cost is about one
 * round trip whatever the resource count. Each create then acts on its own
 * answer ({@link GeneratedNameGuard.admit}, right before it is sent):
 *
 * - no holder: create;
 * - a holder this stack's own evidence names -- its state record (any logical
 *   id), its rollback orphans, its rollback journal (a completed op, or a
 *   failed op that recorded a physical id), an intent its create-token ledger
 *   recorded (a crash between that create and its record), what it let go of
 *   under THIS prefix (`retained.json`), or, when this cdkd never wrote that
 *   record here, what an older cdkd's history shows it kept -- take it back.
 *   A kept resource is licensed only when its holder was created no later
 *   than it was kept, for a type that reports a creation time;
 * - any other holder: refuse before the create, CloudFormation-style ("already
 *   exists"), naming `cdkd import` and the likely cause. A queue or bucket
 *   still listed while it is being deleted is re-read across the deletion's
 *   cooldown first;
 * - the lookup refused with 403: warn and create, as before the check (the
 *   403 contract); any other lookup failure refuses.
 *
 * The plan-time reads write nothing. A name is recorded as this stack's
 * intent only at admission (after approval, under the deploy's lock), one
 * write per wave of creates; a verdict decided before an approval prompt
 * that ran, or more than a minute old, is read again first (a re-read that
 * cannot answer falls back to it, with a warning). {@link GeneratedNameGuard.settle}, in
 * the deploy's `finally` before the lock is released, drops every intent whose
 * create was not sent, came back, or was rejected outright.
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
import { createdBeforeFailure } from '../provisioning/auxiliary-failure.js';
import { isAmbiguousOutcomeError } from './retryable-errors/transient.js';
import { isThrottlingError } from './retryable-errors/marks.js';
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

/** A resource this stack's own history shows it created, then kept. */
export interface KeptInHistory {
  logicalId: string;
  resourceType: string;
  physicalId: string;
  /** When it was kept (epoch ms), when the history says. */
  keptAt?: number;
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
  /**
   * What this stack let go of under this prefix (`retained.json`), read on
   * demand; `null` when there is no such record at all (this cdkd never
   * destroyed or orphaned the stack here), the only case in which the history
   * below is read.
   */
  loadRetained(): Promise<readonly RetainedResource[] | null>;
  /**
   * What this prefix's own history shows this stack created and then kept (an
   * older cdkd that wrote no `retained.json`), read only when a held name is
   * licensed by nothing else and there is no `retained.json`.
   */
  loadKeptInHistory?(): Promise<readonly KeptInHistory[]>;
  /** The account the ARNs of SNS / Step Functions names are built in. */
  accountInfo(): Promise<{ partition: string; region: string; accountId: string }>;
  /** Timing, overridable for tests. */
  timing?: Partial<GuardTiming>;
  /** Where a non-fatal note goes (the deploy's logger). */
  warn?(message: string): void;
}

/** The guard's clocks and waits. */
export interface GuardTiming {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** A verdict older than this is read again at admission (a prompt that ran makes any earlier one stale). */
  staleAfterMs: number;
  /** How long a held queue or bucket is re-read while it may be deleting. */
  cooldownMs: number;
  /** The wait between those re-reads. */
  cooldownStepMs: number;
}

/** The defaults (exported so an engine-level test can shorten the waits). */
export const DEFAULT_TIMING: GuardTiming = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  // A prompt that ran makes every earlier verdict stale; otherwise only a gap
  // this long (an ordinary multi-level deploy pays no re-read).
  staleAfterMs: 60_000,
  // SQS keeps a deleted queue's name for 60 seconds; S3 answers for a
  // just-deleted bucket for about as long.
  cooldownMs: 65_000,
  cooldownStepMs: 10_000,
};

/**
 * Types whose exact read can still answer for a resource being deleted (a
 * queue's 60-second cooldown, a bucket's delete propagating): a held name of
 * these is read again across that window before it is refused.
 */
const STILL_LISTED_WHILE_DELETING: ReadonlySet<string> = new Set([
  'AWS::SQS::Queue',
  'AWS::S3::Bucket',
]);

/** Per-name reads through `import()` at once, per type (SNS's API is the strictest). */
const PER_NAME_CONCURRENCY: Readonly<Record<string, number>> = { 'AWS::SNS::Topic': 4 };
const DEFAULT_PER_NAME_CONCURRENCY = 10;

/** Clock skew tolerated between cdkd's clock (when kept) and AWS's (when created). */
const KEPT_AT_SKEW_MS = 60_000;

/**
 * Did the create call that threw `error` prove that it created nothing? A
 * definite client rejection (a 4xx: validation, AlreadyExists, AccessDenied --
 * not a throttle, 408 or 429) with no ambiguous link and no mark that the
 * provider's create returned before the failure. Anything else -- a timeout,
 * a socket error, a 5xx, an unknown -- may have made the resource.
 */
export function provenNothingCreated(
  error: unknown,
  logicalId: string,
  resourceType: string
): boolean {
  if (createdBeforeFailure(error, logicalId, resourceType) !== undefined) return false;
  if (isAmbiguousOutcomeError(error) || isThrottlingError(error)) return false;
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && typeof current === 'object'; depth++) {
    const status = (current as { $metadata?: { httpStatusCode?: unknown } }).$metadata
      ?.httpStatusCode;
    if (typeof status === 'number') {
      return status >= 400 && status < 500 && status !== 408 && status !== 429;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * One deploy's guard.
 *
 * Reads only, until a create is about to be sent: the lookups start at plan
 * time ({@link GeneratedNameGuard.start}), but a name is recorded in the
 * create-token ledger as this stack's INTENT only by {@link admit}, right
 * before its create -- after the approval prompt and the destructive-plan
 * check, under the deploy's lock -- in one write per wave of creates. The
 * deploy's `finally` ({@link settle}, still under the lock) drops every
 * intent whose create was not sent, came back (its resource is then in the
 * record, or the rollback deleted it), or was rejected outright: only a create
 * that was sent and whose outcome is unknown -- a crash, a hang, a timeout, a
 * 5xx, a failure after AWS made it -- keeps its intent, which licenses the
 * re-run taking that resource back.
 */
export class GeneratedNameGuard {
  private readonly verdicts = new Map<string, Promise<GeneratedNameVerdict>>();
  /** When each verdict was decided. */
  private readonly decidedAt = new Map<string, number>();
  /** The candidates by logical id, for a create that asks. */
  private readonly candidates = new Map<string, Candidate>();
  /** Intents this deploy wrote, by logical id. */
  private readonly recorded = new Set<string>();
  /** Creates sent; those that returned a resource; those rejected outright. */
  private readonly sent = new Set<string>();
  private readonly returned = new Set<string>();
  private readonly rejected = new Set<string>();
  /** Creates re-read at admission already. */
  private readonly refreshed = new Set<string>();
  private queued: Candidate[] = [];
  private flushing: Promise<void> | undefined;
  /** Every intent write started, so `settle` awaits them all. */
  private readonly writes = new Set<Promise<void>>();
  private staleQueue: Candidate[] = [];
  private staleRun: Promise<Map<string, Promise<GeneratedNameVerdict>>> | undefined;
  /** Verdicts already decided when the approval prompt was answered. */
  private readonly decidedBeforePrompt = new Set<string>();
  private evidenceRead: Promise<Evidence> | undefined;
  private historyRead: Promise<readonly KeptInHistory[]> | undefined;
  private recordedRead:
    | Promise<ReadonlyMap<string, { resourceType: string; name: string }> | undefined>
    | undefined;

  private readonly input: GeneratedNameGuardInput;
  private readonly timing: GuardTiming;

  private constructor(input: GeneratedNameGuardInput) {
    this.input = input;
    this.timing = { ...DEFAULT_TIMING, ...input.timing };
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

  /** Look `candidates` up and file each one's verdict. */
  private ask(candidates: readonly Candidate[]): void {
    for (const [logicalId, verdict] of this.resolve(candidates))
      this.verdicts.set(logicalId, verdict);
  }

  /**
   * Each candidate's verdict, resolved as soon as ITS type's lookup answers
   * (one type's slow lookup never holds another type's creates). A held,
   * unlicensed queue or bucket waits out a possible deletion
   * ({@link waitOutDeletion}); no other create waits for it. Never rejects.
   */
  private resolve(candidates: readonly Candidate[]): Map<string, Promise<GeneratedNameVerdict>> {
    const out = new Map<string, Promise<GeneratedNameVerdict>>();
    const byType = new Map<string, Candidate[]>();
    for (const c of candidates)
      byType.set(c.resourceType, [...(byType.get(c.resourceType) ?? []), c]);
    for (const group of byType.values()) {
      const decided = this.run(group).catch((error: unknown) => ({
        verdicts: new Map<string, GeneratedNameVerdict>(
          group.map((c) => [c.logicalId, { kind: 'failed', error }])
        ),
        deleting: [] as Candidate[],
      }));
      let waited: Promise<Map<string, GeneratedNameVerdict>> | undefined;
      for (const c of group) {
        out.set(
          c.logicalId,
          decided.then(async ({ verdicts, deleting }) => {
            let verdict = verdicts.get(c.logicalId) ?? { kind: 'free' };
            if (deleting.includes(c)) {
              waited ??= this.waitOutDeletion(deleting);
              verdict = (await waited).get(c.logicalId) ?? verdict;
            }
            this.decidedAt.set(c.logicalId, this.timing.now());
            return verdict;
          })
        );
      }
    }
    return out;
  }

  /**
   * The deploy asked `--require-approval`'s question: every verdict decided
   * before the answer is read again at its create.
   */
  noteApprovalPrompted(): void {
    for (const logicalId of this.decidedAt.keys()) this.decidedBeforePrompt.add(logicalId);
  }

  /** How many planned creates are checked. */
  get size(): number {
    return this.candidates.size;
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
   * with its RESOLVED properties: a deferred lookup runs now, and a free or
   * licensed verdict decided before an approval prompt that ran, or more than
   * a minute old, is read again (one exact read, batched with the creates
   * admitted together; one that cannot answer keeps the earlier verdict, with
   * a warning); a name the create may take (free, or
   * licensed) is then recorded as this stack's intent, in one write shared by
   * the creates admitted together. A write that fails turns the verdict into
   * `failed` (refuse: a create sent unrecorded could not be taken back after a
   * crash). `undefined` when the create was not asked about.
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
    let verdict = await this.verdicts.get(logicalId)!;
    const decidedAt = this.decidedAt.get(logicalId);
    const stale =
      decidedAt !== undefined &&
      (this.decidedBeforePrompt.has(logicalId) ||
        this.timing.now() - decidedAt > this.timing.staleAfterMs);
    if (
      stale &&
      !this.refreshed.has(logicalId) &&
      (verdict.kind === 'free' || verdict.kind === 'licensed')
    ) {
      this.refreshed.add(logicalId);
      const fresh =
        (await (
          await this.reread({ ...c, properties: resolvedProperties, deferred: false })
        ).get(logicalId)) ?? verdict;
      if (fresh.kind === 'failed' || fresh.kind === 'unchecked') {
        // The re-read could not answer: act on the plan-time answer, as a
        // deploy without the prompt would, rather than refuse mid-deploy.
        this.input.warn?.(
          `${c.logicalId}: could not re-read whether a resource holds its generated name after the approval prompt; acting on the earlier lookup.`
        );
      } else {
        verdict = fresh;
        this.verdicts.set(logicalId, Promise.resolve(verdict));
      }
    }
    if (verdict.kind !== 'free' && verdict.kind !== 'licensed') return verdict;
    try {
      await this.recordIntent(c);
    } catch (error) {
      return { kind: 'failed', error };
    }
    return verdict;
  }

  /** Read `c` again, together with the other stale creates admitted now. */
  private reread(c: Candidate): Promise<Map<string, Promise<GeneratedNameVerdict>>> {
    this.staleQueue.push(c);
    if (this.staleRun === undefined) {
      const run: Promise<Map<string, Promise<GeneratedNameVerdict>>> = new Promise<void>(
        (resolve) => setImmediate(resolve)
      ).then(() => {
        const batch = this.staleQueue;
        this.staleQueue = [];
        if (this.staleRun === run) this.staleRun = undefined;
        return this.resolve(batch);
      });
      this.staleRun = run;
    }
    return this.staleRun;
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
   * `logicalId`'s create threw. When the error proves the call created
   * nothing ({@link provenNothingCreated}), its intent is dropped at
   * {@link settle}; otherwise (an unknown outcome) it is kept.
   */
  noteFailed(logicalId: string, error: unknown): void {
    const c = this.candidates.get(logicalId);
    if (c !== undefined && provenNothingCreated(error, logicalId, c.resourceType)) {
      this.rejected.add(logicalId);
    }
  }

  /**
   * The deploy is over (any outcome; called under its lock): drop the
   * intents this deploy wrote whose create was not sent, returned, or was
   * rejected outright. Never throws.
   */
  async settle(): Promise<void> {
    await Promise.all([...this.writes].map((w) => w.catch(() => undefined)));
    const drop = [...this.recorded].filter(
      (id) => !this.sent.has(id) || this.returned.has(id) || this.rejected.has(id)
    );
    if (drop.length > 0) await dropAdoptingCreates(drop);
  }

  /**
   * The logical ids whose create took back a resource this stack kept
   * (`retained.json`, or an older cdkd's history): cleared from that record
   * once the deploy saved its state.
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
      const flush: Promise<void> = new Promise<void>((resolve) => setImmediate(resolve)).then(
        async () => {
          const batch = this.queued;
          this.queued = [];
          if (this.flushing === flush) this.flushing = undefined;
          await recordAdoptingCreates(
            batch.map((b) => ({
              logicalId: b.logicalId,
              resourceType: b.resourceType,
              name: b.name,
            }))
          );
          for (const b of batch) this.recorded.add(b.logicalId);
        }
      );
      this.flushing = flush;
      this.writes.add(flush);
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

  private async run(
    candidates: readonly Candidate[]
  ): Promise<{ verdicts: Map<string, GeneratedNameVerdict>; deleting: Candidate[] }> {
    const input = this.input;
    const out = new Map<string, GeneratedNameVerdict>();
    // The ledger's recorded intents are read alongside the lookups: a crash
    // re-run's license is among them.
    const recorded = this.recordedIntents().then(
      (r) => ({ ok: true as const, value: r }),
      (error: unknown) => ({ ok: false as const, error })
    );
    const { found, typeFailures } = await lookupAll(input, candidates);

    // Evidence is read only when some name is held.
    let evidence: Evidence | { error: unknown } | undefined;
    if (found.size > 0) {
      this.evidenceRead ??= loadEvidence(input);
      evidence = await this.evidenceRead.catch((error: unknown) => ({ error }));
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
      const named = evidence.namedBy(c.resourceType, holder);
      if (named !== undefined) {
        out.set(c.logicalId, await this.licenseIfKeptBefore(c, holder, named));
        if (out.get(c.logicalId)!.kind === 'held') unlicensed.push(c);
        continue;
      }
      out.set(c.logicalId, { kind: 'held', holder });
      unlicensed.push(c);
    }

    // An older cdkd's history: read only when this cdkd never wrote
    // `retained.json` here (orphan and every destroy now write one, an empty
    // one included), and only for the names nothing else licenses.
    if (
      unlicensed.length > 0 &&
      input.loadKeptInHistory !== undefined &&
      evidence !== undefined &&
      !('error' in evidence) &&
      evidence.retainedAbsent
    ) {
      let kept: readonly KeptInHistory[];
      try {
        this.historyRead ??= input.loadKeptInHistory();
        kept = await this.historyRead;
      } catch {
        // Unreadable history licenses nothing: the held verdict stands.
        kept = [];
      }
      for (const c of [...unlicensed]) {
        const holder = found.get(c.logicalId)!;
        const match = kept.find(
          (k) =>
            k.logicalId === c.logicalId &&
            k.resourceType === c.resourceType &&
            probeFoundSameId(c.resourceType, k.physicalId, holder)
        );
        if (match === undefined) continue;
        const verdict = await this.licenseIfKeptBefore(c, holder, {
          via: 'history',
          ...(match.keptAt !== undefined && { keptAt: match.keptAt }),
        });
        out.set(c.logicalId, verdict);
        if (verdict.kind !== 'held') unlicensed.splice(unlicensed.indexOf(c), 1);
      }
    }

    // A queue or bucket being deleted can still read as held: the names
    // nothing licenses are read again across that window (by `resolve`, for
    // those creates only) before they are refused.
    const deleting = unlicensed.filter((c) => STILL_LISTED_WHILE_DELETING.has(c.resourceType));
    return { verdicts: out, deleting };
  }

  /**
   * A license by a KEPT resource (`retained.json`, the history) holds only for
   * a holder created no later than it was kept, when the type reports a
   * creation time: a twin re-created after the kept one was deleted out of
   * band is someone else's. Types without one license by name (a documented
   * residual).
   */
  private async licenseIfKeptBefore(
    c: Candidate,
    holder: string,
    named: { via: LicenseSource; keptAt?: number }
  ): Promise<GeneratedNameVerdict> {
    const licensed: GeneratedNameVerdict = { kind: 'licensed', holder, via: named.via };
    if ((named.via !== 'retained' && named.via !== 'history') || named.keptAt === undefined) {
      return licensed;
    }
    if (c.provider.holderCreatedAt === undefined) return licensed;
    let createdAt: number | undefined;
    try {
      createdAt = await withSkipPrefix(true, () =>
        c.provider.holderCreatedAt!(c.resourceType, holder)
      );
    } catch (error) {
      return isAccessDeniedError(error) ? { kind: 'unchecked', error } : { kind: 'failed', error };
    }
    if (createdAt === undefined || createdAt <= named.keptAt + KEPT_AT_SKEW_MS) return licensed;
    return { kind: 'held', holder };
  }

  /** Re-read held queue / bucket names until they read free or the window ends. */
  private async waitOutDeletion(
    candidates: readonly Candidate[]
  ): Promise<Map<string, GeneratedNameVerdict>> {
    const out = new Map<string, GeneratedNameVerdict>();
    let pending = [...candidates];
    const until = this.timing.now() + this.timing.cooldownMs;
    while (pending.length > 0 && this.timing.now() < until) {
      await this.timing.sleep(this.timing.cooldownStepMs);
      const { found, typeFailures } = await lookupAll(this.input, pending);
      pending = pending.filter((c) => {
        if (typeFailures.has(c.resourceType)) return true;
        if (found.has(c.logicalId)) return true;
        out.set(c.logicalId, { kind: 'free' });
        return false;
      });
    }
    return out;
  }
}

/** Every candidate's holder (by logical id), and the types whose lookup failed. */
async function lookupAll(
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
interface Evidence {
  namedBy(
    resourceType: string,
    holder: string
  ): { via: LicenseSource; keptAt?: number } | undefined;
  /** No `retained.json` at all: this cdkd never destroyed or orphaned the stack here. */
  retainedAbsent: boolean;
}

async function loadEvidence(input: GeneratedNameGuardInput): Promise<Evidence> {
  const [journal, retained] = await Promise.all([input.loadJournal(), input.loadRetained()]);
  const sources: Array<{ via: LicenseSource; type: string; id: string; keptAt?: number }> = [];
  for (const record of Object.values(input.records)) {
    if (typeof record?.physicalId === 'string')
      sources.push({ via: 'record', type: record.resourceType, id: record.physicalId });
  }
  for (const orphan of input.orphans ?? []) {
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
