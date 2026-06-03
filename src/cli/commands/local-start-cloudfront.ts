import type { Command } from 'commander';
import {
  createLocalStartCloudFrontCommand as createCdkLocalStartCloudFrontCommand,
  getEmbedConfig,
} from 'cdk-local';

/**
 * `cdkd local start-cloudfront <distribution>` — serve a CloudFront distribution
 * locally: its S3 origin content (resolved from the BucketDeployment source in
 * the cloud assembly) plus its viewer-request / viewer-response CloudFront
 * Functions, reproducing the distribution routing so a rewrite / routing change
 * is verifiable in seconds. Inherited from cdk-local (go-to-k/cdk-local#363).
 *
 * Unlike the `start-api` / `start-alb` / `start-service` wrappers, this command
 * is a THIN pass-through to cdk-local's factory and adds NO cdkd-specific
 * options. `start-cloudfront` is pure-local: it runs no container and makes no
 * AWS call (it serves the distribution's local BucketDeployment source + runs
 * CloudFront Functions in-process), so it declares NEITHER `--from-cfn-stack`
 * NOR `--assume-role`, and there is no deployed state to bind — hence no
 * `--from-state` / `--state-bucket` / `--state-prefix` options and no
 * `cdkdExtraStateProviders` threading. The flags it exposes are `--port` /
 * `--host` / `--origin <originId>=<dir>` / `--tls` / `--tls-cert` /
 * `--tls-key` / `--watch` plus the shared common / app / context / region /
 * profile options, all owned by cdk-local.
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
