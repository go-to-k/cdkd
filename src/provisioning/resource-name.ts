import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

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
const stackScopeStore = new AsyncLocalStorage<StackScope & { beforeStateRead?: true }>();

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

/**
 * Resource types whose pre-PR #297 code path ran user-supplied
 * physical names through `generateResourceName` (= got the stack-name
 * prefix). These are the only types affected by
 * `--no-prefix-user-supplied-names`; flipping the flag against an
 * existing stack proposes REPLACEMENT on every state resource of
 * one of these types whose `physicalId` is still prefixed.
 *
 * Pattern A providers (Lambda, S3, SNS, SQS, DynamoDB, Logs LogGroup,
 * Events Rule, etc.) historically short-circuited user-supplied names
 * **out** of `generateResourceName` entirely — those types never got
 * the prefix regardless of the flag, so they are NOT included here.
 *
 * Used by the deploy-time pre-flight migration check in
 * `src/cli/commands/prefix-migration-check.ts`. Keep in sync with the
 * Pattern B provider call sites that consume
 * `generateResourceNameWithFallback(...)`.
 */
export const PATTERN_B_RESOURCE_TYPES: readonly string[] = [
  'AWS::IAM::Role',
  'AWS::IAM::User',
  'AWS::IAM::Group',
  'AWS::IAM::InstanceProfile',
  'AWS::IAM::ManagedPolicy',
  'AWS::ElasticLoadBalancingV2::LoadBalancer',
  'AWS::ElasticLoadBalancingV2::TargetGroup',
] as const;

/**
 * For each Pattern B resource type, the CFn template `Properties` field
 * the user sets to supply a physical name (`new iam.Role(this, 'X',
 * { roleName: 'my-role' })` → `Properties.RoleName: 'my-role'`).
 *
 * Used by the prefix-migration check to distinguish user-supplied
 * physical names (which the v0.94.0 default flip would actually
 * REPLACE on next deploy) from auto-generated logical-id-fallback
 * names (which keep the prefix in BOTH old and new default — no
 * REPLACE pending). Without this discriminator, the migration
 * check naively flags every prefix-style physicalId regardless of
 * its origin, surfacing a false-positive WARNING on auto-generated
 * names that won't actually be touched.
 *
 * Keep in sync with `PATTERN_B_RESOURCE_TYPES` and with each
 * provider's `Properties[<NameField>]` lookup in
 * `src/provisioning/providers/`.
 */
export const PATTERN_B_NAME_PROPERTIES: Readonly<Record<string, string>> = {
  'AWS::IAM::Role': 'RoleName',
  'AWS::IAM::User': 'UserName',
  'AWS::IAM::Group': 'GroupName',
  'AWS::IAM::InstanceProfile': 'InstanceProfileName',
  'AWS::IAM::ManagedPolicy': 'ManagedPolicyName',
  'AWS::ElasticLoadBalancingV2::LoadBalancer': 'Name',
  'AWS::ElasticLoadBalancingV2::TargetGroup': 'Name',
};

/**
 * For each Pattern B resource type, the `generateResourceName` options each
 * provider passes at its name call site (maxLength + any lowercase /
 * allowedPattern). Keep in sync with the provider call sites
 * (`generateResourceNameWithFallback(...)` in
 * `src/provisioning/providers/`).
 *
 * Used by the prefix-migration check to recompute BOTH the legacy
 * (prefixed) and the post-v0.94 (unprefixed) physical name for a recorded
 * user-supplied name through the SAME sanitize / truncate pipeline the
 * provider used — so a name that needed sanitization (`my_role` ->
 * `my-role`) or hash-suffix truncation (> maxLength) is compared exactly,
 * not via a naive prefix concat / strip.
 */
export const PATTERN_B_NAME_OPTIONS: Readonly<Record<string, ResourceNameOptions>> = {
  'AWS::IAM::Role': { maxLength: 64 },
  'AWS::IAM::User': { maxLength: 64 },
  'AWS::IAM::Group': { maxLength: 128 },
  'AWS::IAM::InstanceProfile': { maxLength: 128 },
  'AWS::IAM::ManagedPolicy': { maxLength: 128 },
  'AWS::ElasticLoadBalancingV2::LoadBalancer': { maxLength: 32 },
  'AWS::ElasticLoadBalancingV2::TargetGroup': { maxLength: 32 },
};

/**
 * Is `live` the name a Pattern B provider creates for the declared name
 * `declared`, under EITHER user-supplied-name prefix setting? (issue #4081)
 *
 * `cdkd drift` compares a record's declared name against the name AWS holds,
 * and on a stack deployed with the legacy `--prefix-user-supplied-names` the
 * two differ by the stack-name prefix (`my-role` against `MyStack-my-role`)
 * with nothing drifted. Neither the prefix flag nor the stack a deploy ran
 * under is recorded, so both settings are tried, through the same
 * sanitize / truncate pipeline the provider ran. Call it inside the stack's
 * {@link withStackScope}: with no stack name in scope the prefixed arm
 * derives the bare name, and only a sanitize rewrite (`my_role` -> `my-role`)
 * is recognized.
 *
 * Exact comparison, own-key lookup: a type outside the Pattern B tables, a
 * non-string or empty value, or a name neither setting reproduces answers
 * `false`, so the difference stays reported.
 */
export function derivesPatternBName(
  resourceType: string,
  declared: unknown,
  live: unknown
): boolean {
  if (!Object.prototype.hasOwnProperty.call(PATTERN_B_NAME_OPTIONS, resourceType)) return false;
  if (typeof declared !== 'string' || declared === '') return false;
  if (typeof live !== 'string' || live === '') return false;
  const options = PATTERN_B_NAME_OPTIONS[resourceType]!;
  return [true, false].some(
    (skip) =>
      withSkipPrefix(skip, () =>
        generateResourceName(declared, { ...options, userSupplied: true })
      ) === live
  );
}

/**
 * Options for generating a resource name.
 */
