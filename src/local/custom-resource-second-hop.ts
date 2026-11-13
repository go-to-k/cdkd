/**
 * The second hop of a `cr.Provider` custom resource under `--aws-emulator`
 * (go-to-k/cdkd#6213).
 *
 * The custom-resource runtime (`custom-resource-runtime.ts`, #6206) runs the
 * `ServiceToken` function — for a `cr.Provider`, the framework's `onEvent`
 * function — in the official Lambda runtime image. The framework then calls
 * `lambda:Invoke` on the user's `onEventHandler` (and `isCompleteHandler`),
 * and with `isCompleteHandler` it starts a Step Functions waiter. This module
 * is a small HTTP endpoint on the host's loopback that every container the
 * runtime starts gets as `AWS_ENDPOINT_URL_LAMBDA` / `AWS_ENDPOINT_URL_SFN`:
 *
 * - `Invoke` (synchronous, unqualified or `$LATEST`) of a function the
 *   CALLER's own environment names by `Fn::GetAtt [Fn, Arn]` / `Ref Fn` in the
 *   same stack runs that function locally too, with #6206's rules (code from
 *   the assembly, environment / timeout / memory from the deployed function,
 *   handler and runtime cross-checked).
 * - `StartExecution` of a state machine the caller names by `Ref` that has the
 *   shape of CDK's `WaiterStateMachine` (`custom-resource-waiter.ts`) runs
 *   locally, its tasks through the same runner.
 * - Every other call, and one of the above cdkd cannot resolve, is forwarded
 *   to AWS Emulator, signed again with the emulator's own keys.
 *
 * Security: the server binds `127.0.0.1` only (containers reach it through
 * the loopback forwarder in their own network namespace, as they reach the
 * emulator), and every request must carry the per-container token in its
 * path (`http://127.0.0.1:<port>/<token>`); anything else gets a bare 403.
 * A forwarded request goes to the emulator's endpoint only, signed with the
 * emulator credentials of the active `--aws-emulator` wiring — never with any
 * other credentials, and never anywhere else.
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';

import type { FunctionConfiguration, InvocationResponse } from '@aws-sdk/client-lambda';
import { SignatureV4 } from '@smithy/signature-v4';
import { getActiveWorkloadAwsWiring } from 'cdk-local/internal';

import { safeMsg } from '../utils/display-safe.js';
import { getLogger } from '../utils/logger.js';
import type { ResolvedZipLambda } from './lambda-resolver/types.js';
import {
  matchWaiterDefinition,
  runWaiterPlan,
  templateDefinitionWithTargets,
  type WaiterPlan,
  type WaiterTaskResult,
} from './custom-resource-waiter.js';

/** A function running locally: the template entry, the deployed configuration. */
export interface LocalFunction {
  lambda: ResolvedZipLambda;
  deployed: FunctionConfiguration;
  /** The emulator port the container's `127.0.0.1:443` forwards to, if any (#6206). */
  forwardPort?: number | undefined;
}

/** What the endpoint needs from the rest of cdkd; injected for the unit tests. */
export interface SecondHopDeps {
  /** `GetFunctionConfiguration` on the emulator, or `undefined` when it fails. */
  getFunctionConfiguration(functionName: string): Promise<FunctionConfiguration | undefined>;
  /**
   * The template function to run for a deployed one (#6206's
   * `chooseServiceTokenFunction` with this one candidate), or a reason.
   */
  chooseFunction(
    caller: LocalFunction,
    logicalId: string,
    deployed: FunctionConfiguration
  ): { lambda: ResolvedZipLambda } | { reason: string };
  /** Whether the function's runtime image is usable locally. */
  imageAvailable(lambda: ResolvedZipLambda): Promise<boolean>;
  /** Run one event in the runtime image (#6206's runner, with this endpoint wired in). */
  runLocally(target: LocalFunction, event: unknown): Promise<InvocationResponse>;
  /** Send a request to AWS Emulator, signed with its own keys. */
  forward(req: ForwardRequest): Promise<ForwardResponse>;
  sleep(ms: number): Promise<void>;
  /** The emulator's keys: a request must be signed with them (SigV4). */
  emulatorCredentials: EmulatorCredentials;
  /**
   * The address containers reach the host on when it is not the host's
   * loopback (the Docker bridge gateway on Linux), or `undefined`.
   */
  containerGateway?(): Promise<string | undefined>;
}

