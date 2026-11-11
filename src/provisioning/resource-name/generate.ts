import { createHash } from 'node:crypto';
import {
  currentNameGeneration,
  getCurrentSkipPrefix,
  stackScopeStore,
  withSkipPrefix,
} from './stack-scope.js';

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
 * `withStackScope`: with no stack name in scope the prefixed arm
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
  // go-to-k/cdkd#6100: a FIFO queue / topic's generated name ends with the
  // `.fifo` suffix its rule appends after the hash (`fallback-rules.ts`), which
  // the end-anchored forms below would otherwise never match.
  const name = physicalId.replace(/\.fifo$/i, '');
  // The skeleton drops every separator the per-type `allowedPattern` could
  // have rewritten (a hyphen, an underscore, a dot) so an S3-style
  // lowercase-and-dot name still matches its own derivation.
  const skeleton = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const derived = skeleton(`${stackName}-${logicalId}`);
  const actual = skeleton(name);
  if (actual === derived) return true;
  if (stackInstanceId !== undefined) {
    const suffixed = /^(.*)-([0-9a-f]{12})$/.exec(name.toLowerCase());
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
  const truncated = /^(.*)-([0-9a-f]{8})$/.exec(name.toLowerCase());
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
