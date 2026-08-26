/**
 * Shared `--from-state` state-loading helper for `cdkd local invoke` and
 * `cdkd local run-task`. Extracted from `local-invoke.ts` so both commands
 * route through one code path — same region resolution chain, same
 * multi-region disambiguation, same warn-and-fall-back error policy.
 *
 * `--from-state` is opt-in: a broken state file shouldn't abort the
 * invoke, so every "expected" miss (no record, ambiguous region without
 * `--stack-region`, bucket resolution failure) logs at warn and returns
 * `undefined`. Auth failures and other genuine errors propagate.
 *
 * No lock acquisition and no `state.json` write path here. That is NOT the
 * same as "read-only against the bucket", and the difference was mis-stated
 * until issue #1836: {@link buildCrossStackResolver}'s exports-index lookup
 * goes through {@link ExportIndexStore}, whose `load` REBUILDS the index from
 * the per-stack state files on a miss and PUTs the rebuilt object
 * (`cdkd/_index/{region}/exports.json`). So an `Fn::ImportValue` lookup from a
 * `cdkd local` command can write that one derived key. Keeping the index KEY
 * the same spelling the state records carry is what keeps that write CORRECT
 * rather than an empty index — see the note on `consumerRegion` below.
 */

import { getLogger } from '../../utils/logger.js';
import { canonicalizeRegion } from '../../utils/aws-partition.js';
import { AwsClients, resetAwsClients, setAwsClients } from '../../utils/aws-clients.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { ExportIndexStore } from '../../state/export-index-store.js';
import { resolveStateBucketWithDefault } from '../config-loader.js';
import {
  getBootstrapMarkerKey,
  parseBootstrapMarker,
  readBootstrapMarkerBody,
} from '../../assets/asset-storage.js';
import { importableOutputKeys, type StackState } from '../../types/state.js';
import type { CrossStackResolver } from '../../local/state-resolver.js';

export interface LoadStateForStackOptions {
  stackRegion?: string;
  /**
   * The user's UNFOLDED `--stack-region` spelling (issue #1836 round 3).
   *
   * `stackRegion` above is canonical by the time it gets here — every command
   * that owns its handler folds the flag on entry, and the `--from-state`
   * factory folds it again for the engine commands whose handler cdk-local
   * owns. That fold is REQUIRED (the same value names cdk-local's CFn client
   * region), but it also made "an exactly-spelled region always wins" over a
   * case-variant state record unreachable from a real CLI invocation: the
   * comparison could only ever be handed an already-canonical candidate.
   *
   * So the raw spelling travels alongside, and is consulted by EXACTLY two
   * things: the record-matching compare in `findByRegion`, and the marker-key
   * fallback probe in {@link loadBootstrapContainerRepo}, which already needed a
   * raw spelling for the same reason. It never reaches an SDK client or an
   * endpoint.
   *
   * It DOES reach one S3 key that no state record spells (corrected in round 4 —
   * the round-3 wording claimed otherwise): that marker probe builds
   * `cdkd-bootstrap/{RAW}.json` as its SECOND attempt, deliberately, because the
   * WRITE side (`cdkd bootstrap`) does not fold and really can have written the
   * upper-cased key. It is a best-effort read of a non-state key, never a write
   * and never a state key. Every STATE key is still a record's own spelling.
   *
   * Absent means "no raw spelling was captured" — the compare then falls back to
   * `stackRegion`, which is what the pre-round-3 behavior was.
   */
  rawStackRegion?: string;
  stateBucket?: string;
  statePrefix: string;
  region?: string;
  profile?: string;
  /**
   * Logger prefix surfaced on every warn line — the `cdkd local invoke`
   * caller uses `--from-state` so the existing UX stays identical; the
   * run-task caller passes the same string for consistency.
   */
  logPrefix?: string;
}

