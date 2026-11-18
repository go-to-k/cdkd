import {
  CloudControlClient,
  GetResourceCommand,
  ListResourcesCommand,
  type ResourceDescription,
} from '@aws-sdk/client-cloudcontrol';
import type { ContextProvider, ContextProviderAwsConfig } from './index.js';
import { getLogger } from '../../utils/logger.js';
import { displayIdent, safeMsg } from '../../utils/display-safe.js';
import {
  describeJsonParseFailure,
  parseFailureDebugDetail,
  utf8ByteLength,
} from '../../utils/json-parse-failure.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';

/**
 * Parse a Cloud Control resource model WITHOUT echoing it on failure (issue
 * [#5254](https://github.com/go-to-k/cdkd/issues/5254)). V8's `SyntaxError`
 * quotes a window of the model, which can hold a plaintext property value,
 * and the raw error used to reach the context provider's `error` line and the
 * error value handed back to the CDK app. The rethrow names only the type and
 * the failure's offset and size, with no cause; V8's text goes to `debug`.
 */
function parseResourceModel(body: string, typeName: string): ResourceModel {
  try {
    return JSON.parse(body) as ResourceModel;
  } catch (err) {
    getLogger().debug(
      safeMsg`Cloud Control resource model for ${displayIdent(typeName)} failed to parse: ${parseFailureDebugDetail(err)}`
    );
    throw new Error(
      `Cloud Control returned a resource model for ${displayIdent(typeName)} that is not ` +
        `valid JSON: ${describeJsonParseFailure(err, utf8ByteLength(body))}`
    );
  }
}

const CC_API_CONTEXT_KEY_PREFIX = 'cc-api-provider:';

/**
 * Drop `cdk.context.json` entries an older cdkd wrote for a `cc-api-provider`
 * lookup as a bare object (issue
 * [#6542](https://github.com/go-to-k/cdkd/issues/6542)). The CDK CLI only ever
 * stores an array there (a result or an array `dummyValue`), so a non-array
 * value is that old shape; dropping it makes the app report the key missing,
 * and the fresh lookup overwrites the entry. Never mutates `context`.
 */
export function withoutStaleCcApiContext(
  context: Record<string, unknown>
): Record<string, unknown> {
  const stale = Object.keys(context).filter(
    (key) => key.startsWith(CC_API_CONTEXT_KEY_PREFIX) && !Array.isArray(context[key])
  );
  if (stale.length === 0) return context;
  getLogger()
    .child('CcApiContextProvider')
    .debug(`Re-resolving ${stale.length} cc-api-provider context value(s) stored as an object`);
  const kept: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(context)) {
    if (!stale.includes(key)) kept[key] = value;
  }
  return kept;
}

/**
 * No resource matched the query. Only this miss returns `dummyValue` under
 * `ignoreErrorOnMissingContext`; every other failure is raised.
 */
class NoResultsFoundError extends Error {}

/**
 * Cloud Control API context provider
 *
 * Generic provider that uses Cloud Control API to lookup any resource type.
 * CDK provider type: "cc-api-provider"
 *
 * Used by CDK for lookups like IAM Roles, ECR repositories, RDS instances, etc.
 *
 * Mirrors the AWS CDK CLI's provider (toolkit-lib `cc-api-provider.ts`, issue
 * [#6542](https://github.com/go-to-k/cdkd/issues/6542)): the value is ALWAYS an
 * array with one object per match, each carrying the requested properties plus
 * `Identifier`, because aws-cdk-lib's `fromLookup` methods read `response[0]` /
 * `response.length`. An unset `expectedMatchCount` validates nothing.
 */
export class CcApiContextProvider implements ContextProvider {
  private logger = getLogger().child('CcApiContextProvider');
  private awsConfig: ContextProviderAwsConfig | undefined;

  constructor(awsConfig?: ContextProviderAwsConfig) {
    this.awsConfig = awsConfig;
  }

  async resolve(props: Record<string, unknown>): Promise<unknown> {
    const region = (props['region'] as string) || this.awsConfig?.region;
    const typeName = props['typeName'] as string;
    const exactIdentifier = props['exactIdentifier'] as string | undefined;
    const propertiesToReturn = (props['propertiesToReturn'] as string[]) || [];
    const propertyMatch = props['propertyMatch'] as Record<string, unknown> | undefined;
    const expectedMatchCount = props['expectedMatchCount'] as string | undefined;
    const resourceModel = props['resourceModel'] as Record<string, unknown> | undefined;
    const dummyValue = props['dummyValue'];
    const ignoreErrorOnMissingContext = props['ignoreErrorOnMissingContext'] as boolean | undefined;

    if (!typeName) {
      throw new Error('CC API context provider requires typeName property');
    }
    if (exactIdentifier && propertyMatch) {
      throw new Error(
        'CC API context provider: specify either exactIdentifier or propertyMatch, but not both'
      );
    }
    if (!exactIdentifier && !propertyMatch) {
      throw new Error(
        'CC API context provider: neither exactIdentifier nor propertyMatch is specified'
      );
    }
    if (ignoreErrorOnMissingContext && dummyValue === undefined) {
      throw new Error(
        'CC API context provider: if ignoreErrorOnMissingContext is set, a dummyValue must be supplied'
      );
    }
    if (
      dummyValue !== undefined &&
      (!Array.isArray(dummyValue) || !dummyValue.every((v) => isPlainObject(v)))
    ) {
      throw new Error('CC API context provider: dummyValue must be an array of objects');
    }

    this.logger.debug(
      `CC API lookup: ${typeName}${exactIdentifier ? ` (id: ${exactIdentifier})` : ''} (region: ${region})`
    );

    const client = new CloudControlClient({
      ...ambientClientDefaults(),
      ...(region && { region }),
    });

    try {
      const resources = exactIdentifier
        ? await this.getResource(client, typeName, exactIdentifier)
        : await this.listResources(
            client,
            typeName,
            propertyMatch!,
            expectedMatchCount,
            resourceModel
          );

      return resources.map((r) =>
        this.extractProperties(r.properties, r.identifier, propertiesToReturn)
      );
    } catch (error) {
      if (error instanceof NoResultsFoundError && ignoreErrorOnMissingContext) {
        this.logger.debug(`No resources found, returning dummy value`);
        return dummyValue;
      }
      throw error;
    } finally {
      client.destroy();
    }
  }

