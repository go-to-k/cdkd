import { canonicalizeRegion } from '../utils/aws-partition.js';

/**
 * ONE region-normalization point for the CLI's command handlers.
 *
 * Issue [#1795](https://github.com/go-to-k/cdkd/issues/1795) folded `--region`
 * at the boundary of the four `cdkd local *` commands, for a reason that was
 * never specific to them: AWS SDK endpoint resolution, SigV4's credential
 * scope, this repo's own `PARTITION_TABLE` prefix walk and every ARN segment
 * built from the value are ALL case-sensitive, so a raw spelling is wrong at
 * each of them. Issue
 * [#2065](https://github.com/go-to-k/cdkd/issues/2065) measured what that costs
 * the commands the fix skipped — `cdkd deploy --region US-EAST-1` dies at the
 * state-bucket preflight before it does anything:
 *
 * ```text
 * FAIL S3  ListObjectsV2  region=US-EAST-1  AuthorizationHeaderMalformed:
 *          the region 'US-EAST-1' is wrong; expecting 'us-east-1'
 * ```
 *
 * The fold lives here rather than at each consumer because a command reads
 * `options.region` in many places — `applyRoleArnIfSet`, the
 * `process.env.AWS_REGION` copy, several `new AwsClients({ region })` spreads —
 * and folding per consumer is the shape that has needed a follow-up every time
 * a new consumer was added. Double-folding is a no-op, which is what makes a
 * second fold further down (`derivePartitionAndUrlSuffix`, `AwsClients`) safe
 * rather than redundant.
 */

/**
 * Fold `--region` to its canonical spelling in place, at the handler's entry.
 *
 * Call this BEFORE the first consumer of `options.region` — in practice before
 * `applyRoleArnIfSet`, which is the first AWS-touching call in most handlers.
 *
 * A handler that ALSO needs the user's exact spelling must capture it first.
 * The one consumer with that need is the bootstrap-marker read, whose second
 * probe exists precisely to find a key an unfolded `cdkd bootstrap` wrote
 * (see `readBootstrapMarkerBody` in `src/assets/asset-storage.ts`); the
 * `--stack-region` fold in `local-invoke.ts` keeps a `rawStackRegion` for the
 * same class of reason.
 */
export function foldRegionOption(options: { region?: string | undefined }): void {
  if (options.region !== undefined) {
    options.region = canonicalizeRegion(options.region);
  }
  // The ENV spellings need the same fold, and folding only the flag would have
  // left the WORSE half of issue #2065 in place. A handler that builds
  // `new AwsClients({})` with no region - the shape every one of them takes
  // when `--region` is absent - hands region resolution to the AWS SDK's own
  // chain, which reads these two variables DIRECTLY. No amount of folding at
  // cdkd's read sites reaches that read. Measured on this repo's own build:
  //
  // ```text
  // $ AWS_REGION=US-EAST-1 node dist/cli.js state info --state-bucket cdkd-state-<acct>
  // StateError: ... S3 error during HeadBucket on '...' (HTTP 400)
  // ```
  //
  // Overwriting them is in-character rather than a new liberty: `deploy.ts` and
  // `destroy.ts` already assign `--region` into both, and `applyRoleArnIfSet`
  // exports credentials the same way. The value written differs from the one
  // read only in case, and only in the direction AWS itself demands.
  //
  // `AWS_DEFAULT_REGION` is folded for cdkd's OWN readers, not for the SDK's:
  // measured against this repo's vendored SDK, `@smithy/config-resolver`'s
  // `NODE_REGION_CONFIG_OPTIONS` reads `AWS_REGION` only, so
  // `AWS_DEFAULT_REGION=eu-west-9` alone resolves the PROFILE region rather
  // than `eu-west-9`. cdkd reads it in its own right at
  // `src/synthesis/synthesizer.ts` and `src/local/ecr-puller.ts`, and
  // `deploy.ts` / `destroy.ts` write it, which is what this fold is for. An
  // earlier revision of this comment claimed the SDK reads it; it does not.
  for (const key of ['AWS_REGION', 'AWS_DEFAULT_REGION'] as const) {
    const value = process.env[key];
    if (value) process.env[key] = canonicalizeRegion(value);
  }
}