export interface EmulatorCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string | undefined;
}

export interface ForwardRequest {
  service: string;
  region: string;
  method: string;
  path: string;
  query: Record<string, string | string[]>;
  headers: Record<string, string>;
  body: Buffer;
}

export interface ForwardResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/** Lambda's synchronous payload cap is 6 MB; a little room for the framing. */
const MAX_BODY_BYTES = 7 * 1024 * 1024;

const INVOKE_PATH = /^\/2015-03-31\/functions\/([^/]+)\/invocations$/;

/** Headers a forwarded request is signed again without. */
const UNSIGNED_REQUEST_HEADERS = new Set([
  'host',
  'authorization',
  'x-amz-date',
  'x-amz-security-token',
  'x-amz-content-sha256',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'expect',
]);

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
]);

/**
 * The logical id a resource's `Fn::GetAtt [X, Arn]` / `Ref X` value names, or
 * `undefined`.
 */
function referencedLogicalId(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1) return undefined;
  const [key, arg] = entries[0]!;
  if (key === 'Ref') return typeof arg === 'string' ? arg : undefined;
  if (key !== 'Fn::GetAtt') return undefined;
  if (Array.isArray(arg) && arg.length === 2 && arg[1] === 'Arn') {
    return typeof arg[0] === 'string' ? arg[0] : undefined;
  }
  if (typeof arg === 'string' && arg.endsWith('.Arn')) return arg.slice(0, -'.Arn'.length);
  return undefined;
}

/**
 * The resource of `type` in the caller's stack that the caller's environment
 * names by the value `requested`: a variable whose DEPLOYED value is
 * `requested` and whose TEMPLATE value is `Fn::GetAtt [X, Arn]` or `Ref X`.
 * This is how `cr.Provider` hands the framework its targets
 * (`USER_ON_EVENT_FUNCTION_ARN`, `USER_IS_COMPLETE_FUNCTION_ARN`,
 * `WAITER_STATE_MACHINE_ARN`); nothing is guessed from names.
 */
export function callerReferencedLogicalId(
  caller: LocalFunction,
  requested: string,
  type: string
): string | undefined {
  const deployedEnv = caller.deployed.Environment?.Variables ?? {};
  const envProp = caller.lambda.resource.Properties?.['Environment'];
  const templateEnv =
    envProp !== null && typeof envProp === 'object'
      ? (envProp as Record<string, unknown>)['Variables']
      : undefined;
  if (templateEnv === null || typeof templateEnv !== 'object') return undefined;
  const resources = caller.lambda.stack.template.Resources ?? {};
  const unqualified = requested.endsWith(':$LATEST')
    ? requested.slice(0, -':$LATEST'.length)
    : requested;
  for (const [key, value] of Object.entries(deployedEnv)) {
    if (value !== unqualified) continue;
    if (!Object.hasOwn(templateEnv, key)) continue;
    const logicalId = referencedLogicalId((templateEnv as Record<string, unknown>)[key]);
    if (logicalId === undefined || !Object.hasOwn(resources, logicalId)) continue;
    if (resources[logicalId]!.Type === type) return logicalId;
  }
  return undefined;
}

/** `Credential=<key>/<date>/<region>/<service>/aws4_request` of an `Authorization` header. */
export function credentialScope(
  authorization: string | undefined
): { region: string; service: string } | undefined {
  const m = /Credential=[^/,\s]+\/\d{8}\/([^/,\s]+)\/([^/,\s]+)\/aws4_request/.exec(
    authorization ?? ''
  );
  return m ? { region: m[1]!, service: m[2]! } : undefined;
}

function serviceError(status: number, type: string, message: string): ForwardResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', 'x-amzn-errortype': type },
    body: Buffer.from(JSON.stringify({ Type: 'Service', __type: type, message })),
  };
}

