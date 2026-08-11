/**
 * Shape guards for nested CloudFormation config blocks read by SDK providers.
 *
 * The bug class this exists for (issue #1471): a provider reads a string out
 * of a nested block with
 *
 * ```ts
 * const status = (versioningConfig['Status'] as string) || 'Suspended';
 * ```
 *
 * When `versioningConfig` is a STRING / array / number rather than the object
 * the template was supposed to carry, the index yields `undefined` and the
 * `||` substitutes the default — which is frequently the OPPOSITE of what the
 * template declared. `VersioningConfiguration: 'Enabled'` (a hand-written L1
 * template, or an intrinsic the resolver could not resolve) therefore turned
 * versioning OFF on a live bucket with no error anywhere. The same shape was
 * measured at 16 sites across 5 providers.
 *
 * `readConfigString` is that read, done safely, in ONE place — so the class is
 * fixed by construction rather than by 16 hand-written `throw`s that can each
 * be subtly different.
 *
 * Four rules, each of which the versioning case forced (see #1471):
 *
 * 1. **An absent container is not an error.** `undefined` / `null` means the
 *    template omitted the block, and the caller's default is the right answer.
 * 2. **A present-but-non-object container is refused.** This is the headline
 *    bug: a string container silently produced the default.
 * 3. **An absent KEY is not an error** — `{}` legitimately means "defaulted",
 *    e.g. `VersioningConfiguration: {}` really does mean Suspended.
 * 4. **A present-but-unusable key is refused.** `{ Status: null }` and
 *    `{ Status: '' }` both pass a `typeof container === 'object'` check and
 *    still fall through to the default, so validating the CONTAINER alone is
 *    not enough — the FIELD has to be validated too.
 *
 * **Callers must pass the DESIRED side only.** The previous side comes from
 * cdkd state, not from the user's template: a stack deployed by an older cdkd
 * that already recorded a malformed value would otherwise throw on every
 * subsequent `cdkd deploy`, with no way out except hand-editing the S3 state
 * file (editing the template does not help, because the previous side stays
 * malformed until a deploy succeeds). An earlier attempt at this fix guarded
 * both sides and turned a silent misbehavior into an unrecoverable one; that
 * is why `KinesisProvider`'s read of `previousProperties.StreamModeDetails`
 * is deliberately left unguarded.
 *
 * **The `??` spelling has the same failure mode (issue #1493), and it defaults
 * on MORE than `||` did.** The #1471 sweep measured the `||` form;
 * `(cfg['K'] as string) ?? 'default'` substitutes on the same `undefined` a
 * malformed container indexes to, and ALSO on an explicit `null` — so a
 * `{ Comment: null }` that used to default now refuses, per rule 4.
 *
 * Measuring it is the part worth copying, because the obvious grep is wrong.
 * `\] \?\? '` finds NONE of the real sites (the cast sits inside the parens) and
 * the cast-word form `as [A-Za-z]+\) \?\? '` misses every `as string | undefined`
 * / quoted-union / line-wrapped site — including four this change rolls. The
 * class-covering pattern is `as [A-Za-z<>,| ]+\) \?\? '` (20 sites in
 * `providers/` on the pre-fix tree), plus a hand pass for the wrapped ones.
 *
 * ROLLED here: the 9 sites that INDEX A NESTED CONTAINER — CodeBuild
 * `Source` / `SecondarySources[]` / `Artifacts` / `SecondaryArtifacts[]` and
 * `Environment.{Type,ComputeType}`, DynamoDB GlobalTable
 * `StreamSpecification`, Route 53 `HostedZoneConfig` (create + update),
 * CloudFront OAI config (create + update), ECS `DeploymentController` — plus
 * the two `AWS::Lambda::Url` `AuthType` sites the #1471 sweep's
 * cast-specific grep missed (`as FunctionUrlAuthType`, not `as string`),
 * where the default is a PUBLIC function URL.
 *
 * Deliberately NOT rolled, so the decision is challengeable rather than
 * invisible:
 *
 * - **Nested reads whose value is an identity key or a label, never sent to
 *   AWS**: EC2's `rule['IpProtocol'] ?? '-1'` (composes a physical id and is
 *   read from BOTH the previous and next rule), `agentcore-evaluator`'s
 *   `(tag as Record<string, unknown>)['Value'] ?? ''`, and S3's three
 *   `rule['Id'] ?? '<unnamed>'` warning labels. These ARE nested containers —
 *   rule 2 could fire — but a refusal would buy nothing.
 * - **`EC2Provider`'s two `VpcId ?? ''` reads** — they populate the returned
 *   ATTRIBUTE cache only, and `CreateSecurityGroup` already forwards the same
 *   value, so AWS rejects a malformed one first. On the create site a guard
 *   would additionally throw AFTER a successful create and orphan the security
 *   group.
 * - **Reads off the PREVIOUS / state side** (GlobalTable `previousProperties`
 *   `BillingMode`, RDS DB-proxy `delete()` / `readCurrentState`) — the
 *   desired-side-only rule above.
 *
 * **The TOP-LEVEL `properties['X'] ?? 'default'` reads followed in issue
 * #1513**, per site rather than as a sweep: the container there is the
 * provider's own property bag, so rule 2 cannot fire and only rules 3/4 apply —
 * and those turn a present-but-non-string value into a hard refusal, which is a
 * stricter-value decision with its own regression surface. Three axes came out
 * of it, each an option or an omission rather than a blanket:
 *
 * - **Coerce where the value is legitimately numeric-looking.** An unquoted
 *   YAML `IpProtocol: -1` / `Qualifier: 1` is a NUMBER today and deploys fine,
 *   so those sites pass `coerceNumber` (CFn coerces scalars; cdkd does not).
 *   The enum-valued sites — EC2 `InstanceType` / `Domain`, API Gateway
 *   `AuthorizationType`, IAM access-key `Status`, RDS DB-proxy
 *   `TargetGroupName` — do not: a number there is a template bug.
 * - **Throw on CREATE, warn on any STATE-REPLAY path** (`onUnusable`). A rollback
 *   replays via `provider.update(..., previousState.properties, ...)`, so an
 *   update-path refusal can strand a historical state record with no
 *   template-side remedy. "Create is always template-borne" is FALSE and was
 *   corrected in review: the reverse-replacement arm also calls
 *   `provider.create(..., previousState.properties, REPLAYING_STATE_CREATE_CONTEXT)`,
 *   so a create guard downgrades too — see {@link replayWarn}. A create reached
 *   as the re-create half of a delete-then-create UPDATE
 *   (`EC2Provider.updateSecurityGroupIngress`) is the third such path, and the
 *   worst: the revoke has already committed, so a refusal leaves the rule
 *   deleted from AWS.
 * - **Left unguarded: `EC2Provider.buildIpPermission`'s `IpProtocol` read.**
 *   Textually a top-level read, but the helper is also reached from
 *   `deleteSecurityGroupIngress` and from the REVOKE half of the inline-rule
 *   update diff, both carrying STATE-borne rules — a refusal there would break
 *   destroy and rollback. The create path is guarded at its own call site
 *   instead, which refuses before the helper is ever reached.
 *
 * GlobalTable `BillingMode` was the one site #1513 left open, its file being
 * owned by a parallel lane at the time; it is now guarded on the same three
 * axes — enum-valued so no `coerceNumber`, `replayWarn` on the create path,
 * an unconditional warn on the update path, and the `previousProperties`
 * sibling still unguarded.
 *
 * This is a provider-layer guard rather than a pre-flight template check
 * because **rule 4** is only decidable AFTER intrinsic resolution: at pre-flight
 * time a legitimate `Fn::If`-valued block is an object whose `Status` key does
 * not exist yet, so a pre-flight field check would reject valid templates.
 * (Rule 3 is permissive and so cannot false-positive at any layer — it simply
 * could never be STRENGTHENED at pre-flight, since an absent key there is
 * indistinguishable from one an intrinsic will supply. Rule 2 alone genuinely
 * IS pre-flight-able; splitting one guard across two layers for it was judged
 * not worth the divergence.)
 *
 * The trade-off that choice accepts, recorded rather than left implicit: the
 * issue's pre-flight proposal would have failed BEFORE any AWS mutation,
 * whereas a provider-layer guard can throw after `CreateBucket` has already
 * succeeded. `create()` self-heals by deleting the partially-created bucket,
 * but a downstream refusal can still leave earlier sub-config PUTs applied —
 * the same exposure the pre-existing `applyOwnershipControls` throw has, and
 * still strictly better than a silent wrong-direction PUT.
 */