/**
 * The region the user NAMED — `--region` first, then `AWS_REGION` — canonical,
 * or `undefined` when they named NEITHER.
 *
 * `undefined` is a distinct answer from any region string, and the distinction
 * is the whole point of this helper. Issue
 * [#2029](https://github.com/go-to-k/cdkd/issues/2029): materializing a
 * `|| 'us-east-1'` literal collapses "the user named no region" into "the user
 * named us-east-1", and the literal then wins over the profile region the AWS
 * SDK's own chain would have resolved from `~/.aws/config`. For `cdkd gc` that
 * meant evaluating — and deleting in — a region the user never mentioned, with
 * no error, because `us-east-1` is a perfectly valid region.
 *
 * So a caller that builds an SDK client spreads this CONDITIONALLY
 * (`...(named !== undefined && { region: named })`) and lets an absent region
 * stay absent. A caller that needs a region as a VALUE — a state key, a bucket
 * name, a marker key — must resolve one rather than pin a literal, and must
 * resolve the SAME one its clients use or the two silently disagree.
 *
 * Deliberately reads `AWS_REGION` only, not `AWS_DEFAULT_REGION`: that is the
 * precedence every one of these handlers already had, and widening it is a
 * behavior change with no defect behind it.
 */
export function namedCliRegion(optionRegion?: string): string | undefined {
  return canonicalizeRegion(optionRegion || process.env['AWS_REGION']) || undefined;
}

/**
 * The user's EXACT `--region` / `AWS_REGION` spelling, unfolded.
 *
 * Only the bootstrap-marker read wants this — it probes the canonical key
 * first and this spelling second, so that a marker written by a pre-fold
 * `cdkd bootstrap` is still found. Every other consumer wants
 * {@link namedCliRegion}.
 */
export function rawCliRegion(optionRegion?: string): string | undefined {
  return optionRegion || process.env['AWS_REGION'] || undefined;
}

/**
 * Where {@link resolveEffectiveRegion}'s answer came from.
 *
 * `flag` / `env` mean the user NAMED a region; `profile` means the AWS SDK's
 * own chain answered (the `region =` line of the selected profile); `default`
 * means nothing answered and the historical `us-east-1` literal applies.
 */
export type RegionSource = 'flag' | 'env' | 'profile' | 'default';

export interface EffectiveRegion {
  region: string;
  source: RegionSource;
}

/**
 * The region a command OPERATES on.
 *
 * Order: `--region` -> `AWS_REGION` -> `AWS_DEFAULT_REGION` -> the region the
 * AWS SDK's own chain resolves (i.e. the selected profile's `region =` line)
 * -> `us-east-1`.
 *
 * The profile step is what issue
 * [#2029](https://github.com/go-to-k/cdkd/issues/2029) adds, and it removes an
 * incoherence rather than adding a preference. cdkd ALREADY consulted the
 * profile: every command builds its pre-flight bag as
 * `new AwsClients({ ...(options.region && { region }) })`, so with no flag the
 * bag is region-less and the SDK resolves the profile. Only the region VALUE -
 * the one that keys the state file, keys the bootstrap marker and answers
 * `AWS::Region` in every user template - fell back to the literal. Measured on
 * an env-agnostic stack with `region = ap-northeast-1` in the profile and no
 * flag or env var:
 *
 * ```text
 * State bucket '...' is in 'us-east-1' (client was 'ap-northeast-1'); rebuilding S3 client.
 * Getting state for stack: CdkdBasicExample (us-east-1)
 * Resolved Ref to pseudo parameter: AWS::Region -> us-east-1
 * ```
 *
 * One command, two regions: the pre-flight talked to the profile's region
 * while the resources, their ARNs and their state landed in us-east-1. Only an
 * ENV-AGNOSTIC stack is affected - a stack with `env: { region }` pinned in CDK
 * carries its own region through the Cloud Assembly and never reaches this
 * fallback (`assembly-reader.ts` maps CDK's `unknown-region` to `undefined`).
 *
 * `AWS_DEFAULT_REGION` sits between `AWS_REGION` and the profile because the
 * AWS CLI honours it and the JS SDK does NOT (measured: with only that variable
 * set, `STSClient({}).config.region()` returns the PROFILE's region, not the
 * variable's). Reading it here is what stops cdkd disagreeing with the CLI a
 * user just ran.
 *
 * Returning the SOURCE, not just the region, is what lets a caller tell "the
 * user asked for this region" from "we inferred it" - which is the difference
 * that decides whether the reconciliation in
 * {@link reconcileRegionWithLegacyDefault} may move the answer back.
 */
