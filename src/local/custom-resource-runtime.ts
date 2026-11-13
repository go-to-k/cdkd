/**
 * Under `--aws-emulator`, run the function a custom resource's `ServiceToken`
 * points at in the official AWS Lambda runtime image on this machine, instead
 * of `lambda:Invoke` on the emulator (go-to-k/cdkd#6206).
 *
 * The emulator's embedded runtimes miss parts of the standard library
 * (`https` on Node.js, `_signal` on Python), so the provider functions behind
 * `autoDeleteObjects: true` and `s3deploy.BucketDeployment` fail and the
 * deploy rolls back. The function still exists in the emulator; only the
 * execution of the custom-resource event moves, through the machinery
 * `cdkd local invoke` uses (`resolveZipImagePlan`, `runDetached`, the RIE).
 *
 * - Scope: the `ServiceToken` function, and (go-to-k/cdkd#6213) what a
 *   `cr.Provider` framework function calls from there: every container gets
 *   the local endpoint of `custom-resource-second-hop.ts` as its Lambda /
 *   Step Functions endpoint, which runs the user's handlers and the waiter
 *   state machine locally too and forwards every other call to the emulator.
 * - Code: the function's code from the local cloud assembly
 *   ({@link synthesizedStacks}). Handler, runtime, layers come from the
 *   template; the environment, timeout and memory from the deployed function
 *   (`GetFunctionConfiguration` on the emulator), i.e. the resolved values.
 * - Container: `runDetached` applies the active `--aws-emulator` wiring — the
 *   emulator's keys only, its endpoint (a loopback URL served through the
 *   forwarder in the container's namespace, so the pre-signed `ResponseURL`
 *   keeps its host) and its CA with every runtime's trust variable.
 * - Off when `--aws-emulator` is not active: a real AWS deploy never reaches
 *   anything below {@link localCustomResourceRuntimeActive}. Off with
 *   `--no-local-custom-resources`. Without Docker, or when the function is
 *   not found in the assembly, the event goes to the emulator as before, with
 *   one warning.
 */

import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';

import {
  GetFunctionConfigurationCommand,
  type FunctionConfiguration,
  type InvocationResponse,
  type LambdaClient,
} from '@aws-sdk/client-lambda';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { safeMsg } from '../utils/display-safe.js';
import { getLogger } from '../utils/logger.js';
import { synthesizedStacks } from '../synthesis/synthesized-stacks.js';
import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { TemplateResource } from '../types/resource.js';
import { getCurrentStackName } from '../provisioning/resource-name.js';
import { extractLambdaProperties } from './lambda-resolver/properties.js';
import type { ResolvedZipLambda } from './lambda-resolver/types.js';
import { getActiveWorkloadAwsWiring, setContainerRegion } from './local-aws-wiring.js';
import {
  NO_LOCAL_CUSTOM_RESOURCES_FLAG,
  customResourceStackName,
  localCustomResourceCommand,
  localCustomResourceRuntimeActive,
  setLocalCustomResourceRuntimeEnabled,
} from './custom-resource-runtime-gate.js';
import { responsePresignClient } from '../provisioning/providers/custom-resource-response-endpoint.js';
import {
  dockerBridgeGateway,
  ensureDockerAvailable,
  followContainerLogs,
  imageInLocalCache,
  killAndDrainContainerLogs,
  pickFreePort,
  pullImage,
  removeContainer,
  removeContainersSync,
  runDetached,
  startNamespacePortForwarder,
  type ContainerLogStream,
} from './docker-runner.js';
import { resolveHostGatewayExtraHosts } from './docker-version.js';
import { invokeRie, waitForRieReady } from './rie-client.js';
import { resolveZipImagePlan, type ImagePlan } from '../cli/commands/local-invoke/image-plan.js';
import { resolveRuntimeImage } from './runtime-image.js';
import {
  forwardToEmulator,
  startSecondHopEndpoint,
  type LocalFunction,
  type SecondHopEndpoint,
} from './custom-resource-second-hop.js';

