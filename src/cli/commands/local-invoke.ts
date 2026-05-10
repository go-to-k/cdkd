import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Command, Option } from 'commander';
import {
  appOptions,
  commonOptions,
  contextOptions,
  deprecatedRegionOption,
  parseContextOptions,
  warnIfDeprecatedRegion,
} from '../options.js';
import { getLogger } from '../../utils/logger.js';
import { applyRoleArnIfSet } from '../../utils/role-arn.js';
import { withErrorHandling } from '../../utils/error-handler.js';
import { Synthesizer, type SynthesisOptions } from '../../synthesis/synthesizer.js';
import { resolveApp } from '../config-loader.js';
import { resolveLambdaTarget } from '../../local-invoke/lambda-resolver.js';
import { resolveEnvVars, type EnvOverrideFile } from '../../local-invoke/env-resolver.js';
import {
  resolveRuntimeFileExtension,
  resolveRuntimeImage,
} from '../../local-invoke/runtime-image.js';
import {
  ensureDockerAvailable,
  pickFreePort,
  pullImage,
  removeContainer,
  runDetached,
  streamLogs,
} from '../../local-invoke/docker-runner.js';
import { invokeRie, waitForRieReady } from '../../local-invoke/rie-client.js';

interface LocalInvokeOptions {
  app?: string;
  output: string;
  verbose: boolean;
  region?: string;
  profile?: string;
  roleArn?: string;
  context?: string[];
  event?: string;
  eventStdin?: boolean;
  envVars?: string;
  /**
   * Commander maps `--no-pull` to `pull: boolean` (default `true`). When
   * the user passes `--no-pull` the value flips to `false` and we skip
   * `docker pull`. Naming-wise `pull` reads as "should pull" so the
   * skip-when-false logic stays the right way around.
   */
  pull: boolean;
  debugPort?: string;
  containerHost: string;
  /**
   * Q1 recommendation B: optional Lambda execution role to assume before
   * invoking. When set, cdkd calls `sts:AssumeRole` against this ARN and
   * forwards the resulting temporary credentials into the container so
   * the handler runs under the deployed function's narrow permissions
   * (instead of the developer's typically-admin shell credentials). PR 1
   * accepts an explicit ARN only — auto-resolution from the template's
   * `Role` property requires `--from-state` (PR 2). Off by default.
   */
  assumeRole?: string;
}

/**
 * `cdkd local invoke <target>` — run a Lambda function locally inside a
 * Docker container that bundles the AWS Lambda Runtime Interface
 * Emulator (RIE). Modeled on `sam local invoke` but reusing cdkd's
 * synthesis / asset / construct-path plumbing.
 *
 * v1 scope: Node.js runtimes only, literal env vars only, Docker
 * required. See [docs/cli-reference.md](../../../docs/cli-reference.md)
 * for the full surface and out-of-scope items.
 */
