import type { TaskRoleUnresolvedReason } from './role-arn.js';
import type { StackInfo } from '../../synthesis/assembly-reader.js';
import type { TemplateResource } from '../../types/resource.js';
import type { ImageResolutionContext } from '../intrinsic-image.js';

/**
 * Result of resolving a `cdkd local run-task <target>` argument back to a
 * concrete `AWS::ECS::TaskDefinition` in the synthesized assembly. The
 * shape mirrors what the ECS API + the CFn template expose so the runner
 * can directly translate each field into `docker run` flags / `docker
 * network` lifecycle calls without re-walking the template.
 *
 * Phase 1: no AWS-side ECS API calls are needed to build this — every
 * field is template-derived. `Secrets[].valueFrom` resolution happens
 * separately in `ecs-secrets-resolver.ts` so this module stays free of
 * AWS SDK imports.
 */
export interface ResolvedEcsTask {
  /** Stack the task definition belongs to. */
  stack: StackInfo;
  /** Logical id of the AWS::ECS::TaskDefinition resource. */
  taskDefinitionLogicalId: string;
  /** Raw template entry — kept for future feature additions. */
  resource: TemplateResource;
  /**
   * Task family. Falls back to the logical id when not declared (CDK auto-
   * generates a family in this case but only at deploy time; locally we
   * surface the logical id so logs are still identifiable).
   */
  family: string;
  /**
   * Default `bridge`. `awsvpc` is mapped to `bridge` locally with a warn
   * because docker cannot emulate ENI-per-task; `host` and `none` pass
   * through unchanged.
   */
  networkMode: 'bridge' | 'awsvpc' | 'host' | 'none';
  /**
   * Resolved task role ARN. Surfaced as either:
   *   - a flat string ARN passed through verbatim from the template, OR
   *   - the deployed role's ARN when the `TaskRoleArn` is a `Ref` /
   *     `Fn::GetAtt` against an `AWS::IAM::Role` in the same stack and the
   *     state source's record holds that role (go-to-k/cdkd#6189), OR
   *   - a synth-time placeholder of the shape
   *     `arn:${AWS::Partition}:iam::${AWS::AccountId}:role/<RoleLogicalId>`
   *     for the same reference with no such record ({@link taskRoleUnresolved}
   *     is then set). The CLI substitutes the placeholder partition and account
   *     lazily via STS `GetCallerIdentity` when (and only when)
   *     `--assume-task-role` is used in its bare form.
   *   - `undefined` when the template's `TaskRoleArn` is missing OR is an
   *     intrinsic that doesn't reference a same-stack IAM Role (e.g.
   *     points at a non-IAM-Role resource type or is an unsupported
   *     intrinsic shape — see `resolveRoleArn`).
   */
  taskRoleArn?: string;
  /**
   * Set when {@link taskRoleArn} is the placeholder built from the role's
   * LOGICAL id, with why no state record named the deployed role: the ARN is
   * right only if the role's name is its logical id (go-to-k/cdkd#6189).
   */
  taskRoleUnresolved?: { logicalId: string; reason: TaskRoleUnresolvedReason };
  /** Resolved execution role ARN. Follows the same shape as `taskRoleArn`. */
  executionRoleArn?: string;
  containers: ResolvedEcsContainer[];
  volumes: ResolvedEcsVolume[];
  /**
   * `RuntimePlatform.CpuArchitecture` + `OperatingSystemFamily`. Only
   * `X86_64` / `ARM64` + `LINUX` are routed in v1; other values pass
   * through unchanged but the docker-runner only honors the arch field.
   */
  runtimePlatform?: { cpuArchitecture: 'X86_64' | 'ARM64'; operatingSystemFamily: 'LINUX' };
  /**
   * Resolution warnings (e.g. `awsvpc` → `bridge` map) the caller may
   * want to surface at startup. Non-fatal — the runner still proceeds.
   */
  warnings: string[];
}

export interface UnresolvedCommandElement {
  field: 'Command' | 'EntryPoint' | 'HealthCheck.Command';
  index: number;
  reason: string;
}