export interface ResourceNameOptions {
  /** Maximum length for the name (e.g., 32 for ALB/TG, 64 for IAM, 63 for S3) */
  maxLength: number;
  /** Whether to force lowercase (e.g., S3 buckets) */
  lowercase?: boolean;
  /** Allowed character regex pattern. Characters not matching will be removed.
   *  Default: /[^a-zA-Z0-9-]/ (alphanumeric + hyphen) */
  allowedPattern?: RegExp;
  /**
   * `true` when the caller is passing a name the user explicitly
   * declared in their CDK code (e.g. `new iam.Role(this, 'X', {
   *   roleName: 'my-role' })`). `false` (default) when the caller is
   * passing the logical-id fallback or any other cdkd-generated value.
   *
   * Combined with the per-deploy `withSkipPrefix(true)` flag, a
   * `userSupplied: true` call skips the stack-name prefix and returns
   * the user's declared name verbatim (after the same sanitize /
   * truncate pipeline). When `userSupplied` is `false` OR
   * `withSkipPrefix` is unset / `false`, the stack-name prefix is
   * applied (pre-PR behavior).
   *
   * This split is load-bearing: cdkd's stack-scoping concern (prefix
   * for cross-stack uniqueness on auto-generated names) must stay
   * coupled to the auto-generated path, NOT to user-declared names —
   * those belong to the user.
   */
  userSupplied?: boolean;
}

/** Hex characters of a stack-instance name suffix. */
export const STACK_INSTANCE_SUFFIX_LENGTH = 12;

/**
 * The most generations {@link looksLikeCdkdGeneratedName} hashes through: a
 * bound on a state-chosen number, far past any replacement count a stack sees.
 */
const MAX_RECOGNIZED_GENERATION = 1024;

/**
 * The per-stack-instance suffix of the generated name for `name` (go-to-k/cdkd#5064):
 * the first 12 hex of sha256 over the id and the name, NUL-separated (a v4
 * UUID holds no NUL, so no two inputs share a digest input). A pure function,
 * so every re-derivation within one stack lifetime reproduces it, and one-way,
 * so a name does not disclose the id.
 *
 * `generation` (phase 2): 0 hashes exactly the phase-1 input; a later one
 * appends a NUL and its decimal digits, so each replacement of a resource asks
 * for a name no earlier generation held. A logical id holds no NUL, so no
 * (name, generation) pair shares a digest input with another.
 */
export function stackInstanceNameSuffix(
  stackInstanceId: string,
  name: string,
  generation = 0
): string {
  const hash = createHash('sha256').update(stackInstanceId).update('\u0000').update(name);
  if (generation !== 0) hash.update('\u0000').update(String(generation));
  return hash.digest('hex').substring(0, STACK_INSTANCE_SUFFIX_LENGTH);
}

/**
 * Generate a unique resource name from the logical ID.
 *
 * - Auto-generated (`userSupplied: false`) in a scope carrying a stack
 *   instance id: `{StackName}-{LogicalId}-{suffix}`, CloudFormation-style, the
 *   `{StackName}-{LogicalId}` part cut to `maxLength - 13` (go-to-k/cdkd#5064).
 * - Otherwise (a legacy stack, no scope, or a declared name) exactly the
 *   pre-v13 output: `{StackName}-{name}` (or the bare name), cut with an
 *   8-hex hash only when it is longer than `maxLength`.
 *
 * @param name The raw name (from properties or logicalId fallback)
 * @param options Length and character constraints
 * @returns A sanitized, truncated name that fits the constraints
 */
export function generateResourceName(name: string, options: ResourceNameOptions): string {
  const scope = stackScopeStore.getStore();
  if (scope?.beforeStateRead === true && options.userSupplied !== true) {
    throw new Error(
      `cdkd internal error: a generated name for ${name} was derived before the state record ` +
        `of ${scope.stackName} was read, so it cannot carry the stack's instance id`
    );
  }
  // go-to-k/cdkd#5064 phase 2: only a GENERATED name on a stack with an id
  // reads the generation, so a declared name or a legacy stack never asks.
  let generation = 0;
  if (scope?.stackInstanceId !== undefined && options.userSupplied !== true) {
    const known = currentNameGeneration(name);
    if (known === undefined) {
      throw new Error(
        `cdkd internal error: a generated name for ${name} was derived in a scope of ` +
          `${scope.stackName} that carries no name generations, so it could name the resource ` +
          `after an earlier generation`
      );
    }
    generation = known;
  }
  return deriveResourceName(name, options, scope?.stackName, scope?.stackInstanceId, generation);
}

/** {@link generateResourceName} for an explicit scope. */
function deriveResourceName(
  name: string,
  options: ResourceNameOptions,
  currentStackName: string | undefined,
  stackInstanceId: string | undefined,
  generation = 0
): string {
  const {
    maxLength,
    lowercase = false,
    allowedPattern = /[^a-zA-Z0-9-]/g,
    userSupplied = false,
  } = options;

  // Include stack name for uniqueness (like CloudFormation does).
  //
  // The prefix is suppressed when the caller marked the name as
  // user-supplied AND the per-deploy `withSkipPrefix(true)` flag is
  // active — the user owns that name and cdkd should not rewrite it.
  // Every other path (logical-id fallback, no withSkipPrefix scope,
  // flag set to false) keeps the prefix for cross-stack uniqueness.
  const shouldPrefix = currentStackName && !(userSupplied && getCurrentSkipPrefix());
  const fullName = shouldPrefix ? `${currentStackName}-${name}` : name;

  // Apply lowercase BEFORE pattern matching (so A-Z aren't removed by /[^a-z0-9.-]/)
  let sanitized = lowercase ? fullName.toLowerCase() : fullName;
  sanitized = sanitized.replace(allowedPattern, '-');

  // Collapse consecutive hyphens and remove leading/trailing
  sanitized = sanitized.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');

  // go-to-k/cdkd#5064: only a name cdkd generates for a stack with an id gets
  // the suffix. A declared name (prefixed or not) is the user's, and a legacy
  // stack keeps its names byte for byte.
  if (shouldPrefix && !userSupplied && stackInstanceId !== undefined) {
    const suffix = stackInstanceNameSuffix(stackInstanceId, name, generation);
    const base = sanitized.substring(0, maxLength - suffix.length - 1).replace(/-+$/, '');
    return base === '' ? suffix : `${base}-${suffix}`;
  }

  if (sanitized.length <= maxLength) {
    return sanitized;
  }

  // Truncate with hash suffix for uniqueness
  const hash = createHash('sha256').update(fullName).digest('hex').substring(0, 8);
  const maxPrefixLength = maxLength - hash.length - 1; // -1 for separator
  const prefix = sanitized.substring(0, maxPrefixLength).replace(/-+$/, '');

  return `${prefix}-${hash}`;
}

