import { Option, type Command } from 'commander';
import { cdkdHostSynthesizer } from './local-host-synthesizer.js';
import {
  createLocalStartCloudFrontCommand as createCdkLocalStartCloudFrontCommand,
  getEmbedConfig,
} from 'cdk-local';
import { cdkdExtraStateProviders } from './local-state-source.js';
import { adoptDeprecatedRegionFlag } from '../region-options.js';

/**
 * `cdkd local start-cloudfront <distribution>` — serve a CloudFront distribution
 * locally: its S3 origin content (resolved from the BucketDeployment source in
 * the cloud assembly), its Lambda Function URL origins (the backing Lambda is
 * run locally via RIE) AND its Lambda Web Function endpoint origins (the
 * endpoint's revision run as `start-web-function` runs it), plus its
 * viewer-request / viewer-response CloudFront Functions, reproducing the
 * distribution routing so a rewrite / routing change is verifiable in seconds.
 * Inherited from cdk-local (go-to-k/cdk-local#363, Lambda Function URL +
 * deployed-S3 origins added in #380, Web Function endpoint origins in #842 /
 * cdk-local 0.157.0, cdkd #5516).
 *
 * Like the `start-agentcore` wrapper, this command is a THIN pass-through to
 * cdk-local's factory. The serve behavior and the option block (`--port` /
 * `--host` / `--origin <originId>=<dir>` / `--kvs-file` / `--cache-origin` /
 * `--no-pull` / `--tls` / `--tls-cert` / `--tls-key` / `--watch`, plus
 * cdk-local's own `--from-cfn-stack` / `--stack-region` / `--assume-role` for
 * binding a Function URL origin's backing Lambda, a Web Function endpoint
 * origin's revision + a deployed-S3 origin's bucket name to deployed state)
 * live in cdk-local and are auto-inherited.
 *
 * `--region` is the ONE inherited option cdkd replaces rather than accepts as
 * given: cdk-local declares it visibly and undeprecated, while every other cdkd
 * command carries the hidden, warned, folded `deprecatedRegionOption`. See
 * {@link adoptDeprecatedRegionFlag} — the flag keeps working, disappears from
 * `--help`, prints the removal warning, and (the reason it exists) is folded to
 * its canonical spelling before cdk-local's handler builds an SDK client from it
 * ([#2522](https://github.com/go-to-k/cdkd/issues/2522)).
 *
 * ## cdkd's state-source flags
 *
 * cdkd's S3-backed `--from-state` / `--state-bucket` / `--state-prefix` ride
 * through cdk-local's `LocalStateSourceOptions` index signature to
 * `cdkdExtraStateProviders`' `fromState` factory, which cdk-local consults on
 * every state-backed path of this command: the deployed-S3 origin, the
 * `cf.kvs()` bindings and the Function URL / Web Function endpoint /
 * Lambda@Edge container environment (go-to-k/cdk-local#699, cdk-local
 * 0.151.0; the Web Function endpoint origin since cdk-local 0.157.0). Until
 * that release these flags parsed and did nothing here, so they were refused
 * ([#2528](https://github.com/go-to-k/cdkd/issues/2528)); the refusal is gone
 * ([#2600](https://github.com/go-to-k/cdkd/issues/2600)).
 *
 * The active cdkd embed config is re-handed to the factory so branding stays
 * cdkd: cdk-local's factory calls `setEmbedConfig(opts.embedConfig)`, and
 * passing the current config (set once by `createLocalCommand` before the
 * subcommands are built) keeps it as a no-op re-set rather than a reset back to
 * cdk-local's `cdkl` defaults.
 */
export function createLocalStartCloudFrontCommand(): Command {
  const cmd: Command = createCdkLocalStartCloudFrontCommand({
    embedConfig: getEmbedConfig(),
    extraStateProviders: cdkdExtraStateProviders,
    synthesizer: cdkdHostSynthesizer(() =>
      cmd.opts<{ stateBucket?: string; verbose?: boolean; roleArn?: string }>()
    ),
  });

  // Layer cdkd's S3-backed state-source flags on top of cdk-local's inherited
  // `--from-cfn-stack` / `--stack-region` (see the module doc).
  cmd.addOption(
    new Option(
      '--from-state',
      "Read cdkd's S3 state for the target stack: resolve a deployed S3 origin's bucket and the " +
        'KeyValueStores cf.kvs() reads, and substitute Ref / Fn::GetAtt / Fn::Sub / Fn::ImportValue / ' +
        'Fn::GetStackOutput intrinsics in the Function URL origin, Web Function endpoint origin and ' +
        'Lambda@Edge environment variables. ' +
        'Mutually exclusive with --from-cfn-stack.'
    ).default(false)
  );
  cmd.addOption(
    new Option(
      '--state-bucket <bucket>',
      'S3 bucket for --from-state. Falls back to CDKD_STATE_BUCKET env or cdk.json context.cdkd.stateBucket. ' +
        'Also receives the transient upload of a CloudFormation-macro template too large to expand inline.'
    )
  );
  cmd.addOption(
    new Option('--state-prefix <prefix>', 'S3 key prefix for --from-state state files.').default(
      'cdkd'
    )
  );

  // cdk-local's own `--assume-role [arn]` help advertises `(3) --no-assume-role`
  // and its resolver is already written for it (`assumeRole !== true` returns no
  // ARN, and the "run with --assume-role" hint is gated on `=== undefined`), but
  // commander synthesizes no negation for an optional-value option — so the flag
  // was rejected by the parser and the `false` arm unreachable. Registering it
  // here makes the inherited advertisement true (issue #2523). Added AFTER the
  // inherited positive form, so an absent flag still parses as `undefined`.
  cmd.addOption(
    new Option(
      '--no-assume-role',
      'Explicitly opt out of assuming the deployed execution role: forward your ambient AWS ' +
        'credentials (or the --profile overlay) unchanged, and suppress the "re-run with ' +
        '--assume-role" hint that omitting the flag prints when deployed state is loaded.'
    )
  );

  return adoptDeprecatedRegionFlag(cmd);
}