export async function loadStateForStack(
  stackName: string,
  synthRegion: string | undefined,
  opts: LoadStateForStackOptions
): Promise<{ state: StackState; region: string } | undefined> {
  const logger = getLogger();
  const prefix = opts.logPrefix ?? '--from-state';

  // Issue #1836: fold the WHOLE chain, not just `opts.region`. The two env-var
  // fall-throughs are the sources a command's handler-entry fold cannot reach.
  //
  // What this value feeds, precisely — it does NOT pick the S3 client's region
  // (that is `opts.region`, folded separately just below). It is handed to
  // `resolveStateBucketWithDefault`, which names the legacy default state bucket
  // `cdkd-state-{acct}-{region}` (a name S3 could never have accepted with an
  // upper-cased region, so folding here can only ever resolve MORE buckets) and
  // probes it through a client hardcoded to `us-east-1` (`config-loader.ts`);
  // and it is the last-resort `targetRegion` for a legacy region-less record.
  const region = canonicalizeRegion(
    opts.region ??
      process.env['AWS_REGION'] ??
      process.env['AWS_DEFAULT_REGION'] ??
      synthRegion ??
      'us-east-1'
  );
  // Issue #1836: `opts.region` is what BUILDS the S3 client + state backend
  // below, so it needs its own fold. The four `cdkd local` commands with their
  // own handler fold `--region` on entry (#1795) and the `--from-state` factory
  // folds it for the cdk-local-driven engine commands, so this is idempotent for
  // every caller cdkd ships — but the helper is exported and must not DEPEND on
  // an upstream fold. An ABSENT value stays absent: omitting `region` is what
  // lets the SDK's own chain resolve the profile's region, and coercing it to a
  // string here would change that — and a BLANK `--region ''` is treated as
  // absent for the same reason (it passed the earlier `!== undefined` gate and
  // reached the client as `region: ''`, which names no endpoint; `AwsClients`
  // dropped it on a truthiness test one layer down, so this only makes the
  // boundary say what the client already did).
  const clientRegion = canonicalizeRegion(opts.region) || undefined;

  let stateBucket: string;
  try {
    stateBucket = await resolveStateBucketWithDefault(opts.stateBucket, region);
  } catch (err) {
    logger.warn(
      `${prefix}: could not resolve state bucket: ${err instanceof Error ? err.message : String(err)}. Falling back.`
    );
    return undefined;
  }

  const awsClients = new AwsClients({
    ...(clientRegion !== undefined && { region: clientRegion }),
    ...(opts.profile !== undefined && { profile: opts.profile }),
  });
  setAwsClients(awsClients);

  try {
    const stateConfig = { bucket: stateBucket, prefix: opts.statePrefix };
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      ...(clientRegion !== undefined && { region: clientRegion }),
      ...(opts.profile !== undefined && { profile: opts.profile }),
    });
    await stateBackend.verifyBucketExists();

    const refs = (await stateBackend.listStacks()).filter((r) => r.stackName === stackName);
    if (refs.length === 0) {
      logger.warn(
        `${prefix}: no cdkd state found for stack '${stackName}' in bucket '${stateBucket}'. ` +
          `Was it deployed via 'cdkd deploy'? Falling back.`
      );
      return undefined;
    }

    /**
     * Issue #1836: EXACT match first, case-insensitive second.
     *
     * `S3StateBackend.listStacks` dedupes on the EXACT `{stack}\0{region}` pair,
     * so `cdkd/MyStack/US-EAST-1/state.json` and
     * `cdkd/MyStack/us-east-1/state.json` are two DISTINCT refs — and
     * ListObjectsV2 returns them in ASCII order, i.e. the upper-cased one FIRST.
     * A fold-only `find` therefore hands `--stack-region us-east-1` the OTHER
     * record, silently reading state the user did not name; the pre-fold `===`
     * got that case right. So the fold is the RECOVERY for a case mismatch, never
     * an override of a spelling that exists verbatim.
     *
     * `candidate` is therefore the spelling the USER supplied, not the folded
     * one (round 3 of the #1836 review): the fold at each command's handler
     * entry and at the `--from-state` factory is what an SDK client needs, but
     * feeding it to this compare made the exact-match rule unreachable from any
     * real CLI invocation — every candidate was already canonical, so `exact`
     * could only ever match an already-canonical record and `--stack-region
     * US-EAST-1` read the `us-east-1` one while REPORTING it as the exact
     * spelling. `opts.rawStackRegion` carries the unfolded value here; the
     * recovery arm folds both sides itself, so nothing upstream has to.
     *
     * When more than one ref is canonical-equal the choice is announced, because
     * either answer reads some record the user did not spell out in full and the
     * silence is what made the original miss hard to diagnose. The wording
     * states which of the two rules decided it — and does so from the same
     * `exact` binding the choice was made from, so it cannot claim an exact
     * match the compare did not make.
     */
    const findByRegion = (candidate: string, source: string): (typeof refs)[number] | undefined => {
      const exact = refs.find((r) => r.region === candidate);
      const folded = refs.filter(
        (r) => canonicalizeRegion(r.region) === canonicalizeRegion(candidate)
      );
      const chosen = exact ?? folded[0];
      if (folded.length > 1 && chosen) {
        const how = exact
          ? `matches ${source} '${candidate}' exactly`
          : `no record spells ${source} '${candidate}' exactly, so this is a case-insensitive recovery`;
        logger.warn(
          `${prefix}: stack '${stackName}' has state under ${folded.length} case-variant spellings of ${source} '${candidate}' ` +
            `(${folded.map((r) => r.region ?? '(legacy)').join(', ')}). ` +
            `Reading '${chosen.region ?? '(legacy)'}' — ${how}.`
        );
      }
      return chosen;
    };
    // Computed only when it is actually consulted: `findByRegion` can WARN, and
    // warning about a case-variant synth-region record while an explicit
    // `--stack-region` decides the read would be noise about a record nothing
    // reads.
    let synthMatch: (typeof refs)[number] | undefined;
    if (!opts.stackRegion && synthRegion) {
      synthMatch = findByRegion(synthRegion, 'the synth-derived stack region');
    }

    let targetRegion: string;
    if (opts.stackRegion) {
      // Issue #1836: match EXACTLY-then-case-INSENSITIVELY (see
      // `findByRegion`), and take the KEY from the record rather than from the
      // flag. `--stack-region US-EAST-1` used to miss the
      // `us-east-1` record on a raw `===`, and the miss is a SILENT fall-back —
      // the user sees a command that "works" against no state at all. Folding
      // the flag alone would not be enough here and would even regress the
      // mirror-image case: a region's case is not the FLAG's to decide, it is
      // whatever spelling the deploy that wrote the record used (nothing folds
      // `cdkd deploy --region`, and DNS being case-insensitive means an
      // upper-cased commercial deploy succeeds and keys its state that way). So
      // the recovery arm folds both sides for the COMPARISON while
      // `targetRegion` — which becomes the
      // `s3://…/cdkd/{stack}/{region}/state.json` key below — stays the
      // record's own spelling.
      //
      // The candidate is the RAW spelling the user typed (round 3): the exact
      // arm is the whole reason the fold cannot decide the read, so handing it
      // the folded value made the rule inert. `rawStackRegion` is absent only
      // for a caller that supplied no raw spelling at all, and then the folded
      // flag is the best available candidate.
      const requestedRegion = opts.rawStackRegion ?? opts.stackRegion;
      const found = findByRegion(requestedRegion, '--stack-region');
      if (!found) {
        const seen = refs.map((r) => r.region ?? '(legacy)').join(', ');
        logger.warn(
          `${prefix}: stack '${stackName}' has no state in region '${requestedRegion}' (available: ${seen}). Falling back.`
        );
        return undefined;
      }
      // A legacy (region-less) ref can never match a supplied `--stack-region`,
      // so `found.region` is defined here; the `??` is for the type only.
      targetRegion = found.region ?? requestedRegion;
    } else if (synthRegion && synthMatch) {
      // Same exact-then-folded match as the branch above, for the same reason:
      // the synth-derived region is canonical by construction (`${AWS::Region}`
      // always is), but the RECORD's spelling is not guaranteed to be — and
      // leaving this sibling comparison raw while folding the one above would
      // be exactly the drift the one-normalization-point rule exists to stop.
      // The exact-first order matters here too: with both spellings present, the
      // canonical synth region must read the canonical record.
      targetRegion = synthMatch.region ?? synthRegion;
    } else if (refs.length === 1) {
      targetRegion = refs[0]!.region ?? synthRegion ?? region;
    } else {
      const seen = refs.map((r) => r.region ?? '(legacy)').join(', ');
      logger.warn(
        `${prefix}: stack '${stackName}' has state in multiple regions (${seen}). ` +
          `Re-run with --stack-region <region>. Falling back.`
      );
      return undefined;
    }

    const stateData = await stateBackend.getState(stackName, targetRegion);
    if (!stateData) {
      logger.warn(
        `${prefix}: state record for '${stackName}' (${targetRegion}) returned empty. Falling back.`
      );
      return undefined;
    }
    logger.debug(`${prefix}: loaded state for ${stackName} (${targetRegion})`);
    return { state: stateData.state, region: targetRegion };
  } finally {
    // `resetAwsClients()` destroys the underlying clients AND clears the
    // module-global `globalClients` reference. Bare `awsClients.destroy()`
    // would leave a destroyed instance pointed at by the global, which a
    // later caller of `getAwsClients()` would silently reuse.
    resetAwsClients();
  }
}

