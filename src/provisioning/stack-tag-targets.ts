/**
 * Where each resource type takes stack tags (go-to-k/cdkd#6871), read from
 * the CloudFormation registry schema's `tagging` block via
 * `cloudformation:DescribeType`: `taggable`, `tagUpdatable` and
 * `tagProperty` (`/properties/Tags` for most types, `UserPoolTags` for a
 * Cognito user pool, `FileSystemTags` for EFS), plus that property's shape —
 * a `[{Key, Value}]` list or a `{key: value}` map.
 *
 * Caching matches the sibling resolvers (`create-only-properties.ts`,
 * `write-only-properties.ts`): only a SUCCESSFUL lookup is cached per type for
 * the process; a failed one is not, so a later lookup retries live. A failed
 * lookup falls back to cdkd's bundled property-shape table when it has a
 * top-level `Tags` row for the type, and otherwise answers `unknown` — the
 * resource is left untagged with one warning. Never throws.
 *
 * Every lookup goes through the shared DescribeType limiter. None runs for a
 * stack without stack tags.
 */

import { describeAwsFailure } from '../utils/aws-failure-text.js';
import { getLogger } from '../utils/logger.js';
import { parseJsonNamingNoBody } from '../utils/json-parse-failure.js';
import { safeMsg } from '../utils/display-safe.js';
import { scheduleDescribeType } from './describe-type.js';
import { hasOwnKey } from '../utils/own-keys.js';
import { PROPERTY_SHAPES } from './property-shape.generated.js';
import {
  applyStackTags,
  nonEmptyStackTags,
  stackTagCandidateTypes,
  type StackTagTarget,
} from './stack-tags.js';
import type { CloudFormationTemplate } from '../types/resource.js';

const targetCache = new Map<string, Promise<StackTagTarget>>();

/** Clear the per-type cache. Test-only helper. */
export function clearStackTagTargetCache(): void {
  targetCache.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Follow one local `$ref` (`#/definitions/<Name>`) of `schema`. */
function deref(schema: Record<string, unknown>, node: unknown): unknown {
  if (!isRecord(node)) return node;
  const ref = node['$ref'];
  if (typeof ref !== 'string') return node;
  const match = /^#\/definitions\/([^/]+)$/.exec(ref);
  const definitions = schema['definitions'];
  if (!match || !isRecord(definitions)) return undefined;
  return hasOwnKey(definitions, match[1]!) ? definitions[match[1]!] : undefined;
}

/**
 * The members a list entry may need beyond `Key` / `Value`, per type: an Auto
 * Scaling group's `PropagateAtLaunch` (`stack-tags.ts` sends `true`).
 */
const EXTRA_REQUIRED_ENTRY_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  'AWS::AutoScaling::AutoScalingGroup': ['PropagateAtLaunch'],
};

/**
 * The answer a registry schema gives. Pure; exported for tests.
 *
 * A schema with no `tagging` block takes the resource-schema defaults
 * (`taggable: true`, `tagProperty: /properties/Tags`), and is untaggable when
 * it declares no such property (`AWS::IAM::Policy`).
 */
