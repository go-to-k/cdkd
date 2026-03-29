/**
 * CloudFormation Registry Schema Cache
 *
 * Fetches and caches resource type schemas from the CloudFormation Registry
 * using DescribeTypeCommand. Extracts readOnlyProperties to enable automatic
 * attribute discovery for resource types not covered by the static attribute mapper.
 *
 * Phase B of attribute resolution: supplements the static AttributeMapper
 * with dynamic schema-based discovery of read-only (computed) properties.
 */

import {
  CloudFormationClient,
  DescribeTypeCommand,
  RegistryType,
} from '@aws-sdk/client-cloudformation';
import { getAwsClients } from '../utils/aws-clients.js';
import { getLogger } from '../utils/logger.js';

/**
 * Cached schema information for a resource type.
 */
export interface SchemaInfo {
  /** Resource type name (e.g. "AWS::S3::Bucket") */
  resourceType: string;
  /** List of read-only property names extracted from the schema */
  readOnlyProperties: string[];
}

/**
 * In-memory cache of resource type schemas.
 */
const schemaCache = new Map<string, SchemaInfo>();

/**
 * Set of resource types that failed schema lookup (to avoid repeated failures).
 */
const failedTypes = new Set<string>();

const logger = getLogger().child('SchemaCache');

/**
 * Parse readOnlyProperties from a CloudFormation resource type schema.
 *
 * The schema's `readOnlyProperties` field is an array of JSON Pointer strings
 * like `["/properties/Arn", "/properties/TableId"]`.
 * This function extracts just the property names (e.g. `["Arn", "TableId"]`).
 *
 * Only top-level properties (depth 1 under `/properties/`) are returned.
 * Nested paths like `/properties/Foo/Bar` are skipped.
 */
export function parseReadOnlyProperties(schemaJson: string): string[] {
  try {
    const schema = JSON.parse(schemaJson) as {
      readOnlyProperties?: string[];
    };

    if (!Array.isArray(schema.readOnlyProperties)) {
      return [];
    }

    const properties: string[] = [];
    for (const pointer of schema.readOnlyProperties) {
      // Expected format: "/properties/PropertyName"
      const match = /^\/properties\/([^/]+)$/.exec(pointer);
      if (match) {
        properties.push(match[1]!);
      }
    }

    return properties;
  } catch {
    logger.warn(`Failed to parse schema JSON`);
    return [];
  }
}

/**
 * Fetch the resource type schema from CloudFormation Registry.
 *
 * Uses the CloudFormationClient from getAwsClients() and caches results
 * in memory. Failed lookups are also cached to avoid repeated API calls.
 *
 * @param resourceType AWS resource type (e.g. "AWS::S3::Bucket")
 * @returns List of read-only property names, or empty array if unavailable
 */
export async function getReadOnlyProperties(resourceType: string): Promise<string[]> {
  // Return from cache if available
  const cached = schemaCache.get(resourceType);
  if (cached) {
    return cached.readOnlyProperties;
  }

  // Skip types that have previously failed
  if (failedTypes.has(resourceType)) {
    return [];
  }

  try {
    const cfnClient: CloudFormationClient = getAwsClients().cloudFormation;

    const response = await cfnClient.send(
      new DescribeTypeCommand({
        Type: RegistryType.RESOURCE,
        TypeName: resourceType,
      })
    );

    if (!response.Schema) {
      logger.debug(`No schema returned for ${resourceType}`);
      failedTypes.add(resourceType);
      return [];
    }

    const readOnlyProperties = parseReadOnlyProperties(response.Schema);

    const info: SchemaInfo = {
      resourceType,
      readOnlyProperties,
    };
    schemaCache.set(resourceType, info);

    logger.debug(
      `Cached schema for ${resourceType}: ${readOnlyProperties.length} read-only properties`
    );

    return readOnlyProperties;
  } catch (error) {
    const err = error as { name?: string; message?: string };
    logger.debug(
      `Failed to fetch schema for ${resourceType}: ${err.name || 'Unknown'} - ${err.message || 'Unknown error'}`
    );
    failedTypes.add(resourceType);
    return [];
  }
}

/**
 * Clear the schema cache and failed-types set (for testing).
 */
export function clearSchemaCache(): void {
  schemaCache.clear();
  failedTypes.clear();
}
