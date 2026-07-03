import {
  SFNClient,
  CreateStateMachineCommand,
  UpdateStateMachineCommand,
  DeleteStateMachineCommand,
  DescribeStateMachineCommand,
  ListStateMachinesCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  StateMachineDoesNotExist,
  type CreateStateMachineCommandInput,
  type LoggingConfiguration,
  type TracingConfiguration,
  type EncryptionConfiguration,
  type Tag,
  type StateMachineType,
} from '@aws-sdk/client-sfn';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { CDK_PATH_TAG, normalizeAwsTagsToCfn } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS Step Functions State Machine Provider
 *
 * Implements resource provisioning for AWS::StepFunctions::StateMachine using the SFN SDK.
 * WHY: SFN CreateStateMachine is synchronous - the CC API adds unnecessary polling
 * overhead (1s->2s->4s->8s) for an operation that completes immediately.
 * This SDK provider eliminates that polling and returns instantly.
 */
export class StepFunctionsProvider implements ResourceProvider {
  private sfnClient?: SFNClient;
  private s3Client?: S3Client;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('StepFunctionsProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::StepFunctions::StateMachine',
      new Set([
        'StateMachineName',
        'RoleArn',
        'StateMachineType',
        'LoggingConfiguration',
        'TracingConfiguration',
        'Tags',
        'DefinitionString',
        'Definition',
        'DefinitionS3Location',
        'DefinitionSubstitutions',
        'EncryptionConfiguration',
      ]),
    ],
  ]);

  private getClient(): SFNClient {
    if (!this.sfnClient) {
      this.sfnClient = new SFNClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.sfnClient;
  }

  private getS3Client(): S3Client {
    if (!this.s3Client) {
      this.s3Client = new S3Client(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.s3Client;
  }

  /**
   * Create a Step Functions state machine
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Step Functions state machine ${logicalId}`);

    const stateMachineName =
      (properties['StateMachineName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 80 });
    const roleArn = properties['RoleArn'] as string | undefined;

    if (!roleArn) {
      throw new ProvisioningError(
        `RoleArn is required for Step Functions state machine ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      // Build definition string - handle inline string/object forms AND the
      // S3-sourced form (DefinitionS3Location). The S3 path fetches the
      // object and applies DefinitionSubstitutions, so this is async.
      const definitionString = await this.buildDefinitionString(properties);

      // Build tags: CDK uses [{Key, Value}], SFN SDK uses [{key, value}]
      let tags: Tag[] | undefined;
      if (properties['Tags']) {
        const tagList = properties['Tags'] as Array<{ Key: string; Value: string }>;
        tags = tagList.map((tag) => ({ key: tag.Key, value: tag.Value }));
      }

      // Translate every CFn-PascalCase nested object to the SDK's
      // camelCase shape (see helpers at file scope). All three mappers
      // also fold the Class 2 empty-placeholder case to `undefined` so
      // `cdkd drift --revert` round-trips through `update()` without AWS
      // rejecting a structurally incomplete payload.
      const encryptionConfiguration = mapEncryptionConfiguration(
        properties['EncryptionConfiguration']
      );
      const loggingConfiguration = mapLoggingConfiguration(properties['LoggingConfiguration']);
      const tracingConfiguration = mapTracingConfiguration(properties['TracingConfiguration']);

      const createParams: CreateStateMachineCommandInput = {
        name: stateMachineName,
        definition: definitionString,
        roleArn: roleArn,
        type: properties['StateMachineType'] as StateMachineType | undefined,
        loggingConfiguration,
        tracingConfiguration,
        tags: tags,
        encryptionConfiguration,
      };

      const response = await this.getClient().send(new CreateStateMachineCommand(createParams));

      const stateMachineArn = response.stateMachineArn;
      if (!stateMachineArn) {
        throw new Error('CreateStateMachine did not return stateMachineArn');
      }

      this.logger.debug(
        `Successfully created Step Functions state machine ${logicalId}: ${stateMachineArn}`
      );

      // Extract name from ARN (last segment after :)
      const name = stateMachineArn.split(':').pop() || stateMachineName;

      return {
        physicalId: stateMachineArn,
        attributes: {
          Arn: stateMachineArn,
          Name: name,
          StateMachineRevisionId: response.stateMachineVersionArn,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Step Functions state machine ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        stateMachineName,
        cause
      );
    }
  }

  /**
   * Update a Step Functions state machine
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Step Functions state machine ${logicalId}: ${physicalId}`);

    try {
      const definitionString = await this.buildDefinitionString(properties);

      // Translate every CFn-PascalCase nested object to the SDK's
      // camelCase shape (see helpers below). All three mappers also fold
      // the Class 2 empty-placeholder case to `undefined` so `cdkd drift
      // --revert` round-trips through `update()` without AWS rejecting a
      // structurally incomplete payload (`encryptionConfiguration` requires
      // `type`; `loggingConfiguration` without `level` would silently
      // disable logging).
      //
      // BEFORE THIS FIX `properties['LoggingConfiguration']` (CFn PascalCase
      // from cdkd state) was cast straight to the SDK camelCase type — the
      // cast is a no-op at runtime, so AWS received the wrong shape and
      // silently ignored Level / IncludeExecutionData / Destinations, which
      // surfaced as `cdkd drift --revert` reporting `✓ reverted` while the
      // very next `cdkd drift` re-detected the same drift.
      //
      // REMOVAL-CLEAR (issue #978): `UpdateStateMachine` is patch-style — a
      // field omitted from the request keeps its current AWS value. So when a
      // config that WAS present in `previousProperties` is absent from the new
      // `properties`, mapping from `properties` alone yields `undefined`, the
      // field is omitted, and AWS silently keeps the old config (the removal is
      // never applied). For each of the three configs we detect the
      // prev-present / new-absent transition and send an explicit disable
      // sentinel instead of `undefined`, mirroring Lambda ESM's
      // `clearOnUpdateRemoval` / SQS's `SQS_ATTRIBUTE_REMOVAL_RESET`.
      const encryptionConfiguration =
        mapEncryptionConfiguration(properties['EncryptionConfiguration']) ??
        disabledEncryptionConfigurationOnRemoval(
          previousProperties['EncryptionConfiguration'],
          properties['EncryptionConfiguration']
        );
      const loggingConfiguration =
        mapLoggingConfiguration(properties['LoggingConfiguration']) ??
        disabledLoggingConfigurationOnRemoval(
          previousProperties['LoggingConfiguration'],
          properties['LoggingConfiguration']
        );
      const tracingConfiguration =
        mapTracingConfiguration(properties['TracingConfiguration']) ??
        disabledTracingConfigurationOnRemoval(
          previousProperties['TracingConfiguration'],
          properties['TracingConfiguration']
        );

      await this.getClient().send(
        new UpdateStateMachineCommand({
          stateMachineArn: physicalId,
          definition: definitionString,
          roleArn: properties['RoleArn'] as string | undefined,
          loggingConfiguration,
          tracingConfiguration,
          encryptionConfiguration,
        })
      );

      this.logger.debug(`Updated Step Functions state machine ${physicalId}`);

      // Apply tag diff. SFN uses lowercase camelCase shape:
      // TagResource({ resourceArn, tags: [{ key, value }] }),
      // UntagResource({ resourceArn, tagKeys: [...] }).
      await this.applyTagDiff(
        physicalId,
        previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
        properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
      );

      // Describe to get updated attributes
      const describeResponse = await this.getClient().send(
        new DescribeStateMachineCommand({ stateMachineArn: physicalId })
      );

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: physicalId,
          Name: describeResponse.name,
          StateMachineRevisionId: describeResponse.revisionId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update Step Functions state machine ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a Step Functions state machine
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Step Functions state machine ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteStateMachineCommand({ stateMachineArn: physicalId }));
      this.logger.debug(`Successfully deleted Step Functions state machine ${logicalId}`);
    } catch (error) {
      if (error instanceof StateMachineDoesNotExist) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(
          `Step Functions state machine ${physicalId} does not exist, skipping deletion`
        );
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Step Functions state machine ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Read the AWS-current Step Functions state machine config in CFn-property
   * shape.
   *
   * Issues a single `DescribeStateMachine` and surfaces:
   *   - `StateMachineName` (`name`)
   *   - `RoleArn` (`roleArn`)
   *   - `StateMachineType` (`type`)
   *   - `LoggingConfiguration` / `TracingConfiguration` / `EncryptionConfiguration`
   *     (re-mapped to CFn PascalCase)
   *   - `Definition` (parsed from JSON; cdkd state may hold either the
   *     stringified `DefinitionString` or the object `Definition`, so we
   *     surface as the object form — the comparator handles either side).
   *
   * `DefinitionSubstitutions` is omitted because they are applied at create
   * time and not surfaced by `DescribeStateMachine` (the response carries
   * the already-substituted definition).
   *
   * `Tags` is surfaced via a follow-up `ListTagsForResource(arn)` call.
   * CDK's `aws:*` auto-tags are filtered out; the result key is omitted
   * entirely when AWS reports no user tags.
   *
   * Returns `undefined` when the state machine is gone (`StateMachineDoesNotExist`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let resp: {
      name?: string;
      roleArn?: string;
      type?: string;
      definition?: string;
      loggingConfiguration?: LoggingConfiguration;
      tracingConfiguration?: TracingConfiguration;
      encryptionConfiguration?: EncryptionConfiguration;
    };
    try {
      resp = (await this.getClient().send(
        new DescribeStateMachineCommand({ stateMachineArn: physicalId })
      )) as unknown as typeof resp;
    } catch (err) {
      if (err instanceof StateMachineDoesNotExist) return undefined;
      throw err;
    }

    const result: Record<string, unknown> = {};
    if (resp.name !== undefined) result['StateMachineName'] = resp.name;
    if (resp.roleArn !== undefined) result['RoleArn'] = resp.roleArn;
    if (resp.type !== undefined) result['StateMachineType'] = resp.type;
    if (resp.definition !== undefined) {
      try {
        result['Definition'] = JSON.parse(resp.definition) as unknown;
      } catch {
        result['Definition'] = resp.definition;
      }
    }
    {
      const lc: Record<string, unknown> = {};
      if (resp.loggingConfiguration?.level !== undefined) {
        lc['Level'] = resp.loggingConfiguration.level;
      }
      if (resp.loggingConfiguration?.includeExecutionData !== undefined) {
        lc['IncludeExecutionData'] = resp.loggingConfiguration.includeExecutionData;
      }
      if (resp.loggingConfiguration?.destinations) {
        lc['Destinations'] = resp.loggingConfiguration.destinations.map((d) => {
          const inner: Record<string, unknown> = {};
          if (d.cloudWatchLogsLogGroup?.logGroupArn) {
            inner['CloudWatchLogsLogGroup'] = {
              LogGroupArn: d.cloudWatchLogsLogGroup.logGroupArn,
            };
          }
          return inner;
        });
      }
      result['LoggingConfiguration'] = lc;
    }
    result['TracingConfiguration'] = { Enabled: resp.tracingConfiguration?.enabled ?? false };
    {
      const ec: Record<string, unknown> = {};
      if (resp.encryptionConfiguration?.type !== undefined) {
        ec['Type'] = resp.encryptionConfiguration.type;
      }
      if (resp.encryptionConfiguration?.kmsKeyId !== undefined) {
        ec['KmsKeyId'] = resp.encryptionConfiguration.kmsKeyId;
      }
      if (resp.encryptionConfiguration?.kmsDataKeyReusePeriodSeconds !== undefined) {
        ec['KmsDataKeyReusePeriodSeconds'] =
          resp.encryptionConfiguration.kmsDataKeyReusePeriodSeconds;
      }
      result['EncryptionConfiguration'] = ec;
    }

    // Tags via ListTagsForResource (state machine ARN is the physicalId).
    try {
      const tagsResp = await this.getClient().send(
        new ListTagsForResourceCommand({ resourceArn: physicalId })
      );
      const tags = normalizeAwsTagsToCfn(tagsResp.tags);
      result['Tags'] = tags;
    } catch (err) {
      if (!(err instanceof StateMachineDoesNotExist)) throw err;
    }

    return result;
  }

  /**
   * Adopt an existing Step Functions state machine into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<arn>` override → verify with `DescribeStateMachine`.
   *  2. Walk `ListStateMachines` paginator → `ListTagsForResource(arn)`,
   *     match the lowercase `key`/`value` `aws:cdk:path` tag (SFN uses
   *     lowercase tags, so `matchesCdkPath` from import-helpers does not
   *     apply directly).
   *
   * SFN state machines do not expose a template-supplied name field
   * usable as a stable physicalId — the physicalId is the ARN — so the
   * fallback to `Properties.<NameField>` in `resolveExplicitPhysicalId`
   * is skipped here.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        await this.getClient().send(
          new DescribeStateMachineCommand({ stateMachineArn: input.knownPhysicalId })
        );
        return { physicalId: input.knownPhysicalId, attributes: {} };
      } catch (err) {
        if (err instanceof StateMachineDoesNotExist) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let nextToken: string | undefined;
    do {
      const list = await this.getClient().send(
        new ListStateMachinesCommand({ ...(nextToken && { nextToken }) })
      );
      for (const sm of list.stateMachines ?? []) {
        if (!sm.stateMachineArn) continue;
        const tagsResp = await this.getClient().send(
          new ListTagsForResourceCommand({ resourceArn: sm.stateMachineArn })
        );
        if (this.tagsMatchCdkPath(tagsResp.tags, input.cdkPath)) {
          return { physicalId: sm.stateMachineArn, attributes: {} };
        }
      }
      nextToken = list.nextToken;
    } while (nextToken);
    return null;
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via SFN's
   * `TagResource` / `UntagResource` APIs. SFN uses lowercase camelCase
   * (`{ key, value }`) for tags.
   */
  private async applyTagDiff(
    stateMachineArn: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const toMap = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Map<string, string> => {
      const m = new Map<string, string>();
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) m.set(t.Key, t.Value);
      }
      return m;
    };

    const oldMap = toMap(oldTagsRaw);
    const newMap = toMap(newTagsRaw);

    const tagsToAdd: Tag[] = [];
    for (const [k, v] of newMap) {
      if (oldMap.get(k) !== v) tagsToAdd.push({ key: k, value: v });
    }
    const tagsToRemove: string[] = [];
    for (const k of oldMap.keys()) {
      if (!newMap.has(k)) tagsToRemove.push(k);
    }

    if (tagsToRemove.length > 0) {
      await this.getClient().send(
        new UntagResourceCommand({ resourceArn: stateMachineArn, tagKeys: tagsToRemove })
      );
      this.logger.debug(
        `Removed ${tagsToRemove.length} tag(s) from SFN state machine ${stateMachineArn}`
      );
    }
    if (tagsToAdd.length > 0) {
      await this.getClient().send(
        new TagResourceCommand({ resourceArn: stateMachineArn, tags: tagsToAdd })
      );
      this.logger.debug(
        `Added/updated ${tagsToAdd.length} tag(s) on SFN state machine ${stateMachineArn}`
      );
    }
  }

  /**
   * Match SFN's lowercase `key`/`value` tag shape against the CDK path.
   */
  private tagsMatchCdkPath(tags: Tag[] | undefined, cdkPath: string): boolean {
    if (!tags) return false;
    for (const t of tags) {
      if (t.key === CDK_PATH_TAG && t.value === cdkPath) return true;
    }
    return false;
  }

  /**
   * Build the state-machine definition string from CDK properties.
   *
   * Precedence (mirrors CloudFormation): an inline `DefinitionString` /
   * `Definition` wins over `DefinitionS3Location`. The inline forms are
   * returned verbatim — any `DefinitionSubstitutions` they need are already
   * folded into the template as `Fn::Sub` and resolved by cdkd's intrinsic
   * resolver before the provider sees them.
   *
   * `DefinitionS3Location` ({@link https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-stepfunctions-statemachine-s3location.html S3Location})
   * has no SDK `CreateStateMachine` field — CloudFormation reads the S3 object
   * and inlines its contents as the `definition`. cdkd does the same: fetch
   * the object body, then apply `DefinitionSubstitutions` ourselves because
   * the intrinsic resolver cannot reach into S3 content (unlike the inline
   * path, where substitutions arrive pre-resolved).
   */
  private async buildDefinitionString(properties: Record<string, unknown>): Promise<string> {
    const definitionString = properties['DefinitionString'];
    const definition = properties['Definition'];

    if (definitionString !== undefined) {
      if (typeof definitionString === 'string') {
        return definitionString;
      }
      // Object form - stringify it
      return JSON.stringify(definitionString);
    }

    if (definition !== undefined) {
      if (typeof definition === 'string') {
        return definition;
      }
      return JSON.stringify(definition);
    }

    const s3Location = properties['DefinitionS3Location'] as
      | { Bucket?: string; Key?: string; Version?: string }
      | undefined;
    if (s3Location?.Bucket && s3Location.Key) {
      const body = await this.fetchDefinitionFromS3(
        s3Location.Bucket,
        s3Location.Key,
        s3Location.Version
      );
      return this.applyDefinitionSubstitutions(body, properties['DefinitionSubstitutions']);
    }

    // Empty definition - SFN API will reject this, but let it through
    // for consistent error reporting from the API
    return '{}';
  }

  /**
   * Fetch a state-machine definition (Amazon States Language JSON/YAML) from
   * S3 and return its body as a UTF-8 string. Honors an optional object
   * version for versioning-enabled buckets.
   */
  private async fetchDefinitionFromS3(
    bucket: string,
    key: string,
    version?: string
  ): Promise<string> {
    this.logger.debug(
      `Fetching state-machine definition from s3://${bucket}/${key}${version ? `?versionId=${version}` : ''}`
    );
    const resp = await this.getS3Client().send(
      new GetObjectCommand({ Bucket: bucket, Key: key, ...(version && { VersionId: version }) })
    );
    if (!resp.Body) {
      throw new Error(`DefinitionS3Location object s3://${bucket}/${key} returned no body`);
    }
    const body = await resp.Body.transformToString();
    if (body.length === 0) {
      // A zero-byte object has a present Body whose transformToString() is ''.
      // Fail here with a clear message rather than send '' to CreateStateMachine
      // (which AWS rejects with a generic validation error).
      throw new Error(`DefinitionS3Location object s3://${bucket}/${key} returned an empty body`);
    }
    return body;
  }

  /**
   * Apply CloudFormation `DefinitionSubstitutions` (a `{ name: value }` map) to
   * a definition body by replacing each `${name}` token with its value.
   * Returns the body unchanged when no substitutions are supplied.
   */
  private applyDefinitionSubstitutions(body: string, substitutions: unknown): string {
    if (
      substitutions === null ||
      typeof substitutions !== 'object' ||
      Array.isArray(substitutions)
    ) {
      return body;
    }
    let result = body;
    for (const [name, value] of Object.entries(substitutions as Record<string, unknown>)) {
      // Substitution values are scalars (CFn resolves intrinsics before
      // passing them in). Coerce to string; objects/arrays are not valid
      // substitution values, so skip them rather than emit "[object Object]".
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        continue;
      }
      result = result.split(`\${${name}}`).join(String(value));
    }
    return result;
  }
}

