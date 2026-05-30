import { Command, Option } from 'commander';
import { withErrorHandling } from '../../utils/error-handler.js';
import {
  addAlbSpecificOptions,
  addCommonEcsServiceOptions,
  albStrategy,
  runEcsServiceEmulator,
  type EcsServiceEmulatorOptions,
} from './ecs-service-emulator.js';
import { cdkdExtraStateProviders } from './local-state-source.js';

/**
 * Cdkd-specific extension of cdk-local's `EcsServiceEmulatorOptions` carrying
 * the `--from-state` / `--state-bucket` / `--state-prefix` fields (cdkd's
 * S3-backed state source). cdk-local's option type already declares
 * `[key: string]: unknown`, so these fields ride through the engine and reach
 * cdkd's `fromStateFactory` (registered via `cdkdExtraStateProviders`) when
 * the engine calls `createLocalStateProvider` internally. `--from-cfn-stack`
 * + `--stack-region` are inherited from `addCommonEcsServiceOptions`; the
 * ALB-specific flags (`--lb-port` / `--tls` / `--tls-cert` / `--tls-key` /
 * `--no-verify-auth` / `--bearer-token`) ride through via
 * `EcsServiceEmulatorOptions`'s upstream declarations + `addAlbSpecificOptions`.
 */
export interface LocalStartAlbOptions extends EcsServiceEmulatorOptions {
  /**
   * `--from-state` — read cdkd's S3 state for the target stack and substitute
   * `Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::ImportValue` / `Fn::GetStackOutput`
   * intrinsics in the resolved ECS service container images, environment
   * variables, secrets, role ARNs, and volumes. Mutually exclusive with
   * `--from-cfn-stack`.
   */
  fromState: boolean;
  /** S3 bucket for `--from-state`. Falls back to CDKD_STATE_BUCKET / cdk.json. */
  stateBucket?: string;
  /** S3 key prefix for `--from-state` (commander always supplies the default). */
  statePrefix: string;
}

/**
 * `cdkl start-alb <Stack/Alb>` — Issue #86 v1. Names an
 * `AWS::ElasticLoadBalancingV2::LoadBalancer`, discovers the ECS service(s)
 * behind its HTTP `forward` listeners, boots their replicas, and stands up a
 * local front-door on each listener port that round-robins across the replicas.
 * The symmetric ALB counterpart of `start-api`.
 */
export function createLocalStartAlbCommand(): Command {
  // cdkd's `createLocalCommand` (in local-invoke.ts) sets `CDKD_EMBED_CONFIG`
  // once for the whole `cdkd local` command tree, so this factory must NOT
  // call `setEmbedConfig` itself — doing so would clobber cdkd's branding
  // back to cdk-local's `cdkl` defaults.
  const cmd = new Command('start-alb')
    .description(
      'Run an Application Load Balancer locally: name the ALB, and cdk-local boots the ECS ' +
        'service(s) behind its listeners and stands up a local front-door on each listener port ' +
        'that round-robins across the running replicas and routes its listener rules across the ' +
        'backing services — a stable host endpoint, like behind a real load balancer. The ' +
        'symmetric ALB counterpart of `start-api`. Each <target> accepts a CDK display path ' +
        '(MyStack/MyAlb) or stack-qualified logical ID; single-stack apps may omit the stack ' +
        'prefix. Supports HTTP and HTTPS listeners — by default a cloud-HTTPS listener is ' +
        'served over plain HTTP locally (with X-Forwarded-Proto: https preserved). Pass --tls ' +
        '(or --tls-cert / --tls-key) to terminate TLS locally with a self-signed or ' +
        'user-supplied cert. All six ALB rule-condition fields are honored ' +
        '(path-pattern / host-header / http-header / http-request-method / query-string / ' +
        'source-ip); forward (single and weighted), redirect, and fixed-response actions; and ' +
        'ECS or Lambda targets (a Lambda target group is invoked locally via the Lambda RIE). ' +
        'authenticate-cognito / authenticate-oidc actions enforce a local Bearer-JWT check ' +
        '(or AWSELBAuthSessionCookie pass-through) against the same JWKS / OIDC discovery URL ' +
        'the deployed ALB would; use --bearer-token <jwt> to inject a default token or ' +
        '--no-verify-auth to disable the guard. Omit <targets> in an interactive terminal to ' +
        'multi-select the load balancers from a list.'
    )
    .argument(
      '[targets...]',
      'One or more CDK display paths or stack-qualified logical IDs of the AWS::ElasticLoadBalancingV2::LoadBalancer resources to run (omit to multi-select interactively in a TTY)'
    )
    .addOption(
      new Option(
        '--from-state',
        "Read cdkd's S3 state for the target stack and substitute Ref / Fn::GetAtt / Fn::Sub / " +
          'Fn::ImportValue / Fn::GetStackOutput intrinsics in container images, environment ' +
          'variables, secrets, role ARNs, and volumes of the ECS services behind the ALB. ' +
          'Mutually exclusive with --from-cfn-stack.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--state-bucket <bucket>',
        'S3 bucket for --from-state. Falls back to CDKD_STATE_BUCKET env or cdk.json context.cdkd.stateBucket.'
      )
    )
    .addOption(
      new Option('--state-prefix <prefix>', 'S3 key prefix for --from-state state files.').default(
        'cdkd'
      )
    )
    .action(
      withErrorHandling(async (targets: string[], options: LocalStartAlbOptions) => {
        await runEcsServiceEmulator(
          targets,
          options,
          albStrategy(options),
          cdkdExtraStateProviders
        );
      })
    );

  addAlbSpecificOptions(cmd);
  return addCommonEcsServiceOptions(cmd);
}
