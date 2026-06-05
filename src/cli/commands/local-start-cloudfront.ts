import { Option, type Command } from 'commander';
import {
  createLocalStartCloudFrontCommand as createCdkLocalStartCloudFrontCommand,
  getEmbedConfig,
} from 'cdk-local';
import { cdkdExtraStateProviders } from './local-state-source.js';

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
 * As of cdk-local 0.128.0 (go-to-k/cdk-local#426 / #436) the start-cloudfront
 * factory accepts the `extraStateProviders` seam — the same one
 * `start-agentcore` / `start-alb` / `start-service` use — so cdkd now threads
 * its S3-backed `--from-state` factory in via `cdkdExtraStateProviders` and
 * layers the cdkd-specific `--from-state` / `--state-bucket` / `--state-prefix`
 * flags on top of cdk-local's inherited `--from-cfn-stack` / `--stack-region`
 * (issue #766). The factory's internal `createLocalStateProvider` calls pick
 * cdkd's `fromState` factory transparently when `--from-state` is passed, so a
 * Function URL origin's backing Lambda + a deployed-S3 origin's bucket name can
 * be bound to cdkd-managed state (after a prior `cdkd deploy`), not just to a
 * CloudFormation stack.
 *
 * The active cdkd embed config is re-handed to the factory so branding stays
 * cdkd: cdk-local's factory calls `setEmbedConfig(opts.embedConfig)`, and
 * passing the current config (set once by `createLocalCommand` before the
 * subcommands are built) keeps it as a no-op re-set rather than a reset back to
 * cdk-local's `cdkl` defaults.
 */
export function createLocalStartCloudFrontCommand(): Command {
  const cmd = createCdkLocalStartCloudFrontCommand({
    embedConfig: getEmbedConfig(),
    extraStateProviders: cdkdExtraStateProviders,
  });

  // Layer cdkd's S3-backed state-source flags on top of cdk-local's inherited
  // `--from-cfn-stack` / `--stack-region`. These ride through cdk-local's
  // `LocalStateSourceOptions` index signature and reach `cdkdExtraStateProviders`'
  // `fromState` factory when the factory's `createLocalStateProvider` runs.
  cmd.addOption(
    new Option(
      '--from-state',
      "Read cdkd's S3 state for the target stack and substitute Ref / Fn::GetAtt / Fn::Sub / " +
        'Fn::ImportValue / Fn::GetStackOutput intrinsics when binding a Lambda Function URL ' +
        "origin's backing Lambda and a deployed-S3 origin's bucket name. Mutually exclusive with " +
        '--from-cfn-stack.'
    ).default(false)
  );
  cmd.addOption(
    new Option(
      '--state-bucket <bucket>',
      'S3 bucket for --from-state. Falls back to CDKD_STATE_BUCKET env or cdk.json context.cdkd.stateBucket.'
    )
  );
  cmd.addOption(
    new Option('--state-prefix <prefix>', 'S3 key prefix for --from-state state files.').default(
      'cdkd'
    )
  );

  return cmd;
}
