/**
 * SDK Provider for AWS::BedrockAgentCore::Evaluator
 *
 * Provisions custom evaluators (LLM-as-a-Judge or code-based Lambda
 * configs) for AgentCore quality evaluations via the
 * `bedrock-agentcore-control` control plane (issue #1058).
 *
 * Uses direct SDK calls (`CreateEvaluator` / `UpdateEvaluator` /
 * `DeleteEvaluator` / `GetEvaluator`) instead of Cloud Control for the same
 * reasons as the sibling `agentcore-runtime-provider.ts`: synchronous
 * responses, immediate error surfaces, and no CC-API polling overhead.
 *
 * CFn <-> SDK mapping notes (verified against the registry schema and
 * `@aws-sdk/client-bedrock-agentcore-control` typings):
 * - The physical id is the Evaluator ARN (the type's primaryIdentifier, so
 *   `Ref` matches CloudFormation); the SDK ops take the evaluator ID, which
 *   is the ARN's final `evaluator/<id>` path segment.
 * - `EvaluatorConfig` is a union (`LlmAsAJudge` | `CodeBased`) whose member
 *   and field names map 1:1 to the SDK's camelCase shapes — EXCEPT the
 *   free-form `AdditionalModelRequestFields` document, whose inner keys are
 *   model-specific request fields (e.g. `top_k`) and must be passed
 *   verbatim (see `agentcore-case-convert.ts`).
 * - CFn `Tags` is a `[{Key, Value}]` list; the SDK's create/tag ops take a
 *   `Record<string, string>` map. `UpdateEvaluator` does not accept tags,
 *   so tag changes go through `TagResource` / `UntagResource`.
 * - `EvaluatorName` is the type's only createOnly property; a name change
 *   is classified as replacement by the deploy engine's registry-schema
 *   createOnly fallback (`create-only-properties.ts`) — no per-provider
 *   replacement logic needed.
 */
import {
  BedrockAgentCoreControlClient,
  CreateEvaluatorCommand,
  UpdateEvaluatorCommand,
  DeleteEvaluatorCommand,
  GetEvaluatorCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { getLogger } from '../../utils/logger.js';
import { pascalToCamelCaseKeys, camelToPascalCaseKeys } from './agentcore-case-convert.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * The `EvaluatorConfig` subtree keys whose values are free-form JSON
 * documents (user/model-defined keys) that must NOT be case-converted.
 */
const CFN_PRESERVE_KEYS: ReadonlySet<string> = new Set(['AdditionalModelRequestFields']);
const SDK_PRESERVE_KEYS: ReadonlySet<string> = new Set(['additionalModelRequestFields']);

/**
 * Extract the evaluator ID from an evaluator ARN
 * (`arn:...:evaluator/<id>` → `<id>`). Falls back to the input verbatim
 * when it does not look like an ARN (already an ID).
 */
export function evaluatorIdFromArn(arnOrId: string): string {
  const marker = ':evaluator/';
  const idx = arnOrId.indexOf(marker);
  return idx >= 0 ? arnOrId.slice(idx + marker.length) : arnOrId;
}

/** CFn `[{Key, Value}]` tag list → SDK `Record<string, string>` map. */
function cfnTagListToMap(tags: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (
        tag !== null &&
        typeof tag === 'object' &&
        typeof (tag as Record<string, unknown>)['Key'] === 'string'
      ) {
        map[(tag as Record<string, unknown>)['Key'] as string] = String(
          (tag as Record<string, unknown>)['Value'] ?? ''
        );
      }
    }
  }
  return map;
}

/** SDK `Record<string, string>` tag map → CFn `[{Key, Value}]` list. */
function tagMapToCfnList(tags: Record<string, string>): Array<{ Key: string; Value: string }> {
  return Object.entries(tags).map(([Key, Value]) => ({ Key, Value }));
}

/**
 * AWS BedrockAgentCore Evaluator Provider
 */
