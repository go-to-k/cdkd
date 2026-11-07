import { BatchGetProjectsCommand, ResourceNotFoundException } from '@aws-sdk/client-codebuild';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../../import-helpers.js';
import {
  type ResourceImportInput,
  type ResourceImportResult,
  type ResourceNotFound,
  RESOURCE_NOT_FOUND,
} from '../../../types/resource.js';
import type { CodeBuildProvider } from '../codebuild-provider.js';

/**
 * Adopt an existing CodeBuild project into cdkd state.
 *
 * Lookup: `--resource` override or `Properties.Name` → verify via
 * `BatchGetProjects`. There is no `aws:cdk:path` tag walk — AWS rejects
 * `aws:`-prefixed tag writes, so that tag never exists on a real resource
 * (issue #1134); auto-mode import resolves ids from CloudFormation's
 * `DescribeStackResources` instead.
 */
/**
 * Read the AWS-current CodeBuild Project configuration in CFn-property shape.
 *
 * Issues `BatchGetProjects` and re-shapes the SDK's camelCase response back
 * to CFn's PascalCase shape (the `mapProperties` helper above goes the
 * other way at create time). Coverage targets every user-controllable
 * top-level field via the always-emit pattern (PR #145):
 *  - `Source` / `Artifacts` / `Environment` (with `EnvironmentVariables`
 *    sub-array): full reshape to CFn shape.
 *  - `LogsConfig` (`CloudWatchLogs` + `S3Logs` sub-shapes): always-emit
 *    placeholder so a console-side enable on a previously-default
 *    project surfaces as drift.
 *  - `VpcConfig` (VpcId / Subnets / SecurityGroupIds): always-emit
 *    placeholder.
 *  - `Cache` (Type / Location / Modes): always-emit placeholder.
 *
 * Not read back: `Triggers`, which is write-only in the CloudFormation
 * schema (see {@link getDriftUnknownPaths}).
 *
 * Tags are surfaced from the same `BatchGetProjects` response (CodeBuild
 * uses lower-case `key`/`value` shape; `normalizeAwsTagsToCfn` re-shapes
 * to CFn `[{Key, Value}]`). CDK's `aws:*` auto-tags are filtered out
 * and the result key is omitted when AWS reports no user tags. Returns
 * `RESOURCE_NOT_FOUND` when the project is gone (`projects` array empty /
 * `projectsNotFound` set).
 */
