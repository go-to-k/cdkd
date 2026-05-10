/**
 * Map a CloudFormation `Runtime` string to the AWS Lambda base image that
 * bundles the matching runtime + the Lambda Runtime Interface Emulator (RIE).
 *
 * Per D1 in the issue, cdkd uses the **full** base image
 * (`public.ecr.aws/lambda/<lang>:<version>`, ~600MB) over SAM's lighter
 * `public.ecr.aws/sam/emulation-<lang>` (~150MB). The size cost is one-time
 * per machine; in exchange the local runtime is the same artifact AWS runs
 * for container Lambdas, so a "works locally, breaks in AWS" mismatch is
 * almost always a config issue rather than an image divergence.
 *
 * v1 supports Node.js only. Other runtimes throw `UnsupportedRuntimeError`
 * with a pointer at the planned PR.
 */

const NODEJS_RUNTIMES: Readonly<Record<string, string>> = {
  'nodejs18.x': 'public.ecr.aws/lambda/nodejs:18',
  'nodejs20.x': 'public.ecr.aws/lambda/nodejs:20',
  'nodejs22.x': 'public.ecr.aws/lambda/nodejs:22',
};

export class UnsupportedRuntimeError extends Error {
  constructor(
    public readonly runtime: string,
    message: string
  ) {
    super(message);
    this.name = 'UnsupportedRuntimeError';
    Object.setPrototypeOf(this, UnsupportedRuntimeError.prototype);
  }
}

/**
 * Resolve a Lambda `Runtime` value to the local-invoke base image tag.
 *
 * Throws {@link UnsupportedRuntimeError} for runtimes outside the v1 scope.
 * Container Lambdas (`Code.ImageUri`, no `Runtime` property) are handled
 * separately and never reach this function in v1.
 */
export function resolveRuntimeImage(runtime: string): string {
  if (typeof runtime !== 'string' || runtime.length === 0) {
    throw new UnsupportedRuntimeError(
      String(runtime),
      'Lambda function has no Runtime property. Container-image Lambdas (Code.ImageUri) are not supported in cdkd local invoke v1.'
    );
  }

  const image = NODEJS_RUNTIMES[runtime];
  if (image) return image;

  if (
    runtime.startsWith('python') ||
    runtime.startsWith('java') ||
    runtime.startsWith('dotnet') ||
    runtime.startsWith('ruby') ||
    runtime.startsWith('go') ||
    runtime.startsWith('provided')
  ) {
    throw new UnsupportedRuntimeError(
      runtime,
      `Runtime '${runtime}' is not supported in cdkd local invoke v1. ` +
        'Only Node.js runtimes (nodejs18.x / nodejs20.x / nodejs22.x) are supported. ' +
        'Python is planned for the next iteration; other runtimes follow.'
    );
  }

  throw new UnsupportedRuntimeError(
    runtime,
    `Unknown runtime '${runtime}'. cdkd local invoke v1 supports nodejs18.x / nodejs20.x / nodejs22.x.`
  );
}

/**
 * Whether the runtime is in the v1 supported set. Useful for callers that
 * want to filter without catching an exception.
 */
export function isSupportedRuntime(runtime: string): boolean {
  return runtime in NODEJS_RUNTIMES;
}
