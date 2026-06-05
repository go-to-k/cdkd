import { Option, type Command } from 'commander';
import {
  createLocalStartAgentCoreCommand as createCdkLocalStartAgentCoreCommand,
  getEmbedConfig,
} from 'cdk-local';
import { cdkdExtraStateProviders } from './local-state-source.js';

/**
 * `cdkd local start-agentcore <target>` — long-running serve for a Bedrock
 * AgentCore Runtime's bidirectional `/ws` WebSocket endpoint. Boots the
 * `AWS::BedrockAgentCore::Runtime` container (same image / env / credential
 * resolution as `invoke-agentcore`) and fronts its `/ws` endpoint with a host
 * WebSocket bridge that injects the AgentCore session-id (and `Authorization`
 * under a `customJwtAuthorizer`) on the container upgrade, so a header-less
 * client (e.g. a browser) can hold an interactive multi-frame session. HTTP /
 * AGUI protocols only. The serve counterpart of the single-shot
 * `cdkd local invoke-agentcore`. Inherited from cdk-local
 * (go-to-k/cdk-local#420).
 *
 * Like `start-cloudfront`, this is a THIN pass-through to cdk-local's factory —
 * the serve behavior and the `start-agentcore`-only option block (`--port` /
 * `--host` / `--session-id` / `--bearer-token` / `--no-verify-auth` /
 * `--env-vars` / `--platform` / `--no-pull` / `--no-build` / `--container-host`
 * / `--timeout` / `--assume-role` / `--ecr-role-arn` / `--from-cfn-stack` /
 * `--stack-region`) live in cdk-local's `addStartAgentCoreSpecificOptions` and
 * are auto-inherited.
 *
 * Like `start-cloudfront` / `start-alb` / `start-service`, this command binds
 * deployed state through cdk-local's `extraStateProviders` seam: the factory
 * accepts an `extraStateProviders` option (the same seam those commands use), so
 * cdkd threads its S3-backed `--from-state` factory in via
 * `cdkdExtraStateProviders` and layers the cdkd-specific `--from-state` /
 * `--state-bucket` / `--state-prefix` flags on top of cdk-local's inherited
 * `--from-cfn-stack` / `--stack-region` (issue #766; the `start-agentcore`
 * factory carried the seam from the start, the `start-cloudfront` factory gained
 * it in cdk-local 0.128.0). The factory's internal `createLocalStateProvider`
 * call picks cdkd's `fromState` factory transparently when `--from-state` is
 * passed.
 *
 * The active cdkd embed config is re-handed to the factory so branding stays
 * cdkd: cdk-local's factory calls `setEmbedConfig(opts.embedConfig)`, and
 * passing the current config (set once by `createLocalCommand` before the
 * subcommands are built) keeps it as a no-op re-set rather than a reset back to
 * cdk-local's `cdkl` defaults.
 */
export function createLocalStartAgentCoreCommand(): Command {
  const cmd = createCdkLocalStartAgentCoreCommand({
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
        'Fn::ImportValue / Fn::GetStackOutput intrinsics in the AgentCore runtime container image ' +
        'and environment variables. Mutually exclusive with --from-cfn-stack.'
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
