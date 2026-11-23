/**
 * The rollback-journal writes a deploy owes when it is force-quit
 * (go-to-k/cdkd#6894).
 *
 * A deploy writes its journal segment only once its operations settle, while
 * the state record is saved after each resource. A force-quit (the second
 * Ctrl-C, the SIGTERM a CI runner sends after its SIGINT) or a closed terminal
 * (SIGHUP) exits the process before that, leaving the changes already made in
 * AWS and in state with no journal, so `cdkd rollback` had nothing to replay.
 *
 * Each running `executeDeployment` registers a flusher here for as long as it
 * is the one that would have to write the segment, and unregisters the moment
 * its own path takes over journaling. The deploy command's force-quit runs
 * every registered flusher, inside its exit budget, before it exits.
 *
 * In memory only: nothing here costs an uninterrupted deploy an AWS call. A
 * SIGKILL or a power loss runs no handler, so it stays uncovered
 * (`docs/cli-rollback-limitations.md`).
 */

/**
 * One flusher: write the segment and answer the stack name a `cdkd rollback`
 * should name, or `undefined` when there is none to print (nothing was
 * written, or a nested child, which is reverted through its top-level stack).
 */
export type ForceQuitFlush = () => Promise<string | undefined>;

/** The handle `registerForceQuitFlush` returns. */
export interface ForceQuitRegistration {
  /**
   * The engine takes over journaling: unregister, and answer whether it MAY
   * write its own segment. `false` means a force-quit flush already started
   * for this run, which writes the segment itself; the engine must then write
   * none, or `cdkd rollback` replays the same operations twice. On `false` it
   * resolves only once that flush settled: the engine's next step may end the
   * process (an error exit), which must not cut the flush's write short.
   */
  takeOver(): Promise<boolean>;
  /** Unregister (idempotent). For the run's `finally`. */
  unregister(): void;
}

/** What {@link startForceQuitFlushes} started. */
export interface StartedForceQuitFlush {
  /** How many flushers were registered when the force-quit began. */
  pending: number;
  /** The stack names each flusher answered; never rejects. */
  done: Promise<string[]>;
}

interface Entry {
  flush: ForceQuitFlush;
  /** The flush, once a force-quit started it. */
  started?: Promise<string | undefined>;
}

const registered = new Set<Entry>();

/**
 * Journal writes in flight, whoever started them (`trackJournalWrite`), each
 * with the stack name a force-quit names once it lands.
 */
const journalWrites = new Map<Promise<unknown>, string | undefined>();

/**
 * Track one rollback-journal write until it settles, so a force-quit that
 * starts meanwhile waits for it (inside its exit budget) instead of exiting
 * mid-write, and names `stackName` in its `cdkd rollback` line when the write
 * lands (`undefined` for a nested child, reverted through its top-level
 * stack). Answers `write` itself.
 */
export function trackJournalWrite<T>(write: Promise<T>, stackName?: string): Promise<T> {
  // `Promise.resolve`: a test double may answer a bare value.
  const tracked = Promise.resolve(write);
  journalWrites.set(tracked, stackName);
  const untrack = (): void => {
    journalWrites.delete(tracked);
  };
  tracked.then(untrack, untrack);
  return tracked;
}

/** Register a run's flusher; see {@link ForceQuitRegistration}. */
export function registerForceQuitFlush(flush: ForceQuitFlush): ForceQuitRegistration {
  const entry: Entry = { flush };
  registered.add(entry);
  return {
    takeOver: async (): Promise<boolean> => {
      registered.delete(entry);
      if (entry.started === undefined) return true;
      await entry.started.catch(() => undefined);
      return false;
    },
    unregister: (): void => {
      registered.delete(entry);
    },
  };
}

/** Registers a flusher that the enclosing {@link withForceQuitFlushScope} removes. */
export type ForceQuitFlushRegistrar = (flush: ForceQuitFlush) => ForceQuitRegistration;

/**
 * Run `fn` with a registrar whose registrations are removed when `fn`
 * settles, however it settles: no flusher outlives the run that owns it.
 */
export async function withForceQuitFlushScope<T>(
  fn: (register: ForceQuitFlushRegistrar) => Promise<T>
): Promise<T> {
  const held: ForceQuitRegistration[] = [];
  try {
    return await fn((flush) => {
      const registration = registerForceQuitFlush(flush);
      held.push(registration);
      return registration;
    });
  } finally {
    for (const registration of held) registration.unregister();
  }
}

/**
 * Run every registered flusher once, concurrently, and wait for every journal
 * write already in flight. Each flusher is marked started synchronously,
 * before it runs, so an engine path reaching its `takeOver` afterwards writes
 * no second segment. A flusher that throws counts as having written nothing.
 */
export function startForceQuitFlushes(): StartedForceQuitFlush {
  const entries = [...registered];
  registered.clear();
  for (const entry of entries) {
    entry.started = Promise.resolve().then(() => entry.flush());
  }
  const inFlight = [...journalWrites];
  const named = (results: PromiseSettledResult<string | undefined>[]): string[] =>
    results.flatMap((result) =>
      result.status === 'fulfilled' && result.value !== undefined ? [result.value] : []
    );
  const done = Promise.allSettled(
    inFlight.map(([write, stackName]) => write.then(() => stackName))
  ).then((written) =>
    Promise.allSettled(entries.map((entry) => entry.started!)).then((flushed) => [
      ...new Set([...named(written), ...named(flushed)]),
    ])
  );
  return { pending: entries.length + inFlight.length, done };
}

/** How many flushers are registered. For tests. */
export function registeredForceQuitFlushCount(): number {
  return registered.size;
}

/**
 * How long a flusher waits for the state saves already queued before it
 * writes the segment: best-effort, so the record and the journal agree as far
 * as possible, while leaving the journal write most of the force-quit's
 * 5-second exit budget (`FORCE_QUIT_ABORT_BUDGET_MS`). Short, because a
 * cancelled GitHub Actions job sends SIGKILL about 2.5 s after the SIGTERM
 * that force-quits the deploy, and the journal write must fit in that.
 */
export const FORCE_QUIT_STATE_WAIT_MS = 1000;
