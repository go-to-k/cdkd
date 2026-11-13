import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { ExportIndexStore } from '../../../state/export-index-store.js';
import type { AwsClients } from '../../../utils/aws-clients.js';
import { awsClientDefaults } from '../../../utils/aws-client-defaults.js';
import {
  legacyStateBucketFallbackRegion,
  reconcileExportIndexRegion,
  withOtherIndexRemoval,
  type EffectiveRegion,
} from '../../region-options.js';
import {
  resolveStateBucketWithDefaultAndSource,
  stateBucketExistenceConfirmed,
} from '../../config-loader.js';
import { ensureAwsEmulatorStateBucket } from '../emulator-auto-bootstrap.js';
import type { DeployCommandOptions } from './types.js';
import type { ConsoleLogger } from '../../../utils/logger.js';

/**
 * Resolves the state bucket, checks it exists and builds the run's exports
 * index store. Started before synthesis and awaited beside it by
 * `deployCommand`, which says why.
 */
export async function prepareStateInfra(args: {
  options: DeployCommandOptions;
  region: string;
  effectiveRegion: EffectiveRegion;
  awsClients: AwsClients;
  logger: ConsoleLogger;
}): Promise<{
  stateBucket: string;
  preflightStateBackend: S3StateBackend;
  exportIndexStore: ExportIndexStore;
}> {
  const { options, region, effectiveRegion, awsClients, logger } = args;
  // go-to-k/cdkd#6186: under `--aws-emulator` only, create the state bucket
  // when the emulator has none (a no-op on real AWS).
  await ensureAwsEmulatorStateBucket({
    cliBucket: options.stateBucket,
    region,
    s3: awsClients.s3,
    sts: awsClients.sts,
  });
  // Resolve --state-bucket from CLI, env, cdk.json, or default (cdkd-state-{accountId};
  // legacy cdkd-state-{accountId}-{region} is consulted only as a fallback).
  const resolvedStateBucket = await resolveStateBucketWithDefaultAndSource(
    options.stateBucket,
    region,
    legacyStateBucketFallbackRegion(effectiveRegion)
  );
  const stateBucket = resolvedStateBucket.bucket;

  // Fail fast if the state bucket is missing, before docker builds / asset uploads.
  // Passing region/profile lets the backend rebuild its S3 client when the
  // state bucket lives in a region different from the CLI's profile region.
  //
  // When the bucket name came from the DEFAULT-name resolution above AND
  // that resolution's own HeadBucket came back clean (with the same
  // credentials), verifyBucketExists only needs its GetBucketLocation +
  // client rebuild — not a second HEAD (issue #1283). An
  // explicitly-specified bucket was never probed, and a 403 probe means
  // "exists but unusable"; both keep the full fail-fast check.
  const preflightStateBackend = new S3StateBackend(
    awsClients.s3,
    {
      bucket: stateBucket,
      prefix: options.statePrefix,
    },
    {
      region,
      ...(options.profile && { profile: options.profile }),
    }
  );
  await preflightStateBackend.verifyBucketExists({
    existenceAlreadyProbed: stateBucketExistenceConfirmed(resolvedStateBucket),
  });

  // Shared exports index store for this deploy session. Lifecycle: created
  // here once and threaded through every per-stack DeployEngine so its
  // in-memory cache survives across all stacks in a `cdkd deploy --all`
  // run. Lazy-loaded — the first Fn::ImportValue resolution triggers the
  // rebuild from state.json (when index file is absent post-upgrade) or
  // a single GET (when index file already exists).
  const runIndexRegion = await reconcileExportIndexRegion({
    effective: effectiveRegion,
    probe: preflightStateBackend,
    statePrefix: options.statePrefix,
    logger,
  });
  const newIndexStore = (indexRegion: string): ExportIndexStore =>
    new ExportIndexStore(
      awsClients.s3,
      stateBucket,
      options.statePrefix,
      indexRegion,
      preflightStateBackend,
      { profile: options.profile }
    );
  // go-to-k/cdkd#2100: a nested child this deploy removes or replaces also
  // leaves the OTHER candidate index file (`withOtherIndexRemoval`).
  const exportIndexStore = withOtherIndexRemoval(newIndexStore(runIndexRegion), {
    effective: effectiveRegion,
    runIndexRegion,
    statePrefix: options.statePrefix,
    probe: preflightStateBackend,
    createStore: newIndexStore,
    logger,
  });
  return { stateBucket, preflightStateBackend, exportIndexStore };
}

/**
 * The caller identity the asset destinations are named from. `deployCommand`
 * starts it beside synthesis and awaits it where it is used.
 */
export async function fetchCallerIdentity(region: string) {
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts');
  const stsClient = new STSClient({
    ...awsClientDefaults(),
    region,
  });
  try {
    return await stsClient.send(new GetCallerIdentityCommand({}));
  } finally {
    stsClient.destroy();
  }
}