/**
 * Read an optional string field out of a nested CFn config block, refusing a
 * container or a value whose shape would otherwise be silently defaulted away.
 *
 * @param container The block the field lives in. Pass the provider's own
 *   `properties` bag directly when the field is top-level.
 * @param key The CFn field name.
 * @param fallback The value to use when the container or the key is absent.
 * @param containerPath CFn path of the CONTAINER, used to build both error
 *   messages, e.g. `AWS::S3::Bucket VersioningConfiguration` (the field is
 *   reported as `<containerPath>.<key>`).
 * @param options Per-site relaxations — see {@link ConfigStringOptions}. They
 *   apply to BOTH refusals this helper can raise: a malformed CONTAINER under
 *   `onUnusable` warns and behaves as `{}` (field absent, so the fallback is
 *   returned — the same thing an empty block already means), and the FIELD
 *   half threads the options into {@link requireConfigString} unchanged. The
 *   downgrade exists for the same state-replay reason as
 *   {@link replayWarn}: a nested block recorded malformed by an older binary
 *   (`StreamSpecification: ''`) would otherwise make a reverse-replacement
 *   create un-rollbackable (issue #1544).
 * @throws Error when the container is present but not a plain object, or the
 *   key is present but not a non-blank string, unless `onUnusable` is
 *   supplied.
 */