  /**
   * Get a single resource by identifier. Returns exactly one resource or throws.
   */
  private async getResource(
    client: CloudControlClient,
    typeName: string,
    identifier: string
  ): Promise<FoundResource[]> {
    let response;
    try {
      response = await client.send(
        new GetResourceCommand({
          TypeName: typeName,
          Identifier: identifier,
        })
      );
    } catch (error) {
      const err = error as { name?: string };
      if (err.name === 'ResourceNotFoundException') {
        throw new NoResultsFoundError(
          `No ${typeName} resource found with identifier ${identifier}`
        );
      }
      throw error;
    }

    if (!response.ResourceDescription) {
      throw new Error(
        `Cloud Control returned an empty response for ${typeName} resource ${identifier}`
      );
    }

    return [this.foundResource(response.ResourceDescription, identifier, typeName)];
  }

  /**
   * List resources of a type matching `propertyMatch`, enforcing
   * `expectedMatchCount` (unset: any number, zero included).
   */
  private async listResources(
    client: CloudControlClient,
    typeName: string,
    propertyMatch: Record<string, unknown>,
    expectedMatchCount: string | undefined,
    resourceModel: Record<string, unknown> | undefined
  ): Promise<FoundResource[]> {
    const found: FoundResource[] = [];
    let nextToken: string | undefined;

    do {
      const response = await client.send(
        new ListResourcesCommand({
          TypeName: typeName,
          ...(resourceModel && { ResourceModel: JSON.stringify(resourceModel) }),
          MaxResults: 100,
          ...(nextToken && { NextToken: nextToken }),
        })
      );

      for (const desc of response.ResourceDescriptions ?? []) {
        const resource = this.foundResource(desc, '*MISSING*', typeName);
        if (this.matchesProperties(resource.properties, propertyMatch)) {
          found.push(resource);
        }
      }

      nextToken = response.NextToken;

      // Fail before consuming the remaining pages.
      if (
        (expectedMatchCount === 'at-most-one' || expectedMatchCount === 'exactly-one') &&
        found.length > 1
      ) {
        throw new Error(
          `Expected ${expectedMatchCountText(expectedMatchCount)} ${typeName}, found ` +
            `${nextToken ? 'at least ' : ''}${found.length}`
        );
      }
    } while (nextToken);

    if (
      (expectedMatchCount === 'at-least-one' || expectedMatchCount === 'exactly-one') &&
      found.length === 0
    ) {
      throw new NoResultsFoundError(
        `Expected ${expectedMatchCountText(expectedMatchCount)} ${typeName}, found none`
      );
    }

    return found;
  }

  private foundResource(
    desc: ResourceDescription,
    fallbackIdentifier: string,
    typeName: string
  ): FoundResource {
    return {
      identifier: desc.Identifier ?? fallbackIdentifier,
      properties: parseResourceModel(desc.Properties ?? '{}', typeName),
    };
  }

  /**
   * Check if resource matches property filter. Strict equality, as the CDK
   * CLI's `propertyMatchesFilter`, so an object or array filter value never
   * matches; a resource lacking the path is a non-match where the CDK CLI
   * throws.
   */
  private matchesProperties(
    resource: ResourceModel,
    propertyMatch: Record<string, unknown>
  ): boolean {
    for (const [key, expectedValue] of Object.entries(propertyMatch)) {
      if (this.getNestedProperty(resource, key) !== expectedValue) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get nested property value using dot notation, stepping into primitives
   * too (`Name.length`), as the CDK CLI's `findJsonValue` does. A missing
   * path is `undefined` where the CDK CLI throws.
   */
  private getNestedProperty(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;
    for (const part of parts) {
      if (current === null || current === undefined) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }
    return current;
  }

  /**
   * The requested properties plus `Identifier`, as the CDK CLI's `getResultObj`
   * builds it.
   */
  private extractProperties(
    resource: ResourceModel,
    identifier: string,
    propertiesToReturn: string[]
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const prop of propertiesToReturn) {
      result[prop] = this.getNestedProperty(resource, prop);
    }
    result['Identifier'] = identifier;
    return result;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expectedMatchCountText(expectedMatchCount: string): string {
  switch (expectedMatchCount) {
    case 'at-least-one':
      return 'at least one';
    case 'at-most-one':
      return 'at most one';
    case 'exactly-one':
      return 'exactly one';
    default:
      return expectedMatchCount;
  }
}

type ResourceModel = Record<string, unknown>;

interface FoundResource {
  readonly identifier: string;
  readonly properties: ResourceModel;
}
