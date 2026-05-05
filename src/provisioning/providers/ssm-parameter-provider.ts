import {
  SSMClient,
  DescribeParametersCommand,
  GetParameterCommand,
  ListTagsForResourceCommand,
  PutParameterCommand,
  DeleteParameterCommand,
  AddTagsToResourceCommand,
  RemoveTagsFromResourceCommand,
  ParameterNotFound,
  type ParameterType,
  type Tag,
} from '@aws-sdk/client-ssm';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { matchesCdkPath, resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS SSM Parameter Provider
 *
 * Implements resource provisioning for AWS::SSM::Parameter using the SSM SDK.
 * This is required because SSM Parameter is not supported by Cloud Control API.
 */
export class SSMParameterProvider implements ResourceProvider {
  private ssmClient: SSMClient;
  private logger = getLogger().child('SSMParameterProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::SSM::Parameter',
      new Set([
        'Name',
        'Type',
        'Value',
        'Description',
        'Tags',
        'AllowedPattern',
        'Tier',
        'Policies',
        'DataType',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.ssmClient = awsClients.ssm;
  }

  /**
   * Create an SSM parameter
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating SSM parameter ${logicalId}`);

    const name =
      (properties['Name'] as string | undefined) ||
      `/${generateResourceName(logicalId, { maxLength: 1023, allowedPattern: /[^a-zA-Z0-9-/_]/g })}`;
    const type = (properties['Type'] as string | undefined) || 'String';
    const value = properties['Value'] as string | undefined;

    if (!value) {
      throw new ProvisioningError(
        `Value is required for SSM parameter ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const putParams: import('@aws-sdk/client-ssm').PutParameterCommandInput = {
        Name: name,
        Type: type as ParameterType,
        Value: value,
        Description: properties['Description'] as string | undefined,
        Overwrite: false,
      };
      if (properties['AllowedPattern']) {
        putParams.AllowedPattern = properties['AllowedPattern'] as string;
      }
      if (properties['Tier']) {
        putParams.Tier = properties['Tier'] as import('@aws-sdk/client-ssm').ParameterTier;
      }
      if (properties['Policies']) {
        putParams.Policies = properties['Policies'] as string;
      }
      if (properties['DataType']) {
        putParams.DataType = properties['DataType'] as string;
      }

      await this.ssmClient.send(new PutParameterCommand(putParams));

      // Apply tags if specified
      if (properties['Tags']) {
        const cfnTags = properties['Tags'] as Array<{ Key: string; Value: string }>;
        const ssmTags: Tag[] = cfnTags.map((t) => ({ Key: t.Key, Value: t.Value }));
        await this.ssmClient.send(
          new AddTagsToResourceCommand({
            ResourceType: 'Parameter',
            ResourceId: name,
            Tags: ssmTags,
          })
        );
      }

      this.logger.debug(`Successfully created SSM parameter ${logicalId}: ${name}`);

      return {
        physicalId: name,
        attributes: {
          Type: type as ParameterType,
          Value: value,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create SSM parameter ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update an SSM parameter
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating SSM parameter ${logicalId}: ${physicalId}`);

    const type = (properties['Type'] as string | undefined) || 'String';
    const value = properties['Value'] as string | undefined;

    if (!value) {
      throw new ProvisioningError(
        `Value is required for SSM parameter ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      const putParams: import('@aws-sdk/client-ssm').PutParameterCommandInput = {
        Name: physicalId,
        Type: type as ParameterType,
        Value: value,
        Description: properties['Description'] as string | undefined,
        Overwrite: true,
      };
      if (properties['AllowedPattern']) {
        putParams.AllowedPattern = properties['AllowedPattern'] as string;
      }
      if (properties['Tier']) {
        putParams.Tier = properties['Tier'] as import('@aws-sdk/client-ssm').ParameterTier;
      }
      if (properties['Policies']) {
        putParams.Policies = properties['Policies'] as string;
      }
      if (properties['DataType']) {
        putParams.DataType = properties['DataType'] as string;
      }

      await this.ssmClient.send(new PutParameterCommand(putParams));

      // Update Tags if changed
      const newTags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
      const oldTags = previousProperties['Tags'] as
        | Array<{ Key: string; Value: string }>
        | undefined;
      if (JSON.stringify(newTags) !== JSON.stringify(oldTags)) {
        // Remove old tags
        if (oldTags && oldTags.length > 0) {
          await this.ssmClient.send(
            new RemoveTagsFromResourceCommand({
              ResourceType: 'Parameter',
              ResourceId: physicalId,
              TagKeys: oldTags.map((t) => t.Key),
            })
          );
        }
        // Apply new tags
        if (newTags && newTags.length > 0) {
          const ssmTags: Tag[] = newTags.map((t) => ({ Key: t.Key, Value: t.Value }));
          await this.ssmClient.send(
            new AddTagsToResourceCommand({
              ResourceType: 'Parameter',
              ResourceId: physicalId,
              Tags: ssmTags,
            })
          );
        }
        this.logger.debug(`Updated tags for SSM parameter ${physicalId}`);
      }

      this.logger.debug(`Successfully updated SSM parameter ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Type: type as ParameterType,
          Value: value,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update SSM parameter ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an SSM parameter
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting SSM parameter ${logicalId}: ${physicalId}`);

    try {
      await this.ssmClient.send(
        new DeleteParameterCommand({
          Name: physicalId,
        })
      );

      this.logger.debug(`Successfully deleted SSM parameter ${logicalId}`);
    } catch (error) {
      if (error instanceof ParameterNotFound) {
        const clientRegion = await this.ssmClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Parameter ${physicalId} does not exist, skipping deletion`);
        return;
      }

      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete SSM parameter ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Read the AWS-current SSM parameter configuration in CFn-property shape.
   *
   * Issues `GetParameter` (with `WithDecryption: false` so SecureString
   * values stay encrypted on the wire) for `Type` / `Value` / `DataType`,
   * then `DescribeParameters` filtered on the parameter name to fetch
   * metadata (`Description`, `AllowedPattern`, `Tier`) that `GetParameter`
   * does not return.
   *
   * `Name` is set to the physical id. `Tags` and `Policies` are intentionally
   * out of scope (`Tags` requires a separate `ListTagsForResource` round-trip
   * and the auto-injected `aws:cdk:path` tag-shape question is unresolved;
   * `Policies` is returned by `DescribeParameters.Policies` as a structured
   * array but cdkd state holds the raw JSON string the user typed — comparing
   * the two accurately needs more work).
   *
   * **Note**: For `SecureString` parameters, AWS returns the encrypted
   * blob in `Value` (we pass `WithDecryption: false`). cdkd state usually
   * holds the plaintext value the user typed in their CDK app, so a
   * SecureString parameter will surface as `Value` drift on every run.
   * That's the correct conservative behavior — surfacing the discrepancy
   * is more useful than silently masking it.
   *
   * Returns `undefined` when the parameter is gone (`ParameterNotFound`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let getResp: {
      Parameter?: { Type?: string; Value?: string; DataType?: string };
    };
    try {
      getResp = (await this.ssmClient.send(
        new GetParameterCommand({ Name: physicalId, WithDecryption: false })
      )) as unknown as typeof getResp;
    } catch (err) {
      if (err instanceof ParameterNotFound) return undefined;
      throw err;
    }
    const param = getResp.Parameter;
    if (!param) return undefined;

    const result: Record<string, unknown> = { Name: physicalId };
    if (param.Type !== undefined) result['Type'] = param.Type;
    if (param.Value !== undefined) result['Value'] = param.Value;
    if (param.DataType !== undefined) result['DataType'] = param.DataType;

    // Fetch metadata via DescribeParameters filtered on the name. Best-effort:
    // a missing-permission error here should not fail the snapshot — we just
    // omit the metadata keys.
    try {
      const desc = await this.ssmClient.send(
        new DescribeParametersCommand({
          ParameterFilters: [{ Key: 'Name', Values: [physicalId] }],
        })
      );
      const meta = desc.Parameters?.[0];
      if (meta) {
        if (meta.Description !== undefined && meta.Description !== '') {
          result['Description'] = meta.Description;
        }
        if (meta.AllowedPattern !== undefined && meta.AllowedPattern !== '') {
          result['AllowedPattern'] = meta.AllowedPattern;
        }
        if (meta.Tier !== undefined) {
          result['Tier'] = meta.Tier;
        }
      }
    } catch {
      // Ignore — Type / Value / DataType already captured above.
    }

    return result;
  }

  /**
   * Adopt an existing SSM parameter into cdkd state.
   *
   * SSM physical IDs ARE the parameter names (`/foo/bar`). The CDK template
   * usually carries `Properties.Name` explicitly, so the explicit-name path
   * covers most cases. The tag-based fallback is rarely needed.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.Name` → verify via `GetParameter`.
   *  2. `aws:cdk:path` tag match via `DescribeParameters` + `ListTagsForResource`
   *     (`ResourceType: 'Parameter'`, `ResourceId: <name>`).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'Name');
    if (explicit) {
      try {
        await this.ssmClient.send(new GetParameterCommand({ Name: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if (err instanceof ParameterNotFound) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let nextToken: string | undefined;
    do {
      const list = await this.ssmClient.send(
        new DescribeParametersCommand({ ...(nextToken && { NextToken: nextToken }) })
      );
      for (const p of list.Parameters ?? []) {
        if (!p.Name) continue;
        try {
          const tagsResp = await this.ssmClient.send(
            new ListTagsForResourceCommand({ ResourceType: 'Parameter', ResourceId: p.Name })
          );
          if (matchesCdkPath(tagsResp.TagList, input.cdkPath)) {
            return { physicalId: p.Name, attributes: {} };
          }
        } catch (err) {
          if (err instanceof ParameterNotFound) continue;
          throw err;
        }
      }
      nextToken = list.NextToken;
    } while (nextToken);
    return null;
  }
}