/**
 * Best-effort read of the region's asset-storage bootstrap marker
 * (`s3://{stateBucket}/cdkd-bootstrap/{region}.json`) to recover the
 * cdkd-owned container-asset ECR repository name (issue #1025). Since
 * `cdkd bootstrap --container-repo <name>` (issue #1011) the repo can
 * carry ANY name, so the local resolvers' conventional-prefix regex
 * cannot classify images published to a custom-named repo — the marker
 * is the only source of truth.
 *
 * This is a fast-path optimization for `cdkd local run-task
 * --from-state` (recognizing a cdk-asset image enables the local
 * `cdk.out` docker build instead of an ECR pull), so it must NEVER fail
 * the run: every miss (no bucket, no marker, malformed marker, any AWS
 * error) logs at debug and returns `undefined` — the caller falls back
 * to the conventional-prefix regex.
 *
 * Marker-key region resolution: the marker records the repo for the
 * stack's DEPLOY region, so after the explicit CLI overrides (`--region`
 * highest per the repo convention, then `--stack-region` — the state
 * disambiguator that names the region whose state is being loaded) the
 * synth-derived stack region outranks the ambient env region. This
 * deliberately differs from {@link loadStateForStack}'s bucket-resolution
 * chain (which is about WHERE the state bucket is, not WHICH region's
 * data is read).
 */
