import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The stack a resource name is generated for: its name, and the id of its
 * current lifetime (state schema v13, go-to-k/cdkd#5064).
 *
 * `stackInstanceId` is `undefined` for a LEGACY stack (a record written before
 * v13, which keeps the deterministic `{stackName}-{logicalId}` names for all
 * its resources) and, by an explicit decision at the call site, where only
 * declared names are derived. A stack WITH an id gets CloudFormation-style
 * `{stackName}-{logicalId}-{suffix}` names for what it does not name itself
 * ({@link generateResourceName}), so a recreated stack never asks for the
 * names its predecessor left behind.
 */
export interface StackScope {
  stackName: string;
  stackInstanceId: string | undefined;
  /**
   * go-to-k/cdkd#5064 phase 2: the GENERATION each logical id's generated name
   * is derived at, from the state record the scope's names belong to
   * (`nameGenerationsOf`, `src/state/name-generation.ts`): a record's own
   * generation, a re-added id's retired generation + 1, and 0 for an id the
   * map does not hold (a first create). Required beside a `stackInstanceId`:
   * a generated name derived in a scope with an id and no map THROWS rather
   * than silently taking generation 0, which would name a replaced resource
   * after its predecessor. `undefined` with no id (legacy, declared names).
   */
  nameGenerations: ReadonlyMap<string, number> | undefined;
}

/**
 * Per-async-context stack scope. Resource-name generation reads this so that
 * concurrent deploys (`cdkd deploy --all` runs stacks in parallel up to
 * `--stack-concurrency`) don't fight over a single shared variable: each
 * deploy's async chain carries its own scope.
 */
export const stackScopeStore = new AsyncLocalStorage<StackScope & { beforeStateRead?: true }>();

/**
 * Run `fn` in a scope that knows the stack's NAME but not yet its instance
 * id, because the state record carrying it has not been read: the deploy
 * engine's outer scope, around a deploy that opens the id-bearing
 * {@link withStackScope} right after its state read. A generated name derived
 * in it THROWS instead of falling back to the legacy scheme, which on a v13
 * stack would name (or, in an IAM `update()`, replace) a resource under the
 * wrong lifetime; declared names, the stack name and the prefix flag work.
 */
export function withStackScopeBeforeStateRead<T>(
  stackName: string,
  fn: () => Promise<T>
): Promise<T> {
  return stackScopeStore.run(
    { stackName, stackInstanceId: undefined, nameGenerations: undefined, beforeStateRead: true },
    fn
  );
}

/**
 * Run `fn` with `scope` visible to {@link generateResourceName} for the
 * duration of the callback (and any `await`s inside). Concurrent invocations
 * each get an independent scope. Both fields are required, so every call site
 * states which lifetime's names it derives; an inner scope replaces an outer
 * one for its callback.
 */
export function withStackScope<T>(scope: StackScope, fn: () => Promise<T>): Promise<T>;
export function withStackScope<T>(scope: StackScope, fn: () => T): T;
export function withStackScope<T>(scope: StackScope, fn: () => T | Promise<T>): T | Promise<T> {
  // Copied: a caller mutating its object afterwards must not rename anything.
  // The generations map is taken as given (read-only, built per state read):
  // a per-resource scope must not pay a copy of it. An outer
  // `withNameGeneration` binding belongs to the outer stack (a parent's
  // replacement around a nested child's deploy): it does not reach in.
  return nameGenerationStore.exit(() =>
    stackScopeStore.run(
      {
        stackName: scope.stackName,
        stackInstanceId: scope.stackInstanceId,
        nameGenerations: scope.nameGenerations,
      },
      fn
    )
  );
}

/** A generation {@link withNameGeneration} binds for ONE logical id. */
interface NameGenerationOverride {
  logicalId: string;
  generation: number;
}

const nameGenerationStore = new AsyncLocalStorage<NameGenerationOverride>();

/** Is `value` a usable name generation (a non-negative safe integer)? */
export function isNameGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Run `fn` with `logicalId`'s generated name derived at `generation` instead
 * of the scope's (go-to-k/cdkd#5064 phase 2): the next generation around a
 * replacement's create, its name check and its holder proof, and the old
 * record's generation around a rollback's re-create of it. Every other
 * logical id keeps the scope's generation; an inner binding replaces an outer
 * one.
 */
export function withNameGeneration<T>(
  binding: { logicalId: string; generation: number },
  fn: () => Promise<T>
): Promise<T>;
export function withNameGeneration<T>(
  binding: { logicalId: string; generation: number },
  fn: () => T
): T;
export function withNameGeneration<T>(
  binding: { logicalId: string; generation: number },
  fn: () => T | Promise<T>
): T | Promise<T> {
  if (!isNameGeneration(binding.generation)) {
    throw new Error(
      `cdkd internal error: name generation ${String(binding.generation)} for ${binding.logicalId} is not a non-negative integer`
    );
  }
  return nameGenerationStore.run(
    { logicalId: binding.logicalId, generation: binding.generation },
    fn
  );
}

/**
 * The generation `logicalId`'s generated name is derived at in the current
 * async context: a {@link withNameGeneration} binding for it, else the scope's
 * map, else 0. `undefined` when the scope carries a stack instance id but no
 * map -- a derivation there would guess.
 */
export function currentNameGeneration(logicalId: string): number | undefined {
  const bound = nameGenerationStore.getStore();
  if (bound !== undefined && bound.logicalId === logicalId) return bound.generation;
  const scope = stackScopeStore.getStore();
  if (scope?.nameGenerations === undefined) {
    return scope?.stackInstanceId === undefined ? 0 : undefined;
  }
  return scope.nameGenerations.get(logicalId) ?? 0;
}

/**
 * Read the current async context's stack name, if any.
 *
 * Returns `undefined` outside any {@link withStackScope}. Also used by the
 * live renderer to scope per-stack in-flight task entries so concurrent
 * deploys don't clobber each other's tasks.
 */
export function getCurrentStackName(): string | undefined {
  return stackScopeStore.getStore()?.stackName;
}

/**
 * The current scope's stack instance id: `undefined` outside a scope, for a
 * legacy stack, and where the call site opened a declared-names-only scope.
 * Never log it: the names derived from it must not be predictable from a log.
 */
/**
 * Whether the current scope derives names before the stack's state record was
 * read ({@link withStackScopeBeforeStateRead}), where a generated name throws.
 */
export function isBeforeStateRead(): boolean {
  return stackScopeStore.getStore()?.beforeStateRead === true;
}

export function getCurrentStackInstanceId(): string | undefined {
  return stackScopeStore.getStore()?.stackInstanceId;
}

/**
 * Per-async-context "skip the stack-name prefix on user-supplied physical
 * names" flag. Read by `generateResourceName` when its caller passes
 * `userSupplied: true`; auto-generated-name paths
 * (`generateResourceName(logicalId, ...)`) ignore this flag.
 *
 * Scoped via AsyncLocalStorage so that `--stack-concurrency > 1` runs
 * cannot cross-contaminate — each deploy's body is wrapped in its own
 * `withSkipPrefix(...)` scope (the deploy CLI plumbs the value
 * `resolveSkipPrefix` resolved through here, the deploy engine records it on
 * each rollback-journal segment, and `cdkd rollback` replays each segment
 * under the recorded value — issue #4018). Outside any scope it reads
 * `false`, i.e. prefix.
 */
const skipPrefixStore = new AsyncLocalStorage<boolean>();

/**
 * Run `fn` with the "skip prefix on user-supplied names" flag set to
 * `skip`. Mirrors {@link withStackScope} — concurrent invocations each
 * get an independent scope so parallel deploys do not fight over a
 * single shared variable.
 *
 * Wrap this around `withStackScope(...)` (innermost is `fn`) in the
 * deploy CLI: `withSkipPrefix(flag, () => withStackScope(scope, body))`.
 * Order does not matter — the two stores are independent — but
 * consistent ordering keeps the call sites readable.
 */
export function withSkipPrefix<T>(skip: boolean, fn: () => Promise<T>): Promise<T>;
export function withSkipPrefix<T>(skip: boolean, fn: () => T): T;
export function withSkipPrefix<T>(skip: boolean, fn: () => T | Promise<T>): T | Promise<T> {
  return skipPrefixStore.run(skip, fn);
}

/**
 * Read the current async context's skip-prefix flag. Defaults to
 * `false` when no `withSkipPrefix` scope is active.
 *
 * Public for unit tests; `generateResourceName` consumes this
 * internally.
 */
export function getCurrentSkipPrefix(): boolean {
  return skipPrefixStore.getStore() ?? false;
}