/**
 * Best-effort: was this physical name GENERATED by cdkd from the logical id,
 * rather than declared in the user's template? (issue #1636)
 *
 * The replacement-collision refusals in `deploy-engine/update-*.ts` /
 * `deploy-engine/replacement.ts` used to assert "the resource has a
 * user-supplied physical name" for EVERY colliding resource, and then prescribe "rename the resource in your CDK code". For a
 * resource the template never named that is false in both halves: the name is
 * cdkd's own `{stackName}-{logicalId}` — which has no random component, so the
 * create-first attempt lands on the name the old resource still holds exactly
 * as it would for a user-named one — and "rename" would mean renaming the
 * CONSTRUCT (changing the logical id), a far more disruptive action than the
 * message implies. A user who reads "user-supplied physical name" and finds
 * none in their template cannot connect the message to their code at all.
 *
 * The test is the naming scheme run backwards: {@link generateResourceName}
 * with `userSupplied: false` always builds from `{stackName}-{logicalId}`,
 * while a template-supplied name builds from `{stackName}-{userName}` (or the
 * bare user name under `--no-prefix-user-supplied-names`). So the two differ
 * unless the declared name happens to EQUAL the logical id.
 *
 * **Deliberately approximate, and biased toward the safe answer.** The
 * per-type `maxLength` / `lowercase` / `allowedPattern` options live in the
 * providers, and the engine does not know which type maps to which — so this
 * compares case-insensitively on the alphanumeric skeleton and accepts the
 * truncated `…-<8 hex>` form by prefix. Every unresolved case answers `false`:
 * a `false` merely keeps the pre-#1636 wording, which is correct for the
 * template-named resource that is the likelier reading of an unrecognized
 * name, whereas a wrong `true` would tell a user who DID name their resource
 * to go looking for a name they never wrote.
 *
 * @param physicalId the name AWS currently holds for the existing resource
 * @param logicalId the template logical id of the resource being replaced
 * A stack with an instance id (go-to-k/cdkd#5064) also generates
 * `{prefix}-{suffix}`, and that form is accepted only with the EXACT suffix
 * `stackInstanceId` derives for `logicalId` — never a bare `-<12 hex>` shape,
 * which a user's own name can end with.
 *
 * @param stackName the deploying stack's name (absent = unresolvable, `false`)
 * @param stackInstanceId the stack's instance id (absent: a legacy stack, or
 *   unknown, so only the pre-v13 forms are recognized)
 * @param generations the name generations the suffix may carry
 *   (go-to-k/cdkd#5064 phase 2): every one from 0 through `through`. Absent:
 *   0 through one past the generation the current scope derives for
 *   `logicalId` -- a replaced resource's old and new names both count.
 */
export function looksLikeCdkdGeneratedName(
  physicalId: string,
  logicalId: string,
  stackName: string | undefined,
  stackInstanceId: string | undefined,
  generations?: { through: number }
): boolean {
  if (!physicalId || !logicalId || !stackName) return false;
  // The skeleton drops every separator the per-type `allowedPattern` could
  // have rewritten (a hyphen, an underscore, a dot) so an S3-style
  // lowercase-and-dot name still matches its own derivation.
  const skeleton = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const derived = skeleton(`${stackName}-${logicalId}`);
  const actual = skeleton(physicalId);
  if (actual === derived) return true;
  if (stackInstanceId !== undefined) {
    const suffixed = /^(.*)-([0-9a-f]{12})$/.exec(physicalId.toLowerCase());
    if (suffixed !== null) {
      const base = skeleton(suffixed[1]!);
      const through = Math.min(
        generations?.through ?? (currentNameGeneration(logicalId) ?? 0) + 1,
        MAX_RECOGNIZED_GENERATION
      );
      for (let g = 0; g <= through; g++) {
        if (suffixed[2] !== stackInstanceNameSuffix(stackInstanceId, logicalId, g)) continue;
        if (base.length > 0 && derived.startsWith(base)) return true;
      }
    }
  }
  // Truncated form: `{prefix}-{8 hex}` where prefix is a cut of the same
  // derivation. Require BOTH halves — a bare prefix match would accept a
  // template-supplied name that merely starts the same way.
  const truncated = /^(.*)-([0-9a-f]{8})$/.exec(physicalId.toLowerCase());
  if (!truncated) return false;
  const prefix = skeleton(truncated[1]!);
  return prefix.length > 0 && derived.startsWith(prefix);
}

/**
 * Generate a resource name from a user-declared physical name OR
 * fall back to the logical id.
 *
 * Wraps {@link generateResourceName} to express the Pattern B call-site
 * shape (`generateResourceName((properties['Name'] as string | undefined)
 * || logicalId, opts)`) as a single typed helper. The user-supplied
 * branch passes `userSupplied: true`, which makes the per-deploy
 * `withSkipPrefix(true)` flag drop the stack-name prefix on that name.
 * The fallback (logical-id) branch is `userSupplied: false` and keeps
 * the prefix regardless of the flag — auto-generated names rely on
 * the prefix for cross-stack uniqueness.
 *
 * Use at every Pattern B provider call site (currently IAM Role, IAM
 * User, IAM Group, IAM InstanceProfile, IAM ManagedPolicy, ELBv2
 * LoadBalancer, ELBv2 TargetGroup) so the `--prefix-user-supplied-names`
 * flag controls those types consistently. Pattern A providers (Lambda, S3, SNS,
 * SQS, DynamoDB, etc.) do NOT need this helper — they already
 * short-circuit the user-supplied name out of the
 * `generateResourceName` call entirely, so the prefix is never
 * applied to user-supplied names regardless of the flag.
 */
export function generateResourceNameWithFallback(
  userSuppliedName: string | undefined,
  logicalId: string,
  options: Omit<ResourceNameOptions, 'userSupplied'>
): string {
  if (userSuppliedName !== undefined && userSuppliedName !== '') {
    return generateResourceName(userSuppliedName, { ...options, userSupplied: true });
  }
  return generateResourceName(logicalId, { ...options, userSupplied: false });
}

/** A name {@link generateResourceNameWithFallback} treats as declared. */
function isDeclaredName(value: unknown): boolean {
  return value !== undefined && value !== '';
}

/**
 * Is `recorded` a name cdkd generates for `logicalId` in the current scope's
 * stack under EITHER naming scheme (go-to-k/cdkd#5064): the legacy
 * `{stackName}-{logicalId}`, or the suffixed one under ANY stack instance id
 * -- this lifetime's, or an earlier lifetime's that `cdkd import` brought in
 * (the suffix's exact base, then 12 hex)?
 *
 * Only for {@link recordedGeneratedNameKept}, whose answer KEEPS a name: the
 * shape arm is acceptable there, and nowhere a `true` would claim a name.
 */