export function stackTagTargetFromSchema(resourceType: string, schema: unknown): StackTagTarget {
  if (!isRecord(schema)) return { kind: 'unknown', reason: 'its registry schema is not an object' };
  const tagging = schema['tagging'];
  if (tagging !== undefined && !isRecord(tagging)) {
    return { kind: 'unknown', reason: "its registry schema's tagging block is malformed" };
  }
  if (tagging?.['taggable'] === false) return { kind: 'skip' };
  // CloudFormation applied no stack tag to a `tagUpdatable: false` type
  // (`AWS::EC2::PlacementGroup`), even at create (go-to-k/cdkd#6871).
  if (tagging?.['tagUpdatable'] === false) return { kind: 'skip' };
  const pointer = tagging?.['tagProperty'] ?? '/properties/Tags';
  const match = typeof pointer === 'string' ? /^\/properties\/([^/]+)$/.exec(pointer) : null;
  if (!match) {
    return { kind: 'unknown', reason: 'its tag property is not a top-level property' };
  }
  const property = match[1]!;
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  const definition = hasOwnKey(properties, property)
    ? deref(schema, properties[property])
    : undefined;
  if (definition === undefined) {
    return tagging === undefined
      ? { kind: 'skip' }
      : {
          kind: 'unknown',
          reason: `its registry schema does not define its tag property ${property}`,
        };
  }
  if (!isRecord(definition)) {
    return { kind: 'unknown', reason: `its tag property ${property} has an unreadable schema` };
  }
  if (definition['type'] === 'object') {
    const members = definition['properties'];
    if (isRecord(members) && Object.keys(members).length > 0) {
      return { kind: 'unknown', reason: `its tag property ${property} is not a key-value map` };
    }
    return { kind: 'apply', property, shape: 'object' };
  }
  if (definition['type'] === 'array') {
    const item = deref(schema, definition['items']);
    const members = isRecord(item) && isRecord(item['properties']) ? item['properties'] : {};
    if (!hasOwnKey(members, 'Key') || !hasOwnKey(members, 'Value')) {
      return { kind: 'unknown', reason: `its tag property ${property} is not a Key/Value list` };
    }
    const allowed = new Set([
      'Key',
      'Value',
      ...(EXTRA_REQUIRED_ENTRY_MEMBERS[resourceType] ?? []),
    ]);
    const required = isRecord(item) && Array.isArray(item['required']) ? item['required'] : [];
    if (required.some((member) => typeof member !== 'string' || !allowed.has(member))) {
      return {
        kind: 'unknown',
        reason: `its tag entries require members other than Key and Value`,
      };
    }
    return { kind: 'apply', property, shape: 'array' };
  }
  return { kind: 'unknown', reason: `its tag property ${property} is neither a list nor a map` };
}

/** The bundled property-shape table's answer for a type whose schema could not be read. */
function fallbackTarget(resourceType: string, detail: string): StackTagTarget {
  const row = PROPERTY_SHAPES.get(resourceType);
  if (row !== undefined) {
    try {
      const shape = (JSON.parse(row) as Record<string, unknown>)['Tags'];
      if (shape === 'array' || shape === 'object') {
        return { kind: 'apply', property: 'Tags', shape };
      }
    } catch {
      // A generated row that does not parse: no fallback.
    }
  }
  return {
    kind: 'unknown',
    reason:
      `its registry schema could not be read (cloudformation:DescribeType: ${detail}). ` +
      'Grant cloudformation:DescribeType so cdkd can tell how it takes tags',
  };
}

/**
 * Where `resourceType` takes stack tags. Never throws; only a successful
 * lookup is cached.
 */
export function getStackTagTarget(resourceType: string): Promise<StackTagTarget> {
  const cached = targetCache.get(resourceType);
  if (cached) return cached;
  const entry = scheduleDescribeType(resourceType)
    .promise.then((response) => {
      const schema = response.Schema;
      if (schema === undefined) {
        throw new Error('the DescribeType response carries no Schema');
      }
      const parsed = parseJsonNamingNoBody(schema, 'the DescribeType schema', (line) =>
        getLogger()
          .child('StackTags')
          .debug(safeMsg`${resourceType}: ${line}`)
      );
      return stackTagTargetFromSchema(resourceType, parsed);
    })
    .catch((error: unknown) => {
      if (targetCache.get(resourceType) === entry) targetCache.delete(resourceType);
      return fallbackTarget(resourceType, describeAwsFailure(error).detail);
    });
  targetCache.set(resourceType, entry);
  return entry;
}

/**
 * `template` with `stackTags` merged into each taggable resource
 * (`applyStackTags`), each warning passed to `warn`. With no stack tags it
 * returns `template` itself and makes no call. Never throws.
 */
export async function applyStackTagsToTemplate(
  template: CloudFormationTemplate,
  stackTags: Readonly<Record<string, string>> | undefined,
  warn: (line: string) => void
): Promise<CloudFormationTemplate> {
  const tags = nonEmptyStackTags(stackTags);
  if (tags === undefined) return template;
  const types = stackTagCandidateTypes(template);
  const targets = new Map(
    await Promise.all(types.map(async (type) => [type, await getStackTagTarget(type)] as const))
  );
  const result = applyStackTags(
    template,
    tags,
    (type) => targets.get(type) ?? { kind: 'unknown', reason: 'it was not looked up' }
  );
  for (const line of result.warnings) warn(line);
  return result.template;
}
