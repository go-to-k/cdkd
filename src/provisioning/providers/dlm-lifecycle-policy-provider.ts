import {
  DLMClient,
  CreateLifecyclePolicyCommand,
  UpdateLifecyclePolicyCommand,
  DeleteLifecyclePolicyCommand,
  GetLifecyclePolicyCommand,
  GetLifecyclePoliciesCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ResourceNotFoundException,
  type CreateLifecyclePolicyCommandInput,
  type UpdateLifecyclePolicyCommandInput,
  type PolicyDetails,
  type CrossRegionCopyTarget,
  type Exclusions,
} from '@aws-sdk/client-dlm';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { CDK_PATH_TAG, normalizeAwsTagsToCfn } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/** CFn tag-list entry shape (`{ Key, Value }`). */
interface CfnTag {
  Key?: string;
  Value?: string;
}

/**
 * SDK Provider for AWS::DLM::LifecyclePolicy (Data Lifecycle Manager).
 *
 * Why an SDK provider (issue #1040): the type is
 * `ProvisioningType: NON_PROVISIONABLE`, so cdkd's Cloud Control fallback
 * cannot handle it and pre-flight rejected it. The DLM API surface is small
 * and the CFn property shape maps 1:1 onto the SDK's PascalCase inputs; the
 * only conversion is the CFn `Tags` list <-> DLM tag-map.
 *
 * physicalId is the service-generated policy id (`policy-0123456789abcdef0`)
 * — matches CFn, where `Ref` returns the policy id (`Id` is the
 * primaryIdentifier). `Fn::GetAtt Arn` returns the policy ARN.
 *
 * API mapping:
 *   - create      -> CreateLifecyclePolicy (+ GetLifecyclePolicy for the Arn
 *                    attribute — the create response only carries PolicyId)
 *   - update      -> UpdateLifecyclePolicy for policy fields, plus explicit
 *                    TagResource / UntagResource for tag diffs (the update
 *                    API has no Tags parameter). Tag removal — including a
 *                    FULL `Tags` property removal — is handled explicitly
 *                    via UntagResource (the #981 ECR regression class).
 *   - delete      -> DeleteLifecyclePolicy (NotFound idempotent, guarded by
 *                    assertRegionMatch)
 *   - getAttribute-> GetLifecyclePolicy (`Arn` from Policy.PolicyArn)
 *
 * `DefaultPolicy` is create-only at the API level (UpdateLifecyclePolicy has
 * no such parameter; CFn documents it as "Update requires: Replacement"), so
 * a change is rejected with `ResourceUpdateNotSupportedError` and the deploy
 * engine's `--replace` fallback recreates the policy.
 */