function isGeneratedNameOfEitherScheme(
  recorded: string,
  logicalId: string,
  options: Omit<ResourceNameOptions, 'userSupplied'>
): boolean {
  const scope = stackScopeStore.getStore();
  if (!scope?.stackName || recorded === '') return false;
  const opts: ResourceNameOptions = { ...options, userSupplied: false };
  if (recorded === deriveResourceName(logicalId, opts, scope.stackName, undefined)) return true;
  // Any well-formed id yields the same base: only the suffix differs.
  const probe = deriveResourceName(
    logicalId,
    opts,
    scope.stackName,
    '00000000-0000-4000-8000-000000000000'
  );
  const base = probe.slice(0, probe.length - STACK_INSTANCE_SUFFIX_LENGTH);
  return recorded.startsWith(base) && /^[0-9a-f]{12}$/.test(recorded.slice(base.length));
}

/**
 * Should an `update()` that re-derives a resource's name KEEP the recorded
 * one rather than replace the resource (go-to-k/cdkd#5064)?
 *
 * The IAM providers derive the name inside `update()` and replace the
 * resource when it differs from the recorded physical id. For a resource no
 * template ever named (neither the desired nor the previous bag declares a
 * name), that difference can only come from the naming SCHEME: a v13 stack
 * holding a resource named under another scheme or lifetime (`cdkd import` of
 * a legacy name, or of what an earlier lifetime kept), or a scope that lacks
 * the stack's id. Neither is a rename anyone
 * asked for -- CloudFormation never renames an un-named resource -- and
 * replacing would create a new resource and delete the live one. So the
 * recorded name is kept whenever it is this logical id's generated name under
 * either scheme. A name that was declared (now or before) is never kept here:
 * a declared rename still replaces.
 */
export function recordedGeneratedNameKept(input: {
  recorded: string;
  derived: string;
  declaredName: unknown;
  previousDeclaredName: unknown;
  logicalId: string;
  options: Omit<ResourceNameOptions, 'userSupplied'>;
}): boolean {
  if (input.derived === input.recorded) return false;
  if (isDeclaredName(input.declaredName) || isDeclaredName(input.previousDeclaredName)) {
    return false;
  }
  return isGeneratedNameOfEitherScheme(input.recorded, input.logicalId, input.options);
}

/**
 * How cdkd names one type's resource when the template does not.
 *
 * The ONE generator per type (go-to-k/cdkd#5095): the SDK provider calls
 * {@link generatedNameFor} and a Cloud Control create fills the same name
 * through {@link applyDefaultNameForFallback}, so a resource gets the same
 * name on either route. The only differences are `legacy`'s, each kept so
 * that no stack without an instance id changes a name it already generates.
 */
interface GeneratedNameRule {
  nameProperty: string;
  options: ResourceNameOptions;
  /** Put before the generated name: a log group's `/cdkd/`, an SSM parameter's `/`. */
  prefix?: string;
  /**
   * A directory bucket: the name ends with the required `--<zone id>--x-s3`,
   * and `options.maxLength` bounds the whole name.
   */
  zoneSuffix?: true;
  /**
   * A prefix the service refuses a name to start with (a security group's
   * `sg-`): a generated name starting with it, case-insensitively, drops the
   * prefix's last character (`sg-app-...` becomes `sgapp-...`).
   */
  refusedPrefix?: string;
  /**
   * `nameProperty` is a key of this object property, not of the resource's
   * top level (a Glue connection's `ConnectionInput.Name`).
   */
  nestedIn?: string;
  /**
   * A stack WITHOUT an instance id (a legacy stack) keeps what each route
   * generated before go-to-k/cdkd#5095. A stack with one always uses the rule.
   */
  legacy?: {
    /**
     * The SDK provider sent the bare logical id (`AWS::CodeBuild::Project`,
     * the security group, trail, Glue and Firehose types).
     */
    sdk?: 'logicalId';
    /**
     * The Cloud Control create filled nothing (`'none'`: the handler named the
     * resource), or a name under these options.
     */
    cloudControl?: 'none' | ResourceNameOptions;
  };
  /**
   * The entry does not admit its type to orphan adoption
   * ({@link explicitNamePropertyFor}): a type added for its generated name
   * alone, never checked against `ADOPTION_REFUSED_TYPES`' three tests.
   */
  notAdopted?: true;
}

/**
 * The generated-name rule of every type cdkd names (see
 * {@link GeneratedNameRule}).
 *
 * A Cloud Control create fills the name from here, for a type with an SDK
 * provider (its provider names the resource with the same rule) and for one
 * without: `AWS::Lambda::CapacityProvider`'s Cloud Control create handler fails
 * without a name its schema leaves optional (issue #3174). The name is filled
 * on a create only; the update path takes it back out
 * (`withoutGeneratedFallbackName`).
 *
 * `AWS::Events::EventBus` has no entry: its CloudFormation schema requires
 * `Name`, so neither route generates one (the SDK provider refuses a missing
 * name, and Cloud Control refuses it as CloudFormation does).
 */
