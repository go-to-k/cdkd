import { Command, Option } from 'commander';
import { cliArgParser } from '../arg-parser.js';
import { addAwsEndpointOptions } from 'cdk-local/internal';
import { emulateRoleViaOption } from '../options/emulate-role-via.js';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  parseAssumeRoleToken,
  stateOptions,
  type AssumeRoleOption,
  parseStackRegion,
} from '../options.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { localStartApiCommand } from './local-start-api/command.js';

export { formatServerListeningBanner } from './local-start-api/command.js';
export {
  installFatalShutdownHandlers,
  targetStackHint,
  pickTargetStacks,
  shouldEmitFromCfnRedundancyTip,
  tryEmitFromCfnRedundancyTipOnce,
} from './local-start-api/targets.js';
export {
  servedLambdaKey,
  groupStackName,
  perStack,
  assertServedLogicalIdsUnambiguous,
} from './local-start-api/served-lambdas.js';
export { warnVpcConfigLambdas } from './local-start-api/startup-warnings.js';
export {
  resolveStartApiAssumeRoleArn,
  dynamicReferenceSpecOptions,
} from './local-start-api/assume-role.js';
export {
  buildContainerSpec,
  resolveContainerImageForStartApi,
  materializeLambdaLayers,
} from './local-start-api/container-spec.js';
export { resolveLambdaByLogicalId } from './local-start-api/lambda-resolver.js';
export type { ResolvedStartApiImageLambda } from './local-start-api/lambda-resolver.js';
export {
  materializeInlineCode,
  readEnvOverridesFile,
  forwardAwsEnv,
} from './local-start-api/env.js';
export {
  resolveProfileCredentials,
  forceExitShutdownWarning,
  assumeLambdaExecutionRole,
} from './local-start-api/credentials.js';
export {
  attachStageContextPerStack,
  buildCorsConfigByStack,
  buildServedLambdaSpecs,
  filterSpecsForGroup,
  filterSpecsForWebSocketApi,
  corsConfigForGroup,
  printPerServerRouteTables,
} from './local-start-api/servers.js';
export { reloadAllServers } from './local-start-api/reload.js';
export {
  envHasIntrinsicValue,
  loadStateForRoutedStacks,
  resolvePseudoParametersForStartApi,
} from './local-start-api/state.js';
export { resolveMtlsConfig } from './local-start-api/flags.js';

/**
 * Builder for the `start-api` subcommand. Wired up by `local.ts`.
 */