export interface ResolvedEcsContainer {
  name: string;
  image: ResolvedEcsImage;
  command?: string[];
  entryPoint?: string[];
  workingDirectory?: string;
  /** Literal-only env vars; intrinsic-valued entries are dropped (matches `cdkd local invoke` v1). */
  environment: Record<string, string>;
  /** SecretArn entries. Resolved to real values by `ecs-secrets-resolver.ts`. */
  secrets: { name: string; valueFrom: string }[];
  /**
   * `environment` keys whose value is ALREADY plaintext from a CloudFormation
   * dynamic reference resolved at the cross-stack boundary (issue #2056).
   * The runner keeps them off the `docker run` argv and never re-scans them.
   */
  resolvedDynamicReferenceKeys?: string[];
  /**
   * `Secrets` names the resolver DROPPED (intrinsic `ValueFrom` with no state
   * to resolve it). A value `--env-vars` supplies for one is still a secret, so
   * the runner keeps it off the `docker run` argv (go-to-k/cdkd#5756).
   */
  droppedSecretNames?: string[];
  /**
   * `Command` / `EntryPoint` / `HealthCheck.Command` elements the resolver
   * could not resolve; each holds an empty placeholder at its index. The CLI
   * refuses the run while any remain (go-to-k/cdkd#6271).
   */
  unresolvedCommandElements?: UnresolvedCommandElement[];
  /**
   * Container port mappings. `name` (mirrors the CFn `Name` field) is
   * surfaced for Service Connect resolution (Phase 3 of #262 / Issue
   * #460) — the resolver matches `ServiceConnectConfiguration.Services[].PortName`
   * against this field.
   */
  portMappings: {
    name?: string;
    containerPort: number;
    hostPort?: number;
    protocol: 'tcp' | 'udp';
  }[];
  mountPoints: { sourceVolume: string; containerPath: string; readOnly: boolean }[];
  dependsOn: { containerName: string; condition: 'START' | 'COMPLETE' | 'SUCCESS' | 'HEALTHY' }[];
  links: string[];
  /** Default true per AWS docs — when not set, the container is treated as essential. */
  essential: boolean;
  healthCheck?: {
    command: string[];
    interval?: number;
    timeout?: number;
    retries?: number;
    startPeriod?: number;
  };
  user?: string;
  privileged?: boolean;
  readonlyRootFilesystem?: boolean;
  ulimits: { name: string; softLimit: number; hardLimit: number }[];
  /**
   * Non-fatal warnings produced while parsing this container — typically
   * intrinsic-valued env vars or secret ValueFrom entries that could not
   * be substituted against state. The CLI prints these so the user
   * understands why an expected env / secret is missing.
   */
  warnings: string[];
}

export type ResolvedEcsImage =
  | { kind: 'cdk-asset'; assetHash?: string }
  | { kind: 'ecr'; uri: string; account: string; region: string }
  | { kind: 'public'; uri: string }
  /**
   * The image names a same-stack `AWS::ECR::Repository` whose URI cannot be
   * resolved without deployed state (no `--from-state` / `--from-cfn-stack`,
   * or the repository is absent from it). A deployed-registry pin like `ecr`,
   * so `--image-override` can replace it with a local build; a container left
   * uncovered fails with `unresolvedReason` before anything starts
   * (`assertEcsTaskImagesResolvable`; go-to-k/cdkd#5768, mirroring
   * go-to-k/cdk-local#847).
   */
  | { kind: 'same-stack-ecr'; repoLogicalId: string; unresolvedReason: string };

export interface ResolvedEcsVolume {
  name: string;
  kind: 'host' | 'docker';
  /** Absolute host path for a bind mount. Undefined → docker anonymous volume. */
  hostPath?: string;
  /**
   * `DockerVolumeConfiguration`. When set, the volume is realized via
   * `docker volume create` rather than a bind mount.
   */
  dockerVolumeConfig?: {
    scope: 'task' | 'shared';
    autoprovision?: boolean;
    driver?: string;
    driverOpts?: Record<string, string>;
    labels?: Record<string, string>;
  };
}

/**
 * Optional substitution data fed into `parseContainerImage`. Closes issue
 * #264 — container `Image` fields shaped as `Fn::Sub` against AWS pseudo
 * parameters (`${AWS::AccountId}` / `${AWS::Region}` / `${AWS::Partition}` /
 * `${AWS::URLSuffix}`) and / or same-stack `AWS::ECR::Repository` refs are
 * resolvable at runtime when the caller can supply the account ID + region
 * (Tier 1, no state needed) and optionally the cdkd state-recorded
 * `physicalId` map (Tier 2, `--from-state`).
 *
 * The CLI command resolves both blocks lazily — STS is only invoked when
 * at least one container's `Image` references the pseudo parameters — and
 * passes the resolved shape here. The resolver itself stays pure and
 * synchronous.
 */
/**
 * Substitution context for ECS resolution. Re-exported alias for the
 * shared `ImageResolutionContext` in `intrinsic-image.ts` (extracted
 * in issue #286 Gap 2 when `lambda-resolver.ts` needed the same
 * resolver). The shared type carries `pseudoParameters` (Tier 1) +
 * `stateResources` (Tier 2). `stateResources` is consumed by:
 *   - Image (PR #267): `${<LogicalId>}` against an `AWS::ECR::Repository`
 *     and the `Fn::GetAtt: [<Repo>, 'RepositoryUri']` shape.
 *   - Environment / Secrets (issue #291): intrinsic-valued
 *     `Environment[].Value` and `Secrets[].ValueFrom` entries
 *     (`Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::Join`) are substituted
 *     via `state-resolver.ts`'s `substituteAgainstState`.
 * Existing consumers (`src/cli/commands/local-run-task.ts`) import the
 * alias; new code should reach for `ImageResolutionContext` directly.
 */
