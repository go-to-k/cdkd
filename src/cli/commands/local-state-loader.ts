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
import { AwsClients, setAwsClients } from '../../utils/aws-clients.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import { resolveStateBucketWithDefault } from '../config-loader.js';
import type { StackState } from '../../types/state.js';

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
    awsClients.destroy();
  }
}