/** `CloudWatch`'s `LogType: 'Tail'` cap, which the emulator path's `LogResult` carries. */
const LOG_TAIL_MAX_BYTES = 4096;

/** The lifetime cdkd gives every `ResponseURL` (`generateResponseURL`). */
const RESPONSE_URL_EXPIRES_IN_SECONDS = 7200;

/** Where the container's RIE listens on this machine. */
const CONTAINER_HOST = '127.0.0.1';

let dockerAvailable: Promise<boolean> | undefined;
const runtimeImages = new Map<string, Promise<boolean>>();
const warnedOnce = new Set<string>();
/** The in-flight events' synchronous teardowns, run by ONE `exit` listener. */
const exitCleanups = new Set<() => void>();
let exitHookInstalled = false;
/** The `cr.Provider` second-hop endpoint (#6213), started with the first local event. */
let secondHop: Promise<SecondHopEndpoint | undefined> | undefined;

/** Test seam: forget the cached Docker probe, the image checks and the once-only warnings. */
export function resetLocalCustomResourceRuntimeForTest(): void {
  setLocalCustomResourceRuntimeEnabled(true);
  dockerAvailable = undefined;
  runtimeImages.clear();
  warnedOnce.clear();
  const endpoint = secondHop;
  secondHop = undefined;
  void endpoint?.then((e) => e?.close());
}

function warnOnce(key: string, message: string): void {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  getLogger().warn(message);
}

/** A `ServiceToken` target found in the assembly. */
export interface ServiceTokenFunction {
  stack: StackInfo;
  logicalId: string;
  resource: TemplateResource;
}

/**
 * The logical id a `ServiceToken` value points at when it is the ARN of a
 * function in the same template: `Fn::GetAtt: [Fn, Arn]` or `'Fn.Arn'`.
 */
function serviceTokenTargetLogicalId(serviceToken: unknown): string | undefined {
  if (serviceToken === null || typeof serviceToken !== 'object') return undefined;
  const getAtt = (serviceToken as Record<string, unknown>)['Fn::GetAtt'];
  if (Array.isArray(getAtt) && getAtt.length === 2 && getAtt[1] === 'Arn') {
    return typeof getAtt[0] === 'string' ? getAtt[0] : undefined;
  }
  if (typeof getAtt === 'string' && getAtt.endsWith('.Arn')) {
    return getAtt.slice(0, -'.Arn'.length);
  }
  return undefined;
}

/**
 * Every function in `stacks` that a custom resource named
 * `customResourceLogicalId` points its `ServiceToken` at.
 */
export function findServiceTokenFunctions(
  stacks: readonly StackInfo[],
  customResourceLogicalId: string
): ServiceTokenFunction[] {
  const found: ServiceTokenFunction[] = [];
  for (const stack of stacks) {
    const resources = stack.template.Resources ?? {};
    const custom = Object.hasOwn(resources, customResourceLogicalId)
      ? resources[customResourceLogicalId]
      : undefined;
    if (custom === undefined) continue;
    if (
      !custom.Type.startsWith('Custom::') &&
      custom.Type !== 'AWS::CloudFormation::CustomResource'
    ) {
      continue;
    }
    const target = serviceTokenTargetLogicalId(custom.Properties?.['ServiceToken']);
    if (target === undefined || !Object.hasOwn(resources, target)) continue;
    const resource = resources[target]!;
    if (resource.Type !== 'AWS::Lambda::Function') continue;
    found.push({ stack, logicalId: target, resource });
  }
  return found;
}

/** What makes two candidates run the same code: code, handler, runtime, layers. */
function codeIdentity(lambda: ResolvedZipLambda): string {
  return JSON.stringify([
    lambda.codePath,
    lambda.inlineCode ?? null,
    lambda.handler,
    lambda.runtime,
    lambda.architecture,
    lambda.layers.map((l) => (l.kind === 'asset' ? l.assetPath : l.arn)),
  ]);
}

