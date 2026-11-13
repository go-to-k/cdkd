/**
 * `--from-state` in AWS Emulator mixed mode (go-to-k/cdkd#6150):
 * `--aws-emulator` makes the emulator the target, and a `"real-aws"` exception
 * in `--env-vars` sends one service to real AWS. So names resolve from the
 * copy of the stack `cdkd deploy --aws-emulator` wrote into the emulator, and
 * the excepted services' resources from the copy `cdkd deploy` wrote into real
 * AWS. cdk-local's `createMixedModeStateProvider` does the per-service merge
 * (emulator primary); this module builds the two cdkd `--from-state`
 * providers it merges.
 *
 * The emulator side is the plain S3 state read: in mixed mode every cdkd
 * client defaults to the emulator (`mixedModeEmulatorOverride`), so its state
 * bucket resolves exactly as it did for that deploy — `--state-bucket` /
 * `CDKD_STATE_BUCKET` / `cdk.json` when set, else the default bucket of the
 * emulator's account. The real side runs every client it builds on real AWS
 * (`runWithRealAws`), with `--profile`.
 *
 * The state loader publishes and resets the PROCESS-GLOBAL `AwsClients`
 * around each read, so the two sides never run at once: cdk-local's merge
 * starts both together, and one shared queue runs them one after the other.
 * The real side publishes nothing global (it runs in its own client scope).
 */

import type { LocalStateProvider } from 'cdk-local';
import { createMixedModeStateProvider } from 'cdk-local/internal';
import { AwsClients, runWithStackAwsClients } from '../utils/aws-clients.js';
import { runWithRealAws } from '../utils/aws-client-defaults.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';
import { getLogger } from '../utils/logger.js';
import {
  S3LocalStateProvider,
  type S3LocalStateProviderOptions,
} from './s3-local-state-provider.js';

/** The label the real side's warnings start with. */
export const REAL_FROM_STATE_LABEL = '--from-state (real AWS)';

/**
 * The cause alone, for cdk-local's merge warning to quote: the loader's own
 * label and its generic advice ("Was it deployed via 'cdkd deploy'? Falling
 * back.") would repeat what the merge warning already says.
 */
export function realMissReason(message: string): string {
  const withoutLabel = message.startsWith(`${REAL_FROM_STATE_LABEL}: `)
    ? message.slice(REAL_FROM_STATE_LABEL.length + 2)
    : message;
  return withoutLabel
    .replace(/\s*Was it deployed via 'cdkd deploy'\?/, '')
    .replace(/\s*Falling back\.\s*$/, '')
    .replace(/\.\s*$/, '');
}

/** Run async jobs one at a time, in call order; a failure does not stop the queue. */
function serialQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const run = tail.then(job, job);
    tail = run.catch(() => undefined);
    return run;
  };
}

/**
 * The `--from-state` provider for a mixed-mode read: the emulator for every
 * resource, real AWS for the resources of `realServices` (one workload's
 * exceptions, or the shared `Parameters` ones). With no exception it is the
 * emulator read alone — never real AWS.
 */
export function createMixedModeFromStateProvider(
  opts: S3LocalStateProviderOptions,
  realServices: readonly string[]
): LocalStateProvider {
  if (realServices.length === 0) return new S3LocalStateProvider(opts);
  const serial = serialQueue();
  const emulatorInner = new S3LocalStateProvider(opts);
  const emulator: LocalStateProvider = {
    label: emulatorInner.label,
    load: (stackName, synthRegion) => serial(() => emulatorInner.load(stackName, synthRegion)),
    buildCrossStackResolver: (region) =>
      serial(() => emulatorInner.buildCrossStackResolver(region)),
    dispose: () => emulatorInner.dispose(),
  };

  let lastLoadError: string | undefined;
  const realInner = new S3LocalStateProvider({
    ...opts,
    logPrefix: REAL_FROM_STATE_LABEL,
    // A miss on the real side is reported once, by cdk-local's merge, with
    // this reason in it (and only when the stack has resources of an excepted
    // service); the rest is debug.
    warn: (message) => {
      lastLoadError ??= realMissReason(message);
      getLogger().debug(message);
    },
    scopedClients: true,
  });
  const real: LocalStateProvider = {
    label: REAL_FROM_STATE_LABEL,
    load: (stackName, synthRegion) =>
      serial(() =>
        runWithRealAws(async () => {
          lastLoadError = undefined;
          // A named region for the scope: every client the read builds,
          // `resolveStateBucketWithDefault`'s STS lookup included, is then
          // one built here, on real AWS.
          const region =
            canonicalizeRegion(
              opts.stackRegion ??
                opts.region ??
                synthRegion ??
                process.env['AWS_REGION'] ??
                process.env['AWS_DEFAULT_REGION']
            ) || 'us-east-1';
          // cdkd-local-role-identity: cdkd reading its OWN state record in
          // real AWS, as the `--from-state` real side always has.
          const clients = new AwsClients({
            region,
            ...(opts.profile && { profile: opts.profile }),
          });
          try {
            return await runWithStackAwsClients(clients, () =>
              realInner.load(stackName, synthRegion)
            );
          } catch (err) {
            // An unreadable real side keeps the emulator names (the merge
            // warns once, with this reason), instead of failing the command.
            lastLoadError = realMissReason(err instanceof Error ? err.message : String(err));
            return undefined;
          } finally {
            clients.destroy();
          }
        })
      ),
    // Cross-stack references resolve from the emulator (cdk-local's merge
    // uses the emulator side only), so the real side builds none.
    buildCrossStackResolver: () => Promise.resolve(undefined),
    getLastLoadError: () => lastLoadError,
    dispose: () => realInner.dispose(),
  };

  return createMixedModeStateProvider({ emulator, real, realServices });
}
