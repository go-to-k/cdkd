import type { AgentCoreRuntimeProvider } from '../agentcore-runtime-provider.js';
import {
  GetAgentRuntimeCommand,
  ListTagsForResourceCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { camelToPascalCaseKeys } from '../agentcore-case-convert.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { SDK_MAP_KEYS, isUserTagKey } from './shared.js';

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
 * time). `Tags` is read by a second call, `ListTagsForResource` on the
 * runtime ARN, and omitted when that read fails.
 *
 * Returns `RESOURCE_NOT_FOUND` when the runtime is gone
 * (`ResourceNotFoundException`).
 */
export async function readCurrentState(
  this: AgentCoreRuntimeProvider,
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
    result['AgentRuntimeArtifact'] = camelToPascalCaseKeys(resp.agentRuntimeArtifact, SDK_MAP_KEYS);
  }
  if (resp.networkConfiguration !== undefined) {
    result['NetworkConfiguration'] = camelToPascalCaseKeys(resp.networkConfiguration, SDK_MAP_KEYS);
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
  // Placeholders for an unset field, so a value added outside cdkd is seen
  // by drift (docs/provider-rules.md#readcurrentstate-for-drift-detection);
  // `writeSharedRuntimeMembers` leaves each placeholder off the wire.
  result['RequestHeaderConfiguration'] =
    resp.requestHeaderConfiguration !== undefined
      ? camelToPascalCaseKeys(resp.requestHeaderConfiguration, SDK_MAP_KEYS)
      : {};
  result['FilesystemConfigurations'] =
    resp.filesystemConfigurations !== undefined
      ? camelToPascalCaseKeys(resp.filesystemConfigurations, SDK_MAP_KEYS)
      : [];
  result['CapacityProviderConfiguration'] =
    resp.capacityProviderConfiguration !== undefined
      ? camelToPascalCaseKeys(resp.capacityProviderConfiguration, SDK_MAP_KEYS)
      : {};
  result['PlatformVersion'] = resp.platformVersion ?? '';

  // Tags: the template's key -> value MAP shape, so drift never compares a
  // list against a map (issue #5390). Best-effort: a tagging read failure
  // (e.g. a missing `ListTagsForResource` grant) omits the key.
  if (resp.agentRuntimeArn) {
    try {
      const tagsResp = await this.client.send(
        new ListTagsForResourceCommand({ resourceArn: resp.agentRuntimeArn })
      );
      result['Tags'] = Object.fromEntries(
        Object.entries(tagsResp.tags ?? {}).filter(([k]) => isUserTagKey(k))
      );
    } catch (err) {
      this.logger.debug(
        safeMsg`Failed to read tags for runtime ${physicalId}: ${describeAwsFailure(err).detail}`
      );
    }
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
export async function importImpl(
  this: AgentCoreRuntimeProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (!input.knownPhysicalId) {
    return null;
  }

  const physicalId = input.knownPhysicalId;
  try {
    const resp = await this.client.send(new GetAgentRuntimeCommand({ agentRuntimeId: physicalId }));
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
