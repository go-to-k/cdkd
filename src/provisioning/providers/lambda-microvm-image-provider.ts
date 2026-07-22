import {
  LambdaMicrovmsClient,
  CreateMicrovmImageCommand,
  GetMicrovmImageCommand,
  UpdateMicrovmImageCommand,
  DeleteMicrovmImageCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ListTagsCommand,
  ResourceNotFoundException,
  type CreateMicrovmImageRequest,
  type UpdateMicrovmImageRequest,
  type CodeArtifact,
  type Capability,
  type Logging,
  type Hooks,
  type CpuConfiguration,
  type Resources,
} from '@aws-sdk/client-lambda-microvms';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS Lambda MicroVM Image Provider
 *
 * Implements `AWS::Lambda::MicrovmImage` using the dedicated `lambda-microvms`
 * service SDK (`@aws-sdk/client-lambda-microvms`) — NOT `@aws-sdk/client-lambda`.
 * The MicroVM image APIs (`CreateMicrovmImage` / `GetMicrovmImage` /
 * `UpdateMicrovmImage` / `DeleteMicrovmImage`) live in their own service model.
 *
 * **The build is asynchronous.** `CreateMicrovmImage` returns immediately with
 * the image in `CREATING` state; Lambda then downloads the code artifact zip
 * from S3, runs the Dockerfile, starts the application, and captures a
 * Firecracker snapshot. The image reaches `CREATED` on success or
 * `CREATE_FAILED` on failure (build logs land in CloudWatch under
 * `/aws/lambda/microvms/<name>`). `create()` polls `GetMicrovmImage` until the
 * image reaches `CREATED`. `UpdateMicrovmImage` triggers the same async rebuild
 * (`UPDATING` -> `UPDATED` / `UPDATE_FAILED`).
 *
 * `CDKD_NO_WAIT=true` (or `cdkd deploy --no-wait`) short-circuits the create /
 * update poll and returns immediately with the image ARN. The build continues
 * asynchronously on the AWS side — cdkd will NOT observe a later
 * `CREATE_FAILED`, and an immediate `destroy` may race the in-flight build.
 * The Cloud Control fallback path does NOT honor `--no-wait` (it always polls
 * its request token to a terminal state), so this SDK provider is what makes
 * `--no-wait` effective for this resource type.
 *
 * **Physical id is the image ARN** (`primaryIdentifier` = `/properties/ImageArn`,
 * an AWS-assigned read-only attribute). CFn `Ref` returns the ARN. `Name` is a
 * create-only property, so a `Name` change is routed to REPLACEMENT by cdkd's
 * create-only detection (`getCreateOnlyPropertyPaths`) and never reaches
 * `update()`.
 *
 * **CFn <-> SDK shape translation.** The template carries CloudFormation-schema
 * PascalCase properties (e.g. `CodeArtifact: { Uri }`, `Tags: [{Key, Value}]`,
 * `Logging: { Disabled: true }`); the SDK expects camelCase with different
 * container shapes (`codeArtifact: { uri }`, `tags: Record<string,string>`,
 * `logging: { disabled: {} }`). The mapping helpers below translate each field
 * explicitly so this provider accepts the exact same template the Cloud Control
 * fallback would.
 *
 * **Tags update out-of-band.** `Tags` is `tagUpdatable` but is NOT a field on
 * `UpdateMicrovmImage`, so `update()` reconciles tag changes via `TagResource`
 * / `UntagResource` (no rebuild). A change limited to `Tags` skips the
 * `UpdateMicrovmImage` rebuild entirely; only a build-affecting property change
 * ({@link BUILD_AFFECTING_CFN_KEYS}) issues the async rebuild.
 */
export class LambdaMicrovmImageProvider implements ResourceProvider {
  private client: LambdaMicrovmsClient;
  private logger = getLogger().child('LambdaMicrovmImageProvider');