const FALLBACK_NAME_RULES: Record<string, GeneratedNameRule> = {
  // The SDK provider's pattern keeps `.`. A logical id or stack name never
  // holds one, so the Cloud Control fill names nothing differently.
  'AWS::S3::Bucket': {
    nameProperty: 'BucketName',
    options: { maxLength: 63, lowercase: true, allowedPattern: /[^a-z0-9.-]/g },
  },
  'AWS::SQS::Queue': { nameProperty: 'QueueName', options: { maxLength: 80 } },
  'AWS::SNS::Topic': { nameProperty: 'TopicName', options: { maxLength: 256 } },
  'AWS::Lambda::Function': { nameProperty: 'FunctionName', options: { maxLength: 64 } },
  'AWS::Lambda::LayerVersion': { nameProperty: 'LayerName', options: { maxLength: 64 } },
  // No SDK provider — Cloud Control only. The schema does not require the
  // name, yet a create without one fails with `Resource Handler Internal
  // Failure` (issue #3174). The schema's maxLength 140 is the ARN form's; the
  // service refuses a NAME over 64 (measured, go-to-k/cdkd#5064). The default
  // `allowedPattern` emits a subset of `[a-zA-Z0-9-_]+`.
  'AWS::Lambda::CapacityProvider': {
    nameProperty: 'CapacityProviderName',
    options: { maxLength: 64 },
  },

  'AWS::IAM::Role': { nameProperty: 'RoleName', options: { maxLength: 64 } },
  'AWS::IAM::Policy': { nameProperty: 'PolicyName', options: { maxLength: 64 } },
  'AWS::IAM::ManagedPolicy': {
    nameProperty: 'ManagedPolicyName',
    options: { maxLength: 128 },
  },
  'AWS::IAM::User': { nameProperty: 'UserName', options: { maxLength: 64 } },
  'AWS::IAM::Group': { nameProperty: 'GroupName', options: { maxLength: 128 } },
  'AWS::IAM::InstanceProfile': {
    nameProperty: 'InstanceProfileName',
    options: { maxLength: 128 },
  },
  'AWS::DynamoDB::Table': { nameProperty: 'TableName', options: { maxLength: 255 } },
  'AWS::ECR::Repository': {
    nameProperty: 'RepositoryName',
    options: { maxLength: 256, lowercase: true },
  },
  'AWS::ECS::Cluster': { nameProperty: 'ClusterName', options: { maxLength: 255 } },
  'AWS::ECS::Service': { nameProperty: 'ServiceName', options: { maxLength: 255 } },
  // `/cdkd/` + 506 = 512. A legacy stack's Cloud Control fill had no prefix.
  'AWS::Logs::LogGroup': {
    nameProperty: 'LogGroupName',
    options: { maxLength: 506, allowedPattern: /[^a-zA-Z0-9-/_]/g },
    prefix: '/cdkd/',
    legacy: { cloudControl: { maxLength: 512 } },
  },
  // PutMetricAlarm: 1-255 characters.
  'AWS::CloudWatch::Alarm': { nameProperty: 'AlarmName', options: { maxLength: 255 } },
  'AWS::Events::Rule': { nameProperty: 'Name', options: { maxLength: 64 } },
  'AWS::Kinesis::Stream': { nameProperty: 'Name', options: { maxLength: 128 } },
  'AWS::StepFunctions::StateMachine': {
    nameProperty: 'StateMachineName',
    options: { maxLength: 80 },
  },
  'AWS::SecretsManager::Secret': {
    nameProperty: 'Name',
    options: { maxLength: 512, allowedPattern: /[^a-zA-Z0-9-/_]/g },
  },
  // A legacy stack's Cloud Control fill had no leading `/` (a valid name too).
  'AWS::SSM::Parameter': {
    nameProperty: 'Name',
    options: { maxLength: 1023, allowedPattern: /[^a-zA-Z0-9-/_]/g },
    prefix: '/',
    legacy: { cloudControl: { maxLength: 2048 } },
  },
  'AWS::Cognito::UserPool': { nameProperty: 'UserPoolName', options: { maxLength: 128 } },
  'AWS::ElastiCache::SubnetGroup': {
    nameProperty: 'CacheSubnetGroupName',
    options: { maxLength: 255, lowercase: true },
  },
  'AWS::ElastiCache::CacheCluster': {
    nameProperty: 'ClusterName',
    options: { maxLength: 40, lowercase: true },
  },
  'AWS::RDS::DBSubnetGroup': {
    nameProperty: 'DBSubnetGroupName',
    options: { maxLength: 255, lowercase: true },
  },
  'AWS::RDS::DBCluster': {
    nameProperty: 'DBClusterIdentifier',
    options: { maxLength: 63, lowercase: true },
  },
  'AWS::RDS::DBInstance': {
    nameProperty: 'DBInstanceIdentifier',
    options: { maxLength: 63, lowercase: true },
  },
  // DocumentDB — RDS-shaped API; same name constraints.
  'AWS::DocDB::DBSubnetGroup': {
    nameProperty: 'DBSubnetGroupName',
    options: { maxLength: 255, lowercase: true },
  },
  'AWS::DocDB::DBCluster': {
    nameProperty: 'DBClusterIdentifier',
    options: { maxLength: 63, lowercase: true },
  },
  'AWS::DocDB::DBInstance': {
    nameProperty: 'DBInstanceIdentifier',
    options: { maxLength: 63, lowercase: true },
  },
  // Neptune — RDS-shaped API; same name constraints.
  'AWS::Neptune::DBSubnetGroup': {
    nameProperty: 'DBSubnetGroupName',
    options: { maxLength: 255, lowercase: true },
  },
  'AWS::Neptune::DBCluster': {
    nameProperty: 'DBClusterIdentifier',
    options: { maxLength: 63, lowercase: true },
  },
  'AWS::Neptune::DBInstance': {
    nameProperty: 'DBInstanceIdentifier',
    options: { maxLength: 63, lowercase: true },
  },
  'AWS::ElasticLoadBalancingV2::LoadBalancer': {
    nameProperty: 'Name',
    options: { maxLength: 32 },
  },
  'AWS::ElasticLoadBalancingV2::TargetGroup': {
    nameProperty: 'Name',
    options: { maxLength: 32 },
  },
  'AWS::WAFv2::WebACL': { nameProperty: 'Name', options: { maxLength: 128 } },
  // CreateProject: 2-150 characters. A legacy stack's SDK provider named the
  // project after the bare logical id; Cloud Control has no handlers for it.
  'AWS::CodeBuild::Project': {
    nameProperty: 'Name',
    options: { maxLength: 150 },
    legacy: { sdk: 'logicalId' },
  },
  // The whole name, zone suffix included, is at most 63 characters. The Cloud
  // Control create reads the zone id from `LocationName`; without one it is
  // refused rather than sent a name AWS rejects.
  'AWS::S3Express::DirectoryBucket': {
    nameProperty: 'BucketName',
    options: { maxLength: 63, lowercase: true },
    zoneSuffix: true,
  },
  // go-to-k/cdkd#5095: the SDK provider generated these names and Cloud
  // Control had no rule. The schema REQUIRES the name of these three, so their
  // Cloud Control create failed on every stack.
  'AWS::CodeCommit::Repository': { nameProperty: 'RepositoryName', options: { maxLength: 100 } },
  'AWS::RDS::DBProxy': { nameProperty: 'DBProxyName', options: { maxLength: 64 } },
  'AWS::RDS::DBProxyEndpoint': {
    nameProperty: 'DBProxyEndpointName',
    options: { maxLength: 64 },
  },
  // go-to-k/cdkd#5309: the SDK provider refused a missing name, which the
  // schema leaves optional (CloudFormation generates one). 3-63 characters of
  // lowercase letters, digits and `-`: the generator emits that, a stack name
  // starts with a letter, and the suffix is hex. A legacy stack's Cloud
  // Control create still leaves the name to the handler.
  'AWS::S3Vectors::VectorBucket': {
    nameProperty: 'VectorBucketName',
    options: { maxLength: 63, lowercase: true },
    legacy: { cloudControl: 'none' },
    notAdopted: true,
  },
  // go-to-k/cdkd#5348: the same, for a Cloud Map service. CreateService takes
  // DNS labels of `[a-zA-Z0-9_-]`, each at most 63 characters, starting and
  // ending with a letter, digit or `_`: the generator emits one label of
  // letters, digits and `-` that starts with a stack name and ends with the
  // hex suffix or the logical id. The schema sets no limit.
  'AWS::ServiceDiscovery::Service': {
    nameProperty: 'Name',
    options: { maxLength: 63 },
    legacy: { cloudControl: 'none' },
    notAdopted: true,
  },
  // ...and the handler named these, which a legacy stack keeps.
  'AWS::Scheduler::Schedule': {
    nameProperty: 'Name',
    options: { maxLength: 64 },
    legacy: { cloudControl: 'none' },
  },
  'AWS::AutoScaling::AutoScalingGroup': {
    nameProperty: 'AutoScalingGroupName',
    options: { maxLength: 255 },
    legacy: { cloudControl: 'none' },
  },
  'AWS::DynamoDB::GlobalTable': {
    nameProperty: 'TableName',
    options: { maxLength: 255 },
    legacy: { cloudControl: 'none' },
  },
  'AWS::ECS::TaskDefinition': {
    nameProperty: 'Family',
    options: { maxLength: 255 },
    legacy: { cloudControl: 'none' },
    notAdopted: true,
  },
  'AWS::Lambda::NetworkConnector': {
    nameProperty: 'Name',
    options: { maxLength: 64 },
    legacy: { cloudControl: 'none' },
    notAdopted: true,
  },
  'AWS::Pipes::Pipe': {
    nameProperty: 'Name',
    options: { maxLength: 64 },
    legacy: { cloudControl: 'none' },
    notAdopted: true,
  },
  // go-to-k/cdkd#5095: the SDK provider sent the bare logical id, unique per
  // VPC / account and region only, so two stacks with one logical id, or a
  // replacement, collided. A legacy stack keeps it; its Cloud Control create
  // still leaves the name to the handler. None was ever admitted to adoption.
  // CreateSecurityGroup: up to 255 characters, not starting with `sg-`.
  'AWS::EC2::SecurityGroup': {
    nameProperty: 'GroupName',
    options: { maxLength: 255 },
    refusedPrefix: 'sg-',
    legacy: { sdk: 'logicalId', cloudControl: 'none' },
    notAdopted: true,
  },
  // 3-128 characters, letters, digits, `.`, `_`, `-`, starting and ending with
  // a letter or digit: the generator emits `[a-zA-Z0-9-]`, a stack name starts
  // with a letter, and the suffix is hex.
  'AWS::CloudTrail::Trail': {
    nameProperty: 'TrailName',
    options: { maxLength: 128 },
    legacy: { sdk: 'logicalId', cloudControl: 'none' },
    notAdopted: true,
  },
  // Glue names: 1-255 characters (CreateJob / CreateCrawler / CreateTrigger /
  // CreateConnection `Name`).
  'AWS::Glue::Job': {
    nameProperty: 'Name',
    options: { maxLength: 255 },
    legacy: { sdk: 'logicalId', cloudControl: 'none' },
    notAdopted: true,
  },
  'AWS::Glue::Crawler': {
    nameProperty: 'Name',
    options: { maxLength: 255 },
    legacy: { sdk: 'logicalId', cloudControl: 'none' },
    notAdopted: true,
  },
  'AWS::Glue::Connection': {
    nameProperty: 'Name',
    nestedIn: 'ConnectionInput',
    options: { maxLength: 255 },
    legacy: { sdk: 'logicalId', cloudControl: 'none' },
    notAdopted: true,
  },
  'AWS::Glue::Trigger': {
    nameProperty: 'Name',
    options: { maxLength: 255 },
    legacy: { sdk: 'logicalId', cloudControl: 'none' },
    notAdopted: true,
  },
  // 1-64 characters of `[a-zA-Z0-9._-]`.
  'AWS::KinesisFirehose::DeliveryStream': {
    nameProperty: 'DeliveryStreamName',
    options: { maxLength: 64 },
    legacy: { sdk: 'logicalId', cloudControl: 'none' },
    notAdopted: true,
  },
};

