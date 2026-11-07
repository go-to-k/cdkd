import type { StackInfo } from '../../synthesis/assembly-reader.js';
import type { TemplateResource } from '../../types/resource.js';

/**
 * Result of resolving a `cdkd local invoke <target>` argument back to a
 * concrete Lambda function in the synthesized assembly.
 *
 * Discriminated union (PR 5, D5.3): `kind === 'zip'` for traditional
 * Node.js / Python ZIP-packaged Lambdas; `kind === 'image'` for container
 * Lambdas (`Code.ImageUri`). The two variants have meaningfully different
 * fields — `runtime` / `handler` / `codePath` are zip-only, while
 * `dockerSource` / `imageConfig` are image-only (`architecture` is on
 * BOTH variants since issue #768) — so the compiler can enforce
 * exhaustive handling at the consumer (the `local-invoke.ts` CLI command
 * branch).
 *
 * Orthogonal future fields (e.g. PR 6 layers) live on the base interface
 * so they apply to both variants without each adding a copy.
 */
export type ResolvedLambda = ResolvedZipLambda | ResolvedImageLambda;

interface ResolvedLambdaBase {
  /** Stack the function belongs to. */
  stack: StackInfo;
  /** CloudFormation logical ID of the function. */
  logicalId: string;
  /** Raw template entry (for property reads beyond what's surfaced here). */
  resource: TemplateResource;
  /** `MemorySize` from the template, or 128 when omitted (Lambda default). */
  memoryMb: number;
  /** `Timeout` (seconds) from the template, or 3 when omitted (Lambda default). */
  timeoutSec: number;
  /**
   * Resolved Lambda layers (PR 6 of #224, issue #232). Each entry points
   * at an `AWS::Lambda::LayerVersion` resource in the same stack — the
   * `logicalId` lets the caller emit clearer error messages, `assetPath`
   * is the absolute directory under `cdk.out` (resolved via the same
   * `Metadata['aws:asset:path']` hint Lambda code uses) that bind-mounts
   * at `/opt`. `[]` when the function declares no Layers.
   *
   * **Order is load-bearing**: AWS layer semantics are "last layer wins
   * on file collision", so this array preserves the template's input
   * order. cdkd implements the last-wins rule by merging every
   * layer's asset directory into a single host tmpdir IN TEMPLATE ORDER
   * (later layers overwrite earlier files, `copyLayerTreeLastWins`), then
   * bind-mounting the merged tmpdir at `/opt:ro`. Docker
   * rejects multiple `-v ...:/opt:ro` entries at the same target path
   * (`Error response from daemon: Duplicate mount point: /opt`) — bind
   * mounts are NOT layered the way the OCI image stack is — so the
   * merge happens on the host, not via overlay layering. The single-
   * layer case skips the copy and bind-mounts the asset dir directly.
   *
   * Out of scope for v1 (any of these hard-error at resolution time):
   *   - Cross-stack / cross-account / cross-region layer ARNs (anything
   *     that isn't a same-stack `Ref` / `Fn::GetAtt[..., Ref]` pointing
   *     at an `AWS::Lambda::LayerVersion`).
   *   - Layers without `Metadata['aws:asset:path']` (i.e. layers whose
   *     content is `S3Bucket`/`S3Key` from outside cdk.out — there's no
   *     local directory to bind-mount).
   */
  layers: ResolvedLambdaLayer[];
  /**
   * `Properties.EphemeralStorage.Size` (issue #440). CDK 2.x's
   * `lambda.Function({ ephemeralStorageSize: cdk.Size.gibibytes(N) })`
   * synthesizes `Properties.EphemeralStorage: { Size: <N * 1024> }`
   * — the value is the templated `/tmp` cap in **MiB** (CFn property
   * range 512..10240). Threaded through to docker's `--tmpfs
   * /tmp:rw,size=<N>m` so handlers that exceed the deployed cap fail
   * locally with `ENOSPC` the way they would on AWS, and handlers
   * that detect free space via `statvfs` / `df` see the templated
   * size rather than the host's overlay-fs.
   *
   * Undefined when `Properties.EphemeralStorage` is absent — the
   * container's `/tmp` is then whatever the base image provides (AWS
   * Lambda base images don't mount a sized tmpfs themselves, so this
   * preserves the pre-#440 behavior). Applies to both ZIP and IMAGE
   * Lambdas — `--tmpfs` overlays inside container Lambdas just like
   * it does on the public base images.
   */
  ephemeralStorageMb?: number;
}

/**
 * One entry of a Lambda's resolved `Properties.Layers`. Two shapes:
 *
 *   - `kind: 'asset'` — same-stack `AWS::Lambda::LayerVersion`
 *     reference (the original PR 6 path). `assetPath` is the absolute
 *     directory under `cdk.out` ready to bind-mount at `/opt`.
 *   - `kind: 'arn'` — pre-existing literal-ARN entry the CDK template
 *     points at directly (AWS Lambda Powertools, Datadog Extension,
 *     shared internal layers, cross-account / cross-region references).
 *     The layer ZIP is NOT yet on disk; the CLI materializes it via
 *     `materializeLayerFromArn(...)` (issue #448) right before the
 *     docker container starts. Carrying the parsed ARN fields here
 *     keeps the resolver pure-functional (no AWS SDK calls) and lets
 *     the materializer be tested independently.
 */