/** One registered container: who it is, so its calls resolve against its own template entry. */
interface Registration {
  caller: LocalFunction;
}

export interface SecondHopEndpoint {
  /** Register a container; its endpoint URL carries a fresh token. */
  register(caller: LocalFunction): {
    url: string;
    port: number;
    release(): void;
  };
  /** The executions started locally and not finished yet (tests). */
  pendingExecutions(): Promise<unknown>[];
  close(): Promise<void>;
}

/**
 * Start the endpoint on `127.0.0.1:<free port>`.
 */
export async function startSecondHopEndpoint(deps: SecondHopDeps): Promise<SecondHopEndpoint> {
  const registrations = new Map<string, Registration>();
  const executions = new Set<Promise<unknown>>();
  const logger = getLogger();

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const m = /^\/([0-9a-f]{64})(\/.*)?$/.exec(url.pathname);
    const registration = m ? registrations.get(m[1]!) : undefined;
    if (m === null || registration === undefined) {
      res.writeHead(403).end();
      req.resume();
      return;
    }
    const path = m[2] ?? '/';
    const body = await readBody(req);
    if (body === undefined) {
      send(res, serviceError(413, 'RequestTooLargeException', 'Request body is too large'));
      return;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k.toLowerCase()] = v;
      else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(',');
    }
    const scope = credentialScope(headers['authorization']);
    const query: Record<string, string | string[]> = {};
    for (const key of new Set(url.searchParams.keys())) {
      const all = url.searchParams.getAll(key);
      query[key] = all.length === 1 ? all[0]! : all;
    }
    const rawPath = (req.url ?? '/').split('?')[0]!;
    const signedByEmulatorKey = await verifySignature(
      { method: req.method ?? 'GET', path: rawPath, query, headers, body },
      deps.emulatorCredentials
    ).catch(() => false);
    if (!signedByEmulatorKey) {
      logger.debug('cr.Provider endpoint: a request not signed with the emulator key was refused');
      send(res, { status: 403, headers: {}, body: Buffer.alloc(0) });
      return;
    }
    const forwardRequest: ForwardRequest = {
      service: scope?.service ?? 'lambda',
      region: scope?.region ?? regionOf(registration.caller),
      method: req.method ?? 'GET',
      path,
      query,
      headers,
      body,
    };
    logger.debug(
      safeMsg`cr.Provider endpoint: ${forwardRequest.service} ${forwardRequest.method} ${path} ${headers['x-amz-target'] ?? ''}`
    );
    const local = await answerLocally(registration.caller, forwardRequest).catch((err: unknown) => {
      logger.warn(
        safeMsg`A cr.Provider call could not run locally: ${err instanceof Error ? err.message : String(err)}`
      );
      return serviceError(
        500,
        'ServiceException',
        'cdkd could not run the function in the Lambda runtime image locally; see the cdkd output'
      );
    });
    if (local !== undefined) {
      send(res, local);
      return;
    }
    send(
      res,
      await deps.forward(forwardRequest).catch((err: unknown) => {
        logger.debug(safeMsg`Forwarding to AWS Emulator failed: ${String(err)}`);
        return serviceError(502, 'ServiceException', 'cdkd could not reach AWS Emulator');
      })
    );
  };

  /** A local answer for the request, or `undefined` to forward it. */
  const answerLocally = async (
    caller: LocalFunction,
    req: ForwardRequest
  ): Promise<ForwardResponse | undefined> => {
    if (req.service === 'lambda' && req.method === 'POST') {
      const invoke = INVOKE_PATH.exec(req.path);
      if (invoke) return invokeLocally(caller, decodeURIComponent(invoke[1]!), req);
    }
    if (
      req.service === 'states' &&
      req.method === 'POST' &&
      req.headers['x-amz-target'] === 'AWSStepFunctions.StartExecution'
    ) {
      return startExecutionLocally(caller, req);
    }
    return undefined;
  };

  /** Resolve a function the caller names, ready to run locally, or a reason. */
  const resolveTarget = async (
    caller: LocalFunction,
    functionName: string
  ): Promise<LocalFunction | { reason: string }> => {
    const logicalId = callerReferencedLogicalId(caller, functionName, 'AWS::Lambda::Function');
    if (logicalId === undefined) return { reason: 'the caller does not reference it' };
    const deployed = await deps.getFunctionConfiguration(functionName);
    if (deployed === undefined) return { reason: 'AWS Emulator does not describe it' };
    const choice = deps.chooseFunction(caller, logicalId, deployed);
    if ('reason' in choice) return choice;
    if (!(await deps.imageAvailable(choice.lambda))) {
      return { reason: 'its Lambda runtime image is not available' };
    }
    return { lambda: choice.lambda, deployed, forwardPort: caller.forwardPort };
  };

  const invokeLocally = async (
    caller: LocalFunction,
    functionName: string,
    req: ForwardRequest
  ): Promise<ForwardResponse | undefined> => {
    const invocationType = req.headers['x-amz-invocation-type'] ?? 'RequestResponse';
    const qualifier = req.query['Qualifier'];
    if (invocationType !== 'RequestResponse') return undefined;
    if (qualifier !== undefined && qualifier !== '$LATEST') return undefined;
    let event: unknown;
    try {
      event = req.body.length === 0 ? {} : JSON.parse(req.body.toString('utf8'));
    } catch {
      return undefined;
    }
    const target = await resolveTarget(caller, functionName);
    if ('reason' in target) {
      logger.debug(safeMsg`Invoke of ${functionName} goes to AWS Emulator: ${target.reason}`);
      return undefined;
    }
    logger.info(
      safeMsg`Running function ${target.lambda.logicalId} (${target.lambda.runtime}), invoked by ${caller.lambda.logicalId}, in the Lambda runtime image locally`
    );
    const result = await deps.runLocally(target, event);
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-amz-executed-version': '$LATEST',
    };
    if (result.FunctionError !== undefined) headers['x-amz-function-error'] = result.FunctionError;
    if (req.headers['x-amz-log-type'] === 'Tail' && result.LogResult !== undefined) {
      headers['x-amz-log-result'] = result.LogResult;
    }
    return {
      status: 200,
      headers,
      body: Buffer.from(result.Payload ?? new Uint8Array()),
    };
  };

  const startExecutionLocally = async (
    caller: LocalFunction,
    req: ForwardRequest
  ): Promise<ForwardResponse | undefined> => {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(req.body.toString('utf8')) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const stateMachineArn = body['stateMachineArn'];
    if (typeof stateMachineArn !== 'string') return undefined;
    const declined = (reason: string): undefined => {
      logger.warn(
        // cdkd-arn-display: a state machine ARN from the emulator, not a role; through safeMsg.
        safeMsg`The state machine ${stateMachineArn} runs on AWS Emulator, not locally: ${reason}.`
      );
      return undefined;
    };
    const smLogicalId = callerReferencedLogicalId(
      caller,
      stateMachineArn,
      'AWS::StepFunctions::StateMachine'
    );
    if (smLogicalId === undefined) {
      logger.debug(
        // cdkd-arn-display: a state machine ARN from the emulator, not a role; through safeMsg.
        safeMsg`StartExecution of ${stateMachineArn} goes to AWS Emulator: the caller does not reference it`
      );
      return undefined;
    }
    const sm = caller.lambda.stack.template.Resources![smLogicalId]!;
    const templateDefinition = templateDefinitionWithTargets(sm);
    if (templateDefinition === undefined)
      return declined('its definition is not a plain JSON text');
    const described = await deps.forward({
      service: 'states',
      region: req.region,
      method: 'POST',
      path: '/',
      query: {},
      headers: {
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': 'AWSStepFunctions.DescribeStateMachine',
      },
      body: Buffer.from(JSON.stringify({ stateMachineArn })),
    });
    let deployedDefinition: unknown;
    try {
      deployedDefinition = (JSON.parse(described.body.toString('utf8')) as Record<string, unknown>)[
        'definition'
      ];
    } catch {
      deployedDefinition = undefined;
    }
    if (described.status !== 200 || typeof deployedDefinition !== 'string') {
      return declined('AWS Emulator does not describe it');
    }
    const plan = matchWaiterDefinition(templateDefinition, deployedDefinition);
    if ('reason' in plan) return declined(plan.reason);
    const targets = new Map<string, LocalFunction>();
    for (const [name, task] of plan.states) {
      const logicalId = task.targetLogicalId;
      const resources = caller.lambda.stack.template.Resources ?? {};
      if (
        !Object.hasOwn(resources, logicalId) ||
        resources[logicalId]!.Type !== 'AWS::Lambda::Function'
      ) {
        return declined(`state ${name} does not run a function of the stack`);
      }
      const deployed = await deps.getFunctionConfiguration(task.functionArn);
      if (deployed === undefined)
        return declined(`AWS Emulator does not describe state ${name}'s function`);
      const choice = deps.chooseFunction(caller, logicalId, deployed);
      if ('reason' in choice) return declined(`state ${name}: ${choice.reason}`);
      if (!(await deps.imageAvailable(choice.lambda))) {
        return declined(`state ${name}'s Lambda runtime image is not available`);
      }
      targets.set(name, {
        lambda: choice.lambda,
        deployed,
        forwardPort: caller.forwardPort,
      });
    }
    let input: unknown = {};
    if (typeof body['input'] === 'string') {
      try {
        input = JSON.parse(body['input']);
      } catch {
        return undefined;
      }
    }
    const execName = typeof body['name'] === 'string' ? body['name'] : randomUUID();
    // cdkd-arn-display: the API answer to the container, never printed.
    const executionArn = `${stateMachineArn.replace(':stateMachine:', ':execution:')}:${execName}`;
    logger.info(safeMsg`Running state machine ${smLogicalId} (the cr.Provider waiter) locally`);
    const execution = runExecution(smLogicalId, plan, targets, input).finally(() =>
      executions.delete(execution)
    );
    executions.add(execution);
    return {
      status: 200,
      headers: { 'content-type': 'application/x-amz-json-1.0' },
      body: Buffer.from(JSON.stringify({ executionArn, startDate: Date.now() / 1000 })),
    };
  };

  const runExecution = async (
    smLogicalId: string,
    plan: WaiterPlan,
    targets: Map<string, LocalFunction>,
    input: unknown
  ): Promise<void> => {
    const runTask = async (
      stateName: string,
      _task: unknown,
      taskInput: unknown
    ): Promise<WaiterTaskResult> => {
      const target = targets.get(stateName)!;
      let result: InvocationResponse;
      try {
        result = await deps.runLocally(target, taskInput);
      } catch (err) {
        return {
          ok: false,
          error: 'Lambda.ServiceException',
          cause: err instanceof Error ? err.message : String(err),
        };
      }
      const raw = Buffer.from(result.Payload ?? new Uint8Array()).toString('utf8');
      if (result.FunctionError !== undefined) {
        let errorType = 'Lambda.Unknown';
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (typeof parsed['errorType'] === 'string') errorType = parsed['errorType'];
        } catch {
          // The cause carries the raw text.
        }
        return { ok: false, error: errorType, cause: raw };
      }
      try {
        return { ok: true, output: raw === '' ? null : JSON.parse(raw) };
      } catch {
        return { ok: true, output: raw };
      }
    };
    try {
      const outcome = await runWaiterPlan(plan, input, runTask, (ms) => deps.sleep(ms));
      if (outcome.status === 'FAILED') {
        logger.warn(
          safeMsg`The cr.Provider waiter ${smLogicalId} failed locally: ${outcome.error}: ${outcome.cause}`
        );
      }
    } catch (err) {
      logger.warn(
        safeMsg`The cr.Provider waiter ${smLogicalId} stopped: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    handle(req, res).catch((err: unknown) => {
      logger.debug(safeMsg`cr.Provider endpoint error: ${String(err)}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  };
  const server: Server = createServer(onRequest);
  // Never keeps cdkd alive on its own.
  server.unref();
  // Loopback only: containers reach it through their namespace's forwarder,
  // which connects to `host.docker.internal`, the host's loopback on Docker
  // Desktop.
  await listen(server, 0, '127.0.0.1');
  const port = (server.address() as AddressInfo).port;
  // On Linux that name is the Docker bridge gateway instead, which a loopback
  // listener does not answer: listen there too (the containers' address
  // only, never `0.0.0.0`), on the same port.
  let gatewayServer: Server | undefined;
  const gateway = deps.containerGateway === undefined ? undefined : await deps.containerGateway();
  if (gateway !== undefined) {
    const s = createServer(onRequest);
    s.unref();
    try {
      await listen(s, port, gateway);
      gatewayServer = s;
    } catch (err) {
      logger.debug(
        safeMsg`The cr.Provider endpoint cannot listen on ${gateway}:${String(port)}: ${String(err)}`
      );
      server.close();
      throw err;
    }
  }

  return {
    register(caller) {
      const token = randomBytes(32).toString('hex');
      registrations.set(token, { caller });
      return {
        url: `http://127.0.0.1:${port}/${token}`,
        port,
        release: () => {
          registrations.delete(token);
        },
      };
    },
    pendingExecutions: () => [...executions],
    close: async () => {
      await Promise.all(
        [server, gatewayServer]
          .filter((s): s is Server => s !== undefined)
          .map(
            (s) =>
              new Promise<void>((resolveClose) => {
                s.close(() => resolveClose());
                s.closeAllConnections();
              })
          )
      );
    },
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
}

/**
 * Whether the request carries a SigV4 `Authorization` made with the
 * emulator's secret key: its access key id must be the emulator's, and the
 * signature computed again over the headers it lists must be the same.
 */
export async function verifySignature(
  req: {
    method: string;
    path: string;
    query: Record<string, string | string[]>;
    headers: Record<string, string>;
    body: Buffer;
  },
  credentials: EmulatorCredentials
): Promise<boolean> {
  const auth = req.headers['authorization'] ?? '';
  const m =
    /^AWS4-HMAC-SHA256 Credential=([^/,\s]+)\/(\d{8})\/([^/,\s]+)\/([^/,\s]+)\/aws4_request,\s*SignedHeaders=([a-z0-9;_.-]+),\s*Signature=([0-9a-f]{64})$/.exec(
      auth
    );
  if (m === null || m[1] !== credentials.accessKeyId) return false;
  const [, , , region, service, signedHeaderList, signature] = m;
  const amzDate = req.headers['x-amz-date'];
  if (amzDate === undefined || !/^\d{8}T\d{6}Z$/.test(amzDate)) return false;
  const signingDate = new Date(
    `${amzDate.slice(0, 4)}-${amzDate.slice(4, 6)}-${amzDate.slice(6, 8)}T${amzDate.slice(9, 11)}:${amzDate.slice(11, 13)}:${amzDate.slice(13, 15)}Z`
  );
  const signedHeaders = signedHeaderList!.split(';');
  if (!signedHeaders.includes('host')) return false;
  const headers: Record<string, string> = {};
  for (const name of signedHeaders) {
    const value = req.headers[name];
    if (value === undefined) return false;
    headers[name] = value;
  }
  const signer = new SignatureV4({
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken !== undefined && {
        sessionToken: credentials.sessionToken,
      }),
    },
    region: region!,
    service: service!,
    sha256: NodeSha256,
  });
  const resigned = await signer.sign(
    {
      method: req.method,
      protocol: 'http:',
      hostname: '127.0.0.1',
      path: req.path,
      query: req.query,
      headers,
      body: req.body,
    },
    { signingDate, signableHeaders: new Set(signedHeaders) }
  );
  const expected = /Signature=([0-9a-f]{64})/.exec(resigned.headers['authorization'] ?? '')?.[1];
  if (expected === undefined) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature!));
}