export function createLocalStartApiCommand(): Command {
  const startApi = new Command('start-api')
    .description(
      'Run a long-running local HTTP server that maps API Gateway routes (REST v1, HTTP API, Function URL) to Lambda invocations against the AWS Lambda Runtime Interface Emulator (Docker required). Supports Lambda TOKEN/REQUEST authorizers, Cognito User Pool / HTTP v2 JWT authorizers, and AWS_IAM auth (REST v1 `AuthorizationType: AWS_IAM` and Function URL `AuthType: AWS_IAM` — SigV4 signature verification only; IAM policy evaluation is NOT emulated; see https://cdkd.dev/local-start-api/#aws-iam-authorization). When JWKS is unreachable, JWT authorizers fall back to pass-through (every token accepted) with a warn line — local dev fallback. VPC-config Lambdas run locally and surface a warn line at startup; their containers do NOT get attached to the deployed VPC subnets, so calls to private RDS / ElastiCache will fail.'
    )
    .argument(
      '[target]',
      "Optional API filter. Accepts the bare CDK logical id ('MyHttpApi'; single-stack apps only), stack-qualified logical id ('MyStack:MyHttpApi'), full CDK Construct path ('MyStack/MyHttpApi/Resource'), or an ancestor Construct path that prefix-matches ('MyStack/MyHttpApi'). When omitted, every discovered API gets its own server. Mirrors `cdkd local invoke` / `cdkd local run-task` target syntax."
    )
    .addOption(
      new Option('--port <port>', 'HTTP server port (default: auto-allocate)').default('0')
    )
    .addOption(new Option('--host <host>', 'Bind address').default('127.0.0.1'))
    .addOption(new Option('--stack <name>', 'Stack to start (single-stack apps auto-detect)'))
    .addOption(
      new Option('--warm', 'Pre-start one container per Lambda at server boot').default(false)
    )
    .addOption(
      new Option(
        '--per-lambda-concurrency <n>',
        'Pool size cap per Lambda (default 2, max 4)'
      ).default('2')
    )
    .addOption(new Option('--no-pull', 'Skip docker pull (cached image)'))
    .addOption(
      new Option(
        '--container-host <host>',
        'IP the host uses to bind/probe the RIE port (must be a numeric IP — `docker run -p <ip>:<port>:8080` rejects hostnames). Defaults to 127.0.0.1.'
      ).default('127.0.0.1')
    )
    .addOption(
      new Option(
        '--debug-port-base <port>',
        'Reserve a contiguous --debug-port range (one per Lambda)'
      )
    )
    .addOption(
      new Option(
        '--env-vars <file>',
        'JSON env-var overrides (SAM-compatible: {"LogicalId":{"KEY":"VALUE"}, "Parameters": {...}})'
      )
    )
    .addOption(
      new Option(
        '--assume-role <arn-or-pair>',
        "Assume the Lambda's execution role and forward STS-issued temp creds. Two forms: " +
          '(1) `--assume-role <arn>` sets a single global default ARN used for every routed Lambda; ' +
          '(2) `--assume-role <LogicalId>=<arn>` (repeatable) is a per-Lambda override (wins over the global default and over --assume-role-auto for the named Lambda). ' +
          'Pair with --assume-role-auto to auto-resolve every other Lambda. Precedence: per-Lambda > (--assume-role-auto OR global default) > unset (developer creds passed through).'
      ).argParser(
        cliArgParser((raw, prev: AssumeRoleOption | undefined) => parseAssumeRoleToken(raw, prev))
      )
    )
    .addOption(
      new Option(
        '--assume-role-auto',
        "Auto-resolve EACH routed Lambda's own execution role per-Lambda (literal ARN / Fn::GetAtt against template / --from-cfn-stack state). " +
          "Slower boot — one STS call per Lambda — but the right shape when each Lambda's deployed role differs. " +
          'Mutually exclusive with `--assume-role <arn>` (global default); errors at boot. ' +
          'Compatible with `--assume-role <LogicalId>=<arn>` per-Lambda overrides — the map wins for named Lambdas, auto-resolve handles the rest.'
      ).default(false)
    )
    .addOption(emulateRoleViaOption('--assume-role'))
    .addOption(
      new Option(
        '--watch',
        'Hot-reload: watch the CDK app source tree and re-synth + re-discover routes on a source edit (cdk.out / node_modules / .git excluded; honors cdk.json watch.include / watch.exclude). Off by default; the server keeps the previous version serving when synth fails mid-reload.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--stage <name>',
        "Select an API Gateway Stage by its 'StageName'. Default: the first Stage attached to each API. Drives BOTH event.stageVariables and requestContext.stage, for REST v1 and HTTP API v2 alike: when a route's API has a matching templated Stage, the selected StageName is threaded into requestContext.stage. An HTTP API v2 route reports '$default' only when its API carries no AWS::ApiGatewayV2::Stage in the template — that is v2's auto-deployed stage, not a limit on what this flag can select (AWS's CreateStage accepts named stages on v2 too). An API with no Stage matching the selected name is warned about at start-up and its routes get stageVariables: null."
      )
    )
    .addOption(
      new Option(
        '--api <id>',
        'DEPRECATED — use the positional <target> argument instead. Same accepted forms (bare logical id, stack-qualified, Construct path, ancestor prefix). Will be removed in a future major release.'
      )
    )
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
        '--from-state',
        'Read cdkd S3 state for every routed stack and substitute Ref / Fn::GetAtt / Fn::Sub / Fn::Join ' +
          '(and AWS pseudo parameters) in Lambda env vars with the deployed physical IDs / attributes. ' +
          'Off by default — pre-PR warn-and-drop semantics are preserved. Turn on for stacks already deployed via cdkd deploy. ' +
          'Mirrors `cdkd local invoke --from-state` / `cdkd local run-task --from-state`. ' +
          'Re-runs against fresh state on every hot-reload firing (--watch).'
      ).default(false)
    )
    .addOption(
      new Option(
        '--from-cfn-stack [cfn-stack-name]',
        'Read a deployed CloudFormation stack via ListStackResources and substitute Ref / Fn::ImportValue ' +
          'in Lambda env vars with the deployed physical IDs / exports. ' +
          'Use for CDK apps deployed via the upstream CDK CLI (`cdk deploy`). ' +
          'Bare form uses the cdkd stack name per routed stack; pass an explicit value when a single CFn stack should serve every routed stack. ' +
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
    .addOption(
      new Option(
        '--mtls-truststore <path>',
        'PEM-encoded CA bundle for client-certificate verification (mutual TLS). ' +
          'When set, the local server switches from HTTP to HTTPS and the TLS handshake rejects ' +
          "clients whose certificate doesn't chain to one of these CAs. Verified certs are surfaced " +
          'on the Lambda event under requestContext.identity.clientCert (REST v1) / ' +
          'requestContext.authentication.clientCert (HTTP API v2). Must be set together with ' +
          '--mtls-cert + --mtls-key; partial flag sets are rejected. ' +
          'Generate a CA + server + client cert for local dev: ' +
          'openssl req -x509 -newkey rsa:2048 -nodes -keyout ca-key.pem -out ca.pem -subj "/CN=cdkd-local-ca" -days 365; ' +
          'openssl req -newkey rsa:2048 -nodes -keyout server-key.pem -out server-csr.pem -subj "/CN=localhost"; ' +
          'openssl x509 -req -in server-csr.pem -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out server-cert.pem -days 365; ' +
          'openssl req -newkey rsa:2048 -nodes -keyout client-key.pem -out client-csr.pem -subj "/CN=client"; ' +
          'openssl x509 -req -in client-csr.pem -CA ca.pem -CAkey ca-key.pem -CAcreateserial -out client-cert.pem -days 365; ' +
          'curl --cacert ca.pem --cert client-cert.pem --key client-key.pem https://localhost:<port>/...'
      )
    )
    .addOption(
      new Option(
        '--mtls-cert <path>',
        'PEM-encoded server certificate for mutual TLS. Self-signed is fine for local dev. ' +
          'Must be set together with --mtls-truststore + --mtls-key.'
      )
    )
    .addOption(
      new Option(
        '--mtls-key <path>',
        'PEM-encoded server private key matching --mtls-cert. ' +
          'Must be set together with --mtls-truststore + --mtls-cert.'
      )
    )
    .addOption(
      new Option(
        '--strict-sigv4',
        'Opt-in: enforce strict AWS_IAM SigV4 verification. When set, requests whose signature ' +
          'cannot be cryptographically verified (foreign access-key-id, OR no local AWS credentials ' +
          'configured) are denied. DEFAULT off — warn-and-pass with a placeholder principalId, ' +
          "matching cdk-local's `cdkl start-api`. Enable this when you want local parity with the " +
          "deployed API Gateway's signature enforcement."
      ).default(false)
    )
    .action(withErrorHandling(localStartApiCommand));

  [...commonOptions, ...appOptions, ...contextOptions, ...stateOptions].forEach((opt) =>
    startApi.addOption(opt)
  );
  startApi.addOption(deprecatedRegionOption);
  // `--aws-emulator [url]` / `--ca-bundle <file>` (go-to-k/cdkd#6131, #6132),
  // the same spelling the cdk-local engine commands register.
  addAwsEndpointOptions(startApi);

  return startApi;
}