  // Configurable via env for test runs. Default = 30 min (180 polls x 10s):
  // a MicroVM image build runs the user's Dockerfile + boots the app +
  // snapshots, which can take several minutes. `getMinResourceTimeoutMs()`
  // lifts the deploy engine's per-resource deadline to match so the outer
  // wrapper never truncates the inner poll.
  private readonly maxPollAttempts = positiveIntFromEnv(
    process.env['CDKD_MICROVM_IMAGE_POLL_ATTEMPTS'],
    180
  );
  private readonly pollIntervalMs = positiveIntFromEnv(
    process.env['CDKD_MICROVM_IMAGE_POLL_INTERVAL_MS'],
    10000
  );

  constructor() {
    this.client = getAwsClients().lambdaMicrovms;
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Lambda::MicrovmImage',
      new Set([
        'Name',
        'BaseImageArn',
        'BaseImageVersion',
        'BuildRoleArn',
        'Description',
        'CodeArtifact',
        'Logging',
        'EgressNetworkConnectors',
        'CpuConfigurations',
        'Resources',
        'AdditionalOsCapabilities',
        'Hooks',
        'EnvironmentVariables',
        'Tags',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::Lambda::MicrovmImage',
      new Map([
        ['ImageArn', 'AWS-managed read-only attribute (primaryIdentifier / physical id)'],
        ['State', 'AWS-managed read-only attribute'],
        ['LatestActiveImageVersion', 'AWS-managed read-only attribute'],
        ['LatestFailedImageVersion', 'AWS-managed read-only attribute'],
        ['CreatedAt', 'AWS-managed read-only attribute'],
        ['UpdatedAt', 'AWS-managed read-only attribute'],
      ]),
    ],
  ]);