export function readConfigString(
  container: unknown,
  key: string,
  fallback: string,
  containerPath: string,
  options?: ConfigStringOptions
): string {
  if (container === undefined || container === null) return fallback;

  if (!isPlainObject(container)) {
    const detail = malformedShapeDetail(container);

    if (options?.onUnusable) {
      const named = fallback === '' ? '' : ` (${fallback})`;
      options.onUnusable(
        `${containerPath} must be an object ${detail}. Treating the block as empty, ` +
          `so ${containerPath}.${key} takes its default${named} here; the same ` +
          `value is REFUSED on a template-path create`
      );
      return fallback;
    }

    throw new Error(`${containerPath} must be an object ${detail}`);
  }

  return requireConfigString(container[key], fallback, `${containerPath}.${key}`, options);
}

/**
 * Per-call-site relaxations for {@link requireConfigString}, both introduced by
 * the TOP-LEVEL sweep (issue #1513). Each is opt-in per site because the whole
 * point of that issue is that these are PER-SITE decisions, not a blanket rule.
 */
export interface ConfigStringOptions {
  /**
   * Accept a finite NUMBER and stringify it, instead of refusing it.
   *
   * CloudFormation coerces scalars and cdkd does not, so an unquoted YAML
   * `IpProtocol: -1` or `Qualifier: 1` arrives here as a number and deploys
   * fine today. Refusing it would break a template that works — so the sites
   * whose value is legitimately numeric-looking coerce, and only those. A
   * number where an enum belongs (`InstanceType`, `AuthorizationType`,
   * `Status`, `Domain`) stays a refusal.
   */
  coerceNumber?: boolean;

  /**
   * Warn through this callback and return the fallback, instead of throwing.
   *
   * For UPDATE-path call sites ONLY. `rollback-executor.ts` replays a rollback
   * by calling `provider.update(..., previousState.properties, ...)`, so the
   * "desired" bag an `update()` sees can be a HISTORICAL cdkd state record
   * written by an older binary — one that may already carry the malformed value
   * this guard refuses. A hard refusal there would make such a resource not
   * merely un-updatable but UN-ROLLBACKABLE, with no template-side remedy
   * (editing the template does not change the state record). Warning keeps the
   * divergence loud without stranding the user, while the CREATE path — where
   * the value is always template-borne — stays strict.
   */
  onUnusable?: (message: string) => void;
}