export async function loadBootstrapContainerRepo(
  synthRegion: string | undefined,
  opts: LoadStateForStackOptions
): Promise<string | undefined> {
  const logger = getLogger();
  const prefix = opts.logPrefix ?? '--from-state';

  // Issue #1836: folded for the same reasons as {@link loadStateForStack}'s
  // chain — the state-bucket NAME this resolves is lowercase-only, so folding
  // can only ever resolve more buckets.
  //
  // The RAW spelling is kept because the same value becomes the
  // `cdkd-bootstrap/{region}.json` marker KEY, and the WRITE side does NOT fold:
  // `cdkd bootstrap` derives its region from `options.region || AWS_REGION ||
  // 'us-east-1'` verbatim (`src/cli/commands/bootstrap.ts`), so
  // `AWS_REGION=US-EAST-1 cdkd bootstrap` really wrote
  // `cdkd-bootstrap/US-EAST-1.json`. Folding the read alone would MISS that
  // marker and silently fall back to the conventional repo names — where the
  // pre-fold read HIT — so the probe below tries the canonical key first (what a
  // canonical-region bootstrap wrote, and what the write side should converge on)
  // and the raw spelling second. Aligning the write side is issue #1820's lane.
  //
  // `rawStackRegion` is preferred over `stackRegion` for exactly that reason
  // (round 3): the handler-entry fold had already canonicalized the flag by the
  // time it arrived, so `--stack-region US-EAST-1` could not reach the raw
  // second probe at all and the marker an upper-cased `cdkd bootstrap` wrote
  // stayed unreachable through the one flag that names the region explicitly.
  const rawRegion =
    opts.region ??
    opts.rawStackRegion ??
    opts.stackRegion ??
    synthRegion ??
    process.env['AWS_REGION'] ??
    process.env['AWS_DEFAULT_REGION'] ??
    'us-east-1';
  const region = canonicalizeRegion(rawRegion);

  let stateBucket: string;
  try {
    stateBucket = await resolveStateBucketWithDefault(opts.stateBucket, region);
  } catch (err) {
    logger.debug(
      `${prefix}: could not resolve state bucket for the bootstrap-marker read: ${err instanceof Error ? err.message : String(err)}. Falling back to conventional asset-repo names.`
    );
    return undefined;
  }

  // Issue #1836: same fold as `loadStateForStack`'s `clientRegion` — this is the
  // value that BUILDS the S3 client, and SDK endpoint resolution is
  // case-SENSITIVE. Absent stays absent (the SDK's own chain resolves it), and a
  // BLANK `--region ''` counts as absent for the same reason.
  const clientRegion = canonicalizeRegion(opts.region) || undefined;

  const awsClients = new AwsClients({
    ...(clientRegion !== undefined && { region: clientRegion }),
    ...(opts.profile !== undefined && { profile: opts.profile }),
  });
  setAwsClients(awsClients);

  try {
    const stateConfig = { bucket: stateBucket, prefix: opts.statePrefix };
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      ...(clientRegion !== undefined && { region: clientRegion }),
      ...(opts.profile !== undefined && { profile: opts.profile }),
    });
    // `getRawObject` takes a bucket-root-relative key; the marker lives
    // OUTSIDE the state prefix (see asset-storage.ts), so the key from
    // `getBootstrapMarkerKey` is used verbatim — no prefixing.
    //
    // Issue #2021 folded the canonical-then-raw two-probe read (issue #1836)
    // into `readBootstrapMarkerBody`. THIS caller's policy is unchanged and is
    // the one that differs from its two siblings: best-effort throughout — the
    // helper does not catch, so every failure still lands in this function's own
    // catch, which warns at debug and falls back to the conventional
    // asset-repo names rather than aborting the invoke.
    const { body, resolvedKey } = await readBootstrapMarkerBody(stateBackend, rawRegion, {
      logPrefix: prefix,
    });
    if (body === null) {
      const rawKey = getBootstrapMarkerKey(rawRegion);
      logger.debug(
        `${prefix}: no bootstrap marker at '${resolvedKey}'${rawKey !== resolvedKey ? ` (nor '${rawKey}')` : ''} in bucket '${stateBucket}' — assuming conventional asset-repo names.`
      );
      return undefined;
    }
    const marker = parseBootstrapMarker(body, resolvedKey);
    logger.debug(
      `${prefix}: bootstrap marker for ${region} names container repo '${marker.containerRepo}'.`
    );
    return marker.containerRepo;
  } catch (err) {
    logger.debug(
      `${prefix}: bootstrap-marker read failed: ${err instanceof Error ? err.message : String(err)}. Falling back to conventional asset-repo names.`
    );
    return undefined;
  } finally {
    // Same rationale as `loadStateForStack`: `resetAwsClients()` destroys
    // the clients AND clears the module-global reference so no destroyed
    // instance leaks to a later `getAwsClients()` caller.
    resetAwsClients();
  }
}