  getMinResourceTimeoutMs(): number {
    return this.maxPollAttempts * this.pollIntervalMs;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating MicroVM image ${logicalId}`);

    const name = properties['Name'] as string | undefined;
    const baseImageArn = properties['BaseImageArn'] as string | undefined;
    const buildRoleArn = properties['BuildRoleArn'] as string | undefined;
    const codeArtifact = mapCodeArtifact(properties['CodeArtifact']);
    const missing = [
      !name && 'Name',
      !baseImageArn && 'BaseImageArn',
      !buildRoleArn && 'BuildRoleArn',
      !codeArtifact && 'CodeArtifact.Uri',
    ].filter(Boolean);
    if (missing.length > 0) {
      throw new ProvisioningError(
        `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required for MicroVM image ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const input: CreateMicrovmImageRequest = {
      name: name!,
      baseImageArn: baseImageArn!,
      buildRoleArn: buildRoleArn!,
      codeArtifact: codeArtifact!,
      ...buildCommonImageInput(properties),
    };
    const tags = mapKeyValueListToRecord(properties['Tags']);
    if (tags) input.tags = tags;

    try {
      const response = await this.client.send(new CreateMicrovmImageCommand(input));
      const imageArn = response.imageArn;
      if (!imageArn) {
        throw new ProvisioningError(
          `CreateMicrovmImage succeeded but no imageArn returned for ${logicalId}`,
          resourceType,
          logicalId
        );
      }
      this.logger.debug(
        `Created MicroVM image ${logicalId}: ${imageArn} (state=${response.state})`
      );

      const noWait = process.env['CDKD_NO_WAIT'] === 'true';
      // Prefer the terminal poll result for the returned attributes (State
      // CREATED, populated version); under --no-wait fall back to the
      // still-CREATING create response.
      let latest: GetImageResult = {
        state: response.state,
        latestActiveImageVersion: response.latestActiveImageVersion,
        latestFailedImageVersion: response.latestFailedImageVersion,
        createdAt: response.createdAt,
        updatedAt: response.updatedAt,
      };
      if (!noWait) {
        latest = await this.waitForTerminalState(imageArn, logicalId, 'create');
      } else {
        this.logger.warn(
          `Skipping wait for MicroVM image ${logicalId} (CDKD_NO_WAIT=true). ` +
            `The build continues asynchronously; a CREATE_FAILED will not be observed here.`
        );
      }

      return {
        physicalId: imageArn,
        attributes: this.buildAttributes(imageArn, latest.state, {
          latestActiveImageVersion: latest.latestActiveImageVersion,
          latestFailedImageVersion: latest.latestFailedImageVersion,
          createdAt: latest.createdAt,
          updatedAt: latest.updatedAt,
        }),
      };
    } catch (error) {
      throw this.wrapError('create', logicalId, resourceType, undefined, error);
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating MicroVM image ${logicalId}: ${physicalId}`);

    // Name is create-only; cdkd's create-only detection routes a Name change to
    // REPLACEMENT before reaching here. Guard defensively: the SDK
    // UpdateMicrovmImage input has no name field, so a Name change would be
    // silently dropped if it ever slipped through.
    if (properties['Name'] !== previousProperties['Name']) {
      throw new ProvisioningError(
        `MicroVM image ${logicalId} Name is create-only and cannot be changed in place ` +
          `(${String(previousProperties['Name'])} -> ${String(properties['Name'])}); this requires replacement.`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      // Tags are `tagUpdatable` and are NOT a field on UpdateMicrovmImage —
      // they are reconciled out-of-band via TagResource / UntagResource, and a
      // tags-only change must NOT trigger an image rebuild. Reconcile them
      // first (a build rebuild below re-applies nothing tag-related).
      await this.reconcileTags(physicalId, properties['Tags'], previousProperties['Tags']);

      // Only issue an UpdateMicrovmImage (which triggers an async rebuild) when
      // a build-affecting property actually changed. A tags-only update skips
      // the rebuild entirely.
      const buildChanged = BUILD_AFFECTING_CFN_KEYS.some(
        (key) => JSON.stringify(properties[key]) !== JSON.stringify(previousProperties[key])
      );
      if (!buildChanged) {
        this.logger.debug(
          `MicroVM image ${logicalId}: only tags changed, skipping UpdateMicrovmImage rebuild`
        );
        const current = (await this.client.send(
          new GetMicrovmImageCommand({ imageIdentifier: physicalId })
        )) as GetImageResult;
        return {
          physicalId,
          wasReplaced: false,
          attributes: this.buildAttributes(physicalId, current.state, current),
        };
      }

      const baseImageArn = properties['BaseImageArn'] as string | undefined;
      const buildRoleArn = properties['BuildRoleArn'] as string | undefined;
      const codeArtifact = mapCodeArtifact(properties['CodeArtifact']);
      if (!baseImageArn || !buildRoleArn || !codeArtifact) {
        throw new ProvisioningError(
          `BaseImageArn, BuildRoleArn, and CodeArtifact.Uri are required to update MicroVM image ${logicalId}`,
          resourceType,
          logicalId,
          physicalId
        );
      }

      const input: UpdateMicrovmImageRequest = {
        imageIdentifier: physicalId,
        baseImageArn,
        buildRoleArn,
        codeArtifact,
        ...buildCommonImageInput(properties),
        // UpdateMicrovmImage rebuilds from the full desired config; send
        // environmentVariables explicitly (`{}` when cleared) so removing the
        // last variable is applied, not silently dropped.
        environmentVariables: mapKeyValueListToRecord(properties['EnvironmentVariables']) ?? {},
      };

      await this.client.send(new UpdateMicrovmImageCommand(input));

      const noWait = process.env['CDKD_NO_WAIT'] === 'true';
      let latest;
      if (!noWait) {
        latest = await this.waitForTerminalState(physicalId, logicalId, 'update');
      } else {
        this.logger.warn(
          `Skipping wait for MicroVM image ${logicalId} update (CDKD_NO_WAIT=true). ` +
            `The rebuild continues asynchronously.`
        );
      }

      return {
        physicalId,
        wasReplaced: false,
        attributes: this.buildAttributes(physicalId, latest?.state, {
          latestActiveImageVersion: latest?.latestActiveImageVersion,
          latestFailedImageVersion: latest?.latestFailedImageVersion,
          createdAt: latest?.createdAt,
          updatedAt: latest?.updatedAt,
        }),
      };
    } catch (error) {
      throw this.wrapError('update', logicalId, resourceType, physicalId, error);
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting MicroVM image ${logicalId}: ${physicalId}`);

    try {
      try {
        await this.client.send(new DeleteMicrovmImageCommand({ imageIdentifier: physicalId }));
      } catch (error) {
        if (error instanceof ResourceNotFoundException) {
          const clientRegion = await this.client.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(`MicroVM image ${physicalId} does not exist, skipping deletion`);
          return;
        }
        throw error;
      }
      // DeleteMicrovmImage is asynchronous (DELETING -> DELETED). Poll until the
      // image is gone so the destroy leaves no orphan behind.
      await this.waitForDeleted(physicalId, logicalId);
      this.logger.debug(`Successfully deleted MicroVM image ${logicalId}`);
    } catch (error) {
      throw this.wrapError('delete', logicalId, resourceType, physicalId, error);
    }
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    // Ref returns the ARN (handled by physicalId); ImageArn is a defensive alias.
    if (attributeName === 'ImageArn') return physicalId;

    const resp = await this.client.send(
      new GetMicrovmImageCommand({ imageIdentifier: physicalId })
    );
    switch (attributeName) {
      case 'State':
        return resp.state;
      case 'LatestActiveImageVersion':
        return resp.latestActiveImageVersion;
      case 'LatestFailedImageVersion':
        return resp.latestFailedImageVersion;
      case 'CreatedAt':
        return resp.createdAt?.toISOString();
      case 'UpdatedAt':
        return resp.updatedAt?.toISOString();
      default:
        return undefined;
    }
  }

