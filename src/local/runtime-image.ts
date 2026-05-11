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
 * Supports every current AWS Lambda runtime — Node.js, Python, Ruby,
 * Java, .NET, and the OS-only `provided.al2` / `provided.al2023` (the
 * canonical hosts for Go via a `bootstrap` binary, Rust, C/C++, or any
 * other compiled native runtime). The deprecated `go1.x` runtime is
 * explicitly rejected with a migration pointer to `provided.al2023`.
 *
 * Truly unknown runtime strings (e.g. typos like `nodejs99.x`, or
 * back-revs AWS retired well before cdkd existed) fall through to a
 * generic error that lists every supported runtime.
 *
 * Ruby uses the same `<file>.<func>` handler grammar as Node.js and Python,
 * so the inline-code materializer's `lastIndexOf('.')` parse works
 * unchanged; only the file extension (`.rb`) differs.
 *
 * Java, .NET, and `provided.*` are **asset-backed only** — the Handler
 * value names a compiled artifact (`package.Class::method` for Java's
 * JVM class on the classpath; `Assembly::Namespace.Class::Method` for
 * .NET's CLR assembly / DLL; an arbitrary identifier per the user's
 * `bootstrap` binary for `provided.*`), which can only be supplied as a
 * compiled artifact directory packaged via `lambda.Code.fromAsset(...)`.
 * Inline `Code.ZipFile` has no meaning for any of them, so
 * `fileExtension` is `null` for every Java / .NET / `provided.*` entry
 * and `resolveRuntimeFileExtension` throws a runtime-specific message
 * routing the user to `Code.fromAsset(...)`.
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
  dotnet6: { image: 'public.ecr.aws/lambda/dotnet:6', fileExtension: null },
  dotnet8: { image: 'public.ecr.aws/lambda/dotnet:8', fileExtension: null },
  'provided.al2': { image: 'public.ecr.aws/lambda/provided:al2', fileExtension: null },
  'provided.al2023': { image: 'public.ecr.aws/lambda/provided:al2023', fileExtension: null },
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
 * Throws {@link UnsupportedRuntimeError} for runtimes outside the supported
 * set (currently every AWS Lambda runtime — see {@link SUPPORTED_RUNTIMES}).
 * Container Lambdas (`Code.ImageUri`, no `Runtime` property) are handled
 * separately and never reach this function.
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
        'The Lambda Handler shape for this runtime names a compiled artifact (a JVM class, a .NET assembly, or — for the OS-only `provided.*` runtimes — an arbitrary `bootstrap` binary) that cannot be expressed as a single inline source file. ' +
        'Use `lambda.Code.fromAsset(<dir>)` with a directory containing the compiled output (.class hierarchy / JAR / DLL / native binary).'
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

  // The pre-OAL `go1.x` runtime was end-of-lifed by AWS Lambda on
  // 2024-01-08 and no longer has a base image at `public.ecr.aws/lambda/`.
  // Reject with a migration pointer rather than the generic "unknown
  // runtime" message — users who still have `lambda.Runtime.GO_1_X` in
  // their CDK code will hit this and need the explicit next step.
  if (runtime === 'go1.x') {
    throw new UnsupportedRuntimeError(
      runtime,
      `Runtime 'go1.x' was deprecated by AWS Lambda on 2024-01-08 and is no longer available. ` +
        'Migrate to the OS-only runtime: build your Go program as a `bootstrap` binary and set the CDK runtime to `lambda.Runtime.PROVIDED_AL2023` (or `lambda.Runtime.PROVIDED_AL2`). ' +
        'See https://docs.aws.amazon.com/lambda/latest/dg/lambda-golang.html'
    );
  }

  throw new UnsupportedRuntimeError(
    runtime,
    `Unknown runtime '${runtime}'. cdkd local invoke supports nodejs18.x / nodejs20.x / nodejs22.x / nodejs24.x / python3.11 / python3.12 / python3.13 / python3.14 / ruby3.2 / ruby3.3 / java8.al2 / java11 / java17 / java21 / dotnet6 / dotnet8 / provided.al2 / provided.al2023.`
  );
}

/**
 * Whether the runtime is in the supported set. Useful for callers that
 * want to filter without catching an exception.
 */
export function isSupportedRuntime(runtime: string): boolean {
  return runtime in SUPPORTED_RUNTIMES;
}

/**
 * In-container path where cdkd should bind-mount the function's
 * deployment package (asset directory or materialized inline tmpdir).
 *
 * - Most runtimes: `/var/task` — the standard Lambda deployment dir.
 *   The runtime-specific entrypoint (Node / Python / Ruby / Java / .NET)
 *   loads the user code from this path.
 * - `provided.al2` / `provided.al2023`: `/var/runtime` — the AWS Lambda
 *   `provided.*` base images hardcode `/lambda-entrypoint.sh` to
 *   `exec /usr/local/bin/aws-lambda-rie /var/runtime/bootstrap`, so the
 *   user's `bootstrap` binary must live at `/var/runtime/bootstrap` and
 *   NOT under `/var/task`. AWS Lambda's runtime service ordinarily
 *   stages the bootstrap to `/var/runtime` as part of init; RIE inside
 *   the public base image does not, so the host-side bind mount has to
 *   target `/var/runtime` directly.
 *
 * Throws {@link UnsupportedRuntimeError} for the same runtime set as
 * the other resolvers — by the time a caller asks for the mount path
 * the runtime has already been validated.
 */
export function resolveRuntimeCodeMountPath(runtime: string): string {
  // Trigger the standard validation so unknown runtimes throw the same
  // message users see from resolveRuntimeImage.
  resolveRuntimeSpec(runtime);
  if (runtime === 'provided.al2' || runtime === 'provided.al2023') {
    return '/var/runtime';
  }
  return '/var/task';
}