/**
 * The template function to run for one custom resource event, or a reason it
 * cannot be chosen. A candidate must agree with the deployed function on
 * handler and runtime; candidates left in several stacks are narrowed to the
 * stack being deployed (its name scope), and must then run the same code.
 */
export function chooseServiceTokenFunction(
  candidates: readonly ServiceTokenFunction[],
  deployed: { Handler?: string | undefined; Runtime?: string | undefined },
  currentStackName: string | undefined
): { lambda: ResolvedZipLambda } | { reason: string } {
  const resolved: ResolvedZipLambda[] = [];
  for (const c of candidates) {
    let lambda;
    try {
      lambda = extractLambdaProperties(
        c.stack,
        c.logicalId,
        c.resource,
        c.stack.template.Resources ?? {}
      );
    } catch (err) {
      getLogger().debug(
        safeMsg`${c.stack.stackName}/${c.logicalId} cannot run locally: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    if (lambda.kind !== 'zip') continue;
    if (lambda.handler !== deployed.Handler || lambda.runtime !== deployed.Runtime) {
      getLogger().debug(
        safeMsg`${c.stack.stackName}/${c.logicalId} is ${lambda.handler} (${lambda.runtime}) in the assembly, the deployed function ${String(deployed.Handler)} (${String(deployed.Runtime)})`
      );
      continue;
    }
    resolved.push(lambda);
  }
  if (resolved.length === 0) {
    return { reason: 'its function was not found in the local cloud assembly' };
  }
  // A known stack never borrows another stack's function of the same logical id.
  const pool =
    currentStackName === undefined
      ? resolved
      : resolved.filter((l) => l.stack.stackName === currentStackName);
  if (pool.length === 0) {
    return { reason: 'its function was not found in the stack being deployed' };
  }
  const identities = new Set(pool.map(codeIdentity));
  if (identities.size > 1) {
    return { reason: 'several functions in the local cloud assembly match it' };
  }
  return { lambda: pool[0]! };
}

/**
 * Whether the runtime image is usable: in the local cache, else pulled ONCE
 * per image per process (every custom resource event would otherwise pay a
 * registry round trip). A failed pull is remembered too, so the fallback
 * warning is printed once.
 */
function runtimeImageAvailable(image: string): Promise<boolean> {
  let ready = runtimeImages.get(image);
  if (ready === undefined) {
    ready = (async (): Promise<boolean> => {
      if (await imageInLocalCache(image)) return true;
      try {
        await pullImage(image, false);
        return true;
      } catch (err) {
        getLogger().debug(safeMsg`Pulling ${image} failed: ${describeAwsFailure(err).detail}`);
        return false;
      }
    })();
    runtimeImages.set(image, ready);
  }
  return ready;
}

async function dockerIsAvailable(): Promise<boolean> {
  dockerAvailable ??= ensureDockerAvailable().then(
    () => true,
    (err: unknown) => {
      getLogger().debug(safeMsg`Docker probe failed: ${describeAwsFailure(err).detail}`);
      return false;
    }
  );
  return dockerAvailable;
}

/**
 * The warning for a command that read no cloud assembly. Only a DESTROY gets
 * "run `cdkd destroy` from the app": for `cdkd rollback` (or anything else)
 * that remedy would delete the stack the user meant to keep.
 */
export function noAssemblyWarning(command: string | undefined): string {
  const head =
    `This command did not synthesize the CDK app, so custom resource functions run in AWS ` +
    `Emulator's own Lambda runtime, which can fail.`;
  if (command === 'destroy' || command === 'state destroy') {
    return `${head} Run \`cdkd destroy --aws-emulator\` from the app's directory to run them locally.`;
  }
  return `${head} Pass ${NO_LOCAL_CUSTOM_RESOURCES_FLAG} to silence this.`;
}

/** The function's region, from its ARN (`arn:<partition>:lambda:<region>:...`). */
function regionOfFunctionArn(arn: string): string | undefined {
  const parts = arn.split(':');
  return parts.length >= 7 && parts[2] === 'lambda' && parts[3] ? parts[3] : undefined;
}

/**
 * Run one custom resource event in the official Lambda runtime image, or
 * return `undefined` to send it to the emulator as before: the runtime is not
 * active, Docker is unavailable, or the function cannot be resolved from the
 * assembly. Nothing has been delivered when it returns `undefined`.
 *
 * The result is shaped as the emulator's `Invoke` answer would be, so the
 * response handling downstream is unchanged: `Payload` is the handler's
 * return value, `FunctionError` is set when the runtime reported an error,
 * and `LogResult` is the base64 tail of the container's log.
 */
export async function invokeCustomResourceFunctionLocally(
  clients: { lambda: LambdaClient; s3: S3Client },
  serviceToken: string,
  request: Record<string, unknown>
): Promise<InvocationResponse | undefined> {
  if (!localCustomResourceRuntimeActive()) return undefined;
  const logger = getLogger();
  const customResourceLogicalId =
    typeof request['LogicalResourceId'] === 'string' ? request['LogicalResourceId'] : '';
  const fallback = `it runs in AWS Emulator's own Lambda runtime instead`;

  if (!(await dockerIsAvailable())) {
    warnOnce(
      'docker',
      `Docker is not available, so custom resource functions run in AWS Emulator's own Lambda ` +
        `runtime, which can fail (pass ${NO_LOCAL_CUSTOM_RESOURCES_FLAG} to silence this).`
    );
    return undefined;
  }

  let deployed: FunctionConfiguration;
  try {
    deployed = await clients.lambda.send(
      new GetFunctionConfigurationCommand({ FunctionName: serviceToken })
    );
  } catch (err) {
    // The emulator's own invoke reports a missing function the usual way.
    logger.debug(safeMsg`GetFunctionConfiguration failed: ${describeAwsFailure(err).detail}`);
    return undefined;
  }
  const stacks = synthesizedStacks();
  if (stacks.length === 0) {
    // `cdkd state destroy`, `cdkd rollback`, or a destroy run without the app.
    warnOnce('no-assembly', noAssemblyWarning(localCustomResourceCommand()));
    return undefined;
  }
  const choice = chooseServiceTokenFunction(
    findServiceTokenFunctions(stacks, customResourceLogicalId),
    deployed,
    getCurrentStackName() ?? customResourceStackName()
  );
  if ('reason' in choice) {
    warnOnce(
      `resolve:${customResourceLogicalId}`,
      safeMsg`Custom resource ${customResourceLogicalId}: ${choice.reason}, so ${fallback}.`
    );
    return undefined;
  }
  const lambda = choice.lambda;
  const image = resolveRuntimeImage(lambda.runtime);
  if (!(await runtimeImageAvailable(image))) {
    warnOnce(
      `image:${image}`,
      safeMsg`The Lambda runtime image ${image} is not available locally and could not be pulled, so ` +
        `${lambda.runtime} custom resource functions run in AWS Emulator's own Lambda runtime instead.`
    );
    return undefined;
  }
  logger.info(
    safeMsg`Running custom resource ${customResourceLogicalId}'s function ${lambda.logicalId} (${lambda.runtime}) in the Lambda runtime image locally`
  );
  const response = await responseUrlForContainer(clients.s3, request['ResponseURL']);
  return runInContainer(
    { lambda, deployed, forwardPort: response.forwardPort },
    serviceToken,
    response.url === undefined ? request : { ...request, ResponseURL: response.url },
    await secondHopEndpoint(clients.lambda)
  );
}

/**
 * The `cr.Provider` second-hop endpoint (#6213), started once per process
 * with the first local event; `undefined` (calls go to the emulator as
 * before) unless the wiring is full emulator mode with its own keys, which a
 * forwarded call is signed with.
 */
function secondHopEndpoint(lambdaClient: LambdaClient): Promise<SecondHopEndpoint | undefined> {
  secondHop ??= (async (): Promise<SecondHopEndpoint | undefined> => {
    const wiring = getActiveWorkloadAwsWiring();
    if (
      wiring?.mode !== 'emulator' ||
      wiring.emulatorEndpoint === undefined ||
      wiring.emulatorCredentials === undefined
    ) {
      return undefined;
    }
    try {
      return await startSecondHopEndpoint({
        getFunctionConfiguration: async (functionName) => {
          try {
            return await lambdaClient.send(
              new GetFunctionConfigurationCommand({
                FunctionName: functionName,
              })
            );
          } catch (err) {
            getLogger().debug(
              safeMsg`GetFunctionConfiguration(${functionName}) failed: ${describeAwsFailure(err).detail}`
            );
            return undefined;
          }
        },
        chooseFunction: (caller, logicalId, deployed) =>
          chooseServiceTokenFunction(
            [
              {
                stack: caller.lambda.stack,
                logicalId,
                resource: caller.lambda.stack.template.Resources![logicalId]!,
              },
            ],
            deployed,
            caller.lambda.stack.stackName
          ),
        imageAvailable: (lambda) => runtimeImageAvailable(resolveRuntimeImage(lambda.runtime)),
        runLocally: async (target, event) =>
          runInContainer(
            target,
            target.deployed.FunctionArn ?? '',
            event,
            await secondHopEndpoint(lambdaClient)
          ),
        forward: forwardToEmulator,
        emulatorCredentials: wiring.emulatorCredentials,
        // Docker Desktop's `host.docker.internal` is the host's loopback; on
        // Linux it is the bridge gateway.
        ...(process.platform === 'linux' && {
          containerGateway: dockerBridgeGateway,
        }),
        sleep: (ms) =>
          new Promise((resolveSleep) => {
            setTimeout(resolveSleep, ms).unref();
          }),
      });
    } catch (err) {
      getLogger().debug(
        safeMsg`The cr.Provider endpoint did not start: ${err instanceof Error ? err.message : String(err)}`
      );
      return undefined;
    }
  })();
  return secondHop;
}

/**
 * The `ResponseURL` the container gets, and the emulator port its default
 * HTTPS port must reach.
 *
 * CDK's Node.js handlers PUT the response with `https.request({ hostname,
 * path })`, which drops the URL's port and connects to 443. The URL cdkd
 * signed is on the emulator's port (`https://127.0.0.1:9297/...`), so for a
 * URL on the emulator's origin the same object is signed again for the
 * default port (`https://127.0.0.1/...`; the host is part of the signature),
 * and the container's `127.0.0.1:443` is forwarded to the emulator port
 * (`startNamespacePortForwarder`). Python's `cfnresponse` PUTs the full
 * URL, which reaches the same place. Any other URL (`CDKD_CR_S3_ENDPOINT_URL`)
 * is left as it is.
 */
export async function responseUrlForContainer(
  s3Client: S3Client,
  responseUrl: unknown
): Promise<{ url?: string; forwardPort?: number }> {
  const endpoint = getActiveWorkloadAwsWiring()?.emulatorEndpoint;
  // Loopback only: the container reaches a loopback emulator through the
  // forwarder in its own namespace, which is what makes its `127.0.0.1:443`
  // forwardable. A remote emulator (`https://emu.lan:9297`) keeps the URL as
  // signed: Python's `cfnresponse` PUTs it as it is.
  if (typeof responseUrl !== 'string' || endpoint === undefined || !endpoint.loopback) return {};
  const emulatorUrl = endpoint.url;
  let url: URL;
  let emulator: URL;
  try {
    url = new URL(responseUrl);
    emulator = new URL(emulatorUrl);
  } catch {
    return {};
  }
  if (url.origin !== emulator.origin || url.protocol !== 'https:' || url.port === '') return {};
  // Path-style, as every S3 call to the emulator: `/<bucket>/<key>`.
  const [, bucket, ...keyParts] = url.pathname.split('/');
  if (!bucket || keyParts.length === 0) return {};
  const origin = `https://${url.hostname}`;
  const signer = await responsePresignClient(s3Client, {
    url: origin,
    origin,
    httpsOnDefaultPort: true,
  });
  const signed = await getSignedUrl(
    signer,
    new PutObjectCommand({
      Bucket: decodeURIComponent(bucket),
      Key: keyParts.map((p) => decodeURIComponent(p)).join('/'),
    }),
    { expiresIn: RESPONSE_URL_EXPIRES_IN_SECONDS }
  );
  return { url: signed, forwardPort: Number(url.port) };
}

/** The variables a container's Lambda / Step Functions clients follow to the second-hop endpoint. */
export const SECOND_HOP_ENDPOINT_ENV_KEYS = [
  'AWS_ENDPOINT_URL_LAMBDA',
  'AWS_ENDPOINT_URL_SFN',
] as const;

async function runInContainer(
  fn: LocalFunction,
  functionArn: string,
  request: unknown,
  endpoint: SecondHopEndpoint | undefined
): Promise<InvocationResponse> {
  const { lambda, deployed, forwardPort } = fn;
  const logger = getLogger();
  // This container's own token: its calls resolve against ITS template entry.
  const hop = endpoint?.register(fn);
  let imagePlan: ImagePlan | undefined;
  let containerId: string | undefined;
  let forwarderId: string | undefined;
  let logStream: ContainerLogStream | undefined;
  const logChunks: Buffer[] = [];
  const tmpDirs = (): string[] =>
    [
      imagePlan?.inlineTmpDir,
      imagePlan?.layersTmpDir,
      ...(imagePlan?.layerArnTmpDirs ?? []),
    ].filter((d): d is string => d !== undefined);
  // A deploy interrupted for good (a second ^C) leaves through
  // `process.exit`, which skips the `finally` below: remove what this event
  // started on the way out.
  // Named up front and recorded BEFORE each `docker run`, so an exit while it
  // is still starting (before its id is known) removes it too.
  const containerName = `cdkd-cr-${randomBytes(6).toString('hex')}`;
  const forwarderName = `${containerName}-443`;
  const starting: string[] = [];
  const onExit = (): void => {
    removeContainersSync([...starting].reverse());
    for (const dir of tmpDirs()) rmSync(dir, { recursive: true, force: true });
  };
  exitCleanups.add(onExit);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', () => {
      for (const cleanup of exitCleanups) cleanup();
    });
  }
  try {
    // The image was checked (or pulled once) by `runtimeImageAvailable`.
    imagePlan = await resolveZipImagePlan(lambda, { pull: false });

    const functionEnv = deployed.Environment?.Variables ?? {};
    const timeoutSec = deployed.Timeout ?? lambda.timeoutSec;
    const env: Record<string, string> = {
      AWS_LAMBDA_FUNCTION_NAME: deployed.FunctionName ?? lambda.logicalId,
      AWS_LAMBDA_FUNCTION_MEMORY_SIZE: String(deployed.MemorySize ?? lambda.memoryMb),
      AWS_LAMBDA_FUNCTION_TIMEOUT: String(timeoutSec),
      AWS_LAMBDA_FUNCTION_VERSION: '$LATEST',
      AWS_LAMBDA_LOG_GROUP_NAME: `/aws/lambda/${deployed.FunctionName ?? lambda.logicalId}`,
      AWS_LAMBDA_LOG_STREAM_NAME: 'local',
      ...functionEnv,
    };
    setContainerRegion(env, regionOfFunctionArn(functionArn) ?? lambda.stack.region);
    const hopEnv: Record<string, string> = {};
    if (hop !== undefined) {
      for (const key of SECOND_HOP_ENDPOINT_ENV_KEYS) hopEnv[key] = hop.url;
    }

    const hostPort = await pickFreePort();
    const extraHosts = await resolveHostGatewayExtraHosts();
    starting.push(containerName);
    containerId = await runDetached({
      name: containerName,
      image: imagePlan.image,
      mounts: imagePlan.mounts,
      ...(imagePlan.extraMounts !== undefined && { extraMounts: imagePlan.extraMounts }),
      env,
      // The function's own variables may hold resolved secrets: keep their
      // values off the `docker run` argv.
      sensitiveEnvKeys: new Set(Object.keys(functionEnv)),
      // On the argv: the docker client reads `AWS_ENDPOINT_URL_*` itself, so
      // they cannot travel in its environment. The URL's token only names the
      // caller; the endpoint accepts a request only when it is signed with the
      // emulator's secret key, which stays off the argv.
      ...(hop !== undefined && {
        envAfterWiring: hopEnv,
        extraLoopbackPorts: [hop.port],
      }),
      ...(extraHosts.length > 0 && { extraHosts }),
      cmd: imagePlan.cmd,
      hostPort,
      host: CONTAINER_HOST,
      ...(imagePlan.platform !== undefined && { platform: imagePlan.platform }),
      ...(imagePlan.tmpfs !== undefined && { tmpfs: imagePlan.tmpfs }),
    });
    // Captured, not relayed: the handler may print the event, which carries
    // the resource's properties. The tail travels as `LogResult` like the
    // emulator's, which the response handling prints only on a failure.
    logStream = followContainerLogs(containerId, {
      stdout: (chunk) => logChunks.push(chunk),
      stderr: (chunk) => logChunks.push(chunk),
    });
    if (forwardPort !== undefined) {
      // CDK's Node.js handlers connect to 443 whatever the URL's port.
      starting.push(forwarderName);
      forwarderId = await startNamespacePortForwarder(
        containerId,
        443,
        forwardPort,
        undefined,
        forwarderName
      );
    }
    await waitForRieReady(CONTAINER_HOST, hostPort, 5000);
    const invokeTimeoutMs = Math.max(30_000, timeoutSec * 2 * 1000);
    const result = await invokeRie(CONTAINER_HOST, hostPort, request, invokeTimeoutMs);
    await killAndDrainContainerLogs(containerId, logStream);
    logStream = undefined;
    const logTail = Buffer.concat(logChunks).subarray(-LOG_TAIL_MAX_BYTES);
    return {
      StatusCode: 200,
      ExecutedVersion: '$LATEST',
      // Only ever read through `Buffer.from(...)` downstream.
      Payload: Buffer.from(result.raw) as unknown as InvocationResponse['Payload'],
      ...(isRuntimeError(result.payload) && { FunctionError: 'Unhandled' }),
      ...(logTail.length > 0 && { LogResult: logTail.toString('base64') }),
    };
  } finally {
    await killAndDrainContainerLogs(containerId, logStream).catch(() => undefined);
    if (forwarderId !== undefined) await removeContainer(forwarderId).catch(() => undefined);
    // By id once known; else by the pre-assigned name, which a `docker run`
    // that CREATED the container and then failed to start it leaves behind
    // (`removeContainer` swallows a not-found).
    const toRemove = containerId ?? (starting.includes(containerName) ? containerName : undefined);
    if (toRemove !== undefined) {
      await removeContainer(toRemove).catch((err: unknown) => {
        logger.debug(safeMsg`removeContainer(${toRemove}) failed: ${String(err)}`);
      });
    }
    for (const dir of tmpDirs()) rmSync(dir, { recursive: true, force: true });
    exitCleanups.delete(onExit);
    hop?.release();
  }
}

/**
 * The runtime's error answer (`{"errorType": ..., "errorMessage": ...}`),
 * which Lambda reports with `FunctionError` and the RIE as a plain body.
 */
export function isRuntimeError(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  return typeof p['errorMessage'] === 'string' && typeof p['errorType'] === 'string';
}