export async function readCurrentState(
  this: CodeBuildProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let project;
  try {
    const resp = await this.getClient().send(new BatchGetProjectsCommand({ names: [physicalId] }));
    project = resp.projects?.[0];
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
  // BatchGetProjects reports a missing project as an empty `projects` list.
  if (!project) return RESOURCE_NOT_FOUND;

  // CodeBuild projects are mutable via UpdateProject. Top-level keys are
  // surfaced two ways: keys AWS always returns (Description / ServiceRole /
  // EncryptionKey / ...) get a placeholder default so a console-side ADD on
  // a property not templated at deploy time surfaces as drift; keys AWS
  // returns only when set (ConcurrentBuildLimit / AutoRetryLimit / ...) are
  // emit-when-present (gated on `!== undefined`) so a project that never set
  // them does not grow a phantom-drift key.
  const result: Record<string, unknown> = {};
  if (project.name !== undefined) result['Name'] = project.name;
  result['Description'] = project.description ?? '';
  result['ServiceRole'] = project.serviceRole ?? '';
  if (project.timeoutInMinutes !== undefined) {
    result['TimeoutInMinutes'] = project.timeoutInMinutes;
  }
  if (project.queuedTimeoutInMinutes !== undefined) {
    result['QueuedTimeoutInMinutes'] = project.queuedTimeoutInMinutes;
  }
  result['EncryptionKey'] = project.encryptionKey ?? '';
  if (project.concurrentBuildLimit !== undefined) {
    result['ConcurrentBuildLimit'] = project.concurrentBuildLimit;
  }
  // AutoRetryLimit (#609 backfill): emit-when-present — BatchGetProjects
  // returns project.autoRetryLimit only when the project sets it, so a
  // template that never set it stays absent from the snapshot (no default
  // placeholder, which would fire phantom drift on every project).
  if (project.autoRetryLimit !== undefined) {
    result['AutoRetryLimit'] = project.autoRetryLimit;
  }
  result['BadgeEnabled'] = project.badge?.badgeEnabled ?? false;
  result['SourceVersion'] = project.sourceVersion ?? '';

  {
    const src: Record<string, unknown> = {};
    if (project.source?.type !== undefined) src['Type'] = project.source.type;
    if (project.source?.location !== undefined) src['Location'] = project.source.location;
    if (project.source?.buildspec !== undefined) src['BuildSpec'] = project.source.buildspec;
    if (project.source?.gitCloneDepth !== undefined) {
      src['GitCloneDepth'] = project.source.gitCloneDepth;
    }
    if (project.source?.insecureSsl !== undefined) src['InsecureSsl'] = project.source.insecureSsl;
    if (project.source?.reportBuildStatus !== undefined) {
      src['ReportBuildStatus'] = project.source.reportBuildStatus;
    }
    // Sub-blocks wired on the write side by issue #1386 — reverse-mapped
    // emit-when-present (same policy as every key above) so the drift
    // baseline and the AWS-current snapshot stay symmetric.
    if (project.source?.sourceIdentifier !== undefined) {
      src['SourceIdentifier'] = project.source.sourceIdentifier;
    }
    if (project.source?.gitSubmodulesConfig !== undefined) {
      src['GitSubmodulesConfig'] = {
        FetchSubmodules: project.source.gitSubmodulesConfig.fetchSubmodules,
      };
    }
    if (project.source?.buildStatusConfig !== undefined) {
      const bsc: Record<string, unknown> = {};
      if (project.source.buildStatusConfig.context !== undefined) {
        bsc['Context'] = project.source.buildStatusConfig.context;
      }
      if (project.source.buildStatusConfig.targetUrl !== undefined) {
        bsc['TargetUrl'] = project.source.buildStatusConfig.targetUrl;
      }
      src['BuildStatusConfig'] = bsc;
    }
    // `Source.Auth` is deliberately NOT reverse-mapped: it is the source
    // credential authorization block, and BatchGetProjects returns it
    // partially (the `resource` value is not echoed back for every auth
    // type). Emitting a partial shape would fire phantom drift on every
    // project that sets it, so the write side wires it while the read side
    // leaves it out — same policy as the v1-omitted keys listed above.
    result['Source'] = src;
  }

  {
    const art: Record<string, unknown> = {};
    if (project.artifacts?.type !== undefined) art['Type'] = project.artifacts.type;
    if (project.artifacts?.location !== undefined) art['Location'] = project.artifacts.location;
    if (project.artifacts?.path !== undefined) art['Path'] = project.artifacts.path;
    if (project.artifacts?.name !== undefined) art['Name'] = project.artifacts.name;
    if (project.artifacts?.namespaceType !== undefined) {
      art['NamespaceType'] = project.artifacts.namespaceType;
    }
    if (project.artifacts?.packaging !== undefined) art['Packaging'] = project.artifacts.packaging;
    if (project.artifacts?.encryptionDisabled !== undefined) {
      art['EncryptionDisabled'] = project.artifacts.encryptionDisabled;
    }
    if (project.artifacts?.overrideArtifactName !== undefined) {
      art['OverrideArtifactName'] = project.artifacts.overrideArtifactName;
    }
    if (project.artifacts?.artifactIdentifier !== undefined) {
      art['ArtifactIdentifier'] = project.artifacts.artifactIdentifier;
    }
    result['Artifacts'] = art;
  }

  {
    const env: Record<string, unknown> = {};
    if (project.environment?.type !== undefined) env['Type'] = project.environment.type;
    if (project.environment?.image !== undefined) env['Image'] = project.environment.image;
    if (project.environment?.computeType !== undefined) {
      env['ComputeType'] = project.environment.computeType;
    }
    if (project.environment?.privilegedMode !== undefined) {
      env['PrivilegedMode'] = project.environment.privilegedMode;
    }
    if (project.environment?.imagePullCredentialsType !== undefined) {
      env['ImagePullCredentialsType'] = project.environment.imagePullCredentialsType;
    }
    if (project.environment?.certificate !== undefined) {
      env['Certificate'] = project.environment.certificate;
    }
    // Fleet / DockerServer wired on the write side by issue #1386.
    if (project.environment?.hostKernel !== undefined) {
      env['HostKernel'] = project.environment.hostKernel;
    }
    if (project.environment?.fleet !== undefined) {
      const fleet: Record<string, unknown> = {};
      if (project.environment.fleet.fleetArn !== undefined) {
        fleet['FleetArn'] = project.environment.fleet.fleetArn;
      }
      env['Fleet'] = fleet;
    }
    if (project.environment?.dockerServer !== undefined) {
      const ds: Record<string, unknown> = {};
      if (project.environment.dockerServer.computeType !== undefined) {
        ds['ComputeType'] = project.environment.dockerServer.computeType;
      }
      if (project.environment.dockerServer.securityGroupIds !== undefined) {
        ds['SecurityGroupIds'] = project.environment.dockerServer.securityGroupIds;
      }
      env['DockerServer'] = ds;
    }
    env['EnvironmentVariables'] = (project.environment?.environmentVariables ?? []).map((ev) => {
      const out: Record<string, unknown> = {};
      if (ev.name !== undefined) out['Name'] = ev.name;
      if (ev.value !== undefined) out['Value'] = ev.value;
      if (ev.type !== undefined) out['Type'] = ev.type;
      return out;
    });
    result['Environment'] = env;
  }

  // LogsConfig — both sub-shapes (cloudWatchLogs / s3Logs) are user-
  // controllable. Always-emit nested placeholders so a console-side
  // enable on either is detectable; AWS's CFn shape uses Status to
  // toggle each, so a console-side enable shows up as
  // Status: 'ENABLED' against the always-emit Status: 'DISABLED'.
  {
    const logs: Record<string, unknown> = {};
    const cw: Record<string, unknown> = {
      Status: project.logsConfig?.cloudWatchLogs?.status ?? 'ENABLED',
    };
    if (project.logsConfig?.cloudWatchLogs?.groupName !== undefined) {
      cw['GroupName'] = project.logsConfig.cloudWatchLogs.groupName;
    }
    if (project.logsConfig?.cloudWatchLogs?.streamName !== undefined) {
      cw['StreamName'] = project.logsConfig.cloudWatchLogs.streamName;
    }
    logs['CloudWatchLogs'] = cw;
    const s3: Record<string, unknown> = {
      Status: project.logsConfig?.s3Logs?.status ?? 'DISABLED',
    };
    if (project.logsConfig?.s3Logs?.location !== undefined) {
      s3['Location'] = project.logsConfig.s3Logs.location;
    }
    if (project.logsConfig?.s3Logs?.encryptionDisabled !== undefined) {
      s3['EncryptionDisabled'] = project.logsConfig.s3Logs.encryptionDisabled;
    }
    if (project.logsConfig?.s3Logs?.bucketOwnerAccess !== undefined) {
      s3['BucketOwnerAccess'] = project.logsConfig.s3Logs.bucketOwnerAccess;
    }
    logs['S3Logs'] = s3;
    result['LogsConfig'] = logs;
  }

  // VpcConfig — Class 1: AWS only returns vpcId / subnets / securityGroupIds
  // when the project actually has a VPC config (not all projects do).
  // Emit `{}` placeholder when AWS reports no VPC config so a console-
  // side ADD against the empty placeholder shows up via the comparator's
  // union-walk on the v3 observedProperties baseline.
  if (project.vpcConfig?.vpcId !== undefined) {
    const vpc: Record<string, unknown> = { VpcId: project.vpcConfig.vpcId };
    vpc['Subnets'] = project.vpcConfig.subnets ?? [];
    vpc['SecurityGroupIds'] = project.vpcConfig.securityGroupIds ?? [];
    result['VpcConfig'] = vpc;
  } else {
    result['VpcConfig'] = {};
  }

  // Cache — always-emit `{Type: 'NO_CACHE'}` placeholder (AWS-default
  // when not configured) so a console-side enable surfaces as drift.
  {
    const cache: Record<string, unknown> = {
      Type: project.cache?.type ?? 'NO_CACHE',
    };
    if (project.cache?.location !== undefined) cache['Location'] = project.cache.location;
    if (project.cache?.modes !== undefined) cache['Modes'] = project.cache.modes;
    // CacheNamespace wired on the write side by issue #1386.
    if (project.cache?.cacheNamespace !== undefined) {
      cache['CacheNamespace'] = project.cache.cacheNamespace;
    }
    result['Cache'] = cache;
  }

  // SecondarySources / SecondaryArtifacts — same shape as Source /
  // Artifacts above; reshape camelCase to PascalCase. Always-emit []
  // for console-side ADD detection.
  result['SecondarySources'] = (project.secondarySources ?? []).map((s) => {
    const out: Record<string, unknown> = {};
    if (s.type !== undefined) out['Type'] = s.type;
    if (s.location !== undefined) out['Location'] = s.location;
    if (s.buildspec !== undefined) out['BuildSpec'] = s.buildspec;
    if (s.gitCloneDepth !== undefined) out['GitCloneDepth'] = s.gitCloneDepth;
    if (s.insecureSsl !== undefined) out['InsecureSsl'] = s.insecureSsl;
    if (s.reportBuildStatus !== undefined) out['ReportBuildStatus'] = s.reportBuildStatus;
    if (s.sourceIdentifier !== undefined) out['SourceIdentifier'] = s.sourceIdentifier;
    // Same #1386 sub-blocks as the primary Source above (SecondarySources
    // share the `mapSource` write path, so they must share the read shape).
    if (s.gitSubmodulesConfig !== undefined) {
      out['GitSubmodulesConfig'] = { FetchSubmodules: s.gitSubmodulesConfig.fetchSubmodules };
    }
    if (s.buildStatusConfig !== undefined) {
      const bsc: Record<string, unknown> = {};
      if (s.buildStatusConfig.context !== undefined) bsc['Context'] = s.buildStatusConfig.context;
      if (s.buildStatusConfig.targetUrl !== undefined) {
        bsc['TargetUrl'] = s.buildStatusConfig.targetUrl;
      }
      out['BuildStatusConfig'] = bsc;
    }
    return out;
  });

  result['SecondaryArtifacts'] = (project.secondaryArtifacts ?? []).map((a) => {
    const out: Record<string, unknown> = {};
    if (a.type !== undefined) out['Type'] = a.type;
    if (a.location !== undefined) out['Location'] = a.location;
    if (a.path !== undefined) out['Path'] = a.path;
    if (a.name !== undefined) out['Name'] = a.name;
    if (a.namespaceType !== undefined) out['NamespaceType'] = a.namespaceType;
    if (a.packaging !== undefined) out['Packaging'] = a.packaging;
    if (a.encryptionDisabled !== undefined) out['EncryptionDisabled'] = a.encryptionDisabled;
    if (a.overrideArtifactName !== undefined) {
      out['OverrideArtifactName'] = a.overrideArtifactName;
    }
    if (a.artifactIdentifier !== undefined) out['ArtifactIdentifier'] = a.artifactIdentifier;
    return out;
  });

  // SecondarySourceVersions — simple {sourceIdentifier, sourceVersion} array.
  result['SecondarySourceVersions'] = (project.secondarySourceVersions ?? []).map((v) => {
    const out: Record<string, unknown> = {};
    if (v.sourceIdentifier !== undefined) out['SourceIdentifier'] = v.sourceIdentifier;
    if (v.sourceVersion !== undefined) out['SourceVersion'] = v.sourceVersion;
    return out;
  });

  // FileSystemLocations — array of EFS mount config.
  result['FileSystemLocations'] = (project.fileSystemLocations ?? []).map((f) => {
    const out: Record<string, unknown> = {};
    if (f.type !== undefined) out['Type'] = f.type;
    if (f.location !== undefined) out['Location'] = f.location;
    if (f.mountPoint !== undefined) out['MountPoint'] = f.mountPoint;
    if (f.identifier !== undefined) out['Identifier'] = f.identifier;
    if (f.mountOptions !== undefined) out['MountOptions'] = f.mountOptions;
    return out;
  });

  // BuildBatchConfig — `{}` placeholder when no batch config exists.
  if (project.buildBatchConfig) {
    const bbc: Record<string, unknown> = {};
    if (project.buildBatchConfig.serviceRole !== undefined) {
      bbc['ServiceRole'] = project.buildBatchConfig.serviceRole;
    }
    if (project.buildBatchConfig.restrictions !== undefined) {
      const r: Record<string, unknown> = {};
      if (project.buildBatchConfig.restrictions.maximumBuildsAllowed !== undefined) {
        r['MaximumBuildsAllowed'] = project.buildBatchConfig.restrictions.maximumBuildsAllowed;
      }
      if (project.buildBatchConfig.restrictions.computeTypesAllowed !== undefined) {
        r['ComputeTypesAllowed'] = project.buildBatchConfig.restrictions.computeTypesAllowed;
      }
      if (project.buildBatchConfig.restrictions.fleetsAllowed !== undefined) {
        r['FleetsAllowed'] = project.buildBatchConfig.restrictions.fleetsAllowed;
      }
      bbc['Restrictions'] = r;
    }
    if (project.buildBatchConfig.timeoutInMins !== undefined) {
      bbc['TimeoutInMins'] = project.buildBatchConfig.timeoutInMins;
    }
    if (project.buildBatchConfig.batchReportMode !== undefined) {
      bbc['BatchReportMode'] = project.buildBatchConfig.batchReportMode;
    }
    if (project.buildBatchConfig.combineArtifacts !== undefined) {
      bbc['CombineArtifacts'] = project.buildBatchConfig.combineArtifacts;
    }
    result['BuildBatchConfig'] = bbc;
  } else {
    result['BuildBatchConfig'] = {};
  }

  // ResourceAccessRole — simple string. Always-emit '' for ADD detection.
  result['ResourceAccessRole'] = project.resourceAccessRole ?? '';
  // Visibility (go-to-k/cdkd#2762): AWS reports it on every project.
  if (project.projectVisibility !== undefined) {
    result['Visibility'] = project.projectVisibility;
  }

  // Tags from the same BatchGetProjects response (CodeBuild uses lower-case
  // {key, value} shape).
  const tags = normalizeAwsTagsToCfn(project.tags);
  result['Tags'] = tags;

  return result;
}

export async function importImpl(
  this: CodeBuildProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'Name');
  if (explicit) {
    try {
      const resp = await this.getClient().send(new BatchGetProjectsCommand({ names: [explicit] }));
      return resp.projects?.[0]?.name ? { physicalId: explicit, attributes: {} } : null;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw err;
    }
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // `DescribeStackResources` or the template's physical-name property; a
  // project reaching here needs an explicit `--resource` override.
  return null;
}