async function localInvokeCommand(target: string, options: LocalInvokeOptions): Promise<void> {
  const logger = getLogger();
  if (options.verbose) {
    logger.setLevel('debug');
  }

  warnIfDeprecatedRegion(options);

  // The role-arn helper accepts an optional region for the SDK fallback;
  // any AWS calls invoked indirectly (e.g. STS during synthesis context
  // probing) will pick up the assumed credentials.
  await applyRoleArnIfSet({ roleArn: options.roleArn, region: options.region });

  await ensureDockerAvailable();

  // Synthesize. Default is "synth every time" (Q2 recommendation C):
  // safe-by-default, with `-a/--app cdk.out` as the explicit opt-out
  // for the watch / fast-path use case.
  const appCmd = resolveApp(options.app);
  if (!appCmd) {
    throw new Error('No CDK app specified. Pass --app, set CDKD_APP, or add "app" to cdk.json.');
  }

  logger.info('Synthesizing CDK app...');
  const synthesizer = new Synthesizer();
  const context = parseContextOptions(options.context);
  const synthOpts: SynthesisOptions = {
    app: appCmd,
    output: options.output,
    ...(options.region && { region: options.region }),
    ...(options.profile && { profile: options.profile }),
    ...(Object.keys(context).length > 0 && { context }),
  };
  const { stacks } = await synthesizer.synthesize(synthOpts);

  const lambda = resolveLambdaTarget(target, stacks);
  logger.info(`Target: ${lambda.stack.stackName}/${lambda.logicalId} (${lambda.runtime})`);

  // Prepare the local code directory the container will bind-mount at
  // /var/task. Asset-backed Lambdas point at an unzipped CDK directory
  // already; inline (Code.ZipFile) Lambdas need to materialize the
  // body to a temp dir using the runtime-appropriate file extension
  // (`.js` for Node.js, `.py` for Python).
  const codeDir =
    lambda.codePath ??
    materializeInlineCode(
      lambda.handler,
      lambda.inlineCode ?? '',
      resolveRuntimeFileExtension(lambda.runtime)
    );

  // Resolve env vars. Intrinsic-valued template entries are warned about
  // and dropped; the user can override them via --env-vars (SAM-shape).
  const overrides = readEnvOverridesFile(options.envVars);
  const envResult = resolveEnvVars(lambda.logicalId, getTemplateEnv(lambda.resource), overrides);
  for (const key of envResult.unresolved) {
    logger.warn(
      `Environment variable ${key} contains a CloudFormation intrinsic and was dropped. ` +
        `Override it with --env-vars (e.g. {"${lambda.logicalId}":{"${key}":"<literal>"}}) or wait for --from-state in PR 2.`
    );
  }

  // Read the event payload. Default to {} (matches SAM).
  const event = await readEvent(options);

  const image = resolveRuntimeImage(lambda.runtime);

  // Build the env that the container sees. Lambda runtime conventions:
  // we always pass the standard AWS_LAMBDA_* vars so context.* fields
  // inside the handler look real, and forward AWS credentials so SDK
  // calls can hit AWS from inside the handler.
  const dockerEnv: Record<string, string> = {
    AWS_LAMBDA_FUNCTION_NAME: lambda.logicalId,
    AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(lambda.memoryMb),
    AWS_LAMBDA_FUNCTION_TIMEOUT: String(lambda.timeoutSec),
    AWS_LAMBDA_FUNCTION_VERSION: '$LATEST',
    AWS_LAMBDA_LOG_GROUP_NAME: `/aws/lambda/${lambda.logicalId}`,
    AWS_LAMBDA_LOG_STREAM_NAME: 'local',
    ...envResult.resolved,
  };
  // Q1 recommendation B: if --assume-role is set, swap the developer's
  // credentials for STS-issued temporary credentials scoped to the
  // function's deployed execution role. Otherwise pass the developer's
  // creds through (SAM-compatible default). Region precedence mirrors
  // the rest of cdkd: --region > AWS_REGION > AWS_DEFAULT_REGION.
  if (options.assumeRole) {
    const stsRegion =
      options.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'];
    const creds = await assumeLambdaExecutionRole(options.assumeRole, stsRegion);
    dockerEnv['AWS_ACCESS_KEY_ID'] = creds.accessKeyId;
    dockerEnv['AWS_SECRET_ACCESS_KEY'] = creds.secretAccessKey;
    dockerEnv['AWS_SESSION_TOKEN'] = creds.sessionToken;
    if (stsRegion) dockerEnv['AWS_REGION'] = stsRegion;
  } else {
    forwardAwsEnv(dockerEnv);
  }

  // Optional inspector: --debug-port enables `node --inspect-brk` inside
  // the container. The Lambda Node.js base image's RIE entrypoint
  // forwards NODE_OPTIONS to node, so this is enough.
  let debugPort: number | undefined;
  if (options.debugPort) {
    debugPort = Number(options.debugPort);
    if (!Number.isInteger(debugPort) || debugPort <= 0 || debugPort > 65535) {
      throw new Error(`--debug-port must be an integer in 1..65535, got '${options.debugPort}'`);
    }
    dockerEnv['NODE_OPTIONS'] = `--inspect-brk=0.0.0.0:${debugPort}`;
  }

  // Commander surfaces `--no-pull` as `pull: false` (default `true`).
  await pullImage(image, options.pull === false);

  const hostPort = await pickFreePort();
  const containerHost = options.containerHost || '127.0.0.1';

  logger.info(`Starting container (image=${image}, port=${hostPort})...`);
  const containerId = await runDetached({
    image,
    mounts: [{ hostPath: codeDir, containerPath: '/var/task', readOnly: true }],
    env: dockerEnv,
    cmd: [lambda.handler],
    hostPort,
    host: containerHost,
    ...(debugPort !== undefined && { debugPort }),
  });

  // Stream the container's logs to the user's terminal so they see the
  // handler's stdout/stderr as it runs. The stop function is called from
  // the finally to detach before docker rm.
  const stopLogs = streamLogs(containerId);

  // Make sure SIGINT (^C) cleans up the container — the user expects
  // ^C to stop both the CLI AND the daemonized container in one shot.
  // process.on() expects a `void`-returning handler; wrap the async
  // cleanup in a non-async closure so the lint rule about
  // misused-promises doesn't fire.
  const sigintHandler = (): void => {
    stopLogs();
    void removeContainer(containerId).then(() => {
      process.exit(130);
    });
  };
  process.on('SIGINT', sigintHandler);

  try {
    await waitForRieReady(containerHost, hostPort, 5000);

    // Invoke timeout: 2x the function's Timeout, floor 30s. RIE doesn't
    // enforce the function's Timeout itself, but we cap the HTTP wait
    // so a hung handler doesn't block the CLI forever.
    const invokeTimeoutMs = Math.max(30_000, lambda.timeoutSec * 2 * 1000);
    const result = await invokeRie(containerHost, hostPort, event, invokeTimeoutMs);

    // Settle a few hundred ms so logs fully flush before we tear down.
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    process.stdout.write(`${result.raw}\n`);
  } finally {
    process.off('SIGINT', sigintHandler);
    stopLogs();
    await removeContainer(containerId);
  }
}