/**
 * Translate a CFn-shape `EncryptionConfiguration` (PascalCase) into the SDK's
 * camelCase shape, or `undefined` if the value is absent / a Class 2
 * empty-object placeholder.
 *
 * `readCurrentState` always-emits `EncryptionConfiguration: {}` on state
 * machines with no encryption — the comparator's top-level walk is
 * state-keys-only, so the placeholder is required to detect a console-side
 * encryption attach.  `cdkd drift --revert` later round-trips that
 * placeholder back through `update()`. AWS rejects an `encryptionConfiguration`
 * whose required `type` field is missing ("Member must not be null"), so an
 * empty placeholder is folded to `undefined` here (no-op on the wire).
 */
function mapEncryptionConfiguration(value: unknown): EncryptionConfiguration | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return undefined;
  const cfg = value as Record<string, unknown>;
  // Class 2 sanitize: empty placeholder => no-op
  if (cfg['Type'] === undefined) return undefined;
  return {
    type: cfg['Type'] as EncryptionConfiguration['type'],
    kmsKeyId: cfg['KmsKeyId'] as string | undefined,
    kmsDataKeyReusePeriodSeconds: cfg['KmsDataKeyReusePeriodSeconds'] as number | undefined,
  };
}

/**
 * Translate a CFn-shape `LoggingConfiguration` (PascalCase) into the SDK's
 * camelCase shape, or `undefined` for the empty placeholder case (no `Level`).
 *
 * `readCurrentState` always-emits `LoggingConfiguration: {}` (no `Level`) on
 * state machines that never configured logging.  Forwarding that placeholder
 * to `UpdateStateMachine` would inadvertently set `level=OFF` and disable
 * logging on a state machine that has logging configured outside cdkd's
 * managed view — fold to `undefined` here so the placeholder round-trip is
 * a no-op.
 */
