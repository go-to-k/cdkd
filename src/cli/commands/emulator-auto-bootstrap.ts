import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, type STSClient } from '@aws-sdk/client-sts';

import { awsEndpointOverrideActive } from '../../utils/aws-client-defaults.js';
import { getLogger } from '../../utils/logger.js';
import { safeMsg } from '../../utils/display-safe.js';
import { CdkdError } from '../../utils/error-handler.js';
import { getDefaultStateBucketName, resolveStateBucketWithSource } from '../config-loader.js';
import { configureStateBucket, createStateBucket } from './bootstrap-state-bucket.js';

/**
 * go-to-k/cdkd#6186: under `--aws-emulator`, a command that WRITES state
 * (`cdkd deploy`, `cdkd import`) creates the state bucket itself when the
 * emulator has none, instead of failing with "run cdkd bootstrap".
 *
 * AWS Emulator keeps everything in memory, so every emulator start would
 * otherwise need `cdkd bootstrap --aws-emulator` first. The bucket is created
 * and configured by the same routine `cdkd bootstrap` uses
 * (`bootstrap-state-bucket.ts`). Asset storage is not created here: the
 * deploy's per-region asset-storage auto-create covers it for each stack's
 * OWN region, and accepts without a prompt under `--aws-emulator`.
 *
 * Inert without an active endpoint override: real AWS keeps requiring an
 * explicit `cdkd bootstrap`. Runs BEFORE the command resolves the state
 * bucket, so that resolution (and its "no state bucket" refusal) is unchanged.
 *
 * @returns the bucket it created, or `undefined` when it did nothing.
 */
export async function ensureAwsEmulatorStateBucket(args: {
  /** The command's `--state-bucket` value (env / cdk.json are read here too). */
  cliBucket: string | undefined;
  /** The run's region: where a new bucket is created. */
  region: string;
  s3: S3Client;
  sts: STSClient;
}): Promise<string | undefined> {
  if (!awsEndpointOverrideActive()) return undefined;
  const logger = getLogger();

  const identity = await args.sts.send(new GetCallerIdentityCommand({}));
  const accountId = identity.Account!;
  // A named bucket (flag / CDKD_STATE_BUCKET / cdk.json) is the one the
  // command will use; otherwise the current default name. The legacy
  // per-region default is not consulted: it predates `--aws-emulator`, so an
  // emulator never holds one.
  const bucketName =
    resolveStateBucketWithSource(args.cliBucket)?.bucket ?? getDefaultStateBucketName(accountId);

  try {
    await args.s3.send(new HeadBucketCommand({ Bucket: bucketName }));
    return undefined;
  } catch (error) {
    const name = (error as { name?: string }).name;
    // Anything but "not there" is left to the command's own preflight, which
    // reports it the way it always has.
    if (name !== 'NotFound' && name !== 'NoSuchBucket') return undefined;
  }

  const setup = {
    s3: args.s3,
    bucketName,
    accountId,
    region: args.region,
    report: (message: string) => logger.debug(message),
  };
  try {
    try {
      await createStateBucket(setup);
    } catch (error) {
      // Two runs against one fresh emulator both see NotFound; the second
      // CreateBucket loses the race, and the bucket is there all the same.
      const code = (error as { name?: string }).name;
      if (code !== 'BucketAlreadyOwnedByYou' && code !== 'BucketAlreadyExists') throw error;
    }
    await configureStateBucket(setup);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new CdkdError(
      safeMsg`AWS Emulator auto-bootstrap of state bucket ${bucketName} failed: ${msg}. ` +
        'Run `cdkd bootstrap --aws-emulator --force` to retry.',
      'AWS_EMULATOR_BOOTSTRAP_FAILED',
      error instanceof Error ? error : undefined
    );
  }
  logger.info(
    safeMsg`AWS Emulator had no cdkd bootstrap; bootstrapped it (state bucket ${bucketName}).`
  );
  return bucketName;
}