/**
 * Pull the function's `Properties.Environment.Variables` map (when
 * present). Type-narrowed at the boundary so the env-resolver can stay
 * pure and accept `Record<string, unknown>`.
 */
function getTemplateEnv(resource: {
  Properties?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  const props = resource.Properties ?? {};
  const env = props['Environment'];
  if (!env || typeof env !== 'object') return undefined;
  const vars = (env as Record<string, unknown>)['Variables'];
  if (!vars || typeof vars !== 'object') return undefined;
  return vars as Record<string, unknown>;
}

/**
 * Read the `--env-vars` JSON file. Returns `undefined` when the flag
 * was not passed; throws on parse failure with a clear pointer at the
 * file. SAM's accepted shape is loose; we only require it to be an
 * object at the top level.
 */
function readEnvOverridesFile(filePath: string | undefined): EnvOverrideFile | undefined {
  if (!filePath) return undefined;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read --env-vars file '${filePath}': ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse --env-vars file '${filePath}' as JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`--env-vars file '${filePath}' must contain a JSON object at the top level.`);
  }
  return parsed as EnvOverrideFile;
}

/**
 * Read the event payload from `--event <file>`, `--event-stdin`, or
 * default `{}`. JSON-validated at parse time so a typo doesn't reach
 * the handler as a string blob.
 */
async function readEvent(options: LocalInvokeOptions): Promise<unknown> {
  if (options.event && options.eventStdin) {
    throw new Error('--event and --event-stdin are mutually exclusive.');
  }
  if (options.eventStdin) {
    const raw = await readStdin();
    return parseEvent(raw, '<stdin>');
  }
  if (options.event) {
    const raw = readFileSync(options.event, 'utf-8');
    return parseEvent(raw, options.event);
  }
  return {};
}