/**
 * The value-level half of {@link readConfigString}, for a value the caller has
 * ALREADY read out of a container it knows is a plain object — in practice a
 * TOP-LEVEL property read straight off the provider's `properties` bag, where
 * only rules 3 and 4 can apply.
 *
 * Keep this form at top-level call sites rather than passing `properties` to
 * {@link readConfigString}: the `handled-property-wiring` critic
 * (`scripts/gen-handled-property-wiring.ts`) recognises a property as WIRED
 * from the `properties['X']` element-read at the call site, and deliberately
 * does not treat a whole-bag forward into a helper as evidence. Hiding the
 * read inside the helper made `S3DirectoryBucketProvider` and
 * `WAFv2WebACLProvider` report un-wired — a false handled claim, which is the
 * exact thing that critic exists to prevent.
 *
 * @param value The already-read field value.
 * @param fallback The value to use when the field is absent.
 * @param path CFn path used in the error message, e.g. `AWS::WAFv2::WebACL Scope`.
 * @param options Per-site relaxations — see {@link ConfigStringOptions}.
 * @throws Error when the value is present but not a non-blank string (and not a
 *   finite number under `coerceNumber`), unless `onUnusable` is supplied.
 */
export function requireConfigString(
  value: unknown,
  fallback: string,
  path: string,
  options?: ConfigStringOptions
): string {
  // ONE predicate, shared with the SKIP-unit probe {@link configStringRefusal}
  // exports (issue #1595) — a second hand-written test would disagree with this
  // one on exactly the interesting values.
  const refusal = configValueRefusal(value, fallback, path, options);

  if (refusal === undefined) {
    // The accepted shapes, in the order the predicate cleared them: an ABSENT
    // field takes the default; a finite NUMBER stringifies (`coerceNumber`
    // sites only — CloudFormation coerces scalars and cdkd does not, so an
    // unquoted YAML `IpProtocol: -1` deploys fine); anything else is already
    // the string, INCLUDING the blank-value-with-blank-default case, where
    // `LoggingConfiguration.LogFilePrefix: ''` legitimately means "no prefix".
    if (value === undefined) return fallback;
    if (typeof value === 'number') return String(value);
    return value as string;
  }

  const named = fallback === '' ? '' : ` (${fallback})`;

  if (options?.onUnusable) {
    options.onUnusable(
      `${refusal}. Ignoring it and using the ` +
        `default${named} here; the same value is REFUSED on a template-path create`
    );
    return fallback;
  }

  throw new Error(`${refusal}. Omit the field entirely to use the default${named}`);
}

/**
 * The CREATE-path counterpart of {@link ConfigStringOptions.onUnusable}.
 *
 * `create()` is NOT always template-borne, which is the correction that made
 * this helper necessary: `rollback-executor.ts`'s reverse-replacement arm
 * revives the OLD resource by calling `provider.create(..., previousState.properties,
 * REPLAYING_STATE_CREATE_CONTEXT)`. A resource written by an older binary with a
 * value this guard now refuses would otherwise become un-rollbackable, with only
 * a hand-edit of `state.json` as a remedy — the same failure the update-path
 * warn exists to prevent, and what `.claude/rules/providers.md` requires a
 * create-side pre-flight refusal to downgrade for.
 *
 * Spread into the options bag so a site can combine it with `coerceNumber`:
 * `{ coerceNumber: true, ...replayWarn(this.logger, context) }`.
 *
 * @returns `{ onUnusable }` when the caller declared a state replay, else `{}`
 *   (an ordinary template-path create, where the refusal stands).
 */
export function replayWarn(
  logger: { warn: (message: string) => void },
  context?: { replayingState?: boolean }
): ConfigStringOptions {
  return context?.replayingState === true ? { onUnusable: (message) => logger.warn(message) } : {};
}

