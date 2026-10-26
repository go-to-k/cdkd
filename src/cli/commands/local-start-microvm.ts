import { Option, type Command } from 'commander';
import { cdkdHostSynthesizer } from './local-host-synthesizer.js';
import {
  createLocalStartMicrovmCommand as createCdkLocalStartMicrovmCommand,
  getEmbedConfig,
} from 'cdk-local';
import { cdkdExtraStateProviders } from './local-state-source.js';
import { adoptDeprecatedRegionFlag } from '../region-options.js';

/**
 * `cdkd local start-microvm <target>` — run AWS Lambda MicroVMs from an
 * `AWS::Lambda::MicrovmImage` locally: `docker build` of the image's code
 * artifact, `--count` containers driven through the `/ready` / `/validate` /
 * `/run` lifecycle hooks, and one front door per MicroVM with
 * `X-aws-proxy-port` / `lambda-microvms.port.N` routing and a suspend /
 * resume / terminate control endpoint. Inherited from cdk-local
 * (go-to-k/cdk-local#835, cdk-local 0.156.0).
 *
 * Like `start-web-function`, this is a THIN pass-through to cdk-local's
 * factory: the behavior and the option block (`--count` / `--run-hook-payload`
 * / `--run-hook-payload-file` / `--port` / `--host` / `--platform` /
 * `--proxy-port` / `--auto-resume` / `--no-build-cache` / `--env-vars` /
 * `--timeout` / `--assume-role <arn>` / `--from-cfn-stack` / `--stack-region`)
 * live in cdk-local's `addStartMicrovmSpecificOptions` and are auto-inherited.
 *
 * The factory accepts `extraStateProviders`, which its handler passes to
 * `resolveLambdaContainerEnv`, so cdkd's `--from-state` substitutes the image's
 * `EnvironmentVariables` intrinsics from cdkd's S3 state. There is no
 * state-resolved role: the execution role is a `run-microvm` parameter, not
 * part of the template, so cdk-local's `--assume-role` takes a REQUIRED ARN
 * and advertises no `--no-assume-role`, and cdkd registers none.
 *
 * The active cdkd embed config is re-handed to the factory so branding stays
 * cdkd (see `local-start-agentcore.ts`).
 */
export function createLocalStartMicrovmCommand(): Command {
  const cmd: Command = createCdkLocalStartMicrovmCommand({
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
      "Read cdkd's S3 state for the target stack and substitute Ref / Fn::GetAtt / Fn::Sub / " +
        'Fn::ImportValue / Fn::GetStackOutput intrinsics in the MicroVM image environment variables. ' +
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

  // cdk-local declares a visible `--region`; cdkd replaces it with its hidden
  // deprecated twin and folds it in a `preAction` hook (issue #2522).
  return adoptDeprecatedRegionFlag(cmd);
}
