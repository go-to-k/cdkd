/**
 * ARN shapes shared by the Lambda Web Function revision and endpoint providers
 * (go-to-k/cdkd#4926). Both physical ids are child ARNs of the function:
 *
 *   arn:<partition>:lambda:<region>:<account>:web-function/<fn>/revision/<id>
 *   arn:<partition>:lambda:<region>:<account>:web-function/<fn>/endpoint/<name>
 *
 * The Lambda Web API takes the function ARN as `functionName` and the revision
 * ARN as `revisionId`, but an endpoint is addressed by `functionName` +
 * `endpointName` only, so the provider splits the recorded ARN rather than
 * storing the parts separately.
 */

const CHILD_ARN =
  /^(arn:[^:]+:lambda:[^:]+:\d{12}:web-function\/[^/]+)\/(revision|endpoint)\/([^/]+)$/;

export interface WebFunctionChildArn {
  /** The owning function's ARN, accepted by every Lambda Web call as `functionName`. */
  functionArn: string;
  /** The revision id (`rev-...`) or the endpoint name. */
  childId: string;
}

/**
 * Split a revision or endpoint ARN, or return `undefined` when `arn` is not
 * that kind of child ARN. A caller addressing AWS with the parts must refuse
 * on `undefined` rather than guess.
 */
export function parseWebFunctionChildArn(
  arn: string,
  kind: 'revision' | 'endpoint'
): WebFunctionChildArn | undefined {
  const match = CHILD_ARN.exec(arn);
  if (!match || match[2] !== kind) return undefined;
  return { functionArn: match[1]!, childId: match[3]! };
}

/** The function NAME at the end of a function ARN (`...:web-function/<name>`). */
export function webFunctionNameOfArn(functionArn: string): string {
  return functionArn.slice(functionArn.lastIndexOf('/') + 1);
}

/**
 * The recorded `FunctionName` spelling for a readback: a template may pass the
 * function's name or its ARN, and Lambda Web reports both, so the readback
 * echoes whichever form the record holds when it names the live function.
 * Otherwise the live ARN is returned, which then reports as drift.
 */
export function recordedFunctionNameSpelling(recorded: unknown, liveFunctionArn: string): string {
  if (
    typeof recorded === 'string' &&
    (recorded === liveFunctionArn || recorded === webFunctionNameOfArn(liveFunctionArn))
  ) {
    return recorded;
  }
  return liveFunctionArn;
}

/**
 * The live value laid onto the RECORDED bag's shape: each recorded key takes
 * the live value at the same path, recursing through plain objects, and a key
 * the live side lacks stays absent. AWS fills defaults the template never
 * declared (a revision's `MaxConcurrencyPerEnvironment: 64` and its default
 * `TelemetryConfig`), and `cdkd drift` compares nested objects whole, so those
 * defaults would otherwise report as drift on every run.
 */
export function projectOntoRecorded(recorded: unknown, live: unknown): unknown {
  if (!isPlainRecord(recorded) || !isPlainRecord(live)) return live;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(recorded)) {
    if (!Object.prototype.hasOwnProperty.call(live, key)) continue;
    out[key] = projectOntoRecorded(recorded[key], live[key]);
  }
  return out;
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Poll schedule for the revision / endpoint waits: 500 ms, which the measured ~3 s settle needs. */
export const LAMBDA_WEB_POLL_INTERVAL_MS = 500;
/** Ten minutes of polling before a wait gives up. */
export const LAMBDA_WEB_MAX_POLL_ATTEMPTS = 1200;
/** Polls (5 s) on which a not-found right after a create is read as not yet visible. */
export const READ_AFTER_CREATE_GRACE_POLLS = 10;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
