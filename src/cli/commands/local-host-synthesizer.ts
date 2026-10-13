import type { CdkAppSynthesizer } from 'cdk-local';
import { Synthesizer } from '../../synthesis/synthesizer.js';
import {
  getAssumedRoleCredentials,
  setAssumedRoleCredentials,
} from '../../utils/aws-client-defaults.js';
import { getLogger } from '../../utils/logger.js';

/**
 * The synthesizer cdkd hands to the cdk-local commands it embeds
 * (`start-agentcore`, `start-cloudfront`, `start-service`, `start-alb`), so
 * they synthesize the CDK app with cdkd's own synthesizer, as every other
 * `cdkd local` command does, rather than cdk-local's toolkit-lib one.
 *
 * It adds what cdkd's `local invoke` passes and cdk-local's options do not
 * carry: the command's `--state-bucket` for a macro-bearing template too large
 * to expand inline, and the profile for that upload. `readOptions` is read at
 * synth time, after Commander has parsed the command's flags.
 *
 * `--verbose` raises cdk-local's logger only; cdkd's synthesizer logs through
 * cdkd's, so it is raised here too, or the app's output and the synth's debug
 * lines would be lost.
 *
 * `--role-arn` is assumed by cdk-local, which writes the role's credentials to
 * the `AWS_*` environment (channel 2 in `src/utils/role-arn.ts`). Under
 * `--profile` the SDK skips those, so cdkd's own clients in the synthesizer
 * (STS, the macro-expansion change set and upload) would run as the profile.
 * The role is therefore also published to them (channel 1), ONCE, from the
 * triple cdk-local wrote. cdkd's `applyRoleArnIfSet` is not used: run before
 * cdk-local's, it would make cdk-local snapshot the role as the caller's own
 * credentials and forward it into the user's container.
 */
export function cdkdHostSynthesizer(
  readOptions: () => {
    stateBucket?: string | undefined;
    verbose?: boolean | undefined;
    roleArn?: string | undefined;
  }
): CdkAppSynthesizer {
  return {
    synthesize: async (opts) => {
      const { stateBucket, verbose, roleArn } = readOptions();
      if (verbose === true) getLogger().setLevel('debug');
      // cdk-local's own rule for whether it assumed a role.
      if ((roleArn || process.env['CDKD_ROLE_ARN']) && getAssumedRoleCredentials() === undefined) {
        publishAssumedRoleFromEnv();
      }
      return new Synthesizer().synthesize({
        ...opts,
        ...(stateBucket !== undefined && { stateBucket }),
        ...(opts.profile !== undefined && { macroExpandS3ClientOpts: { profile: opts.profile } }),
      });
    },
  };
}

/** Channel 1 from the role triple cdk-local just wrote to the environment. */
function publishAssumedRoleFromEnv(): void {
  // cdkd-local-env-identity: read only, and only when `--role-arn` is set, so
  // the triple is the role cdk-local just assumed; it goes to cdkd's own
  // clients (channel 1), never into a container.
  const accessKeyId = process.env['AWS_ACCESS_KEY_ID'];
  const secretAccessKey = process.env['AWS_SECRET_ACCESS_KEY'];
  const sessionToken = process.env['AWS_SESSION_TOKEN'];
  if (!accessKeyId || !secretAccessKey || !sessionToken) {
    throw new Error(
      '--role-arn was given, but the assumed role left no session credentials in the environment; refusing to synthesize as another identity.'
    );
  }
  setAssumedRoleCredentials({ accessKeyId, secretAccessKey, sessionToken });
}
