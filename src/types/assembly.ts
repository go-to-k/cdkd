/**
 * Cloud Assembly types
 *
 * Based on CDK Cloud Assembly manifest format.
 * These types replace @aws-cdk/cloud-assembly-api dependency.
 */

/**
 * Cloud Assembly manifest (manifest.json)
 */
export interface AssemblyManifest {
  /** Cloud assembly schema version */
  version: string;

  /** Artifacts in the assembly */
  artifacts?: Record<string, ArtifactManifest>;

  /** Missing context values that need to be resolved */
  missing?: MissingContext[];

  /** Runtime information */
  runtime?: RuntimeInfo;
}

/**
 * Artifact manifest entry
 */
export interface ArtifactManifest {
  /** Artifact type */
  type: ArtifactType;

  /** Target environment (e.g., "aws://123456789012/us-east-1") */
  environment?: string;

  /** Artifact-specific properties */
  properties?: Record<string, unknown>;

  /** Dependencies on other artifacts (by artifact ID) */
  dependencies?: string[];

  /** Metadata entries */
  metadata?: Record<string, MetadataEntry[]>;
}

/**
 * Artifact types
 */
export type ArtifactType =
  | 'aws:cloudformation:stack'
  | 'cdk:asset-manifest'
  | 'cdk:tree'
  | 'cdk:cloud-assembly'
  | 'cdk:feature-flag-report';

/**
 * CloudFormation stack artifact properties
 */
export interface StackArtifactProperties {
  /** Path to template file relative to assembly directory */
  templateFile: string;

  /** Physical stack name */
  stackName?: string;

  /** Stack parameters */
  parameters?: Record<string, string>;

  /** Stack tags */
  tags?: Record<string, string>;

  /** Role to assume for deployment */
  assumeRoleArn?: string;

  /** CloudFormation execution role */
  cloudFormationExecutionRoleArn?: string;

  /** Termination protection */
  terminationProtection?: boolean;
}

/**
 * Asset manifest artifact properties
 */
export interface AssetManifestArtifactProperties {
  /** Path to asset manifest file relative to assembly directory */
  file: string;

  /** Required bootstrap stack version */
  requiresBootstrapStackVersion?: number;
}

/**
 * Missing context entry
 */
export interface MissingContext {
  /** Context key */
  key: string;

  /** Context provider type */
  provider: string;

  /** Provider-specific query properties */
  props: ContextQueryProperties;
}

/**
 * Base context query properties (all providers extend this)
 */
export interface ContextQueryProperties {
  /** Target AWS account */
  account: string;

  /** Target AWS region */
  region: string;

  /** Role to assume for lookup */
  lookupRoleArn?: string;

  /** Additional properties (provider-specific) */
  [key: string]: unknown;
}

/**
 * Metadata entry in artifact
 */
export interface MetadataEntry {
  type: string;
  data?: unknown;
  trace?: string[];
}

/**
 * Runtime information
 */
export interface RuntimeInfo {
  libraries?: Record<string, string>;
}

/**
 * Parsed environment from artifact
 */
export interface ArtifactEnvironment {
  account: string;
  region: string;
}

/**
 * Parse environment string "aws://account/region"
 */
export function parseEnvironment(env: string): ArtifactEnvironment {
  const match = env.match(/^aws:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    return { account: 'unknown-account', region: 'unknown-region' };
  }
  return {
    account: match[1] === 'unknown-account' ? 'unknown-account' : match[1]!,
    region: match[2] === 'unknown-region' ? 'unknown-region' : match[2]!,
  };
}
