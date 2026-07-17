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
 * Read-only against state — no lock acquisition or save path here.
 */

import { getLogger } from '../../utils/logger.js';
import { AwsClients, resetAwsClients, setAwsClients } from '../../utils/aws-clients.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { ExportIndexStore } from '../../state/export-index-store.js';
import { resolveStateBucketWithDefault } from '../config-loader.js';
import { getBootstrapMarkerKey, parseBootstrapMarker } from '../../assets/asset-storage.js';
import type { StackState } from '../../types/state.js';
import type { CrossStackResolver } from '../../local/state-resolver.js';

export interface LoadStateForStackOptions {
  stackRegion?: string;
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

  const region =
    opts.region ??
    process.env['AWS_REGION'] ??
    process.env['AWS_DEFAULT_REGION'] ??
    synthRegion ??
    'us-east-1';

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
    ...(opts.region !== undefined && { region: opts.region }),
    ...(opts.profile !== undefined && { profile: opts.profile }),
  });
  setAwsClients(awsClients);

  try {
    const stateConfig = { bucket: stateBucket, prefix: opts.statePrefix };
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      ...(opts.region !== undefined && { region: opts.region }),
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

    let targetRegion: string;
    if (opts.stackRegion) {
      const found = refs.find((r) => r.region === opts.stackRegion);
      if (!found) {
        const seen = refs.map((r) => r.region ?? '(legacy)').join(', ');
        logger.warn(
          `${prefix}: stack '${stackName}' has no state in region '${opts.stackRegion}' (available: ${seen}). Falling back.`
        );
        return undefined;
      }
      targetRegion = opts.stackRegion;
    } else if (synthRegion && refs.some((r) => r.region === synthRegion)) {
      targetRegion = synthRegion;
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

  const region =
    opts.region ??
    opts.stackRegion ??
    synthRegion ??
    process.env['AWS_REGION'] ??
    process.env['AWS_DEFAULT_REGION'] ??
    'us-east-1';

  let stateBucket: string;
  try {
    stateBucket = await resolveStateBucketWithDefault(opts.stateBucket, region);
  } catch (err) {
    logger.debug(
      `${prefix}: could not resolve state bucket for the bootstrap-marker read: ${err instanceof Error ? err.message : String(err)}. Falling back to conventional asset-repo names.`
    );
    return undefined;
  }

  const awsClients = new AwsClients({
    ...(opts.region !== undefined && { region: opts.region }),
    ...(opts.profile !== undefined && { profile: opts.profile }),
  });
  setAwsClients(awsClients);

  try {
    const stateConfig = { bucket: stateBucket, prefix: opts.statePrefix };
    const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
      ...(opts.region !== undefined && { region: opts.region }),
      ...(opts.profile !== undefined && { profile: opts.profile }),
    });
    // `getRawObject` takes a bucket-root-relative key; the marker lives
    // OUTSIDE the state prefix (see asset-storage.ts), so the key from
    // `getBootstrapMarkerKey` is used verbatim — no prefixing.
    const markerKey = getBootstrapMarkerKey(region);
    const body = await stateBackend.getRawObject(markerKey);
    if (body === null) {
      logger.debug(
        `${prefix}: no bootstrap marker at '${markerKey}' in bucket '${stateBucket}' — assuming conventional asset-repo names.`
      );
      return undefined;
    }
    const marker = parseBootstrapMarker(body, markerKey);
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
    stateBucket = await resolveStateBucketWithDefault(opts.stateBucket, consumerRegion);
  } catch (err) {
    logger.warn(
      `${prefix}: cross-stack resolver could not resolve state bucket: ${err instanceof Error ? err.message : String(err)}. ` +
        `Fn::ImportValue / Fn::GetStackOutput env entries will warn-and-drop.`
    );
    return undefined;
  }

  const awsClients = new AwsClients({
    ...(opts.region !== undefined && { region: opts.region }),
    ...(opts.profile !== undefined && { profile: opts.profile }),
  });

  const stateConfig = { bucket: stateBucket, prefix: opts.statePrefix };
  const stateBackend = new S3StateBackend(awsClients.s3, stateConfig, {
    ...(opts.region !== undefined && { region: opts.region }),
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
      for (const ref of refs) {
        const region = ref.region ?? consumerRegion;
        if (region !== consumerRegion) continue; // same-region scope (v1)
        try {
          const got = await stateBackend.getState(ref.stackName, region);
          if (!got || !got.state.outputs) continue;
          if (exportName in got.state.outputs) {
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
      try {
        const got = await stateBackend.getState(producerStack, producerRegion);
        if (!got || !got.state.outputs) return undefined;
        if (!(outputName in got.state.outputs)) return undefined;
        const value = got.state.outputs[outputName];
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        return JSON.stringify(value);
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