  /**
   * Adopt an existing MicroVM image into cdkd state.
   *
   * Override-only: the image ARN must be supplied via `--resource
   * <logicalId>=<arn>`. There is no auto-lookup — MicroVM images have no
   * `aws:cdk:path` tag (AWS reserves the `aws:` tag prefix) and a bare `Name`
   * is rejected by `GetMicrovmImage` ("Invalid ARN format"), so the physical id
   * must be the image ARN. Returns `null` when the image does not exist.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const arn = input.knownPhysicalId;
    if (!arn) {
      // No auto-lookup — the user must pass the image ARN via --resource.
      return null;
    }
    if (!arn.startsWith('arn:')) {
      throw new Error(
        `--resource override for ${input.logicalId} must be a MicroVM image ARN ` +
          `(got '${arn}'). A bare image name is not accepted; use the arn:...:microvm-image:... ARN.`
      );
    }
    try {
      await this.client.send(new GetMicrovmImageCommand({ imageIdentifier: arn }));
      return { physicalId: arn, attributes: { ImageArn: arn } };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return null;
      throw error;
    }
  }

  /**
   * Read the AWS-current MicroVM image state for `cdkd drift`.
   *
   * Only `Name` and `Tags` are readable back: `GetMicrovmImage` returns just
   * `imageArn` / `name` / `state` / versions / timestamps / `tags`, so the
   * build configuration (`BaseImageArn` / `BuildRoleArn` / `CodeArtifact` /
   * `Logging` / `Hooks` / ...) never comes back. Those paths are excluded from
   * the drift comparison via {@link getDriftUnknownPaths}; drift is therefore
   * scoped to the mutable, readable surface (Tags — updated in place via
   * TagResource/UntagResource).
   *
   * Tags are read via the dedicated `ListTags` (the authoritative tag source),
   * not the `GetMicrovmImage` response's `tags` field, whose population is not
   * guaranteed (the "type != populated" trap).
   *
   * Returns `undefined` when the image is gone.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let name: string | undefined;
    try {
      const resp = await this.client.send(
        new GetMicrovmImageCommand({ imageIdentifier: physicalId })
      );
      name = resp.name;
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return undefined;
      throw error;
    }

    const result: Record<string, unknown> = {};
    if (name !== undefined) result['Name'] = name;
    const tagsResp = await this.client.send(new ListTagsCommand({ Resource: physicalId }));
    result['Tags'] = normalizeAwsTagsToCfn(tagsResp.Tags);
    return result;
  }

  /**
   * Drift comparison paths this provider cannot read back from AWS: the build
   * configuration `GetMicrovmImage` never returns (its response carries only
   * `imageArn` / `name` / `state` / versions / timestamps / `tags`). Only
   * `Name` + `Tags` are read back (see {@link readCurrentState}), so every
   * other managed property is declared unknown to avoid guaranteed
   * false-positive drift on every run.
   */
  getDriftUnknownPaths(_resourceType: string): string[] {
    return [...MICROVM_UNREADABLE_CFN_KEYS];
  }