/**
 * Options consumed by {@link buildCrossStackResolver}. Mirrors
 * `LoadStateForStackOptions` but is needed independently because the
 * resolver outlives a single state load — `cdkd local invoke --from-state`
 * resolves `Fn::ImportValue` / `Fn::GetStackOutput` per-env-var, with each
 * lookup potentially hitting a different producer stack's state file.
 */
export interface BuildCrossStackResolverOptions {
  stateBucket?: string;
  statePrefix: string;
  region?: string;
  profile?: string;
  /** Logger prefix surfaced on every warn line. Defaults to `--from-state`. */
  logPrefix?: string;
}

/**
 * Build a {@link CrossStackResolver} that walks cdkd's S3 state to look
 * up `Fn::ImportValue` / `Fn::GetStackOutput` references the same way
 * `cdkd deploy`'s `IntrinsicFunctionResolver` does. Returns `undefined`
 * when the state bucket cannot be resolved (warn + fall back; matches
 * `loadStateForStack`'s policy).
 *
 * The returned `dispose` closes the AWS clients owned by the resolver
 * when the caller is done — callers MUST call it (typically in a
 * `try / finally`) so the per-request S3 client isn't leaked across the
 * CLI's lifetime.
 *
 * Why a separate AwsClients instance from `loadStateForStack`: the
 * existing helper destroys its clients in a `finally` immediately after
 * loading the consumer stack's state. The cross-stack resolver lives
 * longer — every env-var that references a cross-stack output triggers a
 * new state read. Owning a fresh `AwsClients` here gives the resolver
 * an independent lifetime managed by the caller.
 *
 * Same-account / same-region only in v1 (the resolver's `producerRegion`
 * arg is honored, but only for state lookups within the same cdkd state
 * bucket). Cross-region `Fn::ImportValue` is tracked under #451;
 * cross-account `Fn::GetStackOutput.RoleArn` is tracked under #449.
 */