/** Input a generated name needs beyond the logical id. */
export interface GeneratedNameInput {
  /** A directory bucket's zone id (`use1-az5`), which its name ends with. */
  zoneId?: string;
}

/** The current scope is a stack with an instance id (not a legacy stack). */
function scopeHasStackInstanceId(): boolean {
  return stackScopeStore.getStore()?.stackInstanceId !== undefined;
}

/** `rule`'s name for `logicalId`, or `undefined` when a zone suffix has no zone id. */
function deriveRuleName(
  rule: GeneratedNameRule,
  logicalId: string,
  input: GeneratedNameInput
): string | undefined {
  if (rule.zoneSuffix === true) {
    if (input.zoneId === undefined || input.zoneId === '') return undefined;
    const suffix = `--${input.zoneId}--x-s3`;
    const base = generateResourceName(logicalId, {
      ...rule.options,
      maxLength: rule.options.maxLength - suffix.length,
    });
    return `${base}${suffix}`;
  }
  const name = `${rule.prefix ?? ''}${generateResourceName(logicalId, rule.options)}`;
  const refused = rule.refusedPrefix;
  if (refused !== undefined && name.toLowerCase().startsWith(refused.toLowerCase())) {
    return `${name.slice(0, refused.length - 1)}${name.slice(refused.length)}`;
  }
  return name;
}

/**
 * The name an SDK provider generates for an un-named `resourceType` resource
 * (go-to-k/cdkd#5095): the same name {@link applyDefaultNameForFallback} fills
 * for a Cloud Control create, except where `legacy` keeps a legacy stack's
 * SDK name. Throws for a type with no rule, or a directory bucket without
 * `input.zoneId`: both are cdkd bugs.
 */
export function generatedNameFor(
  resourceType: string,
  logicalId: string,
  input: GeneratedNameInput = {}
): string {
  const rule = FALLBACK_NAME_RULES[resourceType];
  if (rule === undefined) {
    throw new Error(`cdkd internal error: ${resourceType} has no generated-name rule`);
  }
  // Not before the state read: `generateResourceName` refuses that scope.
  if (
    rule.legacy?.sdk === 'logicalId' &&
    !scopeHasStackInstanceId() &&
    stackScopeStore.getStore()?.beforeStateRead !== true
  ) {
    return logicalId;
  }
  const name = deriveRuleName(rule, logicalId, input);
  if (name === undefined) {
    throw new Error(`cdkd internal error: the generated ${resourceType} name needs a zone id`);
  }
  return name;
}

