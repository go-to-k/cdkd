import type { PipesPipeProvider } from '../pipes-provider.js';
import { NotFoundException, type DescribePipeCommandOutput } from '@aws-sdk/client-pipes';
import {
  RESOURCE_NOT_FOUND,
  type ResourceImportInput,
  type ResourceImportResult,
  type ResourceNotFound,
} from '../../../types/resource.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { resolveExplicitPhysicalId } from '../../import-helpers.js';
import { MOVING_STATES } from './shared.js';

/**
 * Live `Fn::GetAtt`. The attributes are recorded at create / update time,
 * so this serves imported or degraded records. `undefined` for an unknown
 * attribute or a pipe that is gone.
 */
export async function getAttribute(
  this: PipesPipeProvider,
  physicalId: string,
  resourceType: string,
  attributeName: string,
  logicalId: string
): Promise<unknown> {
  let response: DescribePipeCommandOutput;
  try {
    response = await this.describe(physicalId);
  } catch (error) {
    if (error instanceof NotFoundException) return undefined;
    // The rethrow reaches the persisted deploy events: AWS's text is
    // withheld like the create / update / delete wraps' (go-to-k/cdkd#2319).
    if (!describeAwsFailure(error).redacted) throw error;
    throw this.wrapCaughtError(
      undefined,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to read ${attributeName} of Pipe ${physicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          error instanceof Error ? error : undefined
        )
    );
  }
  return this.attributesOf(response)[attributeName];
}

/**
 * Drift read-back. `SourceParameters` and `TargetParameters` are WRITE-ONLY
 * in the CFn schema, and `DescribePipe` fills them with AWS defaults the
 * template never declared, so they are left out and declared unknown
 * ({@link getDriftUnknownPaths}) rather than reported as drift on every
 * pipe. Returns `RESOURCE_NOT_FOUND` when the pipe is gone (`NotFoundException`).
 */
export async function readCurrentState(
  this: PipesPipeProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let r: DescribePipeCommandOutput;
  try {
    r = await this.describe(physicalId);
  } catch (error) {
    if (error instanceof NotFoundException) return RESOURCE_NOT_FOUND;
    throw error;
  }
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(r.Tags ?? {})) {
    if (!key.startsWith('aws:')) tags[key] = value;
  }
  return {
    Name: r.Name ?? physicalId,
    Description: r.Description ?? '',
    DesiredState: r.DesiredState ?? 'RUNNING',
    Source: r.Source,
    Enrichment: r.Enrichment ?? '',
    EnrichmentParameters: r.EnrichmentParameters ?? {},
    Target: r.Target,
    RoleArn: r.RoleArn,
    LogConfiguration: r.LogConfiguration ?? {},
    KmsKeyIdentifier: r.KmsKeyIdentifier ?? '',
    Tags: tags,
  };
}

/**
 * Import by explicit name (`--resource <logicalId>=<name>` or the template's
 * `Name`). No tag lookup: a pipe carries no `aws:cdk:path` tag.
 */
export async function importImpl(
  this: PipesPipeProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'Name');
  if (!explicit) return null;
  try {
    const response = await this.describe(explicit);
    return { physicalId: explicit, attributes: this.attributesOf(response) };
  } catch (error) {
    if (error instanceof NotFoundException) return null;
    throw error;
  }
}

/**
 * go-to-k/cdkd#5487: while the pipe is CREATING, UPDATING, STARTING,
 * STOPPING or DELETING, an unsettled key other than `Tags` is still
 * changing. A failed read keeps
 * every name, which only costs the next deploy a re-send.
 */
export async function unsettledInTransition(
  this: PipesPipeProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string,
  names: ReadonlySet<string>
): Promise<ReadonlySet<string>> {
  try {
    const state = (await this.describe(physicalId)).CurrentState;
    // Only a state AWS is moving through. A failed one (`*_FAILED`) is at
    // rest: the update must run, since only another UpdatePipe recovers it
    // (`readUnsettled` makes it re-send).
    if (state === undefined || !MOVING_STATES.has(state)) return new Set();
    return new Set([...names].filter((name) => name !== 'Tags'));
  } catch {
    return names;
  }
}

/**
 * go-to-k/cdkd#5487: `readCurrentState` for the engine's convergence step,
 * except that a pipe at rest in a failed state (`*_FAILED`) reports none of
 * the unsettled names: whatever its configuration reads, it is not what the
 * failed call asked for, so the update re-sends them.
 */
export async function readUnsettled(
  this: PipesPipeProvider,
  physicalId: string,
  logicalId: string,
  resourceType: string,
  names: ReadonlySet<string>
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const live = await this.readCurrentState(physicalId, logicalId, resourceType);
  if (typeof live !== 'object' || live === null) return live;
  const state = (await this.describe(physicalId)).CurrentState;
  if (state === undefined || !state.endsWith('_FAILED')) return live;
  const out: Record<string, unknown> = { ...live };
  for (const name of names) delete out[name];
  return out;
}
