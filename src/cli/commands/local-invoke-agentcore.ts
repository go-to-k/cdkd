import { Command, Option } from 'commander';
import { cliArgParser } from '../arg-parser.js';
import { addAwsEndpointOptions } from 'cdk-local/internal';
import { emulateRoleViaOption } from '../options/emulate-role-via.js';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  stateOptions,
  parseStackRegion,
} from '../options.js';
import { CdkdError, withErrorHandling } from '../../utils/error-handler.js';
import { localInvokeAgentCoreCommand } from './local-invoke-agentcore/command.js';
import type { LocalInvokeAgentCoreOptions } from './local-invoke-agentcore/types.js';

export {
  isAgentCoreWatchEligible,
  containerStartWait,
  bootAgentCoreContainer,
  rebuildAgentCoreContainer,
} from './local-invoke-agentcore/container.js';
export type { ContainerStartGuard } from './local-invoke-agentcore/container.js';
export {
  resolveInboundAuthorization,
  buildSigV4HeadersIfRequested,
  sigv4NoCredentialsRefusal,
  resolveHostCredentialsForSigV4,
} from './local-invoke-agentcore/sigv4.js';
export {
  resolveAgentCoreImage,
  resolveAgentCoreCodeImageFromS3,
  resolveFromS3BucketIntrinsic,
  buildAgentCoreImageContext,
} from './local-invoke-agentcore/image.js';
export {
  buildContainerEnv,
  applyAgentCoreCredentialEnv,
  assumeRoleFallbackWarning,
  resolveAssumeRoleArn,
  forwardAwsEnv,
} from './local-invoke-agentcore/env.js';
export {
  emitResult,
  emitWsResult,
  buildMcpRequest,
  emitMcpResult,
  buildA2aRequest,
  emitA2aResult,
  platformToArchitecture,
} from './local-invoke-agentcore/output.js';
export {
  readEvent,
  parseEvent,
  readStdinLines,
  WS_REPL_PROMPT,
  wrapWsOnMessage,
  readEnvOverridesFile,
} from './local-invoke-agentcore/event-input.js';

/**
 * Parser for `--timeout <ms>`. Accepts a positive integer; rejects 0,
 * negatives, fractions, and non-numeric input.
 */
export function parseTimeoutMs(raw: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new CdkdError(
      `--timeout must be a positive integer number of milliseconds (got '${raw}').`,
      'LOCAL_INVOKE_AGENTCORE_TIMEOUT_INVALID'
    );
  }
  return parsed;
}

