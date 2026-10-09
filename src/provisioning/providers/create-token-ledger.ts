/**
 * The create-token ledger, as the providers see it (go-to-k/cdkd#4438).
 *
 * The persisted document and its lifecycle are described in
 * `src/state/create-token-ledger.ts`. Here: the deploy engine binds one
 * {@link CreateTokenLedger} per stack around the stack's deploy
 * ({@link withCreateTokenLedger}), and a provider whose create token binds for
 * the resource's lifetime takes its token from {@link reserveStackCreateToken}
 * instead of {@link stackScopedCreateToken} directly.
 *
 * An async-local scope rather than a `CreateContext` field, as
 * `prior-attempt-scope.ts` records for its own one-reader case: three
 * providers read it, on their create path only.
 *
 * Outside a bound scope (unit tests) the token is the nonce-free
 * {@link stackScopedCreateToken}, which is what #4428 shipped.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  emptyCreateTokenLedger,
  withStateSavedObserver,
  type CreateTokenLedgerDoc,
  type SentCreateToken,
} from '../../state/create-token-ledger.js';
import { getLogger } from '../../utils/logger.js';
import { displayIdent, displayStackName, safeMsg } from '../../utils/display-safe.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { stackScopedCreateToken, type StackScopedCreateTokenOptions } from './idempotency-token.js';

/** Where a ledger is read from and written to: one stack's record. */
export interface CreateTokenLedgerStore {
  /** `null` when there is none. Throws when it cannot be read. */
  load(): Promise<CreateTokenLedgerDoc | null>;
  save(ledger: CreateTokenLedgerDoc): Promise<void>;
}

/** The token one create sends, and what an earlier attempt of it recorded. */
export interface StackCreateToken {
  /** The value to send. */
  readonly value: string;
  /** The nonce-free token, which cdkd versions before the ledger sent. */
  readonly base: string;
  /**
   * Local epoch ms this stack lineage FIRST sent this token for the logical id
   * -- in this deploy's earlier attempt, or in an earlier, interrupted run --
   * or `undefined` when this is the first send.
   */
  readonly earlierFirstSentAt: number | undefined;
  /**
   * The ledger was started in this deploy (the stack had none, or a stale
   * one), and this is the create's first send. A create an EARLIER cdkd
   * version sent and never recorded holds the nonce-free token instead, which
   * this create will not be handed back; the EFS provider looks that holder up.
   */
  readonly ledgerStartedThisDeploy: boolean;
}

/** The stack a ledger belongs to, as the state backend names it. */
export interface CreateTokenLedgerStack {
  readonly stackName: string;
  readonly region: string;
}

/** One stack's ledger for the length of one deploy. */
export class CreateTokenLedger {
  private doc: CreateTokenLedgerDoc | undefined;
  /** The store was read and held no ledger (go-to-k/cdkd#4705 P1: not read again). */
  private loadedAbsent = false;
  /**
   * Set when a read or write failed: what is in memory may not be what is
   * stored, so the next use reads the ledger again.
   */
  private stale = false;
  /** Set when this deploy found no ledger, or a stale one, and minted one. */
  private startedThisDeploy = false;
  /**
   * This deploy found no state record: a stored ledger carrying
   * `stateRecorded` outlived its record and is replaced. Cleared once a
   * replacement is saved.
   */
  private replaceRecordedLedger = false;
  /** A state record of this lineage exists; every save carries `stateRecorded`. */
  private stateRecorded = false;
  /** The stored ledger is known to carry `stateRecorded` (or there is none). */
  private stateRecordedPersisted = false;
  /**
   * Logical ids this deploy let go of whose rotation could not be persisted,
   * with the failure. The stored ledger still holds the OLD nonce (and maybe
   * the id's entry), and a token derived from it is the one the kept resource
   * holds, so a later create of the id is refused rather than handed it back.
   */
  private readonly unrecordedLetGo = new Map<string, unknown>();
  /** Serialises reads and writes: creates of one stack run concurrently. */
  private chain: Promise<unknown> = Promise.resolve();
  private readonly logger = getLogger().child('CreateTokenLedger');

  private readonly store: CreateTokenLedgerStore;
  private readonly stack: CreateTokenLedgerStack | undefined;