export type ResolvedLambdaLayer = ResolvedAssetLambdaLayer | ResolvedArnLambdaLayer;

export interface ResolvedAssetLambdaLayer {
  kind: 'asset';
  /**
   * CFn logical ID of the `AWS::Lambda::LayerVersion` resource.
   * Shared field name with the `kind: 'arn'` variant so callers can
   * read a uniform identifier without first narrowing the union.
   */
  logicalId: string;
  /**
   * Absolute path on disk to the layer's unzipped asset directory. Will
   * be bind-mounted at `/opt` inside the container (read-only). The
   * directory is laid out per AWS's runtime-specific load-path
   * conventions (`opt/python/...`, `opt/nodejs/...`, etc.) — cdkd does
   * NOT inspect the contents, just hands the directory to docker.
   */
  assetPath: string;
}

export interface ResolvedArnLambdaLayer {
  kind: 'arn';
  /**
   * Pseudo-logical-id for log lines — set to the literal ARN so
   * iteration code like `layers.map((l) => l.logicalId)` works
   * uniformly across both variants without per-kind narrowing.
   */
  logicalId: string;
  /**
   * Full literal ARN as it appeared in the template
   * (`arn:aws:lambda:<region>:<account>:layer:<name>:<version>`). Kept
   * verbatim alongside `logicalId` because callers (the materializer)
   * need the canonical ARN string for SDK calls and the per-kind
   * branch is the only place where the difference matters.
   */
  arn: string;
  /** Region segment extracted from the ARN (e.g. `us-east-1`). */
  region: string;
  /** Account ID segment extracted from the ARN (12 digits). */
  accountId: string;
  /** Layer name segment (the `:layer:<name>:` middle). */
  name: string;
  /** Numeric version segment, as a string for `LayerName:Version` joins. */
  version: string;
}

export interface ResolvedZipLambda extends ResolvedLambdaBase {
  kind: 'zip';
  /** Lambda runtime string (e.g. `nodejs20.x`). */
  runtime: string;
  /** Lambda handler string (e.g. `index.handler`). */
  handler: string;
  /**
   * Resolved local code path. For asset-backed functions, this is the
   * absolute directory under `cdk.out` named by the resource's
   * `Metadata['aws:asset:path']`. For inline `Code.ZipFile` functions,
   * this is `null` and the caller is expected to materialize a temp dir
   * before bind-mounting (handled in the command layer to keep this
   * module side-effect-free).
   */
  codePath: string | null;
  /**
   * For inline Lambdas only: the inline source body. The command layer
   * writes this into a temp dir at the path implied by `handler`.
   */
  inlineCode?: string;
  /**
   * `Architectures: [x86_64]` (default) or `[arm64]`. Threaded through to
   * `--platform linux/amd64` / `linux/arm64` on the ZIP container's
   * `docker run` (issue #768). Without this, a `provided.*` custom-runtime
   * `bootstrap` compiled for the other arch fails with
   * `fork/exec /var/runtime/bootstrap: exec format error` /
   * `Runtime.InvalidEntrypoint` when the host arch differs from the
   * function's declared arch — matching the IMAGE path, which already
   * pins `--platform` per `Architectures`.
   */
  architecture: 'x86_64' | 'arm64';
}

export interface ResolvedImageLambda extends ResolvedLambdaBase {
  kind: 'image';
  /**
   * Raw `Code.ImageUri` from the template. Used to extract the asset hash
   * for the local-build path AND for the ECR-pull fallback path (when the
   * URI doesn't match any cdk.out asset). Already resolved through
   * cdk-assets bootstrap-placeholder substitution upstream — `${AWS::*}`
   * pseudo-parameters are still present (cdkd substitutes them at the
   * lookup site since it knows the calling account/region).
   */
  imageUri: string;
  /**
   * `ImageConfig` from the template. All fields are optional — the
   * common case is just `Command: [<handler>]`. Empty `[]` for
   * `entryPoint` means "use the image's default entrypoint" (typically
   * `/lambda-entrypoint.sh` on AWS base images, which routes to RIE).
   */
  imageConfig: {
    command?: string[];
    entryPoint?: string[];
    workingDirectory?: string;
  };
  /**
   * `Architectures: [x86_64]` (default) or `[arm64]`. Threaded through to
   * `--platform linux/amd64` / `linux/arm64` on BOTH `docker build` AND
   * `docker run`. Without this, an arm64 host running an x86_64 Lambda
   * hits emulation; an x86_64 host running arm64 fails with
   * `exec format error`.
   */
  architecture: 'x86_64' | 'arm64';
}

export class LocalInvokeResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalInvokeResolutionError';
    Object.setPrototypeOf(this, LocalInvokeResolutionError.prototype);
  }
}