  // -- helpers -------------------------------------------------------------

  private buildAttributes(
    imageArn: string,
    state: string | undefined,
    extra: {
      latestActiveImageVersion?: string | undefined;
      latestFailedImageVersion?: string | undefined;
      createdAt?: Date | undefined;
      updatedAt?: Date | undefined;
    }
  ): Record<string, unknown> {
    const attributes: Record<string, unknown> = { ImageArn: imageArn };
    if (state !== undefined) attributes['State'] = state;
    if (extra.latestActiveImageVersion !== undefined) {
      attributes['LatestActiveImageVersion'] = extra.latestActiveImageVersion;
    }
    if (extra.latestFailedImageVersion !== undefined) {
      attributes['LatestFailedImageVersion'] = extra.latestFailedImageVersion;
    }
    if (extra.createdAt !== undefined) attributes['CreatedAt'] = extra.createdAt.toISOString();
    if (extra.updatedAt !== undefined) attributes['UpdatedAt'] = extra.updatedAt.toISOString();
    return attributes;
  }

  /**
   * Poll `GetMicrovmImage` until the image reaches a terminal success state
   * (`CREATED` after create, `CREATED` / `UPDATED` after update). Throws on the
   * matching failure state (`CREATE_FAILED` / `UPDATE_FAILED`) or on
   * poll-cap exhaustion.
   */
  private async waitForTerminalState(
    imageArn: string,
    logicalId: string,
    operation: 'create' | 'update'
  ): Promise<GetImageResult> {
    this.logger.debug(`Waiting for MicroVM image ${imageArn} to finish ${operation}...`);

    for (let attempt = 1; attempt <= this.maxPollAttempts; attempt++) {
      const resp = (await this.client.send(
        new GetMicrovmImageCommand({ imageIdentifier: imageArn })
      )) as GetImageResult;
      const state = resp.state;

      if (state === 'CREATED' || state === 'UPDATED') {
        this.logger.debug(`MicroVM image ${imageArn} reached ${state}`);
        return resp;
      }
      if (state === 'CREATE_FAILED' || state === 'UPDATE_FAILED') {
        throw new Error(
          `MicroVM image ${logicalId} (${imageArn}) entered ${state} during ${operation}. ` +
            `Check the build logs in CloudWatch under /aws/lambda/microvms/ to diagnose.`
        );
      }

      this.logger.debug(
        `MicroVM image ${imageArn} state: ${state} (attempt ${attempt}/${this.maxPollAttempts})`
      );
      await sleep(this.pollIntervalMs);
    }

    throw new Error(
      `MicroVM image ${logicalId} (${imageArn}) did not finish ${operation} within ` +
        `${(this.maxPollAttempts * this.pollIntervalMs) / 1000}s. ` +
        `Increase --resource-timeout AWS::Lambda::MicrovmImage=<duration> or set CDKD_NO_WAIT=true.`
    );
  }

  /**
   * Poll `GetMicrovmImage` until it 404s (image fully deleted). Throws on
   * `DELETE_FAILED` or poll-cap exhaustion.
   */
  private async waitForDeleted(imageArn: string, logicalId: string): Promise<void> {
    for (let attempt = 1; attempt <= this.maxPollAttempts; attempt++) {
      let resp: GetImageResult;
      try {
        resp = (await this.client.send(
          new GetMicrovmImageCommand({ imageIdentifier: imageArn })
        )) as GetImageResult;
      } catch (error) {
        if (error instanceof ResourceNotFoundException) return; // gone
        throw error;
      }
      if (resp.state === 'DELETE_FAILED') {
        throw new Error(
          `MicroVM image ${logicalId} (${imageArn}) entered DELETE_FAILED. ` +
            `Check the CloudWatch build logs under /aws/lambda/microvms/ to diagnose.`
        );
      }
      this.logger.debug(
        `MicroVM image ${imageArn} state: ${resp.state} (delete attempt ${attempt}/${this.maxPollAttempts})`
      );
      await sleep(this.pollIntervalMs);
    }

    throw new Error(
      `MicroVM image ${logicalId} (${imageArn}) was not fully deleted within ` +
        `${(this.maxPollAttempts * this.pollIntervalMs) / 1000}s.`
    );
  }

