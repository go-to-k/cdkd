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
 * - **TOP-LEVEL `properties['X'] ?? 'default'` reads** (EC2 `InstanceType` /
 *   `Domain`, API Gateway `AuthorizationType`, IAM access-key `Status`, Lambda
 *   event-invoke `Qualifier`, RDS DB-proxy `TargetGroupName`, GlobalTable
 *   `BillingMode` on create and on the desired side of update). The container
 *   is the provider's own property bag, so rule 2 cannot fire; only rules 3/4
 *   would apply, and refusing a present-but-non-string value there is a
 *   stricter-value decision with its own regression surface (an unquoted YAML
 *   `IpProtocol: -1` is a NUMBER today and deploys fine). Tracked as issue #1513.
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
 * @throws Error when the container is present but not a plain object, or the
 *   key is present but not a non-blank string.
 */
export function readConfigString(
  container: unknown,
  key: string,
  fallback: string,
  containerPath: string
): string {
  if (container === undefined || container === null) return fallback;

  if (!isPlainObject(container)) {
    throw new Error(
      `${containerPath} must be an object (got ${describe(container)}) — check for ` +
        `an unresolved intrinsic or a mis-nested template value`
    );
  }

  return requireConfigString(container[key], fallback, `${containerPath}.${key}`);
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
 * @throws Error when the value is present but not a non-blank string.
 */
export function requireConfigString(value: unknown, fallback: string, path: string): string {
  if (value === undefined) return fallback;

  // A BLANK string is only suspicious because it silently takes the default.
  // When the default is itself blank there is no divergence to hide, and an
  // empty value is a legitimate, meaningful template input at exactly those
  // sites — `LoggingConfiguration.LogFilePrefix: ''` means "no prefix" and
  // `GenerateSecretString.ExcludeCharacters: ''` means "exclude nothing".
  // Refusing them would turn this guard into a regression for correct
  // templates, which is the opposite of its purpose.
  if (fallback === '' && typeof value === 'string') return value;

  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `${path} must be a non-empty string (got ${describe(value)}) — check for an ` +
        `unresolved intrinsic or a mis-nested template value. Omit the field ` +
        `entirely to use the default` +
        (fallback === '' ? '' : ` (${fallback})`)
    );
  }

  return value;
}

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
 * @throws Error when the value is not an array.
 */
export function requireConfigArray(value: unknown, path: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw new Error(
      `${path} must be an array (got ${describe(value)}) — check for an ` +
        `unresolved intrinsic or a mis-nested template value`
    );
  }
  return value as Array<Record<string, unknown>>;
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