  constructor(store: CreateTokenLedgerStore, stack?: CreateTokenLedgerStack) {
    this.store = store;
    this.stack = stack;
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /**
   * The deploy read the stack's state record: `exists` is whether there is
   * one. Called before any create.
   */
  beginDeploy(exists: boolean): void {
    this.stateRecorded = exists;
    this.replaceRecordedLedger = !exists;
  }

  /**
   * The ledger as stored, read when this deploy has not read it or a failure
   * left memory unreliable. `null` when the stack has none. Throws when it
   * cannot be read.
   */
  private async current(): Promise<CreateTokenLedgerDoc | null> {
    if (this.doc !== undefined && !this.stale) return this.doc;
    if (this.loadedAbsent && !this.stale) return null;
    const loaded = await this.store.load();
    this.stale = false;
    this.loadedAbsent = loaded === null;
    if (loaded !== null && this.replaceRecordedLedger && loaded.stateRecorded === true) {
      // No state record, yet the ledger says one was saved: an earlier cdkd
      // version deleted the record (a destroy, perhaps keeping resources) and
      // left the ledger. Its `sent` entries name creates that destroy may
      // have kept, so resuming them would take those resources over.
      this.logger.info(
        'This stack has no state record but its create-token ledger outlived an earlier one; starting a fresh ledger, so this deploy does not take over resources that deployment left.'
      );
      this.doc = emptyCreateTokenLedger(randomUUID());
      this.startedThisDeploy = true;
      return this.doc;
    }
    this.doc = loaded ?? undefined;
    return loaded;
  }

  private async persist(doc: CreateTokenLedgerDoc): Promise<void> {
    if (this.stateRecorded) doc.stateRecorded = true;
    await this.store.save(doc);
    this.replaceRecordedLedger = false;
    if (doc.stateRecorded === true) this.stateRecordedPersisted = true;
  }

  /**
   * The token for a create whose nonce-free token is `base`, with the `sent`
   * entry persisted BEFORE it returns.
   *
   * A `sent` entry for the logical id with the same `base` is an earlier send
   * of this very create, in this deploy or an earlier one: its token is sent
   * again (even if the nonce rotated since -- a rotation drops the entries of
   * the logical ids it lets go) and its first send is reported. Otherwise the
   * token folds in the ledger's nonce -- minted and saved now when the stack
   * has none.
   *
   * If the ledger cannot be read or written, the create is REFUSED with an
   * error a retry or a re-run can clear. Sending the nonce-free token instead
   * would fail open: a re-run that can read the ledger again sends a different
   * token, and the resource the first attempt made leaks, billing.
   */
  reserve(
    logicalId: string,
    base: string,
    derive: (nonce: string) => string,
    firstSentAt: number
  ): Promise<{
    value: string;
    earlierFirstSentAt: number | undefined;
    ledgerStartedThisDeploy: boolean;
  }> {
    return this.serialized(async () => {
      // Checked first: the kept resource holds the token every other path
      // here would send (go-to-k/cdkd#4438).
      if (this.unrecordedLetGo.has(logicalId)) {
        throw this.wrapLedgerError(logicalId, this.unrecordedLetGo.get(logicalId));
      }
      // A token this deploy already issued for this create is issued again,
      // whatever has failed since: one create's attempts must agree.
      const earlier = this.doc?.sent[logicalId];
      if (earlier !== undefined && earlier.base === base) {
        return {
          value: earlier.token,
          earlierFirstSentAt: earlier.firstSentAt,
          ledgerStartedThisDeploy: false,
        };
      }
      let doc: CreateTokenLedgerDoc;
      try {
        const loaded = await this.current();
        if (loaded === null) {
          doc = emptyCreateTokenLedger(randomUUID());
          this.doc = doc;
          this.startedThisDeploy = true;
        } else {
          doc = loaded;
          const recorded = doc.sent[logicalId];
          if (recorded !== undefined && recorded.base === base) {
            return {
              value: recorded.token,
              earlierFirstSentAt: recorded.firstSentAt,
              ledgerStartedThisDeploy: false,
            };
          }
        }
      } catch (error) {
        this.stale = true;
        throw this.wrapLedgerError(logicalId, error);
      }
      const value = derive(doc.nonce);
      const previous = doc.sent[logicalId];
      doc.sent[logicalId] = { base, token: value, firstSentAt };
      try {
        await this.persist(doc);
      } catch (error) {
        // Not persisted, so not a token a re-run would send: take it back.
        if (previous === undefined) delete doc.sent[logicalId];
        else doc.sent[logicalId] = previous;
        this.stale = true;
        throw this.wrapLedgerError(logicalId, error);
      }
      return {
        value,
        earlierFirstSentAt: undefined,
        ledgerStartedThisDeploy: this.startedThisDeploy,
      };
    });
  }

  private wrapLedgerError(logicalId: string, error: unknown): Error {
    const stack =
      this.stack === undefined
        ? 'this stack'
        : `stack ${displayStackName(this.stack.stackName)} (${displayIdent(this.stack.region)})`;
    return new Error(
      safeMsg`Could not read or write the create-token ledger of ${stack} (${
        describeAwsFailure(error).summary
      }), so the create of ${logicalId} was not sent: the token it would send without the ledger is not the one a later deploy would send, and the resource could leak. Re-run the deploy once the ledger can be read and written.`,
      { cause: error }
    );
  }

  /**
   * Replace the nonce and drop `logicalId`'s `sent` entry (go-to-k/cdkd#4438):
   * this deploy let that resource go while it still exists -- a
   * `DeletionPolicy: Retain` removal, an `UpdateReplacePolicy: Retain`
   * replacement, a rollback keeping it -- so the stack's next create of it
   * must send a new token. Other logical ids keep the token they sent. No
   * ledger, no-op: the next create mints a fresh nonce anyway. Best-effort;
   * never throws. After a failure, the next use reads the ledger again.
   */
  rotate(logicalId: string): Promise<void> {
    return this.serialized(async () => {
      try {
        const doc = await this.current();
        if (doc === null) return;
        doc.nonce = randomUUID();
        delete doc.sent[logicalId];
        await this.persist(doc);
        this.unrecordedLetGo.delete(logicalId);
      } catch (error) {
        this.stale = true;
        this.unrecordedLetGo.set(logicalId, error);
        this.logger.warn(
          safeMsg`Could not record in this stack's create-token ledger that ${logicalId} was kept (${
            describeAwsFailure(error).summary
          }). A create of ${logicalId} in this deploy is refused; a later deploy's create of it may be handed the kept resource back, so check the resource it records against the one this deploy kept.`
        );
      }
    });
  }

  /**
   * go-to-k/cdkd#4705: the stored `sent` entries (a copy). Throws when the
   * ledger cannot be read; `{}` when the stack has none.
   */
  sentEntries(): Promise<Record<string, SentCreateToken>> {
    return this.serialized(async () => {
      try {
        const doc = await this.current();
        return { ...(doc?.sent ?? {}) };
      } catch (error) {
        this.stale = true;
        throw error;
      }
    });
  }

  /**
   * go-to-k/cdkd#4705: record, in ONE write and BEFORE any of them is sent,
   * the creates a deploy is about to send that adopt a resource by name: each
   * `sent[logicalId] = { base, token: <the name>, firstSentAt }`. A re-run
   * after a crash between such a create and its state record then finds its
   * own name here, which licenses taking the resource back. Throws when the
   * ledger cannot be read or written (the caller refuses those creates).
   */
  recordSent(
    entries: ReadonlyArray<{ logicalId: string; base: string; token: string }>,
    firstSentAt: number
  ): Promise<void> {
    return this.serialized(async () => {
      try {
        let doc = await this.current();
        if (doc === null) {
          doc = emptyCreateTokenLedger(randomUUID());
          this.doc = doc;
          this.startedThisDeploy = true;
        }
        let changed = false;
        for (const entry of entries) {
          const recorded = doc.sent[entry.logicalId];
          if (recorded?.base === entry.base && recorded.token === entry.token) continue;
          doc.sent[entry.logicalId] = { base: entry.base, token: entry.token, firstSentAt };
          changed = true;
        }
        if (changed) await this.persist(doc);
      } catch (error) {
        this.stale = true;
        throw error;
      }
    });
  }

  /**
   * go-to-k/cdkd#4705: drop, in one write, the `sent` entries of
   * `logicalIds` that record a name-adopting create's intent (`base`
   * starting with {@link ADOPTING_CREATE_BASE}): the deploy that wrote them is
   * over and their create was not sent, or came back (the record or the
   * rollback has the resource now). Best-effort; never throws.
   */
  dropAdoptingCreates(logicalIds: readonly string[]): Promise<void> {
    return this.serialized(async () => {
      try {
        const doc = await this.current();
        if (doc === null) return;
        const present = logicalIds.filter(
          (id) => doc.sent[id]?.base.startsWith(ADOPTING_CREATE_BASE) === true
        );
        if (present.length === 0) return;
        for (const id of present) delete doc.sent[id];
        await this.persist(doc);
      } catch (error) {
        this.stale = true;
        this.logger.warn(
          safeMsg`Could not clear this deploy's unsent name-adopting creates from the stack's create-token ledger (${
            describeAwsFailure(error).summary
          }); a later deploy may take a resource of those names back. They are cleared by the next successful deploy.`
        );
      }
    });
  }

  /**
   * Drop the `sent` entries of `logicalIds` once the deploy that sent them
   * has SUCCEEDED and its state record names each of them (go-to-k/cdkd#4438).
   * An entry exists to find a resource an interrupted deploy made but never
   * recorded; once the record names it, keeping the entry would only let a
   * later let-go whose rotation failed hand the kept resource back. Reads the
   * ledger if this deploy has not, or if a failure left memory unreliable.
   * Best-effort; never throws.
   */
  forget(logicalIds: readonly string[]): Promise<void> {
    return this.serialized(async () => {
      try {
        // Read even when this deploy created nothing that takes a ledger
        // token: an entry an EARLIER, failed deploy left for a resource this
        // record now names must go too, or it outlives the record.
        const doc = await this.current();
        if (doc === null) return;
        const present = logicalIds.filter((id) => doc.sent[id] !== undefined);
        if (present.length === 0) return;
        for (const id of present) delete doc.sent[id];
        await this.persist(doc);
      } catch (error) {
        this.stale = true;
        this.logger.warn(
          safeMsg`Could not clear recorded creates from this stack's create-token ledger (${
            describeAwsFailure(error).summary
          }); they stay until a later successful deploy clears them.`
        );
      }
    });
  }

  /**
   * The state backend saved `stackName`/`region`'s record. When it is this
   * ledger's stack, the stored ledger is marked `stateRecorded` (once per
   * deploy), so a later deploy that finds the record gone and the ledger
   * still there does not resume from it. Best-effort; never throws -- a mark
   * that could not be written is tried again on the next state save.
   */
  noteStateSaved(stackName: string, region: string): Promise<void> {
    if (
      this.stack === undefined ||
      this.stack.stackName !== stackName ||
      this.stack.region !== region
    ) {
      return Promise.resolve();
    }
    this.stateRecorded = true;
    if (this.stateRecordedPersisted) return Promise.resolve();
    return this.serialized(async () => {
      if (this.stateRecordedPersisted) return;
      try {
        const doc = await this.current();
        if (doc === null || doc.stateRecorded === true) {
          // None stored: the ledger this deploy mints carries the mark.
          this.stateRecordedPersisted = true;
          return;
        }
        await this.persist(doc);
      } catch (error) {
        this.stale = true;
        this.logger.warn(
          safeMsg`Could not mark this stack's create-token ledger as recorded (${
            describeAwsFailure(error).summary
          }); the next state save tries again.`
        );
      }
    });
  }
}

/** What a ledger needs of the state backend (`S3StateBackend`). */
export interface CreateTokenLedgerBackend {
  loadCreateTokenLedger(stackName: string, region: string): Promise<CreateTokenLedgerDoc | null>;
  saveCreateTokenLedger(
    stackName: string,
    region: string,
    ledger: CreateTokenLedgerDoc
  ): Promise<void>;
}

/** The ledger of the stack record `{stackName}/{region}` in `backend`. */
export function ledgerForStack(
  backend: CreateTokenLedgerBackend,
  stackName: string,
  region: string
): CreateTokenLedger {
  return new CreateTokenLedger(
    {
      load: () => backend.loadCreateTokenLedger(stackName, region),
      save: (doc) => backend.saveCreateTokenLedger(stackName, region, doc),
    },
    { stackName, region }
  );
}

const ledgerStore = new AsyncLocalStorage<CreateTokenLedger>();

/**
 * The `base` prefix of a `sent` entry recording a name-adopting create
 * (go-to-k/cdkd#4705); the rest is its resource type. No token type's base
 * starts with it.
 */
export const ADOPTING_CREATE_BASE = 'adopt-by-name:';

/**
 * go-to-k/cdkd#4705: the bound ledger's recorded adopting creates, as
 * logical id → { resource type, name }. `undefined` with no ledger bound.
 * Throws when the ledger cannot be read.
 */
export async function recordedAdoptingCreates(): Promise<
  ReadonlyMap<string, { resourceType: string; name: string; firstSentAt: number }> | undefined
> {
  const ledger = ledgerStore.getStore();
  if (ledger === undefined) return undefined;
  const out = new Map<string, { resourceType: string; name: string; firstSentAt: number }>();
  for (const [logicalId, entry] of Object.entries(await ledger.sentEntries())) {
    if (entry.base.startsWith(ADOPTING_CREATE_BASE)) {
      out.set(logicalId, {
        resourceType: entry.base.slice(ADOPTING_CREATE_BASE.length),
        name: entry.token,
        firstSentAt: entry.firstSentAt,
      });
    }
  }
  return out;
}

/**
 * go-to-k/cdkd#4705: record the adopting creates a deploy is about to send
 * (see {@link CreateTokenLedger.recordSent}) in the bound ledger, in one
 * write. No ledger bound, no-op. Throws when it cannot be written.
 */
export async function recordAdoptingCreates(
  creates: ReadonlyArray<{ logicalId: string; resourceType: string; name: string }>
): Promise<void> {
  const ledger = ledgerStore.getStore();
  if (ledger === undefined || creates.length === 0) return;
  await ledger.recordSent(
    creates.map((c) => ({
      logicalId: c.logicalId,
      base: `${ADOPTING_CREATE_BASE}${c.resourceType}`,
      token: c.name,
    })),
    Date.now()
  );
}

/**
 * go-to-k/cdkd#4705: drop the bound ledger's name-adopting intents of
 * `logicalIds` (see {@link CreateTokenLedger.dropAdoptingCreates}). Outside a
 * bound ledger, a no-op.
 */
export async function dropAdoptingCreates(logicalIds: readonly string[]): Promise<void> {
  await ledgerStore.getStore()?.dropAdoptingCreates(logicalIds);
}

/**
 * Bound around everything that creates or lets go of a stack's resources: the
 * deploy engine's deploy (and the rollback inside it), `cdkd rollback`'s
 * replay, and a nested child's journal replay -- each with that stack's own
 * ledger. A state save inside it marks the ledger `stateRecorded`.
 */
export function withCreateTokenLedger<T>(ledger: CreateTokenLedger, fn: () => T): T {
  return ledgerStore.run(ledger, () =>
    withStateSavedObserver((stackName, region) => ledger.noteStateSaved(stackName, region), fn)
  );
}

/**
 * The deploy read the stack's state record; `exists` is whether there is one
 * (see {@link CreateTokenLedger.beginDeploy}). No ledger bound, no-op.
 */
export function noteDeployStateRecord(exists: boolean): void {
  ledgerStore.getStore()?.beginDeploy(exists);
}

/** The earliest of the defined times, or `undefined` when none is. */
export function earliestDefined(...times: ReadonlyArray<number | undefined>): number | undefined {
  const defined = times.filter((t): t is number => t !== undefined);
  return defined.length === 0 ? undefined : Math.min(...defined);
}

/**
 * The deploy succeeded and its state record names `logicalIds`: forget their
 * `sent` entries in the bound ledger (see {@link CreateTokenLedger.forget}).
 * No ledger bound, no-op.
 */
export async function forgetRecordedCreateTokens(logicalIds: readonly string[]): Promise<void> {
  await ledgerStore.getStore()?.forget(logicalIds);
}

/**
 * The resource types whose create token comes from {@link reserveStackCreateToken}.
 * Only a resource of one of them holds a token the ledger issued.
 */
export const LEDGER_TOKEN_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  'AWS::EFS::FileSystem',
  'AWS::FSx::FileSystem',
  'AWS::CloudFront::CloudFrontOriginAccessIdentity',
]);