export async function resolveEffectiveRegion(options: {
  region?: string | undefined;
  profile?: string | undefined;
}): Promise<EffectiveRegion> {
  const flag = canonicalizeRegion(options.region);
  if (flag) return { region: flag, source: 'flag' };

  const env = canonicalizeRegion(process.env['AWS_REGION'] || process.env['AWS_DEFAULT_REGION']);
  if (env) return { region: env, source: 'env' };

  const fromProfile = canonicalizeRegion(await resolveSdkDefaultRegion(options.profile));
  if (fromProfile) return { region: fromProfile, source: 'profile' };

  return { region: LEGACY_DEFAULT_REGION, source: 'default' };
}

/**
 * The region cdkd used to fall back to before issue #2029, and still falls
 * back to when nothing at all answers.
 *
 * Named rather than inlined because the reconciliation below has to ask
 * "is there state under the OLD default?", and that question only means
 * something while the two are the same constant.
 */
export const LEGACY_DEFAULT_REGION = 'us-east-1';

/**
 * Ask the AWS SDK's own chain which region it would use.
 *
 * A throwaway client, sampled once and destroyed: `src/utils/aws-clients.ts`
 * is explicit that a region-less bag's lazy members resolve independently and
 * need not agree with each other, so nothing here is reused for real work.
 * Returns `undefined` rather than throwing when the chain answers nothing -
 * a client with no resolvable region REJECTS, and that rejection is the normal
 * "no region configured" signal rather than an error worth surfacing.
 */
async function resolveSdkDefaultRegion(profile?: string): Promise<string | undefined> {
  const { STSClient } = await import('@aws-sdk/client-sts');
  let client: InstanceType<typeof STSClient> | undefined;
  try {
    client = new STSClient({ ...(profile && { profile }) });
    return (await client.config.region()) || undefined;
  } catch {
    return undefined;
  } finally {
    client?.destroy?.();
  }
}

/**
 * The narrowest thing a caller needs to answer "does this stack already have
 * state in region R?". Kept structural rather than importing `S3StateBackend`
 * so this module stays free of the state layer.
 */
export interface RegionReconcileProbe {
  stateExists(stackName: string, region: string): Promise<boolean>;
}

/**
 * Hold an existing stack on the OLD default region instead of silently moving
 * it to the profile's.
 *
 * Issue [#2029](https://github.com/go-to-k/cdkd/issues/2029) changes what a
 * bare `cdkd deploy` targets, and that value keys the state file. Without this,
 * a user whose profile says `ap-northeast-1` and who has been deploying to
 * `us-east-1` all along would, on upgrade, have cdkd look under a key nothing
 * ever wrote — find no state, treat every resource as a CREATE, and duplicate
 * their live infrastructure while orphaning the original stack from its own
 * state file. That is worse than the bug being fixed, so the new default only
 * applies where it cannot strand anything.
 *
 * Applies ONLY when the region was INFERRED (`source: 'profile'`). A region the
 * user NAMED is obeyed as given — `--region ap-northeast-1` against a us-east-1
 * stack means "operate on ap-northeast-1", not "guess what I meant" — and a
 * `default` source is already `us-east-1`, so there is nothing to move.
 *
 * The warning is not decoration: it is the only place the user learns that the
 * default has changed underneath them and how to opt in. `--region` is named
 * explicitly because it is the escape hatch in both directions.
 */
