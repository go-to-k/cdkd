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
 * Docker image asset source
 */
export interface DockerImageAssetSource {
  directory: string;
  dockerFile?: string;
  dockerBuildArgs?: Record<string, string>;
  dockerBuildTarget?: string;
  dockerOutputs?: string[];
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