/**
 * The deploy (or a rollback) let `logicalId`, of `resourceType`, go while it
 * still exists -- `DeletionPolicy: Retain` on a removal or a rolled-back
 * create, `UpdateReplacePolicy: Retain` on a replacement. When the type takes
 * a ledger token, rotate the bound ledger (see {@link CreateTokenLedger.rotate});
 * otherwise, and with no ledger bound, a no-op.
 */
export async function noteRetainedResource(resourceType: string, logicalId: string): Promise<void> {
  // No ledger read for any other type (go-to-k/cdkd#4705 review CB-19): a
  // kept name-adopting resource is licensed back through `retained.json`, so
  // its intent, if any, needs no change here.
  if (!LEDGER_TOKEN_RESOURCE_TYPES.has(resourceType)) return;
  await ledgerStore.getStore()?.rotate(logicalId);
}

/**
 * The create token for a provider whose token binds for the resource's
 * lifetime. See {@link CreateTokenLedger.reserve}. Outside a bound ledger it
 * is the nonce-free {@link stackScopedCreateToken}.
 */
export async function reserveStackCreateToken(
  options: StackScopedCreateTokenOptions
): Promise<StackCreateToken> {
  const base = stackScopedCreateToken(options);
  const ledger = ledgerStore.getStore();
  if (ledger === undefined) {
    return { value: base, base, earlierFirstSentAt: undefined, ledgerStartedThisDeploy: false };
  }
  const derive = (nonce: string): string =>
    stackScopedCreateToken({
      ...options,
      immutableInputs: [...options.immutableInputs, { createTokenNonce: nonce }],
    });
  const reserved = await ledger.reserve(options.logicalId, base, derive, Date.now());
  return { ...reserved, base };
}
