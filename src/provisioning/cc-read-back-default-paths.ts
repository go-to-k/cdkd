import { isDeepStrictEqual } from 'node:util';
import type { JsonPatchOp } from './json-patch-generator.js';

/** One measured read-back default: where it sits and the exact value refused. */
export interface CcReadBackDefault {
  /** Property path segments, from the top-level key down. */
  readonly path: readonly string[];
  readonly value: unknown;
}

/**
 * Per type: values the Cloud Control read model fills in although the
 * template never declared them, and which the service's update API then
 * refuses (go-to-k/cdkd#6676).
 *
 * Cloud Control applies an update patch on top of the model its read handler
 * returns, so a patch that never mentions such a path still sends its value,
 * and every update fails although the template did not change it:
 *
 * - `AWS::OpenSearchService::Domain`: a domain created without them reads back
 *   `AdvancedOptions.override_main_response_version: "false"` and `AIMLOptions`
 *   with both features disabled. `UpdateDomainConfig` refuses each on an
 *   OpenSearch 2.x `t3` domain ("Unrecognized advanced option
 *   'override_main_response_version'", then "S3 Vectors Engine features are
 *   only supported with Opensearch Optimized instance types", then "Serverless
 *   Vector Acceleration features are supported from OS 3.1"). The same update
 *   with both removed succeeds, and AWS still reports the same values.
 * - `AWS::Connect::User`: a user created without it reads back (and
 *   `DescribeUser` reports) `VoiceEnhancementConfigs: [{ Channel: "VOICE" }]`,
 *   which lacks the `VoiceEnhancementMode` the schema requires, so Cloud
 *   Control's model validation refuses every update ("#/VoiceEnhancementConfigs/0:
 *   required key [VoiceEnhancementMode] not found", go-to-k/cdkd#6820). The same
 *   update with it removed succeeds, and AWS still reports the same value.
 *
 * A path joins by measurement, never by reading its schema, with the exact
 * value seen refused: a different value is something the user or AWS chose,
 * and it is sent as before. `CC_READ_BACK_EMPTY_KEYS`
 * (`cc-read-back-empty-keys.ts`) is the sibling table for an EMPTY top-level
 * read-back.
 */
export const CC_READ_BACK_DEFAULT_PATHS: Readonly<Record<string, readonly CcReadBackDefault[]>> = {
  'AWS::Connect::User': [{ path: ['VoiceEnhancementConfigs'], value: [{ Channel: 'VOICE' }] }],
  'AWS::OpenSearchService::Domain': [
    { path: ['AdvancedOptions', 'override_main_response_version'], value: 'false' },
    {
      path: ['AIMLOptions'],
      value: {
        S3VectorsEngine: { Enabled: false },
        ServerlessVectorAcceleration: { Enabled: false },
      },
    },
  ],
};

/** Whether `resourceType` has paths in {@link CC_READ_BACK_DEFAULT_PATHS}. */
export function hasCcReadBackDefaultPaths(resourceType: string): boolean {
  return Object.prototype.hasOwnProperty.call(CC_READ_BACK_DEFAULT_PATHS, resourceType);
}

const ABSENT = Symbol('absent');

function valueAt(bag: Record<string, unknown>, path: readonly string[]): unknown {
  let cur: unknown = bag;
  for (const segment of path) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return ABSENT;
    if (!Object.prototype.hasOwnProperty.call(cur, segment)) return ABSENT;
    cur = (cur as Record<string, unknown>)[segment];
  }
  return cur;
}

/**
 * Extend a Cloud Control update patch with `remove` for each listed path of
 * the type when ALL hold:
 *
 * - no op of the patch is on the path, an ancestor or a descendant: the
 *   generator's op already decides what is sent there, and a `remove` under a
 *   replaced or removed ancestor would fail the whole patch (RFC 6902);
 * - `liveModel` (the Cloud Control read model the patch is applied to) holds
 *   exactly the listed value there;
 * - `desired` lacks the path or holds that same value. A deploy's desired bag
 *   is the template, which omits it; `cdkd drift --revert`'s is the AWS
 *   snapshot, which carries the read-back value. Either way the request then
 *   omits it, as a CloudFormation update does, and AWS keeps what it holds.
 *
 * Every other type, an empty patch, or nothing to remove returns the same
 * array.
 */
export function withCcReadBackDefaultRemovals(
  resourceType: string,
  patch: JsonPatchOp[],
  desired: Record<string, unknown>,
  liveModel: Record<string, unknown> | undefined
): JsonPatchOp[] {
  const defaults = hasCcReadBackDefaultPaths(resourceType)
    ? CC_READ_BACK_DEFAULT_PATHS[resourceType]!
    : [];
  if (defaults.length === 0 || patch.length === 0 || liveModel === undefined) return patch;
  const extra: JsonPatchOp[] = [];
  for (const { path, value } of defaults) {
    const pointer = `/${path.map(escapeJsonPointer).join('/')}`;
    const touched = patch.some(
      (op) =>
        op.path === pointer ||
        op.path.startsWith(`${pointer}/`) ||
        pointer.startsWith(`${op.path}/`)
    );
    if (touched) continue;
    if (!isDeepStrictEqual(valueAt(liveModel, path), value)) continue;
    const declared = valueAt(desired, path);
    if (declared !== ABSENT && !isDeepStrictEqual(declared, value)) continue;
    extra.push({ op: 'remove', path: pointer });
  }
  return extra.length === 0 ? patch : [...patch, ...extra];
}

/** RFC 6901, as `json-patch-generator.ts` spells the paths it emits. */
function escapeJsonPointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}
