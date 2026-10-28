/**
 * SDK Provider for AWS::BedrockAgentCore::Runtime
 *
 * Uses direct SDK calls instead of Cloud Control API because:
 * 1. CC API CREATE is async - it returns IN_PROGRESS, then polls for completion
 * 2. IAM role propagation to BedrockAgentCore is very slow (30-60+ seconds)
 * 3. When CC API polling returns FAILED (role validation), cdkd retries CREATE
 * 4. But the first CREATE actually succeeded asynchronously in the background
 * 5. The retry then fails with "already exists"
 * 6. CC API ClientToken caches the failure result, making it worse
 *
 * With direct SDK calls, we can:
 * - Call CreateAgentRuntime synchronously
 * - Get immediate error responses for IAM propagation issues
 * - Retry with proper exponential backoff
 * - Avoid the async CREATE + polling + retry conflict
 */
import {
  BedrockAgentCoreControlClient,
  CreateAgentRuntimeCommand,
  UpdateAgentRuntimeCommand,
  DeleteAgentRuntimeCommand,
  GetAgentRuntimeCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { getLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import { markNotGone } from '../not-gone.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { pascalToCamelCaseKeys, camelToPascalCaseKeys } from './agentcore-case-convert.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { definedAttributes } from '../attribute-map.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';

/**
 * The members whose VALUE is a user-keyed string map, so the case flip must
 * stop at the member name: its keys are tag keys / scope names, not shape
 * fields (issue #5433 — a `ManagedVpcResource.Tags` key `Env` went out as
 * `env`). Listed by name rather than derived from the schema: the cdkd
 * schema digest does not tell a map apart from an unexpanded struct, and the
 * names below are maps wherever they occur in the Runtime shapes.
 * `Tags`: `AuthorizerConfiguration.CustomJWTAuthorizer.PrivateEndpoint` and
 * `.PrivateEndpointOverrides[].PrivateEndpoint` `ManagedVpcResource.Tags`.
 * `AdvertisedScopeMapping`: `CustomJWTAuthorizer` in the SDK shape (not yet
 * in the CFn schema, but `GetAgentRuntime` returns it). `EnvironmentVariables`
 * is a top-level map passed through verbatim, never converted.
 */
const CFN_MAP_KEYS: ReadonlySet<string> = new Set(['Tags', 'AdvertisedScopeMapping']);
const SDK_MAP_KEYS: ReadonlySet<string> = new Set(['tags', 'advertisedScopeMapping']);

/**
 * AWS BedrockAgentCore Runtime Provider
 *
 * Implements resource provisioning for AWS::BedrockAgentCore::Runtime using the
 * BedrockAgentCoreControl SDK.
 */
export class AgentCoreRuntimeProvider implements ResourceProvider {
  private client: BedrockAgentCoreControlClient;
  private logger = getLogger().child('AgentCoreRuntimeProvider');

  /**
   * The failure wrap this provider's create, update and delete catches throw.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
   * assumed-role ARN. AWS's own text goes to `debug` through the operation's
   * masker, and the wrap is stamped `markRedactedCause`, so the retry
   * classifiers read the withheld text on the `cause` chain. An "already
   * exists" is restated ({@link relayedNameCollision}), so a create-first
   * replacement still recognises the collision. A cdkd-authored or transport
   * error keeps its text, masked, stamped only when the mask changed it
   * (`wrapMaskedAwsError`, issue #4244); a non-`Error` throw is withheld like
   * an AWS one, unstamped (it has no chain). A delete catch tests not-found
   * before it wraps.
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

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::BedrockAgentCore::Runtime',
      new Set([
        'AgentRuntimeName',
        'RoleArn',
        'AgentRuntimeArtifact',
        'NetworkConfiguration',
        'Description',
        'AuthorizerConfiguration',
        'ProtocolConfiguration',
        'LifecycleConfiguration',
        'EnvironmentVariables',
        'ClientToken',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.client = awsClients.bedrockAgentCoreControl;
  }

  /**
   * Create a BedrockAgentCore Runtime
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating BedrockAgentCore Runtime ${logicalId}`);

    const agentRuntimeName = properties['AgentRuntimeName'] as string;
    if (!agentRuntimeName) {
      throw new ProvisioningError(
        `AgentRuntimeName is required for ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    const roleArn = properties['RoleArn'] as string;
    if (!roleArn) {
      throw new ProvisioningError(`RoleArn is required for ${logicalId}`, resourceType, logicalId);
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const input: Record<string, any> = {
        agentRuntimeName,
        roleArn,
      };

      if (properties['AgentRuntimeArtifact'] !== undefined) {
        input['agentRuntimeArtifact'] = pascalToCamelCaseKeys(
          properties['AgentRuntimeArtifact'],
          CFN_MAP_KEYS
        );
      }
      if (properties['NetworkConfiguration'] !== undefined) {
        input['networkConfiguration'] = pascalToCamelCaseKeys(
          properties['NetworkConfiguration'],
          CFN_MAP_KEYS
        );
      }
      if (properties['Description'] !== undefined) {
        input['description'] = properties['Description'];
      }
      if (properties['AuthorizerConfiguration'] !== undefined) {
        input['authorizerConfiguration'] = pascalToCamelCaseKeys(
          properties['AuthorizerConfiguration'],
          CFN_MAP_KEYS
        );
      }
      if (properties['ProtocolConfiguration'] !== undefined) {
        // CFn template has ProtocolConfiguration as a string (e.g. "HTTP"),
        // but the SDK expects an object { serverProtocol: "HTTP" }
        const proto = properties['ProtocolConfiguration'];
        if (typeof proto === 'string') {
          input['protocolConfiguration'] = { serverProtocol: proto };
        } else {
          input['protocolConfiguration'] = pascalToCamelCaseKeys(proto, CFN_MAP_KEYS);
        }
      }
      // Skip empty LifecycleConfiguration (CFn template may have {} which SDK rejects)
      if (
        properties['LifecycleConfiguration'] !== undefined &&
        typeof properties['LifecycleConfiguration'] === 'object' &&
        properties['LifecycleConfiguration'] !== null &&
        Object.keys(properties['LifecycleConfiguration'] as Record<string, unknown>).length > 0
      ) {
        input['lifecycleConfiguration'] = pascalToCamelCaseKeys(
          properties['LifecycleConfiguration'],
          CFN_MAP_KEYS
        );
      }
      if (properties['EnvironmentVariables'] !== undefined) {
        input['environmentVariables'] = properties['EnvironmentVariables'];
      }
      if (properties['ClientToken'] !== undefined) {
        input['clientToken'] = properties['ClientToken'];
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      const response = await this.client.send(new CreateAgentRuntimeCommand(input as any));

      const agentRuntimeId = response.agentRuntimeId!;
      const agentRuntimeArn = response.agentRuntimeArn!;

      this.logger.debug(`Created BedrockAgentCore Runtime: ${agentRuntimeId} (${agentRuntimeArn})`);

      return {
        physicalId: agentRuntimeId,
        attributes: this.buildAttributes(response, agentRuntimeName),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create BedrockAgentCore Runtime ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            undefined,
            cause
          )
      );
    }
  }

  /**
   * Update a BedrockAgentCore Runtime
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating BedrockAgentCore Runtime ${logicalId}: ${physicalId}`);
    // go-to-k/cdkd#2613: the physical id is the bare runtime id, so a client in another region than
    // the state record would send `UpdateAgentRuntime` to a region this record was not written
    // through. Ahead of the RoleArn check so the refusal names the region, not a symptom, and outside
    // the try so it is not re-labelled as an AWS failure. Refuse before any call; the client's
    // region is resolved only when there is one to compare with.
    assertRegionMatch(
      context?.expectedRegion ? await this.client.config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );

    const roleArn = properties['RoleArn'] as string;
    if (!roleArn) {
      throw new ProvisioningError(
        `RoleArn is required for ${logicalId}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    try {
      // A full replace: a field left out here is CLEARED on AWS, which is how a
      // property removed from the template is reset, as CloudFormation does
      // (issue #1160). A CloudFormation A/B (us-east-1) cleared a removed
      // Description / AuthorizerConfiguration / ProtocolConfiguration /
      // EnvironmentVariables and put a removed LifecycleConfiguration back to
      // the service defaults (900 / 28800), exactly what this call leaves when
      // it omits them; so no `removalDefaults` apply. Never fill an absent
      // field from `previousProperties`. No `removalHandledInUpdate` opt-in:
      // the schema's RequestHeaderConfiguration / FilesystemConfigurations /
      // CapacityProviderConfiguration / PlatformVersion are never sent here,
      // and a full replace drops what it omits, so the caller's "left in
      // place" warning would most likely misreport their removal.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const input: Record<string, any> = {
        agentRuntimeId: physicalId,
        roleArn,
      };

      if (properties['AgentRuntimeArtifact'] !== undefined) {
        input['agentRuntimeArtifact'] = pascalToCamelCaseKeys(
          properties['AgentRuntimeArtifact'],
          CFN_MAP_KEYS
        );
      }
      if (properties['NetworkConfiguration'] !== undefined) {
        input['networkConfiguration'] = pascalToCamelCaseKeys(
          properties['NetworkConfiguration'],
          CFN_MAP_KEYS
        );
      }
      if (properties['Description'] !== undefined) {
        input['description'] = properties['Description'];
      }
      if (properties['AuthorizerConfiguration'] !== undefined) {
        input['authorizerConfiguration'] = pascalToCamelCaseKeys(
          properties['AuthorizerConfiguration'],
          CFN_MAP_KEYS
        );
      }
      if (properties['ProtocolConfiguration'] !== undefined) {
        const proto = properties['ProtocolConfiguration'];
        if (typeof proto === 'string') {
          input['protocolConfiguration'] = { serverProtocol: proto };
        } else {
          input['protocolConfiguration'] = pascalToCamelCaseKeys(proto, CFN_MAP_KEYS);
        }
      }
      if (
        properties['LifecycleConfiguration'] !== undefined &&
        typeof properties['LifecycleConfiguration'] === 'object' &&
        properties['LifecycleConfiguration'] !== null &&
        Object.keys(properties['LifecycleConfiguration'] as Record<string, unknown>).length > 0
      ) {
        input['lifecycleConfiguration'] = pascalToCamelCaseKeys(
          properties['LifecycleConfiguration'],
          CFN_MAP_KEYS
        );
      }
      if (properties['EnvironmentVariables'] !== undefined) {
        input['environmentVariables'] = properties['EnvironmentVariables'];
      }
      if (properties['ClientToken'] !== undefined) {
        input['clientToken'] = properties['ClientToken'];
      }

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any
      const response = await this.client.send(new UpdateAgentRuntimeCommand(input as any));

      const agentRuntimeId = response.agentRuntimeId!;

      this.logger.debug(`Successfully updated BedrockAgentCore Runtime ${logicalId}`);

      return {
        physicalId: agentRuntimeId,
        wasReplaced: false,
        attributes: this.buildAttributes(response, properties['AgentRuntimeName'] as string),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update BedrockAgentCore Runtime ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  /**
   * Delete a BedrockAgentCore Runtime
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting BedrockAgentCore Runtime ${logicalId}: ${physicalId}`);

    try {
      await this.client.send(
        new DeleteAgentRuntimeCommand({
          agentRuntimeId: physicalId,
        })
      );

      this.logger.debug(`Successfully deleted BedrockAgentCore Runtime ${logicalId}`);
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
        this.logger.debug(`Runtime ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete BedrockAgentCore Runtime ${logicalId}: ${text}`,
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

  /**
   * Build the CFn read-only attribute map recorded in cdkd state for
   * `Fn::GetAtt` resolution.
   *
   * CloudFormation exposes `AWS::BedrockAgentCore::Runtime`'s read-only
   * attributes under the names `AgentRuntimeArn` / `AgentRuntimeId` /
   * `AgentRuntimeVersion` / `Status` / `CreatedAt` /
   * `WorkloadIdentityDetails` (the type's registry-schema
   * `readOnlyProperties`). The stored `attributes` map is looked up BY CFn
   * attribute name during output / cross-resource `Fn::GetAtt` resolution
   * (`constructAttribute` in `deployment/intrinsic-resolver/getatt.ts` never calls
   * `getAttribute`), so the keys MUST match those CFn names. The previous
   * `Arn` key meant `Fn::GetAtt [Runtime, AgentRuntimeArn]` missed the
   * cached attribute, fell through to the unknown-attribute guard, and hard
   * -failed because the physical id (the runtime name) is not ARN-shaped
   * (issue #1179).
   */
  private buildAttributes(
    response: {
      agentRuntimeArn?: string | undefined;
      agentRuntimeId?: string | undefined;
      agentRuntimeVersion?: string | undefined;
      status?: string | undefined;
      createdAt?: Date | undefined;
      workloadIdentityDetails?: unknown;
    },
    agentRuntimeName: string | undefined
  ): Record<string, unknown> {
    // `definedAttributes` (issue #3077): a member the response did not carry
    // is ABSENT, never a present-but-`undefined` key and never `''` -- the
    // import path used to pass `agentRuntimeName ?? ''` here.
    const attributes: Record<string, unknown> = definedAttributes({
      AgentRuntimeArn: response.agentRuntimeArn,
      AgentRuntimeId: response.agentRuntimeId,
      AgentRuntimeName: agentRuntimeName,
    });
    if (response.agentRuntimeVersion !== undefined) {
      attributes['AgentRuntimeVersion'] = response.agentRuntimeVersion;
    }
    if (response.status !== undefined) {
      attributes['Status'] = response.status;
    }
    if (response.createdAt !== undefined) {
      attributes['CreatedAt'] = response.createdAt.toISOString();
    }
    if (response.workloadIdentityDetails !== undefined) {
      attributes['WorkloadIdentityDetails'] = camelToPascalCaseKeys(
        response.workloadIdentityDetails,
        SDK_MAP_KEYS
      );
    }
    return attributes;
  }

  /**
   * Get resource attribute (for a live `Fn::GetAtt` fetch, e.g. `cdkd
   * orphan`). Output / cross-resource resolution reads the cached
   * `attributes` map written by {@link buildAttributes}; this live path
   * covers callers that bypass that cache.
   *
   * `WorkloadIdentityDetails` is NOT resolvable here because
   * `GetAgentRuntime` does not return it (it is a create/update-time
   * response field only); it stays available via the cached attributes.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    // The physical id IS the runtime id - a known-correct answer with no
    // API call needed.
    if (attributeName === 'AgentRuntimeId') {
      return physicalId;
    }

    const response = await this.client.send(
      new GetAgentRuntimeCommand({ agentRuntimeId: physicalId })
    );

    switch (attributeName) {
      // `Arn` is not a CFn attribute of this type; kept as an alias for
      // any caller still using the pre-#1179 key.
      case 'Arn':
      case 'AgentRuntimeArn':
        return response.agentRuntimeArn;
      case 'AgentRuntimeName':
        return response.agentRuntimeName;
      case 'AgentRuntimeVersion':
        return response.agentRuntimeVersion;
      case 'Status':
        return response.status;
      case 'CreatedAt':
        return response.createdAt?.toISOString();
      case 'LastUpdatedAt':
        return response.lastUpdatedAt?.toISOString();
      case 'FailureReason':
        return response.failureReason;
      default:
        throw new Error(
          `Unsupported attribute: ${attributeName} for AWS::BedrockAgentCore::Runtime`
        );
    }
  }

  /**
   * Read the AWS-current BedrockAgentCore Runtime configuration in
   * CFn-property shape.
   *
   * Issues `GetAgentRuntime` (the physical id is the runtime id) and
   * surfaces the keys `create()` accepts. The SDK returns camelCase keys
   * (`agentRuntimeName`, `roleArn`, `agentRuntimeArtifact`, etc.); we
   * re-shape back to PascalCase via `camelToPascalCaseKeys` so the
   * comparator matches cdkd state.
   *
   * `ProtocolConfiguration` parity: `create()` accepts a CFn-style string
   * (`"HTTP"`) and converts it to `{serverProtocol: "HTTP"}` for the SDK.
   * The SDK returns the object form. We surface the **string form** here
   * (extract `serverProtocol` from the SDK object) since CFn's
   * `AWS::BedrockAgentCore::Runtime.ProtocolConfiguration` is documented
   * as a string and that's what cdkd state typically holds after CDK
   * synth. If state happens to carry the object form (legacy / hand-
   * authored), the comparator will report a one-time drift the user can
   * resolve via `cdkd state refresh-observed`.
   *
   * `ClientToken` is omitted: AWS does not surface it back via
   * `GetAgentRuntime` (it's an idempotency token only meaningful at create
   * time).
   *
   * Returns `RESOURCE_NOT_FOUND` when the runtime is gone
   * (`ResourceNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    let resp;
    try {
      resp = await this.client.send(new GetAgentRuntimeCommand({ agentRuntimeId: physicalId }));
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
      throw err;
    }

    const result: Record<string, unknown> = {};

    if (resp.agentRuntimeName !== undefined) {
      result['AgentRuntimeName'] = resp.agentRuntimeName;
    }
    if (resp.roleArn !== undefined) result['RoleArn'] = resp.roleArn;
    if (resp.agentRuntimeArtifact !== undefined) {
      result['AgentRuntimeArtifact'] = camelToPascalCaseKeys(
        resp.agentRuntimeArtifact,
        SDK_MAP_KEYS
      );
    }
    if (resp.networkConfiguration !== undefined) {
      result['NetworkConfiguration'] = camelToPascalCaseKeys(
        resp.networkConfiguration,
        SDK_MAP_KEYS
      );
    }
    result['Description'] = resp.description ?? '';
    if (resp.authorizerConfiguration !== undefined) {
      result['AuthorizerConfiguration'] = camelToPascalCaseKeys(
        resp.authorizerConfiguration,
        SDK_MAP_KEYS
      );
    }
    if (resp.protocolConfiguration !== undefined) {
      // SDK returns `{serverProtocol: "HTTP"}` for the single-field case.
      // Surface the string form to match CFn's documented shape and the
      // typical post-CDK-synth state. Fall back to the camelToPascal
      // object form for any unexpected shape (defensive).
      const proto = resp.protocolConfiguration as unknown as Record<string, unknown>;
      const keys = Object.keys(proto);
      if (
        keys.length === 1 &&
        keys[0] === 'serverProtocol' &&
        typeof proto['serverProtocol'] === 'string'
      ) {
        result['ProtocolConfiguration'] = proto['serverProtocol'];
      } else {
        result['ProtocolConfiguration'] = camelToPascalCaseKeys(
          resp.protocolConfiguration,
          SDK_MAP_KEYS
        );
      }
    }
    if (resp.lifecycleConfiguration !== undefined) {
      result['LifecycleConfiguration'] = camelToPascalCaseKeys(
        resp.lifecycleConfiguration,
        SDK_MAP_KEYS
      );
    }
    if (resp.environmentVariables !== undefined) {
      result['EnvironmentVariables'] = resp.environmentVariables;
    }

    return result;
  }

  /**
   * Adopt an existing BedrockAgentCore Runtime into cdkd state.
   *
   * **Explicit override only (for now).** The BedrockAgentCore SDK does
   * expose `ListTagsForResource`, so a future PR could add full tag-based
   * auto-lookup. For this batch we keep it override-only to ship
   * consistently with the other batch-5 attachment-style providers; users
   * adopting an existing runtime should pass
   * `--resource <logicalId>=<agentRuntimeId>` (e.g. `runtime-12345`,
   * matching the physical id format returned by `create()`).
   *
   * The imported record's `attributes` are enriched to the same CFn read-only
   * set `create()` / `update()` write (via {@link buildAttributes}) so an
   * imported runtime resolves `Fn::GetAtt [Runtime, AgentRuntimeArn]` (and the
   * other read-only attributes) from cached state, matching deploy-created
   * runtimes (issue #1188). The enrichment is best-effort: a single
   * `GetAgentRuntime` is issued, and any failure (throttle, transient error,
   * a `--resource` id that does not resolve) falls back to the minimal
   * `{ AgentRuntimeId }` record — the live `getAttribute()` path still resolves
   * the ARN, so import never fails on the enrichment. `WorkloadIdentityDetails`
   * is not populated here (`GetAgentRuntime` does not return it — it is a
   * create/update-response field only).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (!input.knownPhysicalId) {
      return null;
    }

    const physicalId = input.knownPhysicalId;
    try {
      const resp = await this.client.send(
        new GetAgentRuntimeCommand({ agentRuntimeId: physicalId })
      );
      return {
        physicalId,
        attributes: this.buildAttributes(resp, resp.agentRuntimeName),
      };
    } catch (err) {
      this.logger.debug(
        `Could not enrich imported BedrockAgentCore Runtime ${physicalId} attributes ` +
          `(${describeAwsFailure(err).detail}); ` +
          `recording AgentRuntimeId only (Fn::GetAtt resolves live via getAttribute)`
      );
      return {
        physicalId,
        attributes: { AgentRuntimeId: physicalId },
      };
    }
  }
}