function mapLoggingConfiguration(value: unknown): LoggingConfiguration | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return undefined;
  const cfg = value as Record<string, unknown>;
  // Class 2 sanitize: empty placeholder (no Level) => no-op
  if (cfg['Level'] === undefined) return undefined;
  const result: LoggingConfiguration = {
    level: cfg['Level'] as LoggingConfiguration['level'],
  };
  if (cfg['IncludeExecutionData'] !== undefined) {
    result.includeExecutionData = cfg['IncludeExecutionData'] as boolean;
  }
  if (Array.isArray(cfg['Destinations'])) {
    result.destinations = (cfg['Destinations'] as Array<Record<string, unknown>>).map((d) => {
      const cwLogs = d['CloudWatchLogsLogGroup'] as Record<string, unknown> | undefined;
      if (cwLogs?.['LogGroupArn'] !== undefined) {
        return {
          cloudWatchLogsLogGroup: { logGroupArn: cwLogs['LogGroupArn'] as string },
        };
      }
      return {};
    });
  }
  return result;
}

/**
 * Translate a CFn-shape `TracingConfiguration` (PascalCase) into the SDK's
 * camelCase shape.  `readCurrentState` always-emits `{ Enabled: false }` (the
 * AWS default), so no Class 2 sanitize is needed — the round-trip simply
 * reaffirms the existing tracing setting.
 */