/**
 * The array-guard subset of {@link ConfigStringOptions}: only the state-replay
 * downgrade applies to a LIST block (`coerceNumber` is meaningless there), so
 * {@link requireConfigArray} takes this narrower bag while still accepting a
 * spread `replayWarn(...)` result structurally.
 */
export type ConfigArrayOptions = Pick<ConfigStringOptions, 'onUnusable'>;

/**
 * Refuse a present-but-non-ARRAY value where a CFn LIST block belongs.
 *
 * The list-shaped sibling of {@link readConfigString}, for the container one
 * level up from a per-item mapper. Without it a truthy non-array
 * (`SecondarySources: 'GITHUB'`) reaches `.map` and dies with a raw
 * `TypeError: … .map is not a function`, and a FALSY one (`''`) is silently
 * dropped by the truthiness gate that usually guards these — the same class
 * `readConfigString` exists for, one level up (issue #1493 review).
 *
 * Callers keep the ABSENT case themselves (`== null ? undefined : …`), because
 * an absent list block legitimately means "no entries" and the caller's own
 * `undefined` is what the SDK expects.
 *
 * @param options Per-site relaxation (issue #1579, same shape as the #1556
 *   downgrade on {@link readConfigString}): under `onUnusable` a non-array
 *   value warns and returns `undefined` instead of throwing, for the
 *   state-replay paths where the desired bag can be a historical cdkd state
 *   record with no template-side remedy. The caller decides what `undefined`
 *   means at its site — the S3 filter builders skip the whole configuration
 *   item rather than applying it with a widened scope.
 * @throws Error when the value is not an array, unless `onUnusable` is
 *   supplied.
 */
export function requireConfigArray(value: unknown, path: string): Array<Record<string, unknown>>;
export function requireConfigArray(
  value: unknown,
  path: string,
  options: ConfigArrayOptions
): Array<Record<string, unknown>> | undefined;
export function requireConfigArray(
  value: unknown,
  path: string,
  options?: ConfigArrayOptions
): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(value)) {
    const detail = malformedShapeDetail(value);

    if (options?.onUnusable) {
      options.onUnusable(
        `${path} must be an array ${detail}. Leaving this configuration ` +
          `unapplied here; the same value is REFUSED on a template-path create`
      );
      return undefined;
    }

    throw new Error(`${path} must be an array ${detail}`);
  }
  return value as Array<Record<string, unknown>>;
}

/**
 * The object-guard subset of {@link ConfigStringOptions}: only the state-replay
 * downgrade applies to a CONTAINER block (`coerceNumber` is meaningless there),
 * so {@link requireConfigObject} takes this narrower bag while still accepting a
 * spread `replayWarn(...)` result structurally.
 */
export type ConfigObjectOptions = Pick<ConfigStringOptions, 'onUnusable'>;

/**
 * Refuse a present-but-non-OBJECT value where a CFn config CONTAINER belongs.
 *
 * The container half of {@link readConfigString} without the field half, for
 * the case where the caller does not read a STRING out of the block and so
 * cannot reach rule 2 through `readConfigString` at all — a container whose
 * members are probed for PRESENCE (`filter?.['Prefix'] ?? rule['Prefix']`,
 * `storageClassAnalysis?.['DataExport'] != null`) rather than read as a value.
 * Every probe of a malformed container indexes to `undefined`, so the block
 * reads as EMPTY and the caller silently proceeds without it: a lifecycle rule
 * loses its whole location scope and applies BUCKET-WIDE, an analytics
 * configuration loses its data export. That is the silent-DROP sibling of the
 * defaulting class, one level up from {@link requireConfigArray}'s LIST block
 * (issue #1581).
 *
 * Callers keep the ABSENT case themselves (`value != null && …`), because an
 * absent container legitimately means "block omitted" and the caller's own
 * defaults are the right answer — the same division of labour
 * {@link requireConfigArray} uses.
 *
 * @param options Per-site relaxation, same shape and same reason as
 *   {@link requireConfigArray}'s: under `onUnusable` a non-object value warns
 *   and returns `undefined` instead of throwing, for the state-replay paths
 *   where the desired bag can be a historical cdkd state record with no
 *   template-side remedy. The caller decides what `undefined` means at its
 *   site — the S3 appliers skip the configuration item, or the whole lifecycle
 *   Put, rather than applying it with a widened scope.
 * @throws Error when the value is not a plain object, unless `onUnusable` is
 *   supplied.
 */
