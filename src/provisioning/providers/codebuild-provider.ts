import {
  CodeBuildClient,
  CreateProjectCommand,
  DeleteProjectCommand,
  UpdateProjectCommand,
  UpdateProjectVisibilityCommand,
  BatchGetProjectsCommand,
  ResourceNotFoundException,
  type SourceType,
  type EnvironmentType,
  type ComputeType,
  type ArtifactsType,
  type ArtifactNamespace,
  type ArtifactPackaging,
  type EnvironmentVariableType,
  type CacheType,
  type CacheMode,
  type HostKernel,
  type ImagePullCredentialsType,
  type SourceAuthType,
  type ProjectSource,
  type CreateProjectCommandInput,
  type BatchReportModeType,
  type ProjectVisibilityType,
} from '@aws-sdk/client-codebuild';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { readConfigString, requireConfigArray } from '../config-shape.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  CreateContext,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { markNotGone } from '../not-gone.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { reportCreatedResource } from '../created-resource-sink.js';
import { maskDeep, maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import { generatedNameFor } from '../resource-name.js';

/**
 * A project's visibility when `UpdateProjectVisibility` has never been called:
 * `CreateProject` has no visibility member and a new project reads back
 * `PRIVATE`.
 */
const DEFAULT_PROJECT_VISIBILITY = 'PRIVATE';

/**
 * CodeBuild's default artifact encryption key, and what CloudFormation resets a
 * removed `EncryptionKey` to (go-to-k/cdkd#1160, CFn A/B): the AWS managed S3
 * key. `UpdateProject` refuses `''`, and omitting the member keeps the old key.
 */
const DEFAULT_ENCRYPTION_KEY = 'alias/aws/s3';

/**
 * `Visibility` + `ResourceAccessRole` as `UpdateProjectVisibility` sends them
 * (go-to-k/cdkd#2762). Both ride that one call, `CreateProject` /
 * `UpdateProject` carry neither, and `projectVisibility` is REQUIRED there, so
 * an absent `Visibility` is the default `PRIVATE`.
 *
 * `''` is ABSENT for `ResourceAccessRole`: `readCurrentState` emits it as the
 * placeholder for "no role", which a `drift --revert` hands back.
 */
type VisibilityRead =
  | { kind: 'usable'; visibility: ProjectVisibilityType; resourceAccessRole?: string }
  | { kind: 'unusable'; reason: string };

function readVisibility(properties: Record<string, unknown>, mask: MaskerFn): VisibilityRead {
  const visibility = properties['Visibility'];
  const role = properties['ResourceAccessRole'];
  const refuse = (key: string, value: unknown): VisibilityRead => ({
    kind: 'unusable',
    reason:
      `AWS::CodeBuild::Project ${key} must be a non-empty string, got ` +
      `${JSON.stringify(maskDeep(value, mask))}`,
  });
  if (visibility != null && (typeof visibility !== 'string' || visibility.trim() === '')) {
    return refuse('Visibility', visibility);
  }
  // `''` is the readback's "no role" placeholder; whitespace names no role and
  // would only be refused by AWS after `CreateProject`.
  if (role != null && (typeof role !== 'string' || (role !== '' && role.trim() === ''))) {
    return refuse('ResourceAccessRole', role);
  }
  return {
    kind: 'usable',
    visibility: ((visibility as string | undefined) ??
      DEFAULT_PROJECT_VISIBILITY) as ProjectVisibilityType,
    ...(typeof role === 'string' && role !== '' && { resourceAccessRole: role }),
  };
}

/**
 * SDK Provider for AWS CodeBuild resources
 *
 * Supports:
 * - AWS::CodeBuild::Project
 *
 * CodeBuild CreateProject/UpdateProject are synchronous - the CC API adds
 * unnecessary polling overhead for operations that complete immediately.
 */
export class CodeBuildProvider implements ResourceProvider {
  private client: CodeBuildClient | undefined;
  private createClient: CodeBuildClient | undefined;
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('CodeBuildProvider');

  /**
   * `AWS::CodeBuild::Project` is `ProvisioningType: NON_PROVISIONABLE` — Cloud
   * Control has no handlers for it — so the #614 silent-drop auto-route must
   * not send a template using an unhandled property (`Triggers`, which CDK's
   * `webhook: true` emits) to CC, where it
   * fails mid-deploy with an opaque UnsupportedActionException. With this
   * opt-out the registry refuses such a template pre-flight (issue #3866).
   */
  readonly disableCcApiFallback = true;

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::CodeBuild::Project',
      new Set([
        'Name',
        'Source',
        'Environment',
        'ServiceRole',
        'Artifacts',
        'Tags',
        'Description',
        'TimeoutInMinutes',
        'QueuedTimeoutInMinutes',
        'EncryptionKey',
        'Cache',
        'VpcConfig',
        'LogsConfig',
        'ConcurrentBuildLimit',
        'SecondaryArtifacts',
        'SecondarySources',
        'SecondarySourceVersions',
        'FileSystemLocations',
        'BuildBatchConfig',
        'BadgeEnabled',
        'SourceVersion',
        'AutoRetryLimit',
        // go-to-k/cdkd#2762: through `UpdateProjectVisibility`, see
        // `applyVisibility`. `Triggers` (a webhook) stays unhandled, so a
        // template declaring it is still refused pre-flight.
        'Visibility',
        'ResourceAccessRole',
      ]),
    ],
  ]);

  private getClient(): CodeBuildClient {
    if (!this.client) {
      // Built together with the create client, so both capture the identity
      // active at this ONE call (issue #4639).
      this.client = new CodeBuildClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
      this.createClient = withoutServerErrorRetries(
        new CodeBuildClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.client;
  }

  /**
   * The client `CreateProject` goes through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
   * keeps the full SDK retry.
   *
   * `CreateProject` carries no idempotency token and a project name is unique
   * per account and region, so the SDK's own replay of a 5xx whose request had
   * succeeded collides with the project the first send made, and that
   * `ResourceAlreadyExistsException` surfaced from the engine's FIRST attempt
   * as a name somebody else holds. Refused here, the 5xx reaches the deploy
   * engine's retry, which marks the create as possibly replayed (`withRetry`,
   * #3978). Nothing is adopted on that collision: a name is not attribution
   * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  private getCreateClient(): CodeBuildClient {
    this.getClient();
    return this.createClient as CodeBuildClient;
  }

  /**
   * Return type is DECLARED on purpose. `new CreateProjectCommand(input)` takes
   * a variable, so TypeScript's excess-property check never runs there and a
   * misspelled SDK member (`gitSubModulesConfig`) would compile, be dropped by
   * the serializer, and still pass every unit test — the tests read back the
   * same key the mapper wrote, so they are tautological on spelling. A fresh
   * object literal returned against a declared type IS excess-property checked,
   * which turns each member name into a compile-time fact (issue #1386).
   */
  private mapSource(
    source: Record<string, unknown> | undefined,
    containerPath: string
  ): ProjectSource {
    // `!= null` rather than a truthiness gate: `Source: ''` is exactly the
    // malformed shape `readConfigString` exists to refuse, and a falsy gate
    // would skip the guard and silently build a NO_SOURCE project
    // (.claude/rules/providers.md, "cover the CREATE path").
    if (source == null) {
      return { type: 'NO_SOURCE' as SourceType };
    }

    let buildspec: string | undefined;
    if (source['BuildSpec'] !== undefined) {
      const bs = source['BuildSpec'];
      buildspec = typeof bs === 'object' ? JSON.stringify(bs) : (bs as string);
    }

    // Nested sub-blocks (issue #1386). `mapSource` builds a FRESH object, so
    // every CFn sub-key that is not named here is silently dropped by the SDK
    // serializer. CFn spellings verified against the live registry schema
    // (`cloudformation:DescribeType AWS::CodeBuild::Project`); SDK members
    // verified against `@aws-sdk/client-codebuild`'s `ProjectSource`.
    const cfnAuth = source['Auth'] as Record<string, unknown> | undefined;
    const cfnGitSubmodules = source['GitSubmodulesConfig'] as Record<string, unknown> | undefined;
    const cfnBuildStatus = source['BuildStatusConfig'] as Record<string, unknown> | undefined;

    return {
      type: readConfigString(source, 'Type', 'NO_SOURCE', containerPath) as SourceType,
      buildspec,
      location: source['Location'] as string | undefined,
      gitCloneDepth: source['GitCloneDepth'] as number | undefined,
      insecureSsl: source['InsecureSsl'] as boolean | undefined,
      reportBuildStatus: source['ReportBuildStatus'] as boolean | undefined,
      // SourceIdentifier is required by AWS on every SecondarySources entry
      // (which routes through this same helper) and optional on the primary
      // Source; omitting it made every SecondarySources template fail.
      sourceIdentifier: source['SourceIdentifier'] as string | undefined,
      auth: cfnAuth
        ? {
            type: cfnAuth['Type'] as SourceAuthType,
            resource: cfnAuth['Resource'] as string | undefined,
          }
        : undefined,
      gitSubmodulesConfig: cfnGitSubmodules
        ? { fetchSubmodules: cfnGitSubmodules['FetchSubmodules'] as boolean }
        : undefined,
      buildStatusConfig: cfnBuildStatus
        ? {
            context: cfnBuildStatus['Context'] as string | undefined,
            targetUrl: cfnBuildStatus['TargetUrl'] as string | undefined,
          }
        : undefined,
    };
  }

  private mapArtifacts(artifacts: Record<string, unknown> | undefined, containerPath: string) {
    // `!= null` for the same reason as `mapSource` above.
    if (artifacts == null) {
      return { type: 'NO_ARTIFACTS' as ArtifactsType };
    }

    return {
      type: readConfigString(artifacts, 'Type', 'NO_ARTIFACTS', containerPath) as ArtifactsType,
      location: artifacts['Location'] as string | undefined,
      path: artifacts['Path'] as string | undefined,
      name: artifacts['Name'] as string | undefined,
      namespaceType: artifacts['NamespaceType'] as ArtifactNamespace | undefined,
      packaging: artifacts['Packaging'] as ArtifactPackaging | undefined,
      overrideArtifactName: artifacts['OverrideArtifactName'] as boolean | undefined,
      encryptionDisabled: artifacts['EncryptionDisabled'] as boolean | undefined,
      artifactIdentifier: artifacts['ArtifactIdentifier'] as string | undefined,
    };
  }

  /**
   * Declared return type for the same excess-property reason as {@link mapSource}.
   * `undeclaredName` names a project the template does not name; called only then.
   */
  private mapProperties(
    undeclaredName: () => string,
    properties: Record<string, unknown>
  ): CreateProjectCommandInput {
    const name = (properties['Name'] as string | undefined) ?? undeclaredName();
    const source = properties['Source'] as Record<string, unknown> | undefined;
    const environment = properties['Environment'] as Record<string, unknown> | undefined;
    // Class 2 sanitize (docs/provider-rules.md#readcurrentstate-for-drift-detection): readCurrentState
    // emits `''` placeholders for ServiceRole / EncryptionKey / SourceVersion
    // so a console-side ADD on a project deployed without those keys
    // surfaces as drift. Shipping `''` back through CreateProject /
    // UpdateProject is structurally invalid — `serviceRole: ''` /
    // `encryptionKey: ''` get rejected by the AWS API. Drop empty
    // placeholders here so the wire layer never sees them; non-empty
    // values pass through unchanged. Symmetric with the placeholder
    // emit on the read side, mirroring `serializeRedrivePolicy` in
    // src/provisioning/providers/sqs-queue-provider.ts.
    const sanitizeOptionalString = (value: unknown): string | undefined => {
      if (typeof value !== 'string') return value as string | undefined;
      return value === '' ? undefined : value;
    };
    const serviceRole = sanitizeOptionalString(properties['ServiceRole']);
    const artifacts = properties['Artifacts'] as Record<string, unknown> | undefined;
    const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;

    const envVars = environment?.['EnvironmentVariables'] as
      | Array<{ Name: string; Value: string; Type?: string }>
      | undefined;

    // Environment nested sub-blocks (issue #1386). Same fresh-object drop
    // hazard as `mapSource`.
    //
    // `Environment.HostKernel` IS mapped now. It was not, for the whole time
    // the installed `@aws-sdk/client-codebuild` had no member to map it onto
    // (issue #1386) — naming it then would have been a false claim of support.
    // The SDK grew `ProjectEnvironment.hostKernel`, which the allow-list entry
    // had named as its own expiry condition, and the nested-key checker's
    // staleness pass is what surfaced that the condition had been met.
    const cfnFleet = environment?.['Fleet'] as Record<string, unknown> | undefined;
    const cfnDockerServer = environment?.['DockerServer'] as Record<string, unknown> | undefined;

    // Map Cache (CFn PascalCase -> SDK camelCase)
    const cfnCache = properties['Cache'] as Record<string, unknown> | undefined;
    const cache = cfnCache
      ? {
          type: cfnCache['Type'] as string as CacheType,
          location: cfnCache['Location'] as string | undefined,
          modes: cfnCache['Modes'] as CacheMode[] | undefined,
          // CacheNamespace (issue #1386): scopes an S3 cache so it can be
          // shared across projects. SDK member `cacheNamespace`.
          cacheNamespace: cfnCache['CacheNamespace'] as string | undefined,
        }
      : undefined;

    // Map VpcConfig
    const cfnVpcConfig = properties['VpcConfig'] as Record<string, unknown> | undefined;
    const vpcConfig = cfnVpcConfig
      ? {
          vpcId: cfnVpcConfig['VpcId'] as string | undefined,
          subnets: cfnVpcConfig['Subnets'] as string[] | undefined,
          securityGroupIds: cfnVpcConfig['SecurityGroupIds'] as string[] | undefined,
        }
      : undefined;

    // Map LogsConfig
    const cfnLogsConfig = properties['LogsConfig'] as Record<string, unknown> | undefined;
    let logsConfig: Record<string, unknown> | undefined;
    if (cfnLogsConfig) {
      const cwLogs = cfnLogsConfig['CloudWatchLogs'] as Record<string, unknown> | undefined;
      const s3Logs = cfnLogsConfig['S3Logs'] as Record<string, unknown> | undefined;
      logsConfig = {
        cloudWatchLogs: cwLogs
          ? {
              status: cwLogs['Status'] as string | undefined,
              groupName: cwLogs['GroupName'] as string | undefined,
              streamName: cwLogs['StreamName'] as string | undefined,
            }
          : undefined,
        s3Logs: s3Logs
          ? {
              status: s3Logs['Status'] as string | undefined,
              location: s3Logs['Location'] as string | undefined,
              encryptionDisabled: s3Logs['EncryptionDisabled'] as boolean | undefined,
            }
          : undefined,
      };
    }

    // Map SecondarySources
    const cfnSecondarySources = properties['SecondarySources'] as
      | Array<Record<string, unknown>>
      | undefined;
    const secondarySources =
      cfnSecondarySources == null
        ? undefined
        : requireConfigArray(cfnSecondarySources, 'AWS::CodeBuild::Project SecondarySources').map(
            (s) => this.mapSource(s, 'AWS::CodeBuild::Project SecondarySources[]')
          );

    // Map SecondaryArtifacts
    const cfnSecondaryArtifacts = properties['SecondaryArtifacts'] as
      | Array<Record<string, unknown>>
      | undefined;
    const secondaryArtifacts =
      cfnSecondaryArtifacts == null
        ? undefined
        : requireConfigArray(
            cfnSecondaryArtifacts,
            'AWS::CodeBuild::Project SecondaryArtifacts'
          ).map((a) => this.mapArtifacts(a, 'AWS::CodeBuild::Project SecondaryArtifacts[]'));

    // Map SecondarySourceVersions
    const cfnSecondarySourceVersions = properties['SecondarySourceVersions'] as
      | Array<Record<string, unknown>>
      | undefined;
    const secondarySourceVersions = cfnSecondarySourceVersions
      ? cfnSecondarySourceVersions.map((sv) => ({
          sourceIdentifier: sv['SourceIdentifier'] as string,
          sourceVersion: sv['SourceVersion'] as string,
        }))
      : undefined;

    // Map FileSystemLocations
    const cfnFileSystemLocations = properties['FileSystemLocations'] as
      | Array<Record<string, unknown>>
      | undefined;
    const fileSystemLocations = cfnFileSystemLocations
      ? cfnFileSystemLocations.map((fsl) => ({
          type: fsl['Type'] as 'EFS' | undefined,
          location: fsl['Location'] as string | undefined,
          mountPoint: fsl['MountPoint'] as string | undefined,
          identifier: fsl['Identifier'] as string | undefined,
          mountOptions: fsl['MountOptions'] as string | undefined,
        }))
      : undefined;

    // Map BuildBatchConfig
    const cfnBuildBatchConfig = properties['BuildBatchConfig'] as
      | Record<string, unknown>
      | undefined;
    let buildBatchConfig: Record<string, unknown> | undefined;
    if (cfnBuildBatchConfig) {
      const restrictions = cfnBuildBatchConfig['Restrictions'] as
        | Record<string, unknown>
        | undefined;
      buildBatchConfig = {
        serviceRole: cfnBuildBatchConfig['ServiceRole'] as string | undefined,
        combineArtifacts: cfnBuildBatchConfig['CombineArtifacts'] as boolean | undefined,
        timeoutInMins: cfnBuildBatchConfig['TimeoutInMins'] as number | undefined,
        // Fifth member of the CFn `ProjectBuildBatchConfig` definition. It was
        // the one sub-key this file still dropped after the #1386 sweep, and
        // `readCurrentState` already reads it back — so the asymmetry sat in
        // this same file. Found by review, not by the sweep.
        batchReportMode: cfnBuildBatchConfig['BatchReportMode'] as BatchReportModeType | undefined,
        restrictions: restrictions
          ? {
              maximumBuildsAllowed: restrictions['MaximumBuildsAllowed'] as number | undefined,
              computeTypesAllowed: restrictions['ComputeTypesAllowed'] as string[] | undefined,
            }
          : undefined,
      };
    }

    return {
      name,
      source: this.mapSource(source, 'AWS::CodeBuild::Project Source'),
      environment: {
        type: readConfigString(
          environment,
          'Type',
          'LINUX_CONTAINER',
          'AWS::CodeBuild::Project Environment'
        ) as EnvironmentType,
        computeType: readConfigString(
          environment,
          'ComputeType',
          'BUILD_GENERAL1_SMALL',
          'AWS::CodeBuild::Project Environment'
        ) as ComputeType,
        image: environment?.['Image'] as string | undefined,
        environmentVariables: envVars
          ? envVars.map((v) => ({
              name: v.Name,
              value: v.Value,
              type: (v.Type ?? 'PLAINTEXT') as EnvironmentVariableType,
            }))
          : undefined,
        privilegedMode: environment?.['PrivilegedMode'] as boolean | undefined,
        certificate: environment?.['Certificate'] as string | undefined,
        imagePullCredentialsType: environment?.['ImagePullCredentialsType'] as
          | ImagePullCredentialsType
          | undefined,
        // `HostKernel` was unmappable until the SDK grew the member: the CFn
        // registry declared the key while `ProjectEnvironment` had nothing to
        // put it on, so naming it here would have been a false claim of
        // support. `@aws-sdk/client-codebuild` 3.1126.0 declares
        // `ProjectEnvironment.hostKernel`, which is exactly the condition the
        // `NESTED_KEY_ALLOW_LIST` entry named as its own expiry.
        hostKernel: environment?.['HostKernel'] as HostKernel | undefined,
        fleet: cfnFleet ? { fleetArn: cfnFleet['FleetArn'] as string | undefined } : undefined,
        dockerServer: cfnDockerServer
          ? {
              computeType: cfnDockerServer['ComputeType'] as ComputeType,
              securityGroupIds: cfnDockerServer['SecurityGroupIds'] as string[] | undefined,
            }
          : undefined,
        registryCredential: environment?.['RegistryCredential']
          ? {
              credential: (environment['RegistryCredential'] as Record<string, unknown>)[
                'Credential'
              ] as string,
              credentialProvider: (environment['RegistryCredential'] as Record<string, unknown>)[
                'CredentialProvider'
              ] as 'SECRETS_MANAGER',
            }
          : undefined,
      },
      serviceRole,
      artifacts: this.mapArtifacts(artifacts, 'AWS::CodeBuild::Project Artifacts'),
      tags: tags ? tags.map((t) => ({ key: t.Key, value: t.Value })) : undefined,
      description: properties['Description'] as string | undefined,
      timeoutInMinutes: properties['TimeoutInMinutes'] as number | undefined,
      queuedTimeoutInMinutes: properties['QueuedTimeoutInMinutes'] as number | undefined,
      encryptionKey: sanitizeOptionalString(properties['EncryptionKey']),
      cache,
      vpcConfig,
      logsConfig,
      concurrentBuildLimit: properties['ConcurrentBuildLimit'] as number | undefined,
      // AutoRetryLimit (#609 backfill): integer 0-10; rides CreateProject /
      // UpdateProject directly (no separate control-plane API). Omit-when-
      // absent so a template that does not set it sends no field to AWS.
      autoRetryLimit: properties['AutoRetryLimit'] as number | undefined,
      secondarySources,
      secondaryArtifacts,
      secondarySourceVersions,
      fileSystemLocations,
      buildBatchConfig,
      badgeEnabled: properties['BadgeEnabled'] as boolean | undefined,
      sourceVersion: sanitizeOptionalString(properties['SourceVersion']),
    };
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating CodeBuild Project ${logicalId}`);
    const mask = maskerOrIdentity(context?.maskSecrets);

    // go-to-k/cdkd#2762: the visibility call runs AFTER `CreateProject`, so an
    // unusable value is refused before it, where nothing exists yet. A state
    // replay leaves the project at the default (PRIVATE, no role) with a
    // warning instead of refusing the restore: the narrower exposure.
    const visibilityRead = readVisibility(properties, mask);
    if (visibilityRead.kind === 'unusable') {
      if (context?.replayingState !== true) {
        throw new ProvisioningError(visibilityRead.reason, resourceType, logicalId);
      }
      this.logger.warn(
        mask(
          `${visibilityRead.reason}. Replaying a state record, so CodeBuild Project ${logicalId} ` +
            `is left ${DEFAULT_PROJECT_VISIBILITY} with no resource access role rather than ` +
            `refusing the restore`
        )
      );
    }

    // Set once CreateProject returns: a later failure is the visibility
    // call's, against a project no state record will hold.
    let createdName: string | undefined;
    try {
      // go-to-k/cdkd#5095: an un-named project gets the generated name a
      // stack with an instance id gives every type; a legacy stack keeps the
      // bare logical id it always sent.
      const input = this.mapProperties(
        () => generatedNameFor('AWS::CodeBuild::Project', logicalId),
        properties
      );

      const result = await this.getCreateClient().send(new CreateProjectCommand(input));

      const projectName = result.project!.name!;
      const projectArn = result.project!.arn!;
      createdName = projectName;
      // go-to-k/cdkd#5511: report before the visibility call.
      reportCreatedResource(logicalId, resourceType, createdName);

      // Only a declaration other than the default needs the call: a new
      // project is already PRIVATE with no role.
      if (
        visibilityRead.kind === 'usable' &&
        (visibilityRead.visibility !== DEFAULT_PROJECT_VISIBILITY ||
          visibilityRead.resourceAccessRole !== undefined)
      ) {
        await this.applyVisibility(projectArn, visibilityRead);
      }

      this.logger.debug(`Successfully created CodeBuild Project ${logicalId}: ${projectName}`);

      return {
        physicalId: projectName,
        attributes: {
          Arn: projectArn,
        },
      };
    } catch (error) {
      if (createdName !== undefined) markAuxiliaryFailure(error, logicalId);
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create CodeBuild Project ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            undefined,
            cause
          )
      );
      // The project exists and no state record will hold it, so name it for
      // the failed-CREATE journal — only once CreateProject returned.
      if (createdName !== undefined) {
        markCreatedBeforeFailure(thrown, logicalId, resourceType, createdName);
      }
      throw thrown;
    }
  }

  /**
   * `UpdateProjectVisibility` (go-to-k/cdkd#2762). Omitting
   * `resourceAccessRole` CLEARS a role the project held: a CFn A/B (us-east-1)
   * moving `PUBLIC_READ` + role to `PRIVATE` with no role read back
   * `resourceAccessRole: null`.
   */
  private async applyVisibility(
    projectArn: string,
    read: Extract<VisibilityRead, { kind: 'usable' }>
  ): Promise<void> {
    await this.getClient().send(
      new UpdateProjectVisibilityCommand({
        projectArn,
        projectVisibility: read.visibility,
        ...(read.resourceAccessRole !== undefined && {
          resourceAccessRole: read.resourceAccessRole,
        }),
      })
    );
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating CodeBuild Project ${logicalId}: ${physicalId}`);
    const mask = maskerOrIdentity(context?.maskSecrets);
    // go-to-k/cdkd#2613: the physical id is a NAME, so a client in another
    // region than the state record would act on a same-named resource cdkd
    // does not manage. Refuse before any call; the client's region is
    // resolved only when there is one to compare with.
    assertRegionMatch(
      context?.expectedRegion ? await this.getClient().config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );

    try {
      // The update addresses the recorded project, never a derived name: a
      // project keeps the name it was created under, whichever scheme that was.
      const input = this.mapProperties(() => physicalId, properties);
      input.name = physicalId;

      // Removal semantics (issue #1160, live CFn A/B 2026-08-10 on a
      // NO_SOURCE project). `UpdateProject` is a merge-semantics API — a
      // name-only update left every other live value untouched — so the
      // umbrella flagged all eight optional fields this provider forwards.
      // The A/B narrowed that to ONE: CloudFormation itself RETAINS
      // `Description` / `TimeoutInMinutes` / `QueuedTimeoutInMinutes` /
      // `ConcurrentBuildLimit` / `AutoRetryLimit` / `Cache` / `LogsConfig`
      // when the template drops them (CFn's own handler omits them from
      // `UpdateProject` and CodeBuild merges), so the pass-through above is
      // ALREADY CFn parity for those seven and they are deliberately NOT
      // reset — pinned by the retention tests rather than "fixed" into a
      // divergence.
      //
      // `BuildBatchConfig` is the one field CFn resets: after the removal
      // update the live project reported `buildBatchConfig: null`. The only
      // shape that clears it is an EMPTY object — omitting the field is the
      // no-op that produced the silent drop this issue tracks.
      //
      // This is `clearOnUpdateRemoval`'s semantic applied at the SDK layer
      // rather than through the helper itself: the helper substitutes a
      // clear value on the side it is given, and here the CFn side has no
      // spelling for "cleared" — the empty object is an SDK-shape value. It
      // is applied to the mapped input (instead of an adjusted property bag)
      // so the whole-bag forward into `mapProperties` stays intact for the
      // handled-property-wiring critic's taint walk.
      // Sub-key granularity, per docs/provider-rules.md#update-removal-semantics-clear-on-removal's
      // "test both shapes": a key dropped from a still-present
      // `BuildBatchConfig` needs no separate handling, because the block is
      // sent WHOLESALE — the mapper rebuilds it from the desired side each
      // time, so a dropped member arrives as an absent SDK member of a
      // present structure. That the empty object clears the whole block is
      // the same wholesale semantic, measured.
      const buildBatchConfigRemoved =
        properties['BuildBatchConfig'] == null && previousProperties['BuildBatchConfig'] != null;
      if (buildBatchConfigRemoved) {
        input.buildBatchConfig = {};
      }

      // go-to-k/cdkd#1160, CFn A/B (us-east-1, a CODECOMMIT-source project):
      // CloudFormation's UpdateProject carried `encryptionKey` and `tags` after
      // both were removed, and the project read back the AWS managed key
      // (`alias/aws/s3`, CodeBuild's documented default) and no user tag. A
      // direct probe showed the clear shapes: `encryptionKey: 'alias/aws/s3'`
      // reads back exactly as CFn's reset did (`''` is refused, min length
      // 1), and `tags: []` removes every tag (UpdateProject replaces the
      // list). `SourceVersion` is the opposite: CFn omitted it and the live
      // value was KEPT, so the merge pass-through is parity and it is not
      // reset. A `''` on either side is the `readCurrentState` placeholder for
      // "no key", never a declared one, so it counts as absent.
      const declaredKey = (value: unknown): boolean => value != null && value !== '';
      if (
        !declaredKey(properties['EncryptionKey']) &&
        declaredKey(previousProperties['EncryptionKey'])
      ) {
        input.encryptionKey = DEFAULT_ENCRYPTION_KEY;
      }
      if (properties['Tags'] == null && previousProperties['Tags'] != null) {
        input.tags = [];
      }

      // go-to-k/cdkd#5492, CFn A/B (us-east-1, a CODECOMMIT-source project in
      // a VPC with an EFS mount, a secondary source, version and artifact, and
      // a badge): each of `VpcConfig` / `FileSystemLocations` /
      // `SecondarySources` / `SecondaryArtifacts` / `SecondarySourceVersions`
      // / `BadgeEnabled` was removed once alone and once beside a
      // `Description` change. CloudFormation's UpdateProject (CloudTrail)
      // omitted the removed member every time and the live value was KEPT, so
      // the merge pass-through is parity and none of the six is reset.
      const updated = await this.getClient().send(new UpdateProjectCommand(input));

      // go-to-k/cdkd#2762: `Visibility` / `ResourceAccessRole`, sent as a pair
      // whenever either differs from the record. A removal is the default
      // pair (PRIVATE, no role), which CloudFormation also applies (CFn A/B).
      // An unusable desired value is warned about and the live pair left
      // alone: this path is state-replay reachable, so it cannot refuse.
      //
      // Removing `ResourceAccessRole` while `PUBLIC_READ` stays sends
      // `PUBLIC_READ` with no role; CloudFormation clears the role in this
      // case and keeps the public alias (CFn A/B on go-to-k/cdkd#2762).
      const desiredVisibility = readVisibility(properties, mask);
      const recorded = readVisibility(previousProperties, mask);
      if (desiredVisibility.kind === 'unusable') {
        // Name what stays live: a project recorded PUBLIC_READ stays public.
        const kept = recorded.kind === 'usable' ? ` (recorded ${recorded.visibility})` : '';
        this.logger.warn(
          mask(
            `${desiredVisibility.reason}. Leaving the visibility of CodeBuild Project ` +
              `${physicalId} unchanged${kept}; the same value is REFUSED on a template-path create`
          )
        );
      } else {
        // The record is read leniently (it is state, not the template): an
        // unreadable one counts as changed, so the desired pair is sent.
        const changed =
          recorded.kind !== 'usable' ||
          recorded.visibility !== desiredVisibility.visibility ||
          recorded.resourceAccessRole !== desiredVisibility.resourceAccessRole;
        if (changed) {
          const projectArn = updated.project?.arn;
          if (projectArn === undefined) {
            throw new Error('UpdateProject returned no project ARN for the visibility update');
          }
          await this.applyVisibility(projectArn, desiredVisibility);
        }
      }

      this.logger.debug(`Successfully updated CodeBuild Project ${logicalId}`);

      return { physicalId, wasReplaced: false };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update CodeBuild Project ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  /**
   * The failure wrap the create, update and delete catches throw.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
   * assumed-role ARN. AWS's own text goes to `debug` through `mask`, and the
   * wrap is stamped `markRedactedCause`, so the retry classifiers read the
   * withheld text on the `cause` chain. An "already exists" is restated
   * ({@link relayedNameCollision}) so a create-first replacement still
   * recognises the collision. A non-`Error` throw is withheld the same way,
   * unstamped: it has no chain.
   *
   * A cdkd-authored or transport error keeps its text, masked, stamped exactly
   * when the mask changed it (`wrapMaskedAwsError`, issue #4244). The delete
   * tests its typed not-found before it wraps.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  private wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    const wrapped = build(`${mask(failure.summary)}${relayedNameCollision(failure.detail)}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting CodeBuild Project ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteProjectCommand({ name: physicalId }));
      this.logger.debug(`Successfully deleted CodeBuild Project ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`CodeBuild Project ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete CodeBuild Project ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
      // The wrap names an AWS failure by its CLASS, and the delete classifiers
      // read `NotFoundException` in a message as "already deleted": only the
      // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
      throw error instanceof Error && error.name.includes('NotFound')
        ? markNotGone(thrown)
        : thrown;
    }
  }

  getAttribute(
    _physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    // Arn is stored in attributes during create
    return Promise.resolve(attributeName);
  }

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
   * schema and not handled by this provider.
   *
   * Tags are surfaced from the same `BatchGetProjects` response (CodeBuild
   * uses lower-case `key`/`value` shape; `normalizeAwsTagsToCfn` re-shapes
   * to CFn `[{Key, Value}]`). CDK's `aws:*` auto-tags are filtered out
   * and the result key is omitted when AWS reports no user tags. Returns
   * `RESOURCE_NOT_FOUND` when the project is gone (`projects` array empty /
   * `projectsNotFound` set).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let project;
    try {
      const resp = await this.getClient().send(
        new BatchGetProjectsCommand({ names: [physicalId] })
      );
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
      if (project.source?.insecureSsl !== undefined)
        src['InsecureSsl'] = project.source.insecureSsl;
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
      if (project.artifacts?.packaging !== undefined)
        art['Packaging'] = project.artifacts.packaging;
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

  getDriftUnknownPaths(): string[] {
    return [
      // `readCurrentState` deliberately does NOT reverse-map `Source.Auth`:
      // BatchGetProjects echoes the source-credential block back only
      // partially, so emitting a partial shape would fire phantom drift on
      // every project that sets it (issue #1386). Declaring it here is the
      // repo's mechanism for "state key the provider can never read back" —
      // without it, a baseline that falls back to `properties` (an imported
      // project, or a failed observed capture) reports permanent drift on it.
      'Source.Auth',
    ];
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'Name');
    if (explicit) {
      try {
        const resp = await this.getClient().send(
          new BatchGetProjectsCommand({ names: [explicit] })
        );
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
}
