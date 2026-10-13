import type { CdkAppSynthesizer } from 'cdk-local';
import { Synthesizer } from '../../synthesis/synthesizer.js';

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
 */
export function cdkdHostSynthesizer(
  readOptions: () => { stateBucket?: string | undefined }
): CdkAppSynthesizer {
  return {
    synthesize: (opts) => {
      const { stateBucket } = readOptions();
      return new Synthesizer().synthesize({
        ...opts,
        ...(stateBucket !== undefined && { stateBucket }),
        ...(opts.profile !== undefined && { macroExpandS3ClientOpts: { profile: opts.profile } }),
      });
    },
  };
}
