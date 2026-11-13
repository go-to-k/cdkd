import { Command, Option } from 'commander';
import { addAwsEndpointOptions } from 'cdk-local/internal';
import { emulateRoleViaOption } from '../options/emulate-role-via.js';
import { mixedModeEmulatorOverride } from '../../local/local-aws-wiring.js';
import { setAwsEndpointOverrideSource } from '../../utils/aws-client-defaults.js';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  stateOptions,
  parseStackRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { terminalSafe } from '../../utils/display-safe.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { createLocalStartApiCommand } from './local-start-api.js';
import { createLocalRunTaskCommand } from './local-run-task.js';
import { createLocalStartServiceCommand } from './local-start-service.js';
import { createLocalInvokeAgentCoreCommand } from './local-invoke-agentcore.js';
import { createLocalStartAgentCoreCommand } from './local-start-agentcore.js';
import { createLocalStartAlbCommand } from './local-start-alb.js';
import { createLocalStartCloudFrontCommand } from './local-start-cloudfront.js';
import { createLocalStartWebFunctionCommand } from './local-start-web-function.js';
import { createLocalStartMicrovmCommand } from './local-start-microvm.js';
import { setEmbedConfig, type EmbedHostLogger } from 'cdk-local';
import { localInvokeCommand } from './local-invoke/command.js';

export { resolveContainerImagePlan, resolveInvokeTemplateEnv } from './local-invoke/command.js';
export type { InvokeTemplateEnvResult } from './local-invoke/command.js';
export {
  applyLambdaCredentialEnv,
  applyProfileCredentialsOverlay,
  forwardAwsEnv,
} from './local-invoke/credentials.js';
export { parseEvent } from './local-invoke/event.js';
export {
  classifyExecutionRoleArnFromState,
  maybeSuggestAssumeRole,
  resolveBareAssumeRoleFromState,
  resolveExecutionRoleArnFromState,
} from './local-invoke/execution-role.js';
export type { ExecutionRoleArnLookup } from './local-invoke/execution-role.js';
export {
  materializeLambdaLayers,
  materializeLambdaLayersIncludingArns,
  resolveTmpfsForLambda,
  resolveZipImagePlan,
} from './local-invoke/image-plan.js';
export { materializeInlineCode, resolveInlineCodeFilePath } from './local-invoke/inline-code.js';
export {
  envHasCrossStackIntrinsic,
  envHasIntrinsicValue,
  readEnvOverridesFile,
  resolvePseudoParametersForInvoke,
} from './local-invoke/template-env.js';

/** True while a line is being handed to cdkd's logger (re-entry guard). */
let hostLoggerForwarding = false;

/**
 * Hand one cdk-local line to cdkd's logger. A throw there (a `BigInt` or a
 * circular arg its `JSON.stringify` cannot render) or a re-entry falls back
 * to stderr, display-safe, with the args dropped. Never cdk-local's own
 * console path, which would put an `info` line on the reserved stdout. No
 * log-line masker is bound on `cdkd local` paths (the masker is deploy-side,
 * per resource), so the fallback skipping it loses nothing.
 */
function forwardToCdkdLogger(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  args: unknown[]
): void {
  if (!hostLoggerForwarding) {
    hostLoggerForwarding = true;
    try {
      getLogger()[level](message, ...args);
      return;
    } catch {
      // fall through to the stderr fallback
    } finally {
      hostLoggerForwarding = false;
    }
  }
  if (level === 'debug' && getLogger().getLevel() !== 'debug') return;
  console.error(terminalSafe(String(message)));
}