/**
 * The object holding `rule`'s name property in `properties`: `properties`
 * itself, or for a `nestedIn` rule that property's object, `undefined` when it
 * is not one.
 */
function nameContainer(
  rule: GeneratedNameRule,
  properties: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (rule.nestedIn === undefined) return properties;
  const nested = properties[rule.nestedIn];
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : undefined;
}

/**
 * The zone id a directory bucket's `LocationName` names (`use1-az5`, or a
 * Local Zone's `usw2-lax1-az1`; a trailing `--x-s3` is accepted, as the SDK
 * provider accepts it), or `undefined` for anything else, such as an
 * Availability Zone NAME, which only an EC2 call could turn into an id.
 */
function directoryBucketZoneId(properties: Record<string, unknown>): string | undefined {
  const location = properties['LocationName'];
  if (typeof location !== 'string') return undefined;
  const zone = location.replace(/--x-s3$/, '');
  return /^[a-z0-9]+(?:-[a-z0-9]+)*-az[0-9]+$/.test(zone) ? zone : undefined;
}

/**
 * Apply default name generation for CC API fallback.
 *
 * When a resource doesn't have an explicit name property set, fills the name
 * its SDK provider generates ({@link generatedNameFor}, go-to-k/cdkd#5095),
 * so the resource is named the same on either route. A legacy stack keeps
 * the Cloud Control name `legacy.cloudControl` records, which may be none.
 *
 * A directory bucket whose `LocationName` is not a zone id has no name to
 * fill: `underivable: 'refuse'` (a create) throws, naming the fix, rather than
 * send a name AWS rejects; `'omit'` (a caller that only reads the name, or an
 * update, which takes it back out) returns `properties` unchanged.
 *
 * @param logicalId Logical ID from the template
 * @param resourceType CloudFormation resource type
 * @param properties Resource properties (will not be mutated)
 * @returns Properties with default name applied if needed, or original properties if no rule exists
 */
export function applyDefaultNameForFallback(
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  underivable: 'refuse' | 'omit' = 'refuse'
): Record<string, unknown> {
  const rule = FALLBACK_NAME_RULES[resourceType];
  if (!rule) return properties;

  // A nested name needs its container: without one (a Glue connection's
  // required `ConnectionInput`) there is nothing to fill, and Cloud Control
  // reports the missing property.
  const container = nameContainer(rule, properties);
  if (container === undefined) return properties;

  // If the name property is already set, no need to generate
  if (container[rule.nameProperty]) return properties;

  let generatedName: string | undefined;
  const legacy = scopeHasStackInstanceId() ? undefined : rule.legacy?.cloudControl;
  if (legacy === 'none') return properties;
  if (legacy !== undefined) {
    generatedName = generateResourceName(logicalId, legacy);
  } else {
    const zoneId = rule.zoneSuffix === true ? directoryBucketZoneId(properties) : undefined;
    generatedName = deriveRuleName(rule, logicalId, zoneId === undefined ? {} : { zoneId });
  }
  if (generatedName === undefined) {
    if (underivable === 'omit') return properties;
    const location =
      properties['LocationName'] === undefined
        ? 'the resource declares no LocationName'
        : 'its LocationName is not a zone id such as use1-az5';
    throw new Error(
      `${logicalId} (${resourceType}): cdkd cannot generate a ${rule.nameProperty} for the ` +
        `Cloud Control create. A directory bucket's name must end with --<zone id>--x-s3, and ` +
        `${location}. Set LocationName to the zone id, or declare ${rule.nameProperty}.`
    );
  }

  if (rule.nestedIn !== undefined) {
    return {
      ...properties,
      [rule.nestedIn]: { ...container, [rule.nameProperty]: generatedName },
    };
  }
  return {
    ...properties,
    [rule.nameProperty]: generatedName,
  };
}

/**
 * The name property {@link applyDefaultNameForFallback} fills for
 * `resourceType`, or `undefined` when it fills none.
 *
 * Read by its two siblings in this file, never by a caller outside it:
 * {@link withoutGeneratedFallbackName}, which the deploy engine calls from its
 * Cloud Control UPDATE path, and {@link explicitNamePropertyFor}, which layers
 * the adoption-only table on top. The UPDATE path must NOT send the generated
 * name (issue #3174). The name only matters to a CREATE: an
 * update is a JSON Patch against the recorded bag, which holds the template's
 * resolved properties and so never carries a generated name. Injecting one
 * there makes every update patch `add` the name — harmless while the live name
 * equals the generated one. For a resource imported under any other name it is
 * a real change: refused where the name is create-only (as it is for
 * `AWS::Lambda::CapacityProvider`), and a RENAME where the type accepts the
 * update (`AWS::Cognito::UserPool`'s `UserPoolName`, for one).
 */
/** Every type {@link applyDefaultNameForFallback} names (for the test that holds each to its limit). */
export function fallbackNameRuleTypes(): string[] {
  return Object.keys(FALLBACK_NAME_RULES);
}

export function fallbackNamePropertyFor(resourceType: string): string | undefined {
  const rule = FALLBACK_NAME_RULES[resourceType];
  // A nested name is no top-level property: a caller reading one finds none.
  return rule?.nestedIn === undefined ? rule?.nameProperty : undefined;
}

/**
 * Where {@link applyDefaultNameForFallback} puts `resourceType`'s name: the
 * top-level property, or `[container, property]` for a nested one
 * (`['ConnectionInput', 'Name']`), or `undefined` when it fills none.
 */
export function fallbackNamePathFor(resourceType: string): readonly string[] | undefined {
  const rule = FALLBACK_NAME_RULES[resourceType];
  if (rule === undefined) return undefined;
  return rule.nestedIn === undefined ? [rule.nameProperty] : [rule.nestedIn, rule.nameProperty];
}

