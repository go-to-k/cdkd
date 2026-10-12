/**
 * Cloud Assembly types
 *
 * Based on CDK Cloud Assembly manifest format.
 * These types replace @aws-cdk/cloud-assembly-api dependency.
 */

import { displayIdent, displayStackName } from '../utils/display-safe.js';
import { SynthesisError } from '../utils/error-handler.js';

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

  /**
   * Hierarchical display name (e.g., "MyStage/MyStack" for stacks under a Stage,
   * or just "MyStack" at the top level). Set by CDK synth.
   */
  displayName?: string;

  /** Artifact-specific properties */
  properties?: Record<string, unknown>;

  /** Dependencies on other artifacts (by artifact ID) */
  dependencies?: string[];

  /** Metadata entries */
  metadata?: Record<string, MetadataEntry[]>;

  /**
   * Side file (`<artifactId>.metadata.json`, relative to the assembly dir)
   * carrying the metadata entries current aws-cdk-lib no longer embeds
   * inline in `manifest.json` — including annotation messages
   * (`aws:cdk:error` / `aws:cdk:warning` / `aws:cdk:info`). See issue #1228.
   */
  additionalMetadataFile?: string;
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

  /**
   * The bootstrap LOOKUP role of the stack's environment (DefaultStackSynthesizer).
   * cdkd reads only `arn`, and only to resolve an aws-cdk-lib-generated
   * cross-account `Fn::GetStackOutput` against this stack's cdkd state.
   */
  lookupRole?: { arn?: unknown };

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
 * The region an assembly's `environment` names: the LONGEST run of lowercase
 * letters, digits and `-` starting right after `aws://<account>/`, the rest
 * ignored. This is exactly the region group of `AWS_ENV_REGEX` in
 * `@aws-cdk/cloud-assembly-api`'s `EnvironmentUtils.parse`, which every
 * `CloudFormationStackArtifact` constructor runs: that pattern is unanchored at
 * its end, so the AWS CDK CLI reads `us-east-1/extra`, `us-east-1 ` and
 * `us-east-1\n...` as `us-east-1`, and cdkd reads them the same way (issue
 * go-to-k/cdkd#2221). The charset covers every real region in every partition
 * (`cn-north-1`, `us-gov-west-1`, `us-isob-east-1`, `eusc-de-east-1`) and the
 * `unknown-region` sentinel.
 */
const ASSEMBLY_REGION_PREFIX = /^[a-z0-9-]+/;

/**
 * `AWS_ENV_REGEX` itself, same character classes (escapes dropped, members
 * reordered). Consulted only when {@link ASSEMBLY_REGION_PREFIX} finds nothing
 * after the FIRST `aws://<account>/`: being unanchored, CDK's pattern can still
 * match a LATER `aws://` in the string, and then the AWS CDK CLI accepts the
 * assembly with that match's account and region, so cdkd must too.
 */
const CDK_ENVIRONMENT_PATTERN = /aws:\/\/([a-zA-Z0-9@._-]+)\/([a-z0-9-]+)/;

/** {@link ASSEMBLY_REGION_PREFIX} matching the WHOLE text. */
const CANONICAL_ASSEMBLY_REGION = /^[a-z0-9-]+$/;

/**
 * Parse environment string "aws://account/region"
 *
 * The region follows the AWS CDK CLI ({@link ASSEMBLY_REGION_PREFIX}). Where it
 * is EMPTY — the text after the `/` does not start with a lowercase letter,
 * digit or `-`, as in `aws://<acct>/US-EAST-1` — the AWS CDK CLI throws
 * `Unable to parse environment specification`, and so does this (issue
 * go-to-k/cdkd#2221). Accepting it was not harmless: the raw text became
 * `StackInfo.region`, the state KEY segment and the `${AWS::Region}` value,
 * while `AwsClients` folds the region its clients sign with, so the deploy
 * succeeded against `us-east-1` and recorded its state under
 * `cdkd/<stack>/US-EAST-1/`, a key no canonically-spelled deploy reads.
 * Refusing rather than folding keeps every state key where it is.
 *
 * The account side is cdkd's own and unchanged — any text up to the first `/` —
 * except where only CDK's later match yields a region, which supplies both.
 *
 * `stackName` only names the stack in the refusal.
 */
export function parseEnvironment(env: string, stackName?: string): ArtifactEnvironment {
  // `[\s\S]`, not `.`: a `.` stops at a line terminator, so a region carrying
  // one failed the whole match and fell through to the `unknown-region`
  // sentinel below, which `assembly-reader.ts` maps to "no region" and so to the
  // command's region fallback, where the AWS CDK CLI reads the region before it.
  const match = env.match(/^aws:\/\/([^/]+)\/([\s\S]+)$/);
  if (!match) {
    return { account: 'unknown-account', region: 'unknown-region' };
  }
  const raw = match[2]!;
  const region = ASSEMBLY_REGION_PREFIX.exec(raw)?.[0];
  if (region !== undefined) {
    return {
      account: match[1] === 'unknown-account' ? 'unknown-account' : match[1]!,
      region,
    };
  }
  // CDK found its match at a LATER `aws://`, so it takes the account from there
  // too; taking ours from the first would pair two environments' halves.
  const cdk = CDK_ENVIRONMENT_PATTERN.exec(env);
  if (cdk === null) {
    throw new SynthesisError(unparsableRegionMessage(raw, stackName));
  }
  return { account: cdk[1]!, region: cdk[2]! };
}

function unparsableRegionMessage(region: string, stackName: string | undefined): string {
  const subject =
    stackName === undefined
      ? 'The cloud assembly'
      : `Stack ${displayStackName(stackName)} in the cloud assembly`;
  const lower = region.toLowerCase();
  // Only a CASE-only spelling gets the state paragraph: it is the one a pre-fix
  // deploy could complete (`AwsClients` folds case and nothing else) and whose
  // raw key `listStacks` can see. A leading line terminator fell through to the
  // command's region fallback instead, and no other refused spelling
  // (leading whitespace, `_`) is a region AWS serves once lowercased.
  const caseOnly = CANONICAL_ASSEMBLY_REGION.test(lower);
  const fix = caseOnly
    ? `Re-synthesize with the region spelled ${displayIdent(lower)}.`
    : "Re-synthesize with a canonical region, e.g. env: { region: 'us-east-1' }.";
  const head =
    `${subject} declares region ${displayIdent(region)}, which is not a canonical ` +
    `AWS region spelling (lowercase letters, digits and '-'). The AWS CDK CLI ` +
    `refuses this assembly too ("Unable to parse environment specification"). ${fix}`;
  if (!caseOnly) return head;
  return (
    `${head}\n` +
    `If an earlier cdkd version deployed this stack from such an assembly, it ` +
    `recorded the stack's state under that raw region spelling, and a deploy ` +
    `using the canonical spelling will not find that state: it starts the stack ` +
    `from no state at all. 'cdkd state show' and 'cdkd state orphan' still reach ` +
    `that record when '--stack-region' is given the exact raw spelling; ` +
    `'state orphan' removes the record and leaves its AWS resources in place, ` +
    `unmanaged by cdkd.`
  );
}