export async function buildCrossStackResolver(
  consumerRegion: string,
  opts: BuildCrossStackResolverOptions
): Promise<{ resolver: CrossStackResolver; dispose: () => void } | undefined> {
  const logger = getLogger();
  const prefix = opts.logPrefix ?? '--from-state';

  let stateBucket: string;
  try {
    // Issue #1836 round 4: the bucket NAME resolution gets the FOLDED spelling,
    // exactly as the two sibling loaders above do (`loadStateForStack` and
    // `loadBootstrapContainerRepo` both hand `resolveStateBucketWithDefault`
    // their canonicalized `region`). `consumerRegion` is a state RECORD's own
    // spelling by contract — which round 3 made reachable in an upper-cased form
    // — and the legacy default bucket name it derives is
    // `cdkd-state-{acct}-{region}`: an upper-cased bucket name is not
    // virtual-hostable, so the request goes path-style, S3 answers 400
    // `InvalidBucketName`, `probeBucket` rethrows and this whole resolver returns
    // `undefined`. That degrades EVERY `Fn::ImportValue` / `Fn::GetStackOutput`
    // env entry to warn-and-drop, on an account where `loadStateForStack` had
    // just read the same record fine. Folding here can only ever resolve MORE
    // buckets (the name is lowercase-only), and the RAW spelling is still what
    // the index key and the scan filter below get.
    stateBucket = await resolveStateBucketWithDefault(
      opts.stateBucket,
      canonicalizeRegion(consumerRegion)
    );
  } catch (err) {
    logger.warn(
      `${prefix}: cross-stack resolver could not resolve state bucket: ${err instanceof Error ? err.message : String(err)}. ` +
        `Fn::ImportValue / Fn::GetStackOutput env entries will warn-and-drop.`
    );
    return undefined;
  }

  // Issue #1836: same `clientRegion` fold as the two loaders above — this value
  // builds the S3 client whose endpoint resolution is case-SENSITIVE. Absent
  // stays absent, and a blank `--region ''` counts as absent.
  const clientRegion = canonicalizeRegion(opts.region) || undefined;

  const awsClients = new AwsClients({
    ...(clientRegion !== undefined && { region: clientRegion }),
    ...(opts.profile !== undefined && { profile: opts.profile }),
  });

  const stateConfig = { bucket: stateBucket, prefix: opts.statePrefix };
  const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
    ...(clientRegion !== undefined && { region: clientRegion }),
    ...(opts.profile !== undefined && { profile: opts.profile }),
  });
  try {
    await stateBackend.verifyBucketExists();
  } catch (err) {
    awsClients.destroy();
    logger.warn(
      `${prefix}: cross-stack resolver could not access state bucket '${stateBucket}': ${err instanceof Error ? err.message : String(err)}. ` +
        `Fn::ImportValue / Fn::GetStackOutput env entries will warn-and-drop.`
    );
    return undefined;
  }

  // The exports index is region-scoped (one file per consumer region).
  // We instantiate it lazily so a stack with only `Fn::GetStackOutput`
  // references doesn't pay the index-load cost.
  //
  // `consumerRegion` is deliberately NOT folded for the index KEY, for the same
  // reason `targetRegion` is not (issue #1836): nothing folds
  // `cdkd deploy --region`. Only the COMPARISON below folds.
  //
  // What the caller must pass is the STATE RECORD's own spelling — that is the
  // contract, and round 3 of the #1836 review found `local-run-task.ts` handing
  // over a FOLDED chain value instead while `local-invoke.ts` /
  // `local-invoke-agentcore.ts` passed `loaded.region`, so the two commands keyed
  // the same index differently. The record's spelling is load-bearing for a
  // reason no comment stated: on an index-key miss `ExportIndexStore.load`
  // REBUILDS from the per-stack state files, and its rebuild filter is a raw
  // `ref.region === this.region` — so a `this.region` that no state record
  // spells yields ZERO refs and PUTs an EMPTY index, after which every
  // `Fn::ImportValue` degrades to the O(N) scan permanently. Keyed by a record's
  // spelling the filter always matches, so the worst case is a key miss plus a
  // CORRECT rebuild. (Deploy derives the write key from `--region` / `AWS_REGION`
  // verbatim — `deploy.ts` — which is a different value from the stack's region
  // whenever the stack declares `env.region`, so a key miss is a case cdkd has
  // to survive rather than one it can spell its way out of. Converging the
  // write-side spelling is issue #1820's lane.)
  const exportIndex = new ExportIndexStore(
    awsClients.s3,
    stateBucket,
    opts.statePrefix,
    consumerRegion,
    stateBackend
  );

  const resolver: CrossStackResolver = {
    async resolveImport(exportName: string): Promise<string | undefined> {
      // Fast path: consult the persistent exports index.
      try {
        const entry = await exportIndex.lookup(exportName);
        if (entry) {
          const value = entry.value;
          if (typeof value === 'string') return value;
          if (typeof value === 'number' || typeof value === 'boolean') return String(value);
          // Object-valued Outputs (rare) — serialize as JSON so the
          // downstream env-var carries something useful. The deploy-time
          // intrinsic resolver flattens these in practice but the index
          // value is the source of truth here, so we mirror its shape.
          return JSON.stringify(value);
        }
      } catch (err) {
        logger.debug(
          `${prefix}: exports index lookup failed for '${exportName}': ${err instanceof Error ? err.message : String(err)}; falling back to per-stack state scan`
        );
      }

      // Fallback: scan every cdkd-managed stack in the consumer region
      // for an Output matching `exportName`. Mirrors the deploy-engine
      // resolver's index-miss path.
      let refs;
      try {
        refs = await stateBackend.listStacks();
      } catch (err) {
        logger.debug(
          `${prefix}: failed to list stacks during Fn::ImportValue fallback for '${exportName}': ${err instanceof Error ? err.message : String(err)}`
        );
        return undefined;
      }
      // Issue #1836: the same-region scope filter folds BOTH sides. The caller's
      // `consumerRegion` is the RECORD's own spelling (`local-invoke.ts` passes
      // `loaded.region`), which `loadStateForStack`'s exact-then-folded match
      // makes reachable in an upper-cased form — and a raw `!==` then skipped
      // EVERY ref, so the `Fn::ImportValue` index-miss fallback resolved nothing
      // and each affected env var was dropped with only a per-key warning.
      const canonicalConsumerRegion = canonicalizeRegion(consumerRegion);
      for (const ref of refs) {
        // The record's own spelling is kept for the `getState` key below, the
        // same way `loadStateForStack` keeps it: a folded key would 404 on an
        // upper-cased record.
        const region = ref.region ?? consumerRegion;
        if (canonicalizeRegion(region) !== canonicalConsumerRegion) continue; // same-region scope (v1)
        try {
          const got = await stateBackend.getState(ref.stackName, region);
          if (!got || !got.state.outputs) continue;
          // Through the shared predicate (issue #2193), not `in outputs`: the
          // bag also holds every plain Output name, and matching on those
          // bound a local env var to a stack that exports nothing of that name.
          if (importableOutputKeys(got.state).includes(exportName)) {
            const value = got.state.outputs[exportName];
            if (typeof value === 'string') return value;
            if (typeof value === 'number' || typeof value === 'boolean') return String(value);
            return JSON.stringify(value);
          }
        } catch (err) {
          logger.debug(
            `${prefix}: state read failed for ${ref.stackName} (${region}) during Fn::ImportValue fallback: ${err instanceof Error ? err.message : String(err)}`
          );
          continue;
        }
      }
      return undefined;
    },
    async resolveGetStackOutput(
      producerStack: string,
      producerRegion: string,
      outputName: string
    ): Promise<string | undefined> {
      const readOutput = (got: { state: StackState } | null | undefined): string | undefined => {
        if (!got || !got.state.outputs) return undefined;
        if (!(outputName in got.state.outputs)) return undefined;
        const value = got.state.outputs[outputName];
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        return JSON.stringify(value);
      };
      try {
        // EXACT spelling first, for the same reason `loadStateForStack`'s
        // `findByRegion` tries it first: both spellings can coexist as two
        // DISTINCT state records, so a fold must never override a key that
        // exists verbatim. A record that EXISTS at the exact key IS the producer
        // record, so a missing output there is a genuine miss — reading a
        // case-variant record instead would answer from a record the caller did
        // not name.
        const got = await stateBackend.getState(producerStack, producerRegion);
        if (got) return readOutput(got);
        // Issue #1836 round 4: case recovery, the same BOTH-SIDES fold
        // `resolveImport`'s index-miss scan does — this arm had none, and it is
        // reached with a `producerRegion` cdkd does not control. cdk-local's
        // `Fn::GetStackOutput` resolution defaults the producer region to
        // `SubstitutionContext.consumerRegion` when the intrinsic carries no
        // explicit `Region`, and that value is a state RECORD's own spelling by
        // this resolver's contract — so an `US-EAST-1`-keyed consumer record
        // asking for a `us-east-1`-keyed producer built the key
        // `cdkd/{producer}/US-EAST-1/state.json`, 404'd, and the env var was
        // dropped with only a per-key warning. The RECORD's own spelling is kept
        // for the retry key, exactly as the scan does: a folded key would 404 on
        // an upper-cased record.
        const canonicalProducerRegion = canonicalizeRegion(producerRegion);
        const refs = await stateBackend.listStacks();
        for (const ref of refs) {
          if (ref.stackName !== producerStack) continue;
          const region = ref.region ?? producerRegion;
          if (region === producerRegion) continue; // already probed above
          if (canonicalizeRegion(region) !== canonicalProducerRegion) continue;
          const recovered = readOutput(await stateBackend.getState(producerStack, region));
          if (recovered !== undefined) {
            logger.debug(
              `${prefix}: Fn::GetStackOutput '${producerStack}.${outputName}' resolved from the case-variant state record '${region}' (no record spells '${producerRegion}' exactly).`
            );
            return recovered;
          }
        }
        return undefined;
      } catch (err) {
        logger.debug(
          `${prefix}: state read failed for Fn::GetStackOutput '${producerStack}.${outputName}' (${producerRegion}): ${err instanceof Error ? err.message : String(err)}`
        );
        return undefined;
      }
    },
  };

  return {
    resolver,
    dispose: (): void => {
      awsClients.destroy();
    },
  };
}