export type EcsImageResolutionContext = ImageResolutionContext & {
  /**
   * Name of the region's cdkd-owned container-asset ECR repository, as
   * recorded in the per-region bootstrap marker (issue #1025). Since
   * `cdkd bootstrap --container-repo <name>` (issue #1011) a region's
   * repo can carry ANY name — the marker is the source of truth — so
   * the conventional `cdkd-container-assets-` prefix regex alone cannot
   * classify images published to a custom-named repo. When set,
   * `isCdkAssetImageUri` additionally accepts any ECR-hosted URI whose
   * repository path component equals this name. Populated lazily by the
   * CLI from the region's bootstrap marker under `--from-state` only
   * (`--from-cfn-stack` stacks were deployed via CloudFormation and
   * therefore use conventional names the regex already matches).
   */
  cdkAssetContainerRepo?: string;
  /**
   * Resolve the task / execution role WITHOUT the record's IAM roles
   * (go-to-k/cdkd#6189): set in AWS Emulator mixed mode when the record's IAM
   * resources are the emulator's while the role is assumed in real AWS. The
   * rest of the record still serves a `Fn::Join` / `Fn::Sub` role ARN.
   */
  ignoreStateForRoles?: boolean;
};

/**
 * Parse a `target` argument into (optional stack pattern, path-or-id).
 * Mirrors `lambda-resolver.parseTarget` exactly — same accepted forms,
 * same single-stack auto-detect rule.
 */
export interface ParsedEcsTarget {
  stackPattern: string | null;
  pathOrId: string;
  isPath: boolean;
}

/**
 * Walk the matched stack's template and report whether any container's
 * `Image` field needs Tier 1 (pseudo-parameter) or Tier 2 (state-recorded
 * ECR Repository) substitution. The CLI uses this to make the STS /
 * state-load calls lazy — flat strings / cdk-asset shapes / Fn::Sub bodies
 * with no recognized placeholders skip both calls entirely.
 *
 * The probe is per-stack rather than per-target because we don't run the
 * full target resolver until the substitution context is built; cheap
 * O(resources) scan over the template's task definitions is sufficient.
 */
export interface EcsImageResolutionNeeds {
  /** Any `Fn::Sub` body references an `AWS::*` pseudo parameter. */
  needsPseudoParameters: boolean;
  /**
   * Any `Fn::Sub` body references an `AWS::ECR::Repository` logical ID,
   * OR any `Fn::GetAtt: [<Repo>, 'RepositoryUri' | 'Arn']` is present.
   */
  needsStateResources: boolean;
  /**
   * Any container's `Environment[].Value` OR `Secrets[].ValueFrom` OR
   * `Command` / `EntryPoint` / `HealthCheck.Command` element (go-to-k/cdkd#6271) is
   * an intrinsic (`Ref` / `Fn::GetAtt` / `Fn::Sub` / `Fn::Join`); OR
   * any task's `Volumes[].Host.SourcePath` is an intrinsic (Gap 6 of
   * #286); OR any task's `TaskRoleArn` / `ExecutionRoleArn` is a
   * `Fn::Sub` / `Fn::Join` intrinsic (Gap 5 of #286). The CLI uses
   * this flag to gate `--from-state` state loading + pseudo-parameter
   * resolution. Without `--from-state` these entries either drop with
   * warnings (env / secret / role ARN) or hard-error (volume source
   * path — silent drop would mount an empty anonymous volume; an argv
   * element — a dropped one runs a different command).
   */
  needsEnvOrSecretSubstitution: boolean;
  /**
   * Any container's `Environment[].Value` OR `Secrets[].ValueFrom` OR argv
   * element (go-to-k/cdkd#6271) is a cross-stack intrinsic (top-level `Fn::ImportValue` /
   * `Fn::GetStackOutput`). Issue #454 — gates the cross-stack resolver
   * construction inside the `--from-state` flow so literal +
   * same-stack-intrinsic env maps don't pay the extra S3-client / index-
   * load cost.
   */
  needsCrossStackResolver: boolean;
  /**
   * Any container's `Image` is a flat-extractable ECR-hosted URI (host
   * part carries an ECR form's labels) whose repository path component does NOT
   * match the conventional `CDK_ASSET_IMAGE_REPO_RE` shapes. The CLI
   * uses this flag to gate the lazy bootstrap-marker read (issue #1025):
   * a region bootstrapped with `cdkd bootstrap --container-repo <name>`
   * publishes container assets to a custom-named repo the prefix regex
   * cannot recognize, and only the marker knows the actual name.
   */
  needsAssetRepoMarker: boolean;
  /**
   * Any task's `TaskRoleArn` is a `Ref` / `Fn::GetAtt` against a same-stack
   * `AWS::IAM::Role` (go-to-k/cdkd#6189). Only the state record knows that
   * role's deployed name, so the CLI loads state for it when the bare
   * `--assume-task-role` is passed with a state source.
   */
  needsTaskRoleState: boolean;
}
