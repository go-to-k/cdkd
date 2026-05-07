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
      // Build definition string - handle both string and object forms
      const definitionString = this.buildDefinitionString(properties);

      // Build tags: CDK uses [{Key, Value}], SFN SDK uses [{key, value}]
      let tags: Tag[] | undefined;
      if (properties['Tags']) {
        const tagList = properties['Tags'] as Array<{ Key: string; Value: string }>;
        tags = tagList.map((tag) => ({ key: tag.Key, value: tag.Value }));
      }

      // Map EncryptionConfiguration (CFn PascalCase -> SDK camelCase)
      const cfnEncConfig = properties['EncryptionConfiguration'] as
        | Record<string, unknown>
        | undefined;
      let encryptionConfiguration: EncryptionConfiguration | undefined;
      if (cfnEncConfig) {
        encryptionConfiguration = {
          type: cfnEncConfig['Type'] as EncryptionConfiguration['type'],
          kmsKeyId: cfnEncConfig['KmsKeyId'] as string | undefined,
          kmsDataKeyReusePeriodSeconds: cfnEncConfig['KmsDataKeyReusePeriodSeconds'] as
            | number
            | undefined,
        };
      }

      const createParams: CreateStateMachineCommandInput = {
        name: stateMachineName,
        definition: definitionString,
        roleArn: roleArn,
        type: properties['StateMachineType'] as StateMachineType | undefined,
        loggingConfiguration: properties['LoggingConfiguration'] as
          | LoggingConfiguration
          | undefined,
        tracingConfiguration: properties['TracingConfiguration'] as
          | TracingConfiguration
          | undefined,
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
      const definitionString = this.buildDefinitionString(properties);

      // Map EncryptionConfiguration for update
      const cfnEncConfig = properties['EncryptionConfiguration'] as
        | Record<string, unknown>
        | undefined;
      let encryptionConfiguration: EncryptionConfiguration | undefined;
      if (cfnEncConfig) {
        encryptionConfiguration = {
          type: cfnEncConfig['Type'] as EncryptionConfiguration['type'],
          kmsKeyId: cfnEncConfig['KmsKeyId'] as string | undefined,
          kmsDataKeyReusePeriodSeconds: cfnEncConfig['KmsDataKeyReusePeriodSeconds'] as
            | number
            | undefined,
        };
      }

      await this.getClient().send(
        new UpdateStateMachineCommand({
          stateMachineArn: physicalId,
          definition: definitionString,
          roleArn: properties['RoleArn'] as string | undefined,
          loggingConfiguration: properties['LoggingConfiguration'] as
            | LoggingConfiguration
            | undefined,
          tracingConfiguration: properties['TracingConfiguration'] as
            | TracingConfiguration
            | undefined,
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
   * Build definition string from CDK properties.
   * Handles both DefinitionString (string) and DefinitionString (object) forms.
   */
  private buildDefinitionString(properties: Record<string, unknown>): string {
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

    // Empty definition - SFN API will reject this, but let it through
    // for consistent error reporting from the API
    return '{}';
  }
}