export class DLMLifecyclePolicyProvider implements ResourceProvider {
  private client: DLMClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('DLMLifecyclePolicyProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::DLM::LifecyclePolicy',
      new Set<string>([
        'Description',
        'ExecutionRoleArn',
        'State',
        'PolicyDetails',
        'Tags',
        'DefaultPolicy',
        'CreateInterval',
        'RetainInterval',
        'CopyTags',
        'ExtendDeletion',
        'CrossRegionCopyTargets',
        'Exclusions',
      ]),
    ],
  ]);

  private getClient(): DLMClient {
    if (!this.client) {
      this.client = new DLMClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  /**
   * Convert the CFn `Tags` list (`[{ Key, Value }]`) to the DLM tag map
   * (`Record<string, string>`). Returns `undefined` for an absent / empty
   * list so callers can omit the field.
   */
  private cfnTagsToMap(tags: unknown): Record<string, string> | undefined {
    if (!Array.isArray(tags)) return undefined;
    const map: Record<string, string> = {};
    for (const t of tags as CfnTag[]) {
      if (typeof t?.Key === 'string' && t.Key.length > 0) {
        map[t.Key] = typeof t.Value === 'string' ? t.Value : '';
      }
    }
    return Object.keys(map).length > 0 ? map : undefined;
  }

  /**
   * Map the CFn property shape to the SDK input shape (shared by create and
   * update — every field name is PascalCase-identical). `Tags` and
   * `DefaultPolicy` are intentionally NOT included: create wires them
   * separately (update has neither parameter).
   */
  private toSdkFields(
    properties: Record<string, unknown>
  ): Omit<UpdateLifecyclePolicyCommandInput, 'PolicyId'> {
    return {
      ...(properties['ExecutionRoleArn'] !== undefined && {
        ExecutionRoleArn: properties['ExecutionRoleArn'] as string,
      }),
      ...(properties['Description'] !== undefined && {
        Description: properties['Description'] as string,
      }),
      ...(properties['State'] !== undefined && {
        State: properties['State'] as UpdateLifecyclePolicyCommandInput['State'],
      }),
      ...(properties['PolicyDetails'] !== undefined && {
        PolicyDetails: properties['PolicyDetails'] as PolicyDetails,
      }),
      ...(properties['CreateInterval'] !== undefined && {
        CreateInterval: properties['CreateInterval'] as number,
      }),
      ...(properties['RetainInterval'] !== undefined && {
        RetainInterval: properties['RetainInterval'] as number,
      }),
      ...(properties['CopyTags'] !== undefined && {
        CopyTags: properties['CopyTags'] as boolean,
      }),
      ...(properties['ExtendDeletion'] !== undefined && {
        ExtendDeletion: properties['ExtendDeletion'] as boolean,
      }),
      ...(properties['CrossRegionCopyTargets'] !== undefined && {
        CrossRegionCopyTargets: properties['CrossRegionCopyTargets'] as CrossRegionCopyTarget[],
      }),
      ...(properties['Exclusions'] !== undefined && {
        Exclusions: properties['Exclusions'] as Exclusions,
      }),
    };
  }

  /** Fetch the policy ARN (`Fn::GetAtt Arn`) for a policy id. */
  private async fetchPolicyArn(policyId: string): Promise<string> {
    const response = await this.getClient().send(
      new GetLifecyclePolicyCommand({ PolicyId: policyId })
    );
    return response.Policy?.PolicyArn ?? '';
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating DLM Lifecycle Policy ${logicalId}`);

    try {
      const tags = this.cfnTagsToMap(properties['Tags']);
      const input: CreateLifecyclePolicyCommandInput = {
        ...this.toSdkFields(properties),
        ...(properties['DefaultPolicy'] !== undefined && {
          DefaultPolicy: properties[
            'DefaultPolicy'
          ] as CreateLifecyclePolicyCommandInput['DefaultPolicy'],
        }),
        ...(tags && { Tags: tags }),
      } as CreateLifecyclePolicyCommandInput;

      const response = await this.getClient().send(new CreateLifecyclePolicyCommand(input));
      if (!response.PolicyId) {
        throw new Error('CreateLifecyclePolicy did not return a PolicyId');
      }

      // The create response only carries PolicyId; fetch the ARN for the
      // `Fn::GetAtt Arn` attribute cache.
      const arn = await this.fetchPolicyArn(response.PolicyId);

      this.logger.debug(
        `Successfully created DLM Lifecycle Policy ${logicalId}: ${response.PolicyId}`
      );
      return {
        physicalId: response.PolicyId,
        attributes: { Arn: arn },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create DLM Lifecycle Policy ${logicalId}: ${cause?.message ?? String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    if (
      JSON.stringify(properties['DefaultPolicy']) !==
      JSON.stringify(previousProperties['DefaultPolicy'])
    ) {
      // UpdateLifecyclePolicy has no DefaultPolicy parameter (CFn documents
      // the property as "Update requires: Replacement"). The engine's
      // --replace fallback recreates the policy.
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `DefaultPolicy cannot be changed in place; ` +
          `re-run with \`cdkd deploy --replace ${logicalId}\` to recreate the policy`
      );
    }

    this.logger.debug(`Updating DLM Lifecycle Policy ${logicalId} (${physicalId})`);

    try {
      await this.getClient().send(
        new UpdateLifecyclePolicyCommand({
          PolicyId: physicalId,
          ...this.toSdkFields(properties),
        })
      );

      // Tag diff via TagResource / UntagResource — UpdateLifecyclePolicy has
      // no Tags parameter. TagResource is additive-only, so a tag dropped
      // from the template (partial removal) — or the entire `Tags` property
      // removed (full removal, newTags === undefined) — would survive on AWS
      // unless we explicitly UntagResource the removed keys (the #981 ECR
      // regression class).
      const newTags = this.cfnTagsToMap(properties['Tags']) ?? {};
      const oldTags = this.cfnTagsToMap(previousProperties['Tags']) ?? {};
      const arn = await this.fetchPolicyArn(physicalId);
      if (JSON.stringify(newTags) !== JSON.stringify(oldTags) && arn) {
        const removedKeys = Object.keys(oldTags).filter((k) => !(k in newTags));
        if (removedKeys.length > 0) {
          await this.getClient().send(
            new UntagResourceCommand({ ResourceArn: arn, TagKeys: removedKeys })
          );
          this.logger.debug(
            `Removed ${removedKeys.length} tag(s) from DLM Lifecycle Policy ${physicalId}`
          );
        }
        const tagsToAdd: Record<string, string> = {};
        for (const [k, v] of Object.entries(newTags)) {
          if (oldTags[k] !== v) tagsToAdd[k] = v;
        }
        if (Object.keys(tagsToAdd).length > 0) {
          await this.getClient().send(
            new TagResourceCommand({ ResourceArn: arn, Tags: tagsToAdd })
          );
          this.logger.debug(
            `Added/updated ${Object.keys(tagsToAdd).length} tag(s) on DLM Lifecycle Policy ${physicalId}`
          );
        }
      }

      return {
        physicalId,
        wasReplaced: false,
        attributes: { Arn: arn },
      };
    } catch (error) {
      if (error instanceof ResourceUpdateNotSupportedError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update DLM Lifecycle Policy ${logicalId}: ${cause?.message ?? String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting DLM Lifecycle Policy ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteLifecyclePolicyCommand({ PolicyId: physicalId }));
      this.logger.debug(`Successfully deleted DLM Lifecycle Policy ${logicalId}`);
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
        this.logger.debug(`DLM Lifecycle Policy ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete DLM Lifecycle Policy ${logicalId}: ${cause?.message ?? String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Attribute fallback. `Arn` is cached in state at create/update time, so
   * this only fires for imported/degraded records.
   */
  async getAttribute(
    physicalId: string,
    resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    // `Ref` / the readOnly `Id` property are the policy id itself.
    if (attributeName === 'Id' || attributeName === 'PolicyId') {
      return physicalId;
    }
    if (attributeName !== 'Arn') {
      throw new ProvisioningError(
        `Unknown attribute ${attributeName} for ${resourceType}`,
        resourceType,
        physicalId
      );
    }
    try {
      return await this.fetchPolicyArn(physicalId);
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to resolve Arn for DLM Lifecycle Policy ${physicalId}: ${cause?.message ?? String(error)}`,
        resourceType,
        physicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Drift read-back. Surfaces `Description`, `State`, `ExecutionRoleArn`,
   * and `Tags` (DLM tag map -> CFn list via `normalizeAwsTagsToCfn`).
   *
   * `PolicyDetails` is intentionally NOT surfaced (see
   * `getDriftUnknownPaths`): the service normalizes the stored details —
   * filling `PolicyType` / `ResourceTypes` / per-schedule defaults the
   * template omitted — and the drift comparator's positional array equality
   * would flag those AWS-added defaults as phantom drift on every clean run.
   * The default-policy shorthand fields (`CreateInterval` / `RetainInterval`
   * / `CopyTags` / `ExtendDeletion` / `CrossRegionCopyTargets` /
   * `Exclusions`) are folded into the normalized `PolicyDetails` by the
   * service (GetLifecyclePolicy does not return them at the top level), so
   * they are excluded for the same reason.
   *
   * Returns `undefined` when the policy is gone (ResourceNotFoundException).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const response = await this.getClient().send(
        new GetLifecyclePolicyCommand({ PolicyId: physicalId })
      );
      const policy = response.Policy;
      if (!policy) return undefined;

      return {
        ...(policy.Description !== undefined && { Description: policy.Description }),
        ...(policy.State !== undefined && { State: policy.State }),
        ...(policy.ExecutionRoleArn !== undefined && {
          ExecutionRoleArn: policy.ExecutionRoleArn,
        }),
        Tags: normalizeAwsTagsToCfn(policy.Tags),
      };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        return undefined; // drift unknown — resource gone
      }
      throw error;
    }
  }

  /**
   * State property paths the provider deliberately does not read back from
   * AWS — see `readCurrentState` for the rationale.
   */
  getDriftUnknownPaths(_resourceType: string): string[] {
    return [
      'PolicyDetails',
      'CreateInterval',
      'RetainInterval',
      'CopyTags',
      'ExtendDeletion',
      'CrossRegionCopyTargets',
      'Exclusions',
      'DefaultPolicy',
    ];
  }

  /**
   * Adopt an existing lifecycle policy into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override (`knownPhysicalId`) -> verify via
   *     GetLifecyclePolicy. There is no template name property — the policy
   *     id is service-generated — so no name fallback applies.
   *  2. Tag-based lookup: GetLifecyclePolicies returns every policy summary
   *     WITH its tag map in a single unpaginated call, so the `aws:cdk:path`
   *     match needs no per-policy follow-up.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        const response = await this.getClient().send(
          new GetLifecyclePolicyCommand({ PolicyId: input.knownPhysicalId })
        );
        return response.Policy?.PolicyId
          ? {
              physicalId: input.knownPhysicalId,
              attributes: { Arn: response.Policy.PolicyArn ?? '' },
            }
          : null;
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    const list = await this.getClient().send(new GetLifecyclePoliciesCommand({}));
    for (const policy of list.Policies ?? []) {
      if (!policy.PolicyId) continue;
      if (policy.Tags?.[CDK_PATH_TAG] === input.cdkPath) {
        return { physicalId: policy.PolicyId, attributes: {} };
      }
    }
    return null;
  }
}