/**
 * cdk-local's own log lines, routed through cdkd's logger (go-to-k/cdkd#2429).
 * cdk-local ships a second `ConsoleLogger` whose `info` goes to stdout through
 * module state cdkd cannot reach, so without this a container-image
 * `cdkd local invoke ... | jq` got `Building container image ...` mixed into
 * the payload, and cdkd's `--verbose` never raised cdk-local's level (its
 * "logged at debug level under --verbose" pointers led nowhere). Each call
 * reads `getLogger()` at call time, so a later `setLogger` still applies; the
 * stdout reservation, level filter, sanitization and formatting are then
 * cdkd's. cdk-local skips the bridge while `CDKL_LOG_LEVEL` or
 * `CDKL_LOG_STREAM` is set (the variables its studio sets on its children), so
 * a user who exported either for standalone `cdkl` gets cdk-local's own
 * console logger back, stdout included.
 */
const CDKD_LOCAL_HOST_LOGGER: EmbedHostLogger = {
  debug: (message, ...args) => forwardToCdkdLogger('debug', message, args),
  info: (message, ...args) => forwardToCdkdLogger('info', message, args),
  warn: (message, ...args) => forwardToCdkdLogger('warn', message, args),
  error: (message, ...args) => forwardToCdkdLogger('error', message, args),
  setLevel: (level) => getLogger().setLevel(level),
  getLevel: () => getLogger().getLevel(),
};

/**
 * cdkd's branding for cdk-local's embed-config. cdkd re-exports cdk-local's
 * local-emulation leaf modules as shims (`runtime-image`, `websocket-*`,
 * `layer-arn-materializer`, etc.) but keeps its OWN `cdkd local` command tree,
 * so it does not go through cdk-local's command factories (which install the
 * config themselves). Without this, those bundled modules render cdk-local's
 * `cdkl` defaults in error strings / resource names. `createLocalCommand`
 * calls `setEmbedConfig(CDKD_EMBED_CONFIG)` once so they read cdkd's branding.
 */
const CDKD_EMBED_CONFIG = {
  cliName: 'cdkd local',
  binaryName: 'cdkd',
  productName: 'cdkd',
  resourceNamePrefix: 'cdkd-local',
  awsBindMountPath: '/cdkd-aws',
  envPrefix: 'CDKD',
  // cdkd follows cdk-local's SigV4 default: warn-and-pass on unverifiable
  // AWS_IAM SigV4, opt IN to fail-closed via `--strict-sigv4`. The previous
  // cdkd-divergent fail-closed default (security review #484) is dropped in
  // this PR to keep the shim surface consistent with upstream — see the
  // `feedback_shim_blocked_by_unadopted_semantic_divergence.md` memory rule
  // for the resolution history.
  sigV4StrictByDefault: false,
  sigV4OptFlag: '--strict-sigv4',
  // Every factory cdkd hands an `embedConfig` passes `getEmbedConfig()`, which
  // returns this logger too, so no later `setEmbedConfig` drops it.
  logger: CDKD_LOCAL_HOST_LOGGER,
  // cdkd's `--role-arn` is a DEPLOY identity: cdk-local resolves the emulated
  // workload's inputs as the caller, keeping the role for synth and the ECR
  // pull (go-to-k/cdkd#3240). Carried the same way as `logger` above.
  workloadIdentity: 'caller',
  // Full `--aws-emulator` mode's SQS sidecar (go-to-k/cdk-local#912, cdkd#6178):
  // AWS Emulator answers real-shaped queue URLs, which the JS SDK v3 follows
  // out of the emulator; a sidecar in each workload rewrites them. Safe for
  // cdkd because every forwarder cdkd starts itself takes its ports and
  // sidecar config from `loopbackForwarderPlan` (the ECS namespace owner), and
  // `runDetached` drops the sidecar's SQS endpoint on the host network.
  awsEmulatorSqsSidecar: true,
  // The deploy the `--aws-emulator` "no state source" hint names
  // (go-to-k/cdk-local#915, cdkd#6179): cdkd's deploy is top-level, not
  // `cdkd local deploy`.
  deployCommand: 'cdkd deploy',
} as const;

/**
 * Top-level `cdkd local` command. PR 1 added `invoke`; PR 8a adds
 * `start-api` (long-running HTTP server that maps API Gateway routes
 * to Lambda invocations). Both share the same Docker / RIE plumbing
 * under `src/local/`.
 */
