/**
 * Map a CloudFormation `Runtime` string to the AWS Lambda base image that
 * bundles the matching runtime + the Lambda Runtime Interface Emulator (RIE),
 * plus the source-file extension for inline-code materialization.
 *
 * Per D1 in the issue, cdkd uses the **full** base image
 * (`public.ecr.aws/lambda/<lang>:<version>`, ~600MB) over SAM's lighter
 * `public.ecr.aws/sam/emulation-<lang>` (~150MB). The size cost is one-time
 * per machine; in exchange the local runtime is the same artifact AWS runs
 * for container Lambdas, so a "works locally, breaks in AWS" mismatch is
 * almost always a config issue rather than an image divergence.
 *
 * v1 supports Node.js + Python. Other runtimes throw `UnsupportedRuntimeError`
 * with a pointer at the planned PR.
 */

interface RuntimeSpec {
  /** ECR image tag the container should pull. */
  readonly image: string;
  /**
   * Source-file extension (with leading dot) for inline-code
   * materialization (`Code.ZipFile`). Node.js → `.js`, Python → `.py`.
   */
  readonly fileExtension: string;
}

const SUPPORTED_RUNTIMES: Readonly<Record<string, RuntimeSpec>> = {
  'nodejs18.x': { image: 'public.ecr.aws/lambda/nodejs:18', fileExtension: '.js' },
  'nodejs20.x': { image: 'public.ecr.aws/lambda/nodejs:20', fileExtension: '.js' },
  'nodejs22.x': { image: 'public.ecr.aws/lambda/nodejs:22', fileExtension: '.js' },
  'nodejs24.x': { image: 'public.ecr.aws/lambda/nodejs:24', fileExtension: '.js' },
  'python3.11': { image: 'public.ecr.aws/lambda/python:3.11', fileExtension: '.py' },
  'python3.12': { image: 'public.ecr.aws/lambda/python:3.12', fileExtension: '.py' },
  'python3.13': { image: 'public.ecr.aws/lambda/python:3.13', fileExtension: '.py' },
  'python3.14': { image: 'public.ecr.aws/lambda/python:3.14', fileExtension: '.py' },
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
  return resolveRuntimeSpec(runtime).image;
}

/**
 * Resolve a Lambda `Runtime` value to the source-file extension used when
 * materializing an inline `Code.ZipFile` body to disk. Node.js → `.js`,
 * Python → `.py`. Throws {@link UnsupportedRuntimeError} on the same
 * runtime set as {@link resolveRuntimeImage}.
 */
export function resolveRuntimeFileExtension(runtime: string): string {
  return resolveRuntimeSpec(runtime).fileExtension;
}

/**
 * Resolve a Lambda `Runtime` value to its full {@link RuntimeSpec}. Public
 * for callers that need both the image AND the file extension in one step;
 * the named helpers above wrap this for the common single-field cases.
 */
export function resolveRuntimeSpec(runtime: string): RuntimeSpec {
  if (typeof runtime !== 'string' || runtime.length === 0) {
    throw new UnsupportedRuntimeError(
      String(runtime),
      'Lambda function has no Runtime property. This branch is only reached for ZIP Lambdas; container-image Lambdas (Code.ImageUri) take a different code path that does not consult the Runtime property.'
    );
  }

  const spec = SUPPORTED_RUNTIMES[runtime];
  if (spec) return spec;

  if (
    runtime.startsWith('java') ||
    runtime.startsWith('dotnet') ||
    runtime.startsWith('ruby') ||
    runtime.startsWith('go') ||
    runtime.startsWith('provided')
  ) {
    throw new UnsupportedRuntimeError(
      runtime,
      `Runtime '${runtime}' is not supported in cdkd local invoke v1. ` +
        'Only Node.js (nodejs18.x / nodejs20.x / nodejs22.x / nodejs24.x) and Python (python3.11 / python3.12 / python3.13 / python3.14) runtimes are supported. ' +
        'Other runtimes follow in subsequent PRs.'
    );
  }

  throw new UnsupportedRuntimeError(
    runtime,
    `Unknown runtime '${runtime}'. cdkd local invoke v1 supports nodejs18.x / nodejs20.x / nodejs22.x / nodejs24.x / python3.11 / python3.12 / python3.13 / python3.14.`
  );
}

/**
 * Whether the runtime is in the v1 supported set. Useful for callers that
 * want to filter without catching an exception.
 */
export function isSupportedRuntime(runtime: string): boolean {
  return runtime in SUPPORTED_RUNTIMES;
}