export function createLocalInvokeAgentCoreCommand(): Command {
  // cdkd's `createLocalCommand` (in local-invoke.ts) sets `CDKD_EMBED_CONFIG`
  // once for the whole `cdkd local` command tree, so this factory must NOT
  // call `setEmbedConfig` itself — doing so would clobber cdkd's branding
  // back to cdk-local's `cdkl` defaults (the image-name `cdkl-invoke-...`
  // / `cliName` / etc. visible in error strings come from the shared
  // process-wide config).
  const cmd = new Command('invoke-agentcore')
    .description(
      'Run a Bedrock AgentCore Runtime container locally and invoke it once over its protocol ' +
        'contract: HTTP (POST /invocations + GET /ping on 8080) or MCP (POST /mcp Streamable HTTP ' +
        'on 8000). Resolves the AWS::BedrockAgentCore::Runtime, pulls/builds its container, injects ' +
        'env vars + AWS credentials, and prints the response. For an MCP runtime, runs the session ' +
        'handshake then sends one JSON-RPC request (tools/list by default, or the method/params from ' +
        '--event). Target accepts a CDK display path (MyStack/MyAgent) or stack-qualified logical ID ' +
        '(MyStack:MyAgentRuntime1234). Single-stack apps may omit the stack prefix. ' +
        'Omit <target> in an interactive terminal to pick from a list. ' +
        'Supports the container artifact and the CodeConfiguration managed-runtime artifact ' +
        '(fromCodeAsset, built from source) on the HTTP + MCP protocols; the agent calls real AWS for managed services.'
    )
    .argument(
      '[target]',
      'CDK display path or stack-qualified logical ID of the AgentCore Runtime to invoke (omit to pick interactively in a TTY)'
    )
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
        '--session-id <id>',
        'AgentCore runtime session id header value (default: a random UUID)'
      )
    )
    .addOption(
      new Option(
        '--ws',
        "Stream over the HTTP-protocol agent's bidirectional /ws WebSocket endpoint (on 8080) " +
          'instead of POST /invocations: send --event as the first frame and print every received ' +
          'frame to stdout until the agent closes. When stdin is a TTY, auto-enters a REPL — each ' +
          'typed line is sent as a follow-up text frame until Ctrl-D / agent close; pipe from ' +
          '/dev/null to force one-shot in a TTY. Ignored for an MCP runtime.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--watch',
        'Re-synth and reload the agent container on CDK source changes. ' +
          'Supported on the HTTP / AGUI protocols, both the --ws session AND the default one-shot ' +
          'POST /invocations (the reload re-runs the single shot). An interpreted-language source ' +
          'edit inside a CodeConfiguration source tree takes a soft-reload fast path (docker cp + ' +
          'docker restart, no rebuild); Dockerfile / compiled-source / asset-hash-changed / ' +
          'ambiguous edits force a full rebuild. For MCP / A2A runtimes --watch is a no-op WARN and ' +
          'the single shot proceeds.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--bearer-token <jwt>',
        'Bearer JWT to present when the runtime declares a customJwtAuthorizer. ' +
          'Verified against the runtime OIDC discovery URL (signature / issuer / expiry / ' +
          'audience) before the container starts, then forwarded to /invocations as ' +
          'Authorization: Bearer <jwt>.'
      )
    )
    .addOption(
      new Option(
        '--no-verify-auth',
        'Skip inbound JWT verification even when the runtime declares a customJwtAuthorizer ' +
          '(local-dev escape hatch). A --bearer-token, if given, is still forwarded.'
      )
    )
    .addOption(
      new Option(
        '--sigv4',
        'Sign the /invocations POST with AWS SigV4 (service bedrock-agentcore) using the resolved ' +
          'credentials, matching the cloud default when the runtime declares no customJwtAuthorizer. ' +
          'Opt-in: default unsigned. Mutually exclusive with --bearer-token; ignored on a JWT-protected runtime.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--platform <platform>',
        'docker --platform for the agent container (linux/amd64 or linux/arm64)'
      )
        .choices(['linux/amd64', 'linux/arm64'])
        .default('linux/arm64')
    )
    .addOption(
      new Option(
        '--no-pull',
        'Skip docker pull (use cached image) — no-op for the local-build path'
      )
    )
    .addOption(
      new Option(
        '--no-build',
        'Skip docker build on the local-asset path (use the previously-built tag). No-op for the ECR / registry pull paths.'
      )
    )
    .addOption(
      new Option('--container-host <host>', 'Host to bind the agent port to').default('127.0.0.1')
    )
    .addOption(
      new Option(
        '--timeout <ms>',
        'Per-request timeout in milliseconds. Applied to POST /invocations, POST /mcp, and the ' +
          '/ws open-to-close window. Raise this for long-running agent calls that exceed the default.'
      )
        .default(120000)
        .argParser(cliArgParser(parseTimeoutMs))
    )
    .addOption(
      new Option(
        '--assume-role [arn]',
        "Assume the runtime's execution role and forward STS-issued temp credentials to the container " +
          'so the agent runs with the deployed role. Three forms: ' +
          '(1) `--assume-role <arn>` assumes the explicit ARN; ' +
          "(2) `--assume-role` (bare) uses the runtime's RoleArn when it is a literal ARN; " +
          '(3) `--no-assume-role` opts out. ' +
          "Off by default — the developer's shell credentials are forwarded unchanged."
      )
    )
    // See the twin registration in `local-invoke.ts`: commander does not
    // synthesize `--no-assume-role` from `--assume-role [arn]`, so form (3)
    // advertised above only exists once it is declared (issue #2523).
    // Declared after the positive form, so absent still parses as `undefined`.
    .addOption(
      new Option(
        '--no-assume-role',
        "Explicitly opt out of assuming the runtime's execution role: forward your ambient AWS " +
          'credentials (or the --profile overlay) unchanged even when --from-state / --from-cfn-stack is set.'
      )
    )
    .addOption(emulateRoleViaOption('--assume-role'))
    .addOption(
      new Option(
        '--ecr-role-arn <arn>',
        'Role ARN to assume before authenticating against ECR for cross-account / centralized registries. ' +
          'A same-account pull in ANY region does not need this flag: the ECR client is built ' +
          "for the image URI's own region, so crossing a region costs nothing extra."
      )
    )
    .addOption(
      new Option(
        '--from-state',
        "Load cdkd's S3 state for the target stack and substitute Ref / Fn::GetAtt / Fn::Sub / Fn::ImportValue " +
          'in env vars with the deployed physical IDs / cross-stack exports. Mutually exclusive with --from-cfn-stack.'
      ).default(false)
    )
    .addOption(
      new Option(
        '--from-cfn-stack [cfn-stack-name]',
        'Read a deployed CloudFormation stack via ListStackResources and substitute Ref / Fn::ImportValue ' +
          'in env vars with the deployed physical IDs / exports. For CDK apps deployed via the upstream CDK CLI. ' +
          'Bare form uses the resolved stack name; pass an explicit value when the CFn stack name differs. ' +
          'Mutually exclusive with --from-state.'
      )
    )
    .addOption(
      new Option(
        '--stack-region <region>',
        'Region of the state record to read. Used with --from-cfn-stack as the CFn client region.'
      ).argParser(parseStackRegion)
    )
    .action(
      withErrorHandling(
        async (target: string | undefined, options: LocalInvokeAgentCoreOptions) => {
          await localInvokeAgentCoreCommand(target, options);
        }
      )
    );

  [...commonOptions, ...appOptions, ...contextOptions, ...stateOptions].forEach((opt) =>
    cmd.addOption(opt)
  );
  cmd.addOption(deprecatedRegionOption);
  // `--aws-emulator [url]` / `--ca-bundle <file>` (go-to-k/cdkd#6131, #6132),
  // the same spelling the cdk-local engine commands register.
  addAwsEndpointOptions(cmd);
  return cmd;
}