/**
 * `prepared` with the name {@link applyDefaultNameForFallback} GENERATED into
 * it taken back out — the bag the deploy engine hands a Cloud Control UPDATE
 * (issue #3174; why an update must not carry it is on
 * {@link fallbackNamePropertyFor}).
 *
 * The name counts as generated exactly when the fill would have produced it:
 * the type has a rule, `resolvedProps` leaves the property falsy (the fill's
 * own test, so an empty string is generated over too), and `prepared` carries
 * it. The property then goes back to what `resolvedProps` holds: deleted when
 * the template has no such key, the template's own falsy value when it does,
 * so the update's desired side agrees with the template on this key.
 * Otherwise `prepared` is returned by identity. Neither input is mutated.
 */
export function withoutGeneratedFallbackName(
  resourceType: string,
  resolvedProps: Record<string, unknown>,
  prepared: Record<string, unknown>
): Record<string, unknown> {
  const rule = FALLBACK_NAME_RULES[resourceType];
  if (rule?.nestedIn !== undefined) {
    // The same test one level down, restoring the container's own key.
    const outer = rule.nestedIn;
    const resolvedInner = nameContainer(rule, resolvedProps);
    const preparedInner = nameContainer(rule, prepared);
    if (resolvedInner === undefined || preparedInner === undefined) return prepared;
    const inner = withoutGeneratedFallbackNameAt(rule.nameProperty, resolvedInner, preparedInner);
    return inner === preparedInner ? prepared : { ...prepared, [outer]: inner };
  }
  const nameProperty = fallbackNamePropertyFor(resourceType);
  if (nameProperty === undefined) return prepared;
  return withoutGeneratedFallbackNameAt(nameProperty, resolvedProps, prepared);
}

/** {@link withoutGeneratedFallbackName} for one object and its name key. */
function withoutGeneratedFallbackNameAt(
  nameProperty: string,
  resolvedProps: Record<string, unknown>,
  prepared: Record<string, unknown>
): Record<string, unknown> {
  if (resolvedProps[nameProperty] || !(nameProperty in prepared)) {
    return prepared;
  }
  const restored = { ...prepared };
  if (nameProperty in resolvedProps) {
    restored[nameProperty] = resolvedProps[nameProperty];
  } else {
    delete restored[nameProperty];
  }
  return restored;
}

/**
 * The template property that supplies an explicit physical name for
 * `resourceType`, or `undefined` when cdkd knows of none (issue #2934).
 *
 * Read by the orphan-adoption pre-pass, where it decides TWO things. It
 * answers whether THIS template hands the resource a name or lets cdkd generate
 * one — and, because an unknown type answers `undefined`, it is also the
 * pre-pass's ALLOW-LIST: a type absent from both tables is NOT adopted at all.
 *
 * That second role inverts what an earlier version of this doc described. It
 * said an unknown type reads as "cdkd names this" and adoption proceeds, whose
 * failure mode is a REPLACEMENT that destroys a resource `DeletionPolicy:
 * Retain` preserved — three review rounds each found one more type reaching it.
 * Now an absent type costs a missed adoption (go-to-k/cdkd#2916's diagnosis
 * still prints) rather than a deletion, so the tables may be incomplete in the
 * safe direction only.
 *
 * **An entry here ADMITS a type to adoption**, as does a generated-name rule
 * not marked `notAdopted`. Before adding one, check the
 * three tests in `ADOPTION_REFUSED_TYPES` (`src/deployment/orphan-adoption.ts`)
 * — create mints a new resource instead of colliding, `update()` refuses, the
 * resulting replacement destroys the retained copy. A type meeting all three
 * belongs in THAT set even if it is named here; `AWS::Lambda::LayerVersion` is
 * exactly that shape and `AWS::ECS::TaskDefinition` is kept there as a belt
 * against a future `Family` entry.
 */
export function explicitNamePropertyFor(resourceType: string): string | undefined {
  const rule = FALLBACK_NAME_RULES[resourceType];
  if (rule !== undefined && rule.notAdopted !== true) return rule.nameProperty;
  return ADOPTION_ONLY_NAME_PROPERTIES[resourceType];
}

/**
 * Name properties known to the ADOPTION guard but not to
 * {@link FALLBACK_NAME_RULES} (issue #2934): a name cdkd never generates.
 *
 * A separate table on purpose: `FALLBACK_NAME_RULES` decides what cdkd GENERATES
 * for a Cloud Control create, so adding an entry there changes the name every
 * later create of that type uses; an existing resource keeps its name, because
 * the Cloud Control update path does not send a generated one (issue #3174),
 * and an SDK provider's update never had one to send. This table
 * answers a strictly narrower question, "does the template hand this resource
 * a name", and generates nothing. An entry here still ADMITS its type to
 * adoption exactly as one there does, so it needs the same three-test check.
 *
 * What a missing or wrong entry costs, in either table. An ABSENT type is refused outright — the
 * empty-`nameProperties` arm in `orphan-adoption.ts` runs BEFORE
 * `templateStillDeclares` — costing a missed adoption, with
 * go-to-k/cdkd#2916's diagnosis still printing. A WRONG entry is the live
 * hazard: a non-empty list clears the empty-list arm, `templateStillDeclares` then
 * looks for a property the template does not use, so an explicit name reads as
 * "no explicit name", the record is adopted, and the diff turns the create-only
 * name into a REPLACE that deletes the resource being rescued. Supplying a name
 * is the natural user move after that diagnosis, so this is a reachable path,
 * not a theoretical one.
 *
 * `AWS::Budgets::Budget` is deliberately absent rather than forgotten: its name
 * is NESTED (`Budget.BudgetName`, create-only), which neither this flat table
 * nor `templateStillDeclares`' top-level property read can express, so adoption
 * of that type is unguarded today — go-to-k/cdkd#2943 carries it.
 *
 * `AWS::ECS::TaskDefinition` was added here and REMOVED again, which is worth
 * recording: its physical id is the revision ARN rather than a
 * `generateResourceName` output, so the by-construction premise this whole
 * guard rests on is false for it and an entry here could never match. It is
 * refused by the adoption pre-pass instead — and the ALLOW-LIST gate is what
 * refuses it: its generated-name rule is `notAdopted`, so it never reaches
 * adoption at all.
 * `ADOPTION_REFUSED_TYPES` in `src/deployment/orphan-adoption.ts` carries it as
 * a BELT against a future entry here (named rather than `{@link}`-ed: this
 * module does not import it, so the link would render as dead text).
 *
 * `AWS::Events::EventBus` lives here since it lost its generated-name rule
 * (go-to-k/cdkd#5095: its `Name` is required, so nothing generates it); its
 * admission to adoption is unchanged.
 */
const ADOPTION_ONLY_NAME_PROPERTIES: Record<string, string> = {
  'AWS::Events::EventBus': 'Name',
};