export async function reconcileRegionWithLegacyDefault(input: {
  effective: EffectiveRegion;
  stackName: string;
  probe: RegionReconcileProbe;
  logger: { info: (message: string) => void; debug: (message: string) => void };
}): Promise<string> {
  const { effective, stackName, probe, logger } = input;
  if (effective.source !== 'profile') return effective.region;
  if (effective.region === LEGACY_DEFAULT_REGION) return effective.region;

  // Order matters: ask about the RESOLVED region first. A stack that already
  // has state there is fully migrated, and probing the legacy key for it would
  // be a wasted round trip whose only possible effect is a false hold.
  if (await probe.stateExists(stackName, effective.region)) {
    logger.debug(
      `[region] '${stackName}' has state in ${effective.region} (from your AWS profile); using it.`
    );
    return effective.region;
  }
  if (!(await probe.stateExists(stackName, LEGACY_DEFAULT_REGION))) {
    // Neither side has state: a first deploy. The profile's region wins, which
    // is the whole point of the change, and nothing exists to strand.
    return effective.region;
  }

  logger.info(
    `Stack '${stackName}' has existing state in ${LEGACY_DEFAULT_REGION}, but your AWS profile ` +
      `resolves ${effective.region}. Continuing to use ${LEGACY_DEFAULT_REGION} so the existing ` +
      `stack is not duplicated. Pass '--region ${effective.region}' to target your profile's ` +
      `region, or '--region ${LEGACY_DEFAULT_REGION}' to silence this message.`
  );
  return LEGACY_DEFAULT_REGION;
}

/** The narrowest thing the marker reconciliation needs from a state backend. */
export interface MarkerReconcileProbe {
  getRawObject(key: string): Promise<string | null>;
}

/**
 * The marker-key twin of {@link reconcileRegionWithLegacyDefault}.
 *
 * `cdkd bootstrap` WRITES `cdkd-bootstrap/{region}.json`; `cdkd gc` and
 * `cdkd bootstrap --destroy` READ it. Issue
 * [#2029](https://github.com/go-to-k/cdkd/issues/2029) moves what `{region}`
 * resolves to when the user names none, and a previous attempt at it moved the
 * READ side alone — which silently broke that pairing: for a user with a
 * non-us-east-1 profile, `cdkd gc` reported "not opted in" and the teardown
 * "nothing to delete" while the asset bucket and ECR repo stayed alive and
 * billing. So all three commands resolve through THIS function, and the pairing
 * holds by construction rather than by three call sites agreeing.
 *
 * The reconciliation itself is the same rule as the state-key one: an inferred
 * region yields to an existing marker under the old default, a named region
 * never does, and a first bootstrap goes to the profile's region because there
 * is nothing to strand.
 *
 * Note this is deliberately NOT `readBootstrapMarkerBody`: that helper answers
 * "read the marker for THIS region, trying both spellings", which is a
 * different question and would conflate a case difference with a region
 * difference. Here both probes use the canonical key, because the question is
 * only which REGION owns a marker.
 */
export async function reconcileMarkerRegionWithLegacyDefault(input: {
  effective: EffectiveRegion;
  probe: MarkerReconcileProbe;
  markerKeyFor: (region: string) => string;
  logger: { info: (message: string) => void; debug: (message: string) => void };
}): Promise<string> {
  const { effective, probe, markerKeyFor, logger } = input;
  if (effective.source !== 'profile') return effective.region;
  if (effective.region === LEGACY_DEFAULT_REGION) return effective.region;

  if ((await probe.getRawObject(markerKeyFor(effective.region))) !== null) {
    logger.debug(
      `[region] asset storage exists in ${effective.region} (from your AWS profile); using it.`
    );
    return effective.region;
  }
  if ((await probe.getRawObject(markerKeyFor(LEGACY_DEFAULT_REGION))) === null) {
    return effective.region;
  }

  logger.info(
    `cdkd asset storage exists in ${LEGACY_DEFAULT_REGION}, but your AWS profile resolves ` +
      `${effective.region}. Continuing to use ${LEGACY_DEFAULT_REGION} so the existing storage ` +
      `is not orphaned. Pass '--region ${effective.region}' to target your profile's region, ` +
      `or '--region ${LEGACY_DEFAULT_REGION}' to silence this message.`
  );
  return LEGACY_DEFAULT_REGION;
}