export class AgentCoreEvaluatorProvider implements ResourceProvider {
  private client: BedrockAgentCoreControlClient;
  private logger = getLogger().child('AgentCoreEvaluatorProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::BedrockAgentCore::Evaluator',
      new Set<string>([
        'EvaluatorName',
        'Description',
        'EvaluatorConfig',
        'Level',
        'KmsKeyArn',
        'Tags',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.client = awsClients.bedrockAgentCoreControl;
  }

  /**
   * Create a BedrockAgentCore Evaluator
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating BedrockAgentCore Evaluator ${logicalId}`);

    const evaluatorName = properties['EvaluatorName'] as string;
    if (!evaluatorName) {
      throw new ProvisioningError(
        `EvaluatorName is required for ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    if (properties['EvaluatorConfig'] === undefined) {
      throw new ProvisioningError(
        `EvaluatorConfig is required for ${logicalId}`,
        resourceType,
        logicalId
      );
    }
    if (properties['Level'] === undefined) {
      throw new ProvisioningError(`Level is required for ${logicalId}`, resourceType, logicalId);
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const input: Record<string, any> = {
        evaluatorName,
        evaluatorConfig: pascalToCamelCaseKeys(properties['EvaluatorConfig'], CFN_PRESERVE_KEYS),
        level: properties['Level'],
      };
      if (properties['Description'] !== undefined) {
        input['description'] = properties['Description'];
      }
      if (properties['KmsKeyArn'] !== undefined) {
        input['kmsKeyArn'] = properties['KmsKeyArn'];
      }
      if (properties['Tags'] !== undefined) {
        const tags = cfnTagListToMap(properties['Tags']);
        if (Object.keys(tags).length > 0) {
          input['tags'] = tags;
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      const response = await this.client.send(new CreateEvaluatorCommand(input as any));

      const evaluatorArn = response.evaluatorArn!;
      const evaluatorId = response.evaluatorId!;

      this.logger.debug(`Created BedrockAgentCore Evaluator: ${evaluatorId} (${evaluatorArn})`);

      return {
        physicalId: evaluatorArn,
        attributes: {
          EvaluatorArn: evaluatorArn,
          EvaluatorId: evaluatorId,
          Status: response.status ?? '',
          CreatedAt: response.createdAt?.toISOString() ?? '',
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create BedrockAgentCore Evaluator ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update a BedrockAgentCore Evaluator.
   *
   * `UpdateEvaluator` covers Description / EvaluatorConfig / Level /
   * KmsKeyArn; tag changes are applied via TagResource / UntagResource
   * (the update op does not accept tags). `EvaluatorName` is createOnly —
   * the deploy engine replaces the resource instead of calling this.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating BedrockAgentCore Evaluator ${logicalId}: ${physicalId}`);

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const input: Record<string, any> = {
        evaluatorId: evaluatorIdFromArn(physicalId),
      };
      if (properties['Description'] !== undefined) {
        input['description'] = properties['Description'];
      }
      if (properties['EvaluatorConfig'] !== undefined) {
        input['evaluatorConfig'] = pascalToCamelCaseKeys(
          properties['EvaluatorConfig'],
          CFN_PRESERVE_KEYS
        );
      }
      if (properties['Level'] !== undefined) {
        input['level'] = properties['Level'];
      }
      if (properties['KmsKeyArn'] !== undefined) {
        input['kmsKeyArn'] = properties['KmsKeyArn'];
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      const response = await this.client.send(new UpdateEvaluatorCommand(input as any));

      await this.syncTags(physicalId, properties['Tags'], previousProperties['Tags']);

      const evaluatorArn = response.evaluatorArn ?? physicalId;

      this.logger.debug(`Successfully updated BedrockAgentCore Evaluator ${logicalId}`);

      return {
        physicalId: evaluatorArn,
        wasReplaced: false,
        attributes: {
          EvaluatorArn: evaluatorArn,
          EvaluatorId: response.evaluatorId ?? evaluatorIdFromArn(evaluatorArn),
          Status: response.status ?? '',
          UpdatedAt: response.updatedAt?.toISOString() ?? '',
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update BedrockAgentCore Evaluator ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Apply CFn tag-list changes via TagResource / UntagResource.
   */
  private async syncTags(
    evaluatorArn: string,
    nextTagsRaw: unknown,
    previousTagsRaw: unknown
  ): Promise<void> {
    const nextTags = cfnTagListToMap(nextTagsRaw);
    const previousTags = cfnTagListToMap(previousTagsRaw);

    const removedKeys = Object.keys(previousTags).filter((key) => !(key in nextTags));
    const upserts: Record<string, string> = {};
    for (const [key, value] of Object.entries(nextTags)) {
      if (previousTags[key] !== value) {
        upserts[key] = value;
      }
    }

    if (removedKeys.length > 0) {
      await this.client.send(
        new UntagResourceCommand({ resourceArn: evaluatorArn, tagKeys: removedKeys })
      );
    }
    if (Object.keys(upserts).length > 0) {
      await this.client.send(new TagResourceCommand({ resourceArn: evaluatorArn, tags: upserts }));
    }
  }

  /**
   * Delete a BedrockAgentCore Evaluator
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting BedrockAgentCore Evaluator ${logicalId}: ${physicalId}`);

    try {
      await this.client.send(
        new DeleteEvaluatorCommand({ evaluatorId: evaluatorIdFromArn(physicalId) })
      );

      this.logger.debug(`Successfully deleted BedrockAgentCore Evaluator ${logicalId}`);
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
        this.logger.debug(`Evaluator ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete BedrockAgentCore Evaluator ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Get resource attribute (for Fn::GetAtt resolution). The CFn read-only
   * attribute set is EvaluatorArn / EvaluatorId / Status / CreatedAt /
   * UpdatedAt.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'EvaluatorArn') {
      return physicalId;
    }
    if (attributeName === 'EvaluatorId') {
      return evaluatorIdFromArn(physicalId);
    }
    if (
      attributeName === 'Status' ||
      attributeName === 'CreatedAt' ||
      attributeName === 'UpdatedAt'
    ) {
      const response = await this.client.send(
        new GetEvaluatorCommand({ evaluatorId: evaluatorIdFromArn(physicalId) })
      );
      if (attributeName === 'Status') return response.status;
      if (attributeName === 'CreatedAt') return response.createdAt?.toISOString();
      return response.updatedAt?.toISOString();
    }

    throw new Error(`Unsupported attribute: ${attributeName} for AWS::BedrockAgentCore::Evaluator`);
  }

  /**
   * Read the AWS-current Evaluator configuration in CFn-property shape.
   *
   * Issues `GetEvaluator` + `ListTagsForResource` and surfaces the keys
   * `create()` accepts, re-shaped to PascalCase (the free-form
   * `additionalModelRequestFields` document is passed through verbatim).
   * Returns `undefined` when the evaluator is gone
   * (`ResourceNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let resp;
    try {
      resp = await this.client.send(
        new GetEvaluatorCommand({ evaluatorId: evaluatorIdFromArn(physicalId) })
      );
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }

    const result: Record<string, unknown> = {};
    if (resp.evaluatorName !== undefined) result['EvaluatorName'] = resp.evaluatorName;
    result['Description'] = resp.description ?? '';
    if (resp.evaluatorConfig !== undefined) {
      result['EvaluatorConfig'] = camelToPascalCaseKeys(resp.evaluatorConfig, SDK_PRESERVE_KEYS);
    }
    if (resp.level !== undefined) result['Level'] = resp.level;
    if (resp.kmsKeyArn !== undefined) result['KmsKeyArn'] = resp.kmsKeyArn;

    try {
      const tagsResp = await this.client.send(
        new ListTagsForResourceCommand({ resourceArn: physicalId })
      );
      result['Tags'] = tagMapToCfnList(tagsResp.tags ?? {});
    } catch (err) {
      // Tags are best-effort for drift purposes; a tagging read failure
      // should not fail the whole drift snapshot.
      this.logger.debug(
        `Failed to read tags for evaluator ${physicalId}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return result;
  }

  /**
   * Adopt an existing BedrockAgentCore Evaluator into cdkd state.
   *
   * **Explicit override only.** Pass `--resource <logicalId>=<value>` where
   * `<value>` is the evaluator ARN or the bare evaluator ID; an ID is
   * resolved to the canonical ARN (the physical id shape `create()`
   * records) via `GetEvaluator`.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (!input.knownPhysicalId) {
      return null;
    }
    if (input.knownPhysicalId.includes(':evaluator/')) {
      return {
        physicalId: input.knownPhysicalId,
        attributes: {
          EvaluatorArn: input.knownPhysicalId,
          EvaluatorId: evaluatorIdFromArn(input.knownPhysicalId),
        },
      };
    }
    const response = await this.client.send(
      new GetEvaluatorCommand({ evaluatorId: input.knownPhysicalId })
    );
    return {
      physicalId: response.evaluatorArn!,
      attributes: {
        EvaluatorArn: response.evaluatorArn!,
        EvaluatorId: response.evaluatorId ?? input.knownPhysicalId,
      },
    };
  }
}