function mapTracingConfiguration(value: unknown): TracingConfiguration | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'object') return undefined;
  const cfg = value as Record<string, unknown>;
  if (cfg['Enabled'] === undefined) return undefined;
  return { enabled: cfg['Enabled'] as boolean };
}

// ---------------------------------------------------------------------------
// Removal-clear sentinels (issue #978)
//
// `UpdateStateMachine` is patch-style, so omitting a config field keeps the
// current AWS value. These helpers turn a prev-present / new-absent transition
// into the explicit disable payload AWS needs to actually clear the config.
//
// Each is only consulted when the corresponding `map*Configuration(properties[...])`
// returned `undefined` (i.e. the new side carries no meaningful config). The
// `wasMeaningfullyConfigured` guard distinguishes a genuine removal (the prop
// was really set before) from the `readCurrentState` empty-placeholder round-trip
// (`{}` / `{ Enabled: false }`), which must stay a no-op — sending a disable
// sentinel there would spuriously reaffirm the AWS default on every drift-revert.
// ---------------------------------------------------------------------------

/**
 * Return the SDK disable payload for `EncryptionConfiguration` when it was
 * present+configured in the previous properties but is absent/placeholder in
 * the new ones; otherwise `undefined` (no clear needed). `AWS_OWNED_KEY` is
 * the AWS default, so this resets a customer-managed-key config back to default.
 */
