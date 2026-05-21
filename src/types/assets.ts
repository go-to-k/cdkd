/**
 * CDK Asset manifest types
 *
 * Based on CDK Asset manifest format (v52.0.0)
 */

/**
 * Asset manifest structure
 */
export interface AssetManifest {
  version: string;
  files: Record<string, FileAsset>;
  dockerImages: Record<string, DockerImageAsset>;
}

/**
 * File asset (Lambda code, etc.)
 */
export interface FileAsset {
  displayName: string;
  source: FileAssetSource;
  destinations: Record<string, FileAssetDestination>;
}

/**
 * File asset source
 */
export interface FileAssetSource {
  path: string;
  packaging: 'file' | 'zip';
  executable?: string[];
}

/**
 * File asset destination (S3)
 */
export interface FileAssetDestination {
  bucketName: string;
  objectKey: string;
  assumeRoleArn?: string;
  region?: string;
}

/**
 * Docker image asset
 */
export interface DockerImageAsset {
  displayName: string;
  source: DockerImageAssetSource;
  destinations: Record<string, DockerImageAssetDestination>;
}

/**
 * Docker image asset source.
 *
 * Mirrors `DockerImageSource` in the CDK Cloud Assembly schema
 * (`@aws-cdk/cloud-assembly-schema`). When a field is absent from the
 * synthesized manifest, the corresponding `docker build` flag is omitted —
 * the upstream schema and BuildKit's defaults remain the source of truth.
 *
 * Either `directory` OR `executable` must be set:
 * - `directory`: standard `docker build <dir>` path with the full BuildKit
 *   flag set below.
 * - `executable`: a command-line that builds the image itself and returns
 *   the resulting local image tag on stdout. Used by users who build their
 *   image outside Docker (Bazel, custom shell scripts, etc.).
 */
export interface DockerImageAssetSource {
  /**
   * Build context directory (relative to the asset manifest location).
   * Either this or `executable` must be set.
   */
  directory?: string;
  /**
   * A command-line executable that returns the name of a local Docker image
   * on stdout after being run. Mutually exclusive with `directory` in
   * upstream CDK; cdkd treats `executable` as taking precedence when both
   * are set.
   */
  executable?: string[];
  /** Name of the file with build instructions (default `Dockerfile`). */
  dockerFile?: string;
  /** Target build stage for multi-stage Dockerfiles (`--target`). */
  dockerBuildTarget?: string;
  /** Additional build args (`--build-arg`). */
  dockerBuildArgs?: Record<string, string>;
  /** Additional build contexts (`--build-context`). Requires BuildKit ≥ 1.4. */
  dockerBuildContexts?: Record<string, string>;
  /** SSH agent socket or keys (`--ssh`). Requires BuildKit. */
  dockerBuildSsh?: string;
  /** Additional build secrets (`--secret`). Requires BuildKit. */
  dockerBuildSecrets?: Record<string, string>;
  /** Networking mode for the RUN commands during build (`--network`). */
  networkMode?: string;
  /** Platform to build for (`--platform`). Requires Docker Buildx. */
  platform?: string;
  /** Build outputs (`--output=<value>`). */
  dockerOutputs?: string[];
  /** Cache from options (`--cache-from`). */
  cacheFrom?: DockerCacheOption[];
  /** Cache to options (`--cache-to`). */
  cacheTo?: DockerCacheOption;
  /** Disable the build cache (`--no-cache`). */
  cacheDisabled?: boolean;
}

/**
 * Options for configuring the Docker cache backend. Mirrors
 * `DockerCacheOption` in the CDK Cloud Assembly schema.
 */
export interface DockerCacheOption {
  /**
   * The type of cache to use (`type=...`). Common values: `registry`,
   * `inline`, `local`, `gha`. See
   * https://docs.docker.com/build/cache/backends/ for the full list.
   */
  type: string;
  /**
   * Additional parameters passed to the cache backend. Each key/value pair
   * is appended as `,key=value` after `type=...`.
   */
  params?: Record<string, string>;
}

/**
 * Docker image asset destination (ECR)
 */
export interface DockerImageAssetDestination {
  repositoryName: string;
  imageTag: string;
  assumeRoleArn?: string;
  region?: string;
}

/**
 * Asset publishing result
 */
export interface AssetPublishResult {
  /** Asset hash */
  assetHash: string;
  /** Asset type */
  type: 'file' | 'docker';
  /** Published location (S3 URL or ECR image URI) */
  location: string;
}