export function requireConfigObject(value: unknown, path: string): Record<string, unknown>;
export function requireConfigObject(
  value: unknown,
  path: string,
  options: ConfigObjectOptions
): Record<string, unknown> | undefined;
export function requireConfigObject(
  value: unknown,
  path: string,
  options?: ConfigObjectOptions
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    const detail = malformedShapeDetail(value);

    if (options?.onUnusable) {
      options.onUnusable(
        `${path} must be an object ${detail}. Leaving this configuration ` +
          `unapplied here; the same value is REFUSED on a template-path create`
      );
      return undefined;
    }

    throw new Error(`${path} must be an object ${detail}`);
  }
  return value;
}

/**
 * The refusal SENTENCE `readConfigString` / {@link requireConfigString} raise,
 * with no action clause attached — `undefined` when the read would succeed.
 *
 * This is the predicate {@link readConfigString} itself runs, exported so a
 * caller whose replay downgrade is a SKIP rather than the helper's
 * warn-and-DEFAULT can ask the question without taking the fallback (issue
 * #1595). Both halves are covered, in the same order and by the same tests:
 * the CONTAINER first, then the FIELD.
 *
 * Sharing the predicate is the point. A hand-written `typeof` twin would
 * disagree with the read it fronts on exactly the values that matter — a blank
 * string, an explicit `null`, a coerced number — which is the guard-mismatch
 * shape this module already exists to stop.
 *
 * @returns The refusal sentence (`<path> must be …`), or `undefined` when the
 *   value is usable — including the ABSENT container / ABSENT key cases, which
 *   legitimately take the fallback.
 */
export function configStringRefusal(
  container: unknown,
  key: string,
  fallback: string,
  containerPath: string,
  options?: ConfigStringOptions
): string | undefined {
  if (container === undefined || container === null) return undefined;
  if (!isPlainObject(container)) {
    return `${containerPath} must be an object ${malformedShapeDetail(container)}`;
  }
  return configValueRefusal(container[key], fallback, `${containerPath}.${key}`, options);
}

/** The FIELD half of {@link configStringRefusal}, shared with {@link requireConfigString}. */
function configValueRefusal(
  value: unknown,
  fallback: string,
  path: string,
  options?: ConfigStringOptions
): string | undefined {
  if (value === undefined) return undefined;
  // A BLANK string is only suspicious because it silently takes the default;
  // with a blank default there is no divergence to hide.
  if (fallback === '' && typeof value === 'string') return undefined;
  if (options?.coerceNumber === true && typeof value === 'number' && Number.isFinite(value)) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return (
      `${path} must be a non-empty string (got ${describe(value)}) — check for an ` +
      `unresolved intrinsic or a mis-nested template value`
    );
  }
  return undefined;
}

/**
 * The shared detail clause every refusal in this module ends with.
 *
 * One source rather than five: the sentence is identical at each guard, and a
 * copy that drifts changes the wording of a user-facing error for one shape
 * only, which is invisible in review.
 */
function malformedShapeDetail(value: unknown): string {
  return (
    `(got ${describe(value)}) — check for an unresolved intrinsic or a ` +
    `mis-nested template value`
  );
}

/**
 * A plain object, i.e. something a CFn config block can legitimately be.
 * Arrays are excluded on purpose: an array where an object belongs is one of
 * the malformed shapes this module exists to catch, and `typeof [] === 'object'`
 * would otherwise wave it through.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Human-readable type for an error message, without dumping user data. */
function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return value.trim() === '' ? 'a blank string' : 'a string';
  return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}