function disabledEncryptionConfigurationOnRemoval(
  previous: unknown,
  next: unknown
): EncryptionConfiguration | undefined {
  if (!wasMeaningfullyConfigured(previous, 'Type')) return undefined;
  if (mapEncryptionConfiguration(next) !== undefined) return undefined;
  return { type: 'AWS_OWNED_KEY' };
}

/**
 * Return the SDK disable payload for `LoggingConfiguration` when it was
 * present+configured in the previous properties but is absent/placeholder in
 * the new ones; otherwise `undefined`. `level: OFF` disables logging;
 * `destinations: []` clears the log destinations (only required when level is
 * not OFF, so an empty list is accepted alongside OFF).
 */
function disabledLoggingConfigurationOnRemoval(
  previous: unknown,
  next: unknown
): LoggingConfiguration | undefined {
  if (!wasMeaningfullyConfigured(previous, 'Level')) return undefined;
  if (mapLoggingConfiguration(next) !== undefined) return undefined;
  return { level: 'OFF', includeExecutionData: false, destinations: [] };
}

/**
 * Return the SDK disable payload for `TracingConfiguration` when it was
 * present+enabled in the previous properties but is absent/placeholder in the
 * new ones; otherwise `undefined`. `enabled: false` turns X-Ray tracing off.
 *
 * Unlike logging/encryption, the "meaningful" signal here is `Enabled === true`
 * (a previous `{ Enabled: false }` is already the AWS default, so there is
 * nothing to clear).
 */
function disabledTracingConfigurationOnRemoval(
  previous: unknown,
  next: unknown
): TracingConfiguration | undefined {
  if (previous === null || typeof previous !== 'object') return undefined;
  const prevCfg = previous as Record<string, unknown>;
  if (prevCfg['Enabled'] !== true) return undefined;
  if (mapTracingConfiguration(next) !== undefined) return undefined;
  return { enabled: false };
}

/**
 * True when `value` is an object that carries a defined `discriminatorKey`
 * field (`Level` for logging, `Type` for encryption) — i.e. it was a real,
 * non-placeholder config in the previous properties. The empty-placeholder
 * shape `{}` that `readCurrentState` emits has no discriminator, so it returns
 * false and no clear is emitted.
 */
function wasMeaningfullyConfigured(value: unknown, discriminatorKey: string): boolean {
  if (value === null || typeof value !== 'object') return false;
  return (value as Record<string, unknown>)[discriminatorKey] !== undefined;
}