function parseEvent(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse event payload from ${source} as JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Assume the Lambda execution role and return temporary credentials.
 *
 * Q1 recommendation B (PR 1): closes the "developer has admin creds, the
 * deployed function has narrow ones" skew that SAM users routinely hit.
 * Off by default; opt-in via `--assume-role <arn>`. PR 2's `--from-state`
 * will add auto-resolution from the template's `Role` property; for now
 * the user supplies the ARN explicitly.
 *
 * Mirrors the env-var-write pattern from `applyRoleArnIfSet` in
 * `src/utils/role-arn.ts` but writes the temp creds onto the container's
 * env block (not the cdkd process's env), so the developer's outer
 * shell credentials still flow into any cdkd-side AWS calls (synthesis
 * context probes, etc.).
 */
async function assumeLambdaExecutionRole(
  roleArn: string,
  region: string | undefined
): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string }> {
  const { STSClient, AssumeRoleCommand } = await import('@aws-sdk/client-sts');
  const sts = new STSClient({ ...(region && { region }) });
  try {
    const response = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: `cdkd-local-invoke-${Date.now()}`,
        DurationSeconds: 3600,
      })
    );
    const creds = response.Credentials;
    if (!creds?.AccessKeyId || !creds.SecretAccessKey || !creds.SessionToken) {
      throw new Error(`AssumeRole(${roleArn}) returned no usable credentials.`);
    }
    return {
      accessKeyId: creds.AccessKeyId,
      secretAccessKey: creds.SecretAccessKey,
      sessionToken: creds.SessionToken,
    };
  } finally {
    sts.destroy();
  }
}

/**
 * Forward the developer's AWS credentials into the container so the
 * handler's AWS SDK calls can authenticate. Used when `--assume-role`
 * is NOT set — SAM-compatible default.
 *
 * Region is inherited from `AWS_REGION` / `AWS_DEFAULT_REGION` so
 * `aws.config.region` inside the handler works without extra setup.
 */
function forwardAwsEnv(env: Record<string, string>): void {
  const passThrough = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
  ] as const;
  for (const key of passThrough) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
}

/**
 * Materialize an inline Lambda body (`Code.ZipFile`) to a tmpdir and
 * return the directory the container should mount at /var/task. The
 * filename is derived from the function's Handler property and the
 * runtime's source-file extension (`.js` for Node.js, `.py` for Python):
 *
 *   Handler "index.handler" + ext ".js"   → tmpdir/index.js
 *   Handler "index.handler" + ext ".py"   → tmpdir/index.py
 *   Handler "lib/handler.main" + ext ".js" → tmpdir/lib/handler.js
 *
 * (Drop the last segment, append the extension to the rest.)
 *
 * The Handler grammar is `<modulePath>.<funcName>` for both Node.js and
 * Python (the dot is the same module-vs-function separator), so the
 * parsing logic is identical across runtimes — only the file extension
 * varies.
 */
function materializeInlineCode(handler: string, source: string, fileExtension: string): string {
  const lastDot = handler.lastIndexOf('.');
  if (lastDot <= 0) {
    throw new Error(`Handler '${handler}' is malformed: expected '<modulePath>.<exportName>'.`);
  }
  const modulePath = handler.substring(0, lastDot);
  const dir = mkdtempSync(path.join(tmpdir(), 'cdkd-local-invoke-'));
  const filePath = path.join(dir, `${modulePath}${fileExtension}`);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, source, 'utf-8');
  return dir;
}

/**
 * Top-level `cdkd local` command. Currently has one subcommand
 * (`invoke`); reserves room for `cdkd local start-api` etc. in later
 * PRs (D3).
 */
export function createLocalCommand(): Command {
  const local = new Command('local').description(
    'Local Lambda execution against the AWS Lambda Runtime Interface Emulator (Docker required)'
  );

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
    .addOption(new Option('--no-pull', 'Skip docker pull (use cached image)'))
    .addOption(new Option('--debug-port <port>', 'Node --inspect-brk port (default: off)'))
    .addOption(
      new Option('--container-host <host>', 'Host to bind the RIE port to').default('127.0.0.1')
    )
    .addOption(
      new Option(
        '--assume-role <arn>',
        "Assume the Lambda's deployed execution role and forward STS-issued temp credentials " +
          "to the container so the handler runs with the deployed function's narrow permissions " +
          '(closes the "developer admin / function narrow" skew). Off by default — when omitted, ' +
          "the developer's shell credentials are forwarded unchanged (SAM-compatible default)."
      )
    )
    .action(withErrorHandling(localInvokeCommand));

  // Reuse standard option blocks. Note: state-bucket / deploy options are
  // intentionally NOT added — local invoke does not touch state in PR 1.
  [...commonOptions, ...appOptions, ...contextOptions].forEach((opt) => invoke.addOption(opt));
  invoke.addOption(deprecatedRegionOption);

  local.addCommand(invoke);
  return local;
}
