import { readFileSync } from 'node:fs';

import {
  resolveAwsEmulatorOption,
  resolveWorkloadAwsWiring,
  setActiveWorkloadAwsWiring,
  setAwsEndpointOverride,
} from 'cdk-local/internal';

import { safeMsg } from '../utils/display-safe.js';
import { CdkdError } from '../utils/error-handler.js';
import { getLogger } from '../utils/logger.js';

/**
 * Activate `--aws-emulator` for a NON-local command (go-to-k/cdkd#6138): the
 * same discovery as `cdkd local` (#6132) — the `/__admin/health` probe, the
 * run's keys (or the auth-off placeholders) and CA under
 * `~/.aws/emulator/<port>/` — installed as cdk-local's endpoint override,
 * which every cdkd client follows through `awsClientDefaults`.
 *
 * Not `activateLocalAwsWiring`: that one speaks for `cdkd local` (its error
 * code, and cdk-local's "...and every workload container" line), while these
 * commands run no workload container.
 */
export async function activateAwsEmulatorForCommand(
  flag: string | boolean | undefined
): Promise<void> {
  try {
    const wiring = await resolveWorkloadAwsWiring({
      awsEmulator: resolveAwsEmulatorOption(flag),
      // No workload container is started, so nothing is pulled.
      skipPull: true,
    });
    // Held so its exit hook disposes the CA / trust-store temp copies.
    setActiveWorkloadAwsWiring(wiring);
    const endpoint = wiring.emulatorEndpoint;
    if (wiring.mode !== 'emulator' || endpoint === undefined) {
      // Only reachable if the flag and cdk-local's resolver disagree: refuse
      // rather than run on with no override.
      throw new Error('--aws-emulator: the AWS Emulator wiring did not resolve to an endpoint.');
    }
    setAwsEndpointOverride({
      endpoint: endpoint.url,
      ...(wiring.caHostPath !== undefined && { caPem: readFileSync(wiring.caHostPath, 'utf8') }),
      ...(wiring.emulatorCredentials !== undefined && { credentials: wiring.emulatorCredentials }),
    });
    const url = endpoint.url;
    getLogger().info(safeMsg`Using AWS Emulator at ${url} for every AWS call.`);
  } catch (err) {
    throw new CdkdError(
      err instanceof Error ? err.message : String(err),
      'AWS_EMULATOR_UNAVAILABLE',
      err instanceof Error ? err : undefined
    );
  }
}
