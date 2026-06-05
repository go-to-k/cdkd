import type { Command } from 'commander';
import {
  createLocalStartCloudFrontCommand as createCdkLocalStartCloudFrontCommand,
  getEmbedConfig,
} from 'cdk-local';

/**
 * `cdkd local start-cloudfront <distribution>` — serve a CloudFront distribution
 * locally: its S3 origin content (resolved from the BucketDeployment source in
 * the cloud assembly) AND its Lambda Function URL origins (the backing Lambda is
 * run locally via RIE), plus its viewer-request / viewer-response CloudFront
 * Functions, reproducing the distribution routing so a rewrite / routing change
 * is verifiable in seconds. Inherited from cdk-local (go-to-k/cdk-local#363,
 * Lambda Function URL + deployed-S3 origins added in #380).
 *
 * Like the `start-agentcore` wrapper, this command is a THIN pass-through to
 * cdk-local's factory. The serve behavior and the option block (`--port` /
 * `--host` / `--origin <originId>=<dir>` / `--kvs-file` / `--cache-origin` /
 * `--no-pull` / `--tls` / `--tls-cert` / `--tls-key` / `--watch`, plus
 * cdk-local's own `--from-cfn-stack` / `--stack-region` / `--assume-role` for
 * binding a Function URL origin's backing Lambda + a deployed-S3 origin's bucket
 * name to deployed state) live in cdk-local and are auto-inherited.
 *
 * UNLIKE `start-agentcore` / `start-alb` / `start-service`, this command does
 * NOT thread cdkd's S3-backed `--from-state` source: cdk-local's
 * `CreateLocalStartCloudFrontCommandOptions` accepts only `embedConfig`, not the
 * `extraStateProviders` seam (the factory's internal `createLocalStateProvider`
 * calls pass no fourth argument). So `--from-state` / `--state-bucket` /
 * `--state-prefix` and `cdkdExtraStateProviders` threading are intentionally
 * absent here — start-cloudfront stays exempt from issue #766 until cdk-local
 * adds `extraStateProviders` to its start-cloudfront factory. Until then the
 * `--from-cfn-stack` flag (CloudFormation-backed deployed state) is the only
 * state source on this command.
 *
 * The active cdkd embed config is re-handed to the factory so branding stays
 * cdkd: cdk-local's factory calls `setEmbedConfig(opts.embedConfig)`, and
 * passing the current config (set once by `createLocalCommand` before the
 * subcommands are built) keeps it as a no-op re-set rather than a reset back to
 * cdk-local's `cdkl` defaults.
 */
export function createLocalStartCloudFrontCommand(): Command {
  return createCdkLocalStartCloudFrontCommand({ embedConfig: getEmbedConfig() });
}