  /**
   * Reconcile the resource's tags to the desired set via TagResource /
   * UntagResource (diff of the CFn `Tags` list, old vs new). Tags are NOT a
   * field on UpdateMicrovmImage, so this is the only way a tag change reaches
   * AWS on update — and it applies without an image rebuild.
   */
  private async reconcileTags(
    physicalId: string,
    newTags: unknown,
    oldTags: unknown
  ): Promise<void> {
    const newMap = mapKeyValueListToRecord(newTags) ?? {};
    const oldMap = mapKeyValueListToRecord(oldTags) ?? {};

    const keysToRemove = Object.keys(oldMap).filter((k) => !(k in newMap));
    const tagsToAdd: Record<string, string> = {};
    for (const [k, v] of Object.entries(newMap)) {
      if (oldMap[k] !== v) tagsToAdd[k] = v;
    }

    if (keysToRemove.length > 0) {
      await this.client.send(
        new UntagResourceCommand({ Resource: physicalId, TagKeys: keysToRemove })
      );
    }
    if (Object.keys(tagsToAdd).length > 0) {
      await this.client.send(new TagResourceCommand({ Resource: physicalId, Tags: tagsToAdd }));
    }
  }

  private wrapError(
    operation: string,
    logicalId: string,
    resourceType: string,
    physicalId: string | undefined,
    error: unknown
  ): ProvisioningError {
    if (error instanceof ProvisioningError) return error;
    const cause = error instanceof Error ? error : undefined;
    return new ProvisioningError(
      `Failed to ${operation} MicroVM image ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
      resourceType,
      logicalId,
      physicalId,
      cause
    );
  }
}

/**
 * CFn property names whose change requires an UpdateMicrovmImage call (an async
 * image rebuild). Everything the SDK's UpdateMicrovmImage accepts EXCEPT tags
 * (which reconcile out-of-band via TagResource / UntagResource) and Name
 * (create-only). A change limited to `Tags` skips the rebuild.
 */
const BUILD_AFFECTING_CFN_KEYS = [
  'BaseImageArn',
  'BaseImageVersion',
  'BuildRoleArn',
  'Description',
  'CodeArtifact',
  'Logging',
  'EgressNetworkConnectors',
  'CpuConfigurations',
  'Resources',
  'AdditionalOsCapabilities',
  'Hooks',
  'EnvironmentVariables',
] as const;

/**
 * CFn property names `GetMicrovmImage` does NOT return (its response carries
 * only `imageArn` / `name` / `state` / versions / timestamps / `tags`), so
 * `cdkd drift` cannot read the build configuration back from AWS.
 * `getDriftUnknownPaths` declares them so they don't fire guaranteed
 * false-positive drift. Currently identical to {@link BUILD_AFFECTING_CFN_KEYS}
 * (the build config is exactly the set that is both rebuild-triggering and
 * unreadable) but kept separate as the two model different concerns
 * (drift-readability vs rebuild-triggering).
 */
const MICROVM_UNREADABLE_CFN_KEYS = BUILD_AFFECTING_CFN_KEYS;

/**
 * Parse a positive-integer poll-config env var, falling back to `dflt` for an
 * unset / non-numeric / non-positive value (so a garbage override cannot yield
 * `NaN`, which would make the poll loop exit immediately with a spurious
 * timeout).
 */
function positiveIntFromEnv(value: string | undefined, dflt: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/** Minimal shape of the `GetMicrovmImage` response fields the provider reads. */
interface GetImageResult {
  state?: string | undefined;
  latestActiveImageVersion?: string | undefined;
  latestFailedImageVersion?: string | undefined;
  createdAt?: Date | undefined;
  updatedAt?: Date | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build the optional create/update input fields shared by both operations,
 * translating each from its CloudFormation-schema shape to the SDK shape.
 * Only defined fields are included so the request never carries `undefined`.
 */
function buildCommonImageInput(
  properties: Record<string, unknown>
): Partial<CreateMicrovmImageRequest> {
  const input: Partial<CreateMicrovmImageRequest> = {};

  if (typeof properties['BaseImageVersion'] === 'string') {
    input.baseImageVersion = properties['BaseImageVersion'];
  }
  if (typeof properties['Description'] === 'string') {
    input.description = properties['Description'];
  }
  const logging = mapLogging(properties['Logging']);
  if (logging) input.logging = logging;
  if (Array.isArray(properties['EgressNetworkConnectors'])) {
    input.egressNetworkConnectors = properties['EgressNetworkConnectors'] as string[];
  }
  const cpuConfigurations = mapCpuConfigurations(properties['CpuConfigurations']);
  if (cpuConfigurations) input.cpuConfigurations = cpuConfigurations;
  const resources = mapResources(properties['Resources']);
  if (resources) input.resources = resources;
  if (Array.isArray(properties['AdditionalOsCapabilities'])) {
    input.additionalOsCapabilities = properties['AdditionalOsCapabilities'] as Capability[];
  }
  const hooks = mapHooks(properties['Hooks']);
  if (hooks) input.hooks = hooks;
  const environmentVariables = mapKeyValueListToRecord(properties['EnvironmentVariables']);
  if (environmentVariables) input.environmentVariables = environmentVariables;

  return input;
}

function mapCodeArtifact(value: unknown): CodeArtifact | undefined {
  if (!isRecord(value)) return undefined;
  const uri = value['Uri'];
  return typeof uri === 'string' ? { uri } : undefined;
}

function mapLogging(value: unknown): Logging | undefined {
  if (!isRecord(value)) return undefined;
  if (value['Disabled'] === true) return { disabled: {} };
  const cloudWatch = value['CloudWatch'];
  if (isRecord(cloudWatch)) {
    const cw: { logGroup?: string; logStream?: string } = {};
    if (typeof cloudWatch['LogGroup'] === 'string') cw.logGroup = cloudWatch['LogGroup'];
    if (typeof cloudWatch['LogStream'] === 'string') cw.logStream = cloudWatch['LogStream'];
    return { cloudWatch: cw };
  }
  return undefined;
}

function mapCpuConfigurations(value: unknown): CpuConfiguration[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter(isRecord)
    .map((c) => ({ architecture: c['Architecture'] as CpuConfiguration['architecture'] }));
}

function mapResources(value: unknown): Resources[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter(isRecord)
    .map((r) => Number(r['MinimumMemoryInMiB']))
    .filter((n) => Number.isFinite(n))
    .map((minimumMemoryInMiB) => ({ minimumMemoryInMiB }));
}

/**
 * Translate the CFn `Hooks` structure (PascalCase keys throughout, all leaf
 * values are strings/numbers) to the SDK `hooks` shape (camelCase keys). Safe
 * to lower-case the first character of every key recursively because Hooks
 * carries no tagged unions and no array-of-record members.
 */
function mapHooks(value: unknown): Hooks | undefined {
  if (!isRecord(value)) return undefined;
  return lowerFirstKeysDeep(value) as Hooks;
}

/**
 * Convert a CFn `[{Key, Value}]` list (used by both `Tags` and
 * `EnvironmentVariables`) to the SDK `Record<string, string>` shape. Returns
 * `undefined` for an empty / absent list so the request omits the field.
 */
function mapKeyValueListToRecord(value: unknown): Record<string, string> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const entry of value) {
    if (isRecord(entry) && typeof entry['Key'] === 'string') {
      out[entry['Key']] = typeof entry['Value'] === 'string' ? entry['Value'] : '';
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function lowerFirstKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(lowerFirstKeysDeep);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k.charAt(0).toLowerCase() + k.slice(1)] = lowerFirstKeysDeep(v);
    }
    return out;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