function regionOf(caller: LocalFunction): string {
  const arn = caller.deployed.FunctionArn ?? '';
  const parts = arn.split(':');
  return parts.length >= 7 && parts[3] ? parts[3] : (caller.lambda.stack.region ?? 'us-east-1');
}

function readBody(req: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolveBody(tooLarge ? undefined : Buffer.concat(chunks)));
    req.on('error', rejectBody);
  });
}

function send(res: ServerResponse, answer: ForwardResponse): void {
  res.writeHead(answer.status, {
    ...answer.headers,
    'content-length': String(answer.body.length),
  });
  res.end(answer.body);
}

/** Node's SHA-256 / HMAC in the shape `SignatureV4` takes. */
class NodeSha256 {
  private hash: ReturnType<typeof createHash> | ReturnType<typeof createHmac>;
  private readonly secret: string | ArrayBuffer | ArrayBufferView | undefined;
  constructor(secret?: string | ArrayBuffer | ArrayBufferView) {
    this.secret = secret;
    this.hash = this.fresh();
  }
  private fresh(): ReturnType<typeof createHash> | ReturnType<typeof createHmac> {
    return this.secret === undefined
      ? createHash('sha256')
      : createHmac('sha256', toBuffer(this.secret));
  }
  update(data: string | ArrayBuffer | ArrayBufferView): void {
    this.hash.update(toBuffer(data));
  }
  digest(): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(this.hash.digest()));
  }
  reset(): void {
    this.hash = this.fresh();
  }
}

