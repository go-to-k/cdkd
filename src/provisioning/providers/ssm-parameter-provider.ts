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
} from '@aws-sdk/client-ssm';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { importTagWalk } from '../import-tag-walk.js';
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
   * Normalize a CFn `AWS::SSM::Parameter.Tags` value into the SDK `Tag[]`
   * shape. Unlike most CFn resources (whose `Tags` is a `{Key,Value}[]` list),
   * `AWS::SSM::Parameter.Tags` is a key->value **map** (`{ "Env": "prod" }`) —
   * CDK synthesizes the map form, so `properties['Tags'].map(...)` throws
   * `Tags.map is not a function`. Accept the map (canonical) AND the list
   * (defensive, in case a hand-authored / escape-hatched template supplies it),
   * coerce each value to a string (SSM tag values must be strings), and drop
   * `aws:`-prefixed reserved keys (AWS rejects user attempts to set them).
   */
  private cfnTagsToSdkTags(raw: unknown): Array<{ Key: string; Value: string }> {
    if (raw === undefined || raw === null) return [];
    // SSM tag values must be strings; coerce primitives and drop objects
    // (which would otherwise stringify to "[object Object]").
    const coerce = (v: unknown): string =>
      typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '';
    let entries: Array<[unknown, unknown]>;
    if (Array.isArray(raw)) {
      entries = (raw as Array<Record<string, unknown>>).map((t) => [t?.['Key'], t?.['Value']]);
    } else if (typeof raw === 'object') {
      entries = Object.entries(raw as Record<string, unknown>);
    } else {
      entries = [];
    }
    const out: Array<{ Key: string; Value: string }> = [];
    for (const [key, value] of entries) {
      if (typeof key !== 'string' || key.length === 0 || key.startsWith('aws:')) continue;
      out.push({ Key: key, Value: coerce(value) });
    }
    return out;
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

      // PutParameter has succeeded (Overwrite: false, so AWS has committed
      // a new parameter — not an idempotent pre-existing-resource path).
      // Wrap the post-create wiring in an inner try/catch that issues a
      // best-effort `DeleteParameterCommand` cleanup on failure, so the
      // next redeploy doesn't hit `ParameterAlreadyExists` from an orphan.
      // See Issue #376 for the cross-provider sweep.
      try {
        // Apply tags if specified. AWS::SSM::Parameter.Tags is a key->value
        // MAP (not the {Key,Value}[] list most CFn resources use), so the raw
        // template value cannot be `.map()`-ed directly — normalize via
        // cfnTagsToSdkTags first (which accepts both the map and the list).
        const ssmTags = this.cfnTagsToSdkTags(properties['Tags']);
        if (ssmTags.length > 0) {
          await this.ssmClient.send(
            new AddTagsToResourceCommand({
              ResourceType: 'Parameter',
              ResourceId: name,
              Tags: ssmTags,
            })
          );
        }
      } catch (innerError) {
        try {
          await this.ssmClient.send(new DeleteParameterCommand({ Name: name }));
          this.logger.debug(
            `Cleaned up partially-created SSM parameter ${logicalId} (${name}) after wiring failure`
          );
        } catch (cleanupError) {
          this.logger.warn(
            `Failed to clean up partially-created SSM parameter ${logicalId} (${name}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required before the next deploy: aws ssm delete-parameter --name '${name}'`
          );
        }
        throw innerError;
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
        Overwrite: true,
      };
      // `!== undefined` (not truthy) so empty Description / AllowedPattern
      // ('') from `readCurrentState`'s placeholders reaches `PutParameterCommand`
      // on the `cdkd drift --revert` round-trip. A truthy gate would silently
      // drop the empty string and leave the AWS-side value untouched — drift
      // would report `✓ reverted` but the next run re-detects the same drift.
      if (properties['Description'] !== undefined) {
        putParams.Description = properties['Description'] as string;
      }
      if (properties['AllowedPattern'] !== undefined) {
        putParams.AllowedPattern = properties['AllowedPattern'] as string;
      }
      if (properties['Tier'] !== undefined) {
        putParams.Tier = properties['Tier'] as import('@aws-sdk/client-ssm').ParameterTier;
      }
      if (properties['Policies'] !== undefined) {
        putParams.Policies = properties['Policies'] as string;
      }
      if (properties['DataType'] !== undefined) {
        putParams.DataType = properties['DataType'] as string;
      }

      await this.ssmClient.send(new PutParameterCommand(putParams));

      // Update Tags if changed. AWS::SSM::Parameter.Tags is a key->value MAP;
      // normalize both sides to the SDK Tag[] shape before diffing/applying
      // (the raw map cannot be `.map()`-ed, and a map-vs-list mismatch would
      // otherwise wrongly look "changed").
      const newTags = this.cfnTagsToSdkTags(properties['Tags']);
      const oldTags = this.cfnTagsToSdkTags(previousProperties['Tags']);
      // Compare key-sorted so a pure key-reorder in the template map (no value
      // change) is not seen as a change — Tags are an unordered set, matching
      // the order-insensitive compare the drift-calculator already does.
      const tagKey = (t: { Key: string; Value: string }): string => t.Key;
      const sortedJson = (tags: Array<{ Key: string; Value: string }>): string =>
        JSON.stringify([...tags].sort((a, b) => tagKey(a).localeCompare(tagKey(b))));
      if (sortedJson(newTags) !== sortedJson(oldTags)) {
        // Remove old tags
        if (oldTags.length > 0) {
          await this.ssmClient.send(
            new RemoveTagsFromResourceCommand({
              ResourceType: 'Parameter',
              ResourceId: physicalId,
              TagKeys: oldTags.map((t) => t.Key),
            })
          );
        }
        // Apply new tags
        if (newTags.length > 0) {
          await this.ssmClient.send(
            new AddTagsToResourceCommand({
              ResourceType: 'Parameter',
              ResourceId: physicalId,
              Tags: newTags,
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
   * `Name` is set to the physical id. `Tags` is surfaced via a follow-up
   * `ListTagsForResource(ResourceType=Parameter)` call, with CDK's `aws:*`
   * auto-tags filtered out.
   *
   * `Policies` is surfaced from the same `DescribeParameters` response.
   * AWS returns `Parameters[0].Policies` as
   * `[{PolicyText, PolicyType, PolicyStatus}]`; cdkd state holds a JSON
   * string of the user-templated policy array (CFn's documented shape).
   * To compare cleanly we parse each `PolicyText` (itself JSON) into
   * objects, drop the AWS-managed `PolicyStatus` (Pending / InSync /
   * Expired), and emit the parsed object array. On the v3
   * `observedProperties` baseline this matches `observedProperties` (which
   * stored our parsed output at deploy time) exactly. On the v2 fallback
   * baseline (state.properties = JSON string) the comparator reports a
   * one-time drift on first run; users resolve via
   * `cdkd state refresh-observed`. Always-emit `[]` placeholder for
   * console-side ADD detection.
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
    let policiesEmitted = false;
    try {
      const desc = await this.ssmClient.send(
        new DescribeParametersCommand({
          ParameterFilters: [{ Key: 'Name', Values: [physicalId] }],
        })
      );
      const meta = desc.Parameters?.[0];
      result['Description'] = meta?.Description ?? '';
      result['AllowedPattern'] = meta?.AllowedPattern ?? '';
      if (meta?.Tier !== undefined) {
        result['Tier'] = meta.Tier;
      }

      // Policies — AWS returns [{PolicyText, PolicyType, PolicyStatus}];
      // we parse PolicyText (JSON) and emit the parsed objects. PolicyStatus
      // is AWS-managed (Pending / InSync / Expired) and intentionally
      // dropped — it's not part of the user's templated input.
      const parsedPolicies: unknown[] = [];
      for (const p of meta?.Policies ?? []) {
        if (!p.PolicyText) continue;
        try {
          parsedPolicies.push(JSON.parse(p.PolicyText));
        } catch {
          parsedPolicies.push(p.PolicyText);
        }
      }
      result['Policies'] = parsedPolicies;
      policiesEmitted = true;
    } catch {
      // Ignore — Type / Value / DataType already captured above.
    }
    // Always-emit guard: if DescribeParameters failed entirely, surface
    // an empty Policies placeholder so a console-side ADD on a previously-
    // un-policy'd parameter still surfaces as drift on the v3
    // observedProperties baseline.
    if (!policiesEmitted) result['Policies'] = [];

    // Tags via ListTagsForResource (best-effort; missing tag permission is
    // tolerated by simply omitting the key).
    try {
      const tagsResp = await this.ssmClient.send(
        new ListTagsForResourceCommand({
          ResourceType: 'Parameter',
          ResourceId: physicalId,
        })
      );
      // AWS::SSM::Parameter.Tags is a key->value MAP in CFn (cdkd stores the
      // template's map shape in state), so emit the readback as a map too — an
      // array shape here would false-positive drift on every clean run for a
      // tagged parameter (state map vs observed list never compare equal).
      const tagArr = normalizeAwsTagsToCfn(tagsResp.TagList);
      result['Tags'] = Object.fromEntries(tagArr.map((t) => [t.Key, t.Value]));
    } catch {
      // Ignore — tag drift is best-effort.
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

    // Tag-based fallback via the shared throttle-tolerant walk: the N+1
    // ListTagsForResource burst is retried with exponential backoff when AWS
    // throttles it instead of aborting the whole import.
    const match = await importTagWalk({
      cdkPath: input.cdkPath,
      logicalId: input.logicalId,
      listPage: async (marker) => {
        const list = await this.ssmClient.send(
          new DescribeParametersCommand({ ...(marker && { NextToken: marker }) })
        );
        return { items: list.Parameters, nextMarker: list.NextToken };
      },
      describe: async (p) => {
        if (!p.Name) return undefined;
        try {
          return await this.ssmClient.send(
            new ListTagsForResourceCommand({ ResourceType: 'Parameter', ResourceId: p.Name })
          );
        } catch (err) {
          // Deleted between the list and the tag read — skip the candidate.
          if (err instanceof ParameterNotFound) return undefined;
          throw err;
        }
      },
      tagsOf: (tagsResp) => tagsResp.TagList,
    });
    if (!match) return null;
    // Non-null by construction: `describe` skips summaries without a name.
    return { physicalId: match.summary.Name!, attributes: {} };
  }
}
