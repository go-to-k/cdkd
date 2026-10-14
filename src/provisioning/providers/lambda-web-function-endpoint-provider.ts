import {
  LambdaWebClient,
  CreateWebFunctionEndpointCommand,
  GetWebFunctionEndpointCommand,
  UpdateWebFunctionEndpointCommand,
  DeleteWebFunctionEndpointCommand,
  ResourceNotFoundException,
  type AuthType,
  type EndpointType,
  type CreateWebFunctionEndpointRequest,
  type UpdateWebFunctionEndpointRequest,
  type GetWebFunctionEndpointResponse,
} from '@aws-sdk/client-lambda-web';
import { getLogger } from '../../utils/logger.js';
import { safeMsg } from '../../utils/display-safe.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { isPlainImportValue, VALUE_NOT_SHOWN } from '../import-helpers.js';
import { logicalIdShown } from '../composite-id.js';
import { markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { definedAttributes } from '../attribute-map.js';
import { coerceCfnInteger } from '../config-shape.js';
import type {
  CreateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import {
  parseWebFunctionChildArn,
  recordedFunctionNameSpelling,
  projectOntoRecorded,
  isPlainRecord,
  sleep,
  LAMBDA_WEB_POLL_INTERVAL_MS,
  LAMBDA_WEB_MAX_POLL_ATTEMPTS,
  READ_AFTER_CREATE_GRACE_POLLS,
} from './lambda-web-function-arns.js';

/**
 * AWS Lambda Web Function Endpoint Provider (go-to-k/cdkd#4926)
 *
 * Implements `AWS::Lambda::WebFunctionEndpoint` through the dedicated
 * `lambda-web` service SDK (`@aws-sdk/client-lambda-web`). The endpoint is
 * what a code change UPDATES on every deploy — its `RevisionWeights` move to
 * the new revision — so this provider sits on the per-deploy path: the direct
 * update settles about 1.7 s sooner than Cloud Control (median of three).
 *
 * **Physical id is the endpoint ARN** (`primaryIdentifier` =
 * `/properties/EndpointArn`), the id Cloud Control records too. The API
 * addresses an endpoint by function + endpoint name, both read off the ARN.
 *
 * **Create waits for `Active`; update waits for `UpdateStatus` to leave
 * `InProgress`**, as the Cloud Control handler does: the deploy has not
 * switched traffic until then, and the replaced revision cannot be deleted
 * while the endpoint still routes to it.
 *
 * **Removing an optional block clears it.** `UpdateWebFunctionEndpoint` keeps
 * any field it is not sent, so `update()` sends `Description: ''`,
 * `ScalingConfig: {}` and `ThrottleConfig: {}` for an absent one — measured to
 * clear each (the readback is `''` / `{}`).
 */
export class LambdaWebFunctionEndpointProvider implements ResourceProvider {
  private client: LambdaWebClient;
  private logger = getLogger().child('LambdaWebFunctionEndpointProvider');

  constructor() {
    this.client = getAwsClients().lambdaWeb;
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::Lambda::WebFunctionEndpoint',
      new Set([
        'FunctionName',
        'EndpointName',
        'Description',
        'EndpointType',
        'AuthType',
        'RevisionWeights',
        'Regions',
        'ScalingConfig',
        'ThrottleConfig',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::Lambda::WebFunctionEndpoint',
      new Map([
        ['FunctionArn', 'AWS-managed read-only attribute'],
        ['EndpointArn', 'AWS-managed read-only attribute (primaryIdentifier / physical id)'],
        ['DomainName', 'AWS-managed read-only attribute'],
        ['State', 'AWS-managed read-only attribute'],
        ['StateReason', 'AWS-managed read-only attribute'],
        ['UpdateStatus', 'AWS-managed read-only attribute'],
        ['UpdateStatusReason', 'AWS-managed read-only attribute'],
        ['RegionalEndpoints', 'AWS-managed read-only attribute'],
        ['CreatedAt', 'AWS-managed read-only attribute'],
        ['UpdatedAt', 'AWS-managed read-only attribute'],
      ]),
    ],
  ]);

  getMinResourceTimeoutMs(): number {
    return LAMBDA_WEB_MAX_POLL_ATTEMPTS * LAMBDA_WEB_POLL_INTERVAL_MS;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(safeMsg`Creating Lambda web function endpoint ${logicalId}`);
    const fail = this.refusal(logicalId, resourceType);
    const lenient = context?.replayingState === true;

    const functionName = properties['FunctionName'];
    const endpointName = properties['EndpointName'];
    const endpointType = properties['EndpointType'];
    const authType = properties['AuthType'];
    for (const [key, value] of [
      ['FunctionName', functionName],
      ['EndpointName', endpointName],
      ['EndpointType', endpointType],
      ['AuthType', authType],
    ] as const) {
      if (typeof value !== 'string' || value === '') fail(`${key} must be a non-empty string`);
    }

    const input: CreateWebFunctionEndpointRequest = {
      functionName: functionName as string,
      endpointName: endpointName as string,
      endpointType: endpointType as EndpointType,
      authType: authType as AuthType,
    };
    if (typeof properties['Description'] === 'string')
      input.description = properties['Description'];
    const weights = readRevisionWeights(properties['RevisionWeights'], fail);
    if (weights !== undefined) {
      input.revisionWeights = weights.map((w) => ({ revisionId: w.RevisionId, weight: w.Weight }));
    }
    if (properties['Regions'] !== undefined) {
      const regions = properties['Regions'];
      if (!Array.isArray(regions) || regions.some((r) => typeof r !== 'string')) {
        fail('Regions must be a list of strings');
      }
      input.regions = [...(regions as string[])];
    }
    const scaling = this.readIntegerBlock(
      properties['ScalingConfig'],
      'ScalingConfig',
      'MaxEnvironments',
      fail,
      lenient
    );
    if (scaling !== undefined) {
      input.scalingConfig = scaling.present ? { maxEnvironments: scaling.n } : {};
    }
    const throttle = this.readIntegerBlock(
      properties['ThrottleConfig'],
      'ThrottleConfig',
      'RateLimit',
      fail,
      lenient
    );
    if (throttle !== undefined) {
      input.throttleConfig = throttle.present ? { rateLimit: throttle.n } : {};
    }

    let createdArn: string | undefined;
    try {
      const response = await this.client.send(new CreateWebFunctionEndpointCommand(input));
      createdArn = response.endpointArn;
      if (!createdArn) {
        throw new ProvisioningError(
          `CreateWebFunctionEndpoint succeeded but returned no endpoint ARN for ${logicalIdShown(logicalId)}`,
          resourceType,
          logicalId
        );
      }
      const settled = await this.waitForSettled(
        input.functionName!,
        input.endpointName!,
        logicalId,
        'create'
      );
      return { physicalId: createdArn, attributes: buildAttributes(settled) };
    } catch (error) {
      const thrown = this.wrapError('create', logicalId, resourceType, undefined, error);
      // The endpoint exists once CreateWebFunctionEndpoint returned its ARN;
      // name it for --revert-failed (go-to-k/cdkd#4583).
      if (createdArn) markCreatedBeforeFailure(thrown, logicalId, resourceType, createdArn);
      throw thrown;
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    // go-to-k/cdkd#2613: refuse a wrong-region client before any write.
    assertRegionMatch(
      context?.expectedRegion ? await this.client.config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );
    const parts = parseWebFunctionChildArn(physicalId, 'endpoint');
    if (!parts) {
      throw new ProvisioningError(
        `Cannot update Lambda web function endpoint ${logicalIdShown(logicalId)}: its recorded id is not an endpoint ARN`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    const fail = this.refusal(logicalId, resourceType, physicalId);
    // A state-borne desired bag (rollback replay, drift --revert) warns and
    // omits a malformed optional block instead of stranding the resource.
    const lenient = context?.replayingState === true || context?.desiredFromAwsReadback === true;

    const input: UpdateWebFunctionEndpointRequest = {
      functionName: parts.functionArn,
      endpointName: parts.childId,
      // An absent optional field is SENT cleared: the API keeps whatever it is
      // not sent, so omitting it would leave a removed block live.
      description: typeof properties['Description'] === 'string' ? properties['Description'] : '',
    };
    if (typeof properties['AuthType'] === 'string')
      input.authType = properties['AuthType'] as AuthType;
    // A malformed weights list is refused on every path: it decides where all
    // traffic goes, and no default is safe.
    const weights = readRevisionWeights(properties['RevisionWeights'], fail);
    if (weights !== undefined) {
      input.revisionWeights = weights.map((w) => ({ revisionId: w.RevisionId, weight: w.Weight }));
    } else if (!lenient) {
      // Measured: AWS refuses an endpoint without weights ("The revisionWeights
      // must be specified when the autoDeploymentMode is Disabled", and
      // CloudFormation exposes no AutoDeploymentMode). The API keeps weights it
      // is not sent, so a template that drops them would deploy "successfully"
      // with traffic still on the old revisions.
      fail(
        'RevisionWeights is required; AWS keeps routing to the current revisions when it is removed'
      );
    }
    // Absent is sent cleared (`{}`); a malformed block skipped under `lenient`
    // is not sent, which leaves the live one as it is.
    const scaling = this.readIntegerBlock(
      properties['ScalingConfig'],
      'ScalingConfig',
      'MaxEnvironments',
      fail,
      lenient
    );
    if (properties['ScalingConfig'] === undefined) input.scalingConfig = {};
    else if (scaling !== undefined) {
      input.scalingConfig = scaling.present ? { maxEnvironments: scaling.n } : {};
    }
    const throttle = this.readIntegerBlock(
      properties['ThrottleConfig'],
      'ThrottleConfig',
      'RateLimit',
      fail,
      lenient
    );
    if (properties['ThrottleConfig'] === undefined) input.throttleConfig = {};
    else if (throttle !== undefined) {
      input.throttleConfig = throttle.present ? { rateLimit: throttle.n } : {};
    }

    try {
      await this.client.send(new UpdateWebFunctionEndpointCommand(input));
      const settled = await this.waitForSettled(
        parts.functionArn,
        parts.childId,
        logicalId,
        'update',
        input.revisionWeights
      );
      return { physicalId, wasReplaced: false, attributes: buildAttributes(settled) };
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
    this.logger.debug(safeMsg`Deleting Lambda web function endpoint ${logicalId}`);
    const parts = parseWebFunctionChildArn(physicalId, 'endpoint');
    if (!parts) {
      throw new ProvisioningError(
        `Cannot delete Lambda web function endpoint ${logicalIdShown(logicalId)}: its recorded id is not an endpoint ARN`,
        resourceType,
        logicalId,
        physicalId
      );
    }
    try {
      try {
        await this.client.send(
          new DeleteWebFunctionEndpointCommand({
            functionName: parts.functionArn,
            endpointName: parts.childId,
          })
        );
      } catch (error) {
        if (error instanceof ResourceNotFoundException) {
          assertRegionMatch(
            await this.client.config.region(),
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(
            safeMsg`Lambda web function endpoint ${logicalId} does not exist, skipping deletion`
          );
          return;
        }
        throw error;
      }
      await this.waitForGone(parts.functionArn, parts.childId, logicalId);
    } catch (error) {
      throw this.wrapError('delete', logicalId, resourceType, physicalId, error);
    }
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'EndpointArn') return physicalId;
    const parts = parseWebFunctionChildArn(physicalId, 'endpoint');
    if (!parts) return undefined;
    if (attributeName === 'FunctionArn') return parts.functionArn;
    const resp = await this.client.send(
      new GetWebFunctionEndpointCommand({
        functionName: parts.functionArn,
        endpointName: parts.childId,
      })
    );
    return buildAttributes(resp)[attributeName];
  }

  /**
   * Adopt an existing endpoint: the `--resource` ARN when given, else the
   * template's `FunctionName` + `EndpointName`, which name exactly one
   * endpoint (an endpoint is not taggable, so there is no cdk-path lookup).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    let functionName: string | undefined;
    let endpointName: string | undefined;
    if (input.knownPhysicalId) {
      const parts = parseWebFunctionChildArn(input.knownPhysicalId, 'endpoint');
      if (!parts) {
        throw new Error(
          `--resource override for ${logicalIdShown(input.logicalId)} must be a Lambda web function endpoint ARN ` +
            `(got ${isPlainImportValue(input.knownPhysicalId) ? `'${input.knownPhysicalId}'` : VALUE_NOT_SHOWN}); use the arn:...:web-function/<name>/endpoint/<endpoint> ARN.`
        );
      }
      functionName = parts.functionArn;
      endpointName = parts.childId;
    } else {
      const props = input.properties ?? {};
      if (typeof props['FunctionName'] !== 'string' || typeof props['EndpointName'] !== 'string')
        return null;
      functionName = props['FunctionName'];
      endpointName = props['EndpointName'];
    }
    try {
      const resp = await this.client.send(
        new GetWebFunctionEndpointCommand({ functionName, endpointName })
      );
      if (!resp.endpointArn) return null;
      return { physicalId: resp.endpointArn, attributes: buildAttributes(resp) };
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return null;
      throw error;
    }
  }

  /** Read the live endpoint for `cdkd drift`, laid onto the recorded bag's shape. */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    const parts = parseWebFunctionChildArn(physicalId, 'endpoint');
    if (!parts) return undefined;
    let resp: GetWebFunctionEndpointResponse;
    try {
      resp = await this.client.send(
        new GetWebFunctionEndpointCommand({
          functionName: parts.functionArn,
          endpointName: parts.childId,
        })
      );
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
      throw error;
    }
    const live: Record<string, unknown> = {
      FunctionName: recordedFunctionNameSpelling(
        properties?.['FunctionName'],
        resp.functionArn ?? parts.functionArn
      ),
      EndpointName: resp.endpointName ?? parts.childId,
    };
    if (resp.description !== undefined) live['Description'] = resp.description;
    if (resp.endpointType !== undefined) live['EndpointType'] = resp.endpointType;
    if (resp.authType !== undefined) live['AuthType'] = resp.authType;
    if (resp.revisionWeights !== undefined) {
      live['RevisionWeights'] = resp.revisionWeights.map((w) => ({
        RevisionId: w.revisionId,
        Weight: w.weight,
      }));
    }
    if (resp.regions !== undefined) live['Regions'] = [...resp.regions];
    if (resp.scalingConfig !== undefined) {
      live['ScalingConfig'] =
        resp.scalingConfig.maxEnvironments !== undefined
          ? { MaxEnvironments: resp.scalingConfig.maxEnvironments }
          : {};
    }
    if (resp.throttleConfig !== undefined) {
      live['ThrottleConfig'] =
        resp.throttleConfig.rateLimit !== undefined
          ? { RateLimit: resp.throttleConfig.rateLimit }
          : {};
    }
    if (!properties) return live;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(live)) {
      out[key] =
        key === 'ScalingConfig' || key === 'ThrottleConfig'
          ? value
          : projectOntoRecorded(properties[key], value);
    }
    return out;
  }

  // -- helpers -------------------------------------------------------------

  private refusal(
    logicalId: string,
    resourceType: string,
    physicalId?: string
  ): (message: string) => never {
    return (message: string): never => {
      throw new ProvisioningError(
        `${message} for Lambda web function endpoint ${logicalIdShown(logicalId)}`,
        resourceType,
        logicalId,
        physicalId
      );
    };
  }

  /**
   * An optional integer block. Absent is `undefined`; malformed is refused on a
   * template path and omitted with a warning when `lenient` (a state-borne
   * bag), so the update leaves the live block as it is.
   */
  private readIntegerBlock(
    value: unknown,
    blockKey: 'ScalingConfig' | 'ThrottleConfig',
    memberKey: 'MaxEnvironments' | 'RateLimit',
    fail: (message: string) => never,
    lenient: boolean
  ): { present: boolean; n?: number } | undefined {
    if (value === undefined) return undefined;
    const bad = (message: string): undefined => {
      if (lenient) {
        this.logger.warn(safeMsg`${message}; leaving the live ${blockKey} unchanged`);
        return undefined;
      }
      return fail(message);
    };
    if (!isPlainRecord(value)) return bad(`${blockKey} must be an object`);
    if (value[memberKey] === undefined) return { present: false };
    const n = coerceCfnInteger(value[memberKey]);
    if (n === undefined) return bad(`${blockKey}.${memberKey} must be an integer`);
    return { present: true, n };
  }

  /**
   * Poll until the endpoint is `Active` with no update in progress. After an
   * update that moved the weights, also until the endpoint REPORTS those
   * weights, so a read taken before `UpdateStatus` turned `InProgress` cannot
   * end the wait early. A not-found on the first polls after a create is a
   * read-after-create gap, not a deleted endpoint.
   */
  private async waitForSettled(
    functionName: string,
    endpointName: string,
    logicalId: string,
    operation: 'create' | 'update',
    sentWeights?: ReadonlyArray<{ revisionId?: string | undefined; weight?: number | undefined }>
  ): Promise<GetWebFunctionEndpointResponse> {
    for (let attempt = 1; attempt <= LAMBDA_WEB_MAX_POLL_ATTEMPTS; attempt++) {
      let resp: GetWebFunctionEndpointResponse;
      try {
        resp = await this.client.send(
          new GetWebFunctionEndpointCommand({ functionName, endpointName })
        );
      } catch (error) {
        if (
          operation === 'create' &&
          attempt <= READ_AFTER_CREATE_GRACE_POLLS &&
          error instanceof ResourceNotFoundException
        ) {
          await sleep(LAMBDA_WEB_POLL_INTERVAL_MS);
          continue;
        }
        throw error;
      }
      if (resp.state === 'Failed') {
        throw new Error(
          `Lambda web function endpoint ${logicalIdShown(logicalId)} entered Failed: ${resp.stateReason ?? 'no reason given'}`
        );
      }
      if (resp.updateStatus === 'Failed') {
        throw new Error(
          `Lambda web function endpoint ${logicalIdShown(logicalId)} ${operation} failed: ${resp.updateStatusReason ?? 'no reason given'}`
        );
      }
      if (
        resp.state === 'Active' &&
        resp.updateStatus !== 'InProgress' &&
        (sentWeights === undefined || sameWeights(sentWeights, resp.revisionWeights))
      ) {
        return resp;
      }
      await sleep(LAMBDA_WEB_POLL_INTERVAL_MS);
    }
    throw new Error(
      `Lambda web function endpoint ${logicalIdShown(logicalId)} did not finish ${operation} within ` +
        `${(LAMBDA_WEB_MAX_POLL_ATTEMPTS * LAMBDA_WEB_POLL_INTERVAL_MS) / 1000}s.`
    );
  }

  private async waitForGone(
    functionName: string,
    endpointName: string,
    logicalId: string
  ): Promise<void> {
    for (let attempt = 1; attempt <= LAMBDA_WEB_MAX_POLL_ATTEMPTS; attempt++) {
      try {
        await this.client.send(new GetWebFunctionEndpointCommand({ functionName, endpointName }));
      } catch (error) {
        if (error instanceof ResourceNotFoundException) return;
        throw error;
      }
      await sleep(LAMBDA_WEB_POLL_INTERVAL_MS);
    }
    throw new Error(
      `Lambda web function endpoint ${logicalIdShown(logicalId)} was not fully deleted within ` +
        `${(LAMBDA_WEB_MAX_POLL_ATTEMPTS * LAMBDA_WEB_POLL_INTERVAL_MS) / 1000}s.`
    );
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
      `Failed to ${operation} Lambda web function endpoint ${logicalIdShown(logicalId)}: ${error instanceof Error ? error.message : String(error)}`,
      resourceType,
      logicalId,
      physicalId,
      cause
    );
  }
}

/**
 * `RevisionWeights`, validated. Absent is `undefined`; anything else
 * must be a list of `{ RevisionId: string, Weight: integer }`, refused
 * otherwise on every path.
 */
function readRevisionWeights(
  value: unknown,
  fail: (message: string) => never
): Array<{ RevisionId: string; Weight: number }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return fail('RevisionWeights must be a list');
  return value.map((entry, i) => {
    if (!isPlainRecord(entry) || typeof entry['RevisionId'] !== 'string') {
      return fail(`RevisionWeights[${i}].RevisionId must be a string`);
    }
    const weight = coerceCfnInteger(entry['Weight']);
    if (weight === undefined) return fail(`RevisionWeights[${i}].Weight must be an integer`);
    return { RevisionId: entry['RevisionId'], Weight: weight };
  });
}

/** Order-insensitive equality of two weight lists. */
function sameWeights(
  a: ReadonlyArray<{ revisionId?: string | undefined; weight?: number | undefined }>,
  b: ReadonlyArray<{ revisionId?: string | undefined; weight?: number | undefined }> | undefined
): boolean {
  if (b === undefined || a.length !== b.length) return false;
  const key = (w: { revisionId?: string | undefined; weight?: number | undefined }): string =>
    `${w.revisionId ?? ''}=${w.weight ?? ''}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((k, i) => k === right[i]);
}

function buildAttributes(resp: {
  endpointArn?: string | undefined;
  functionArn?: string | undefined;
  domainName?: string | undefined;
  state?: string | undefined;
  stateReason?: string | undefined;
  updateStatus?: string | undefined;
  updateStatusReason?: string | undefined;
  createdAt?: Date | undefined;
  updatedAt?: Date | undefined;
}): Record<string, unknown> {
  return definedAttributes({
    EndpointArn: resp.endpointArn,
    FunctionArn: resp.functionArn,
    DomainName: resp.domainName,
    State: resp.state,
    StateReason: resp.stateReason,
    UpdateStatus: resp.updateStatus,
    UpdateStatusReason: resp.updateStatusReason,
    CreatedAt: resp.createdAt?.toISOString(),
    UpdatedAt: resp.updatedAt?.toISOString(),
  });
}