export function createLocalCommand(): Command {
  // Install cdkd branding into cdk-local's embed-config before any shimmed
  // local-emulation module reads it. Idempotent + process-wide; one call
  // covers every `export { ... } from 'cdk-local'` shim cdkd mounts.
  setEmbedConfig(CDKD_EMBED_CONFIG);
  // cdkd's own AWS clients follow the `--aws-emulator` endpoint whichever
  // command activates it: cdkd's four commands through `activateLocalAwsWiring`,
  // the cdk-local engine commands inside cdk-local's own handler.
  // AWS Emulator mixed mode (go-to-k/cdkd#6150): the emulator is the default
  // there too, so a cdkd call fails closed onto it; an excepted call opts out
  // with `realAws`.
  setAwsEndpointOverrideSource(mixedModeEmulatorOverride);

  const local = new Command('local').description(
    'Local execution of Lambda functions (RIE) and ECS task definitions (Docker required)'
  );
  // The `--aws-emulator` value refusal runs in `buildProgram`'s `preAction`
  // hook for every subcommand, the cdk-local engine ones included
  // (go-to-k/cdkd#6132, moved there by #6138).

  const invoke = new Command('invoke')
    .description(
      'Run a Lambda function locally in a Docker container (RIE-backed). ' +
        'Target accepts a CDK display path (MyStack/MyApi/Handler) or stack-qualified logical ID ' +
        '(MyStack:MyApiHandler1234ABCD). Single-stack apps may omit the stack prefix.'
    )
    .argument('<target>', 'CDK display path or stack-qualified logical ID of the Lambda to invoke')
    .addOption(new Option('-e, --event <file>', 'JSON event payload file (default: {})'))
    .addOption(new Option('--event-stdin', 'Read event JSON from stdin').default(false))
    .addOption(
      new Option(
        '--env-vars <file>',
        'JSON env-var overrides (SAM-compatible: {"LogicalId":{"KEY":"VALUE"}})'
      )
    )
    .addOption(
      new Option(
        '--no-pull',
        'Skip docker pull (use cached image) — no-op for IMAGE local-build path; ' +
          '`docker build` does not pull base layers by default'
      )
    )
    .addOption(
      new Option(
        '--no-build',
        'Skip docker build on the IMAGE local-build path (use the previously-built tag). ' +
          'Requires the deterministic tag to already be in the local registry; errors with ' +
          'an actionable message when missing. No-op for ZIP Lambdas and the IMAGE ECR-pull path. ' +
          'Compatible with --no-pull.'
      )
    )
    .addOption(new Option('--debug-port <port>', 'Node --inspect-brk port (default: off)'))
    .addOption(
      new Option('--container-host <host>', 'Host to bind the RIE port to').default('127.0.0.1')
    )
    .addOption(
      new Option(
        '--assume-role [arn]',
        "Assume the Lambda's deployed execution role and forward STS-issued temp credentials " +
          "to the container so the handler runs with the deployed function's narrow permissions " +
          '(closes the "developer admin / function narrow" skew). Three forms: ' +
          '(1) `--assume-role <arn>` assumes the explicit ARN; ' +
          "(2) `--assume-role` (bare) auto-resolves the function's execution role ARN from cdkd " +
          'state (requires --from-state); ' +
          '(3) `--no-assume-role` explicitly opts out (forces dev creds even with --from-state). ' +
          "Off by default — when omitted, the developer's shell credentials are forwarded " +
          'unchanged (SAM-compatible default). STS failures degrade to a warn + dev-creds fallback.'
      )
    )
    // Commander does NOT synthesize a negation for `--assume-role [arn]`; it has
    // to be registered explicitly, and declaring it AFTER the positive form
    // leaves the positive form's default alone (absent stays `undefined`, which
    // is the SAM-compatible "pass dev creds through, but hint" branch). Without
    // this registration the `--no-assume-role` advertised in the help above was
    // rejected by the parser and every `assumeRole === false` arm was dead
    // (issue #2523).
    .addOption(
      new Option(
        '--no-assume-role',
        'Explicitly opt out of assuming the deployed execution role: forward your ambient AWS ' +
          'credentials (or the --profile overlay) even when --from-state is set, and suppress the ' +
          '"run with --assume-role" hint. Distinct from omitting the flag, which still prints that hint.'
      )
    )
    .addOption(emulateRoleViaOption('--assume-role'))
    .addOption(
      new Option(
        '--layer-role-arn <arn>',
        'Role to sts:AssumeRole before calling lambda:GetLayerVersion on every literal-ARN ' +
          'entry in Properties.Layers. Use only when the dev credentials cannot ' +
          'read the layer — typically cross-account layers. AWS-published public layers (e.g. ' +
          'Lambda Powertools) are readable from every account and need no role.'
      )
    )
    .addOption(
      new Option(
        '--ecr-role-arn <arn>',
        'Role ARN to assume before authenticating against ECR for cross-account / centralized ' +
          'registries. Issues sts:AssumeRole via the default credential chain and uses the ' +
          'temporary credentials for ecr:GetAuthorizationToken + docker pull. Required when the ' +
          'caller does not have direct cross-account access to the target repository. ' +
          'A same-account pull in ANY region does not need this flag: the ECR client is built ' +
          "for the image URI's own region, so crossing a region costs nothing extra."
      )
    )
    .addOption(
      new Option(
        '--from-state',
        'Read cdkd S3 state for the target stack and substitute Ref / Fn::GetAtt / Fn::Sub ' +
          'in env vars with the deployed physical IDs / attributes. ' +
          'Off by default — keep PR 1 warn-and-drop semantics; turn on for stacks already deployed via cdkd deploy.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--from-cfn-stack [cfn-stack-name]',
        'Read a deployed CloudFormation stack via ListStackResources and substitute Ref / Fn::ImportValue ' +
          'in env vars with the deployed physical IDs / exports. Use for CDK apps deployed via the upstream ' +
          'CDK CLI (`cdk deploy`). Bare form uses the cdkd stack name; pass an explicit value when CFn stack name differs. ' +
          'Mutually exclusive with --from-state. Fn::GetAtt is warn-and-dropped in v1 (CFn ListStackResources does not return per-attribute values).'
      )
    )
    .addOption(
      new Option(
        '--stack-region <region>',
        'Region of the state record to read. Used with --from-state when the same stack name has state in multiple regions, ' +
          'and with --from-cfn-stack as the CFn client region (cdkd does not have a separate --cfn-stack-region flag).'
      ).argParser(parseStackRegion)
    )
    .action(withErrorHandling(localInvokeCommand));

  // Reuse standard option blocks. State options are added so --from-state
  // can read the cdkd state bucket (PR 2).
  [...commonOptions, ...appOptions, ...contextOptions, ...stateOptions].forEach((opt) =>
    invoke.addOption(opt)
  );
  invoke.addOption(deprecatedRegionOption);
  // `--aws-emulator [url]` / `--ca-bundle <file>` (go-to-k/cdkd#6131, #6132),
  // the same spelling the cdk-local engine commands register.
  addAwsEndpointOptions(invoke);

  local.addCommand(invoke);
  local.addCommand(createLocalStartApiCommand());
  local.addCommand(createLocalRunTaskCommand());
  local.addCommand(createLocalStartServiceCommand());
  local.addCommand(createLocalInvokeAgentCoreCommand());
  local.addCommand(createLocalStartAgentCoreCommand());
  local.addCommand(createLocalStartAlbCommand());
  local.addCommand(createLocalStartCloudFrontCommand());
  local.addCommand(createLocalStartWebFunctionCommand());
  local.addCommand(createLocalStartMicrovmCommand());
  return local;
}
