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
 * Supports Node.js + Python + Ruby + Java. Other runtimes throw
 * `UnsupportedRuntimeError` with a pointer at the planned PR.
 *
 * Ruby uses the same `<file>.<func>` handler grammar as Node.js and Python,
 * so the inline-code materializer's `lastIndexOf('.')` parse works
 * unchanged; only the file extension (`.rb`) differs.
 *
 * Java is **asset-backed only** — the `Handler` value (`package.Class::method`)
 * names a compiled class on the classpath, which can only be supplied as a
 * compiled `.class` hierarchy or `.jar` packaged via `lambda.Code.fromAsset(...)`.
 * Inline `Code.ZipFile` has no meaning for the JVM, so `fileExtension` is
 * `null` for every Java entry and `resolveRuntimeFileExtension` throws a
 * runtime-specific message routing the user to `Code.fromAsset(...)`.
 */

interface RuntimeSpec {
  /** ECR image tag the container should pull. */
  readonly image: string;
  /**
   * Source-file extension (with leading dot) for inline-code
   * materialization (`Code.ZipFile`). Node.js → `.js`, Python → `.py`,
   * Ruby → `.rb`. `null` for runtimes whose Handler shape cannot be
   * satisfied by a single inline source file (Java needs a compiled
   * class hierarchy / JAR) — `resolveRuntimeFileExtension` rejects with
   * a routing message when callers hit this case.
   */
  readonly fileExtension: string | null;
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
  'ruby3.2': { image: 'public.ecr.aws/lambda/ruby:3.2', fileExtension: '.rb' },
  'ruby3.3': { image: 'public.ecr.aws/lambda/ruby:3.3', fileExtension: '.rb' },
  'java8.al2': { image: 'public.ecr.aws/lambda/java:8.al2', fileExtension: null },
  java11: { image: 'public.ecr.aws/lambda/java:11', fileExtension: null },
  java17: { image: 'public.ecr.aws/lambda/java:17', fileExtension: null },
  java21: { image: 'public.ecr.aws/lambda/java:21', fileExtension: null },
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
 * Python → `.py`, Ruby → `.rb`. Throws {@link UnsupportedRuntimeError} on
 * the same runtime set as {@link resolveRuntimeImage}.
 *
 * Additionally throws when the resolved runtime has `fileExtension: null`
 * — this is the canonical entry point for the inline-`Code.ZipFile` branch
 * in both `cdkd local invoke` and `cdkd local start-api`, so rejecting
 * here surfaces a user-friendly "use Code.fromAsset" message before the
 * callers reach the materializer. Asset-backed Lambdas never call this.
 */
export function resolveRuntimeFileExtension(runtime: string): string {
  const spec = resolveRuntimeSpec(runtime);
  if (spec.fileExtension === null) {
    throw new UnsupportedRuntimeError(
      runtime,
      `Inline 'Code.ZipFile' is not supported for runtime '${runtime}'. ` +
        'The Lambda Handler shape for this runtime names a compiled artifact (a JVM class, a .NET assembly, or a native binary) that cannot be expressed as a single inline source file. ' +
        'Use `lambda.Code.fromAsset(<dir>)` with a directory containing the compiled output (.class hierarchy / JAR / DLL / binary).'
    );
  }
  return spec.fileExtension;
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

  if (runtime.startsWith('dotnet') || runtime.startsWith('go') || runtime.startsWith('provided')) {
    throw new UnsupportedRuntimeError(
      runtime,
      `Runtime '${runtime}' is not yet supported in cdkd local invoke. ` +
        'Supported runtimes: Node.js (nodejs18.x / nodejs20.x / nodejs22.x / nodejs24.x), Python (python3.11 / python3.12 / python3.13 / python3.14), Ruby (ruby3.2 / ruby3.3), Java (java8.al2 / java11 / java17 / java21). ' +
        'Other runtimes follow in subsequent PRs.'
    );
  }

  throw new UnsupportedRuntimeError(
    runtime,
    `Unknown runtime '${runtime}'. cdkd local invoke supports nodejs18.x / nodejs20.x / nodejs22.x / nodejs24.x / python3.11 / python3.12 / python3.13 / python3.14 / ruby3.2 / ruby3.3 / java8.al2 / java11 / java17 / java21.`
  );
}

/**
 * Whether the runtime is in the v1 supported set. Useful for callers that
 * want to filter without catching an exception.
 */
export function isSupportedRuntime(runtime: string): boolean {
  return runtime in SUPPORTED_RUNTIMES;
}
