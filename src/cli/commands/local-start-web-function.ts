import { Option, type Command } from 'commander';
import { cdkdHostSynthesizer } from './local-host-synthesizer.js';
import {
  createLocalStartWebFunctionCommand as createCdkLocalStartWebFunctionCommand,
  getEmbedConfig,
} from 'cdk-local';
import { cdkdExtraStateProviders } from './local-state-source.js';
import { adoptDeprecatedRegionFlag } from '../region-options.js';

/**
 * `cdkd local start-web-function <target>` — serve an AWS Lambda Web Function
 * (`AWS::Lambda::WebFunction` / `WebFunctionRevision` / `WebFunctionEndpoint`)
 * locally. The target resolves to ONE revision (the target revision, then
 * `--revision`, then the endpoint's highest weight, then the function's only
 * revision), whose code bundle from `cdk.out` runs in a container whose server
 * listens on `AWS_LAMBDA_HTTP_ENDPOINT`, published on a local port with the
 * revision's `ServiceConfig` environment. Inherited from cdk-local
 * (go-to-k/cdk-local#831, cdk-local 0.155.0).
 *
 * Like `start-agentcore` / `start-cloudfront`, this is a THIN pass-through to
 * cdk-local's factory: the serve behavior and the option block (`--revision` /
 * `--port` / `--host` / `--platform` / `--env-vars` / `--no-pull` /
 * `--timeout` / `--assume-role` / `--from-cfn-stack` / `--stack-region`) live
 * in cdk-local's `addStartWebFunctionSpecificOptions` and are auto-inherited.
 *
 * cdkd's `--from-state` reaches the revision through `extraStateProviders`:
 * cdk-local's handler passes the map to `resolveLambdaContainerEnv`, whose
 * `createLocalStateProvider` picks cdkd's S3 factory when `--from-state` is
 * set. The loaded record substitutes the revision's environment intrinsics AND
 * is what a bare `--assume-role` resolves `ServiceConfig.ExecutionRoleArn`'s
 * `Fn::GetAtt` / `Ref` against (a literal ARN is used as written).
 *
 * The active cdkd embed config is re-handed to the factory so branding stays
 * cdkd (see `local-start-agentcore.ts`).
 */
export function createLocalStartWebFunctionCommand(): Command {
  const cmd: Command = createCdkLocalStartWebFunctionCommand({
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
      "Read cdkd's S3 state for the target stack: substitute Ref / Fn::GetAtt / Fn::Sub / " +
        'Fn::ImportValue / Fn::GetStackOutput intrinsics in the revision environment variables, and ' +
        "resolve the revision's ServiceConfig.ExecutionRoleArn for a bare --assume-role. " +
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

  // Same as the siblings (issue #2523): commander synthesizes no negation for
  // an optional-value option, so cdk-local's advertised `--no-assume-role`
  // would be rejected by the parser without this. Added AFTER the inherited
  // positive form, so an absent flag still parses as `undefined`.
  cmd.addOption(
    new Option(
      '--no-assume-role',
      'Explicitly opt out of assuming the deployed execution role: forward your ambient AWS ' +
        'credentials (or the --profile overlay) unchanged, and suppress the "re-run with ' +
        '--assume-role" hint that omitting the flag prints when deployed state is loaded.'
    )
  );

  // cdk-local declares a visible `--region`; cdkd replaces it with its hidden
  // deprecated twin and folds it in a `preAction` hook (issue #2522).
  return adoptDeprecatedRegionFlag(cmd);
}