function toBuffer(data: string | ArrayBuffer | ArrayBufferView): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(data);
}

let caCache: { path: string; pem: string } | undefined;

/**
 * Send a request to the active `--aws-emulator` endpoint, signed with the
 * emulator's own credentials. Refuses (throws) unless the wiring is full
 * emulator mode with an endpoint and credentials, so no other credential and
 * no other destination can be reached through it.
 */
export async function forwardToEmulator(req: ForwardRequest): Promise<ForwardResponse> {
  const wiring = getActiveWorkloadAwsWiring();
  const endpoint = wiring?.emulatorEndpoint;
  const credentials = wiring?.emulatorCredentials;
  if (wiring?.mode !== 'emulator' || endpoint === undefined || credentials === undefined) {
    throw new Error('no AWS Emulator wiring is active');
  }
  const target = new URL(endpoint.url);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!UNSIGNED_REQUEST_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
  }
  headers['host'] = target.host;
  const signer = new SignatureV4({
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      ...(credentials.sessionToken !== undefined && {
        sessionToken: credentials.sessionToken,
      }),
    },
    region: req.region,
    service: req.service,
    sha256: NodeSha256,
  });
  const signed = await signer.sign({
    method: req.method,
    protocol: target.protocol,
    hostname: target.hostname,
    ...(target.port !== '' && { port: Number(target.port) }),
    path: req.path,
    query: req.query,
    headers,
    body: req.body,
  });
  let ca: string | undefined;
  if (wiring.caHostPath !== undefined) {
    if (caCache?.path !== wiring.caHostPath) {
      caCache = {
        path: wiring.caHostPath,
        pem: readFileSync(wiring.caHostPath, 'utf8'),
      };
    }
    ca = caCache.pem;
  }
  // RFC 3986 encoding, as SigV4 canonicalizes it (not URLSearchParams' `+`).
  const enc = (s: string): string =>
    encodeURIComponent(s).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    );
  const qs = Object.entries(req.query)
    .flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((value) => `${enc(k)}=${enc(value)}`))
    .join('&');
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<ForwardResponse>((resolveResponse, rejectResponse) => {
    const r = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        ...(target.port !== '' && { port: Number(target.port) }),
        method: req.method,
        path: `${req.path}${qs === '' ? '' : `?${qs}`}`,
        headers: {
          ...signed.headers,
          'content-length': String(req.body.length),
        },
        ...(ca !== undefined && { ca }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (HOP_BY_HOP_RESPONSE_HEADERS.has(k) || v === undefined) continue;
            out[k] = Array.isArray(v) ? v.join(', ') : v;
          }
          resolveResponse({
            status: res.statusCode ?? 502,
            headers: out,
            body: Buffer.concat(chunks),
          });
        });
        res.on('error', rejectResponse);
      }
    );
    r.on('error', rejectResponse);
    r.end(req.body);
  });
}
