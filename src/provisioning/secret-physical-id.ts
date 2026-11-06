/**
 * Physical ids that ARE a bearer credential (go-to-k/cdkd#5868).
 *
 * One per-type declaration: a type qualifies only when the id string itself
 * authenticates a caller. `AWS::AppSync::ApiKey` is the only one today: its
 * id is `<apiId>|<apiKeyId>` (or, on a record imported before #5540, the key's
 * ARN), and the key is the `x-api-key` value. An IAM access key's id
 * (`AKIA...`) is the PUBLIC half of its pair, and a Secrets Manager secret's
 * id is its ARN, so neither qualifies.
 *
 * Two consumers: the derived-name judge adds the segment as a LOG-ONLY needle
 * (`secretNameNeedlesOf`), which masks every channel printing under a bound
 * bag, and the display helpers render it for a channel outside any bag (an
 * engine line naming an id no bag holds yet, `cdkd state`'s stdout). Never
 * what is persisted or exported: the id is the record's identity.
 */

/**
 * The resource path of an ApiKey ARN, `apis/<apiId>/apikeys/<apiKeyId>`.
 * CloudFormation writes `apikeys/`; the ARN AppSync documents says `apikey/`.
 * The AppSync provider's `CFN_APPSYNC_ARN_RESOURCE_PATHS` reads this one.
 */
export const APPSYNC_APIKEY_ARN_RESOURCE_PATH = /^apis\/([^/|]+)\/apikeys?\/([^/|]+)$/;

/** An AppSync ARN, its resource path in group 2. */
const APPSYNC_ARN = /^arn:[^:]+:appsync:[^:]*:[^:]*:(.+)$/;

/** Shortest segment matched INSIDE a longer value; a shorter one only whole. */
const SUBSTRING_FLOOR = 4;

/**
 * The display form of a secret segment: its last four characters. AppSync's
 * `maskedApiKeyId` is this function, so a key reads identically in the
 * provider's lines and the engine's.
 */
export function maskedSecretSegment(segment: string): string {
  return `****${segment.slice(-4)}`;
}

/**
 * The segment of `physicalId` that is a bearer credential, or `undefined` when
 * the type declares none. An ApiKey id in neither the `<apiId>|<apiKeyId>` nor
 * the ARN form is secret WHOLE: which part of a malformed id is the key cannot
 * be told, so it errs toward over-masking.
 */
export function secretPhysicalIdSegment(
  resourceType: unknown,
  physicalId: unknown
): string | undefined {
  if (resourceType !== 'AWS::AppSync::ApiKey') return undefined;
  if (typeof physicalId !== 'string' || physicalId === '') return undefined;
  const parts = physicalId.split('|');
  if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') return parts[1];
  const arn = APPSYNC_ARN.exec(physicalId);
  const path = arn ? APPSYNC_APIKEY_ARN_RESOURCE_PATH.exec(arn[1]!) : null;
  if (path) return path[2];
  return physicalId;
}

/** `text` with every occurrence of each of `segments` masked (longest first). */
function maskSegmentsInText(text: string, segments: readonly string[]): string {
  let out = text;
  for (const segment of segments) {
    if (out === segment) return maskedSecretSegment(segment);
    if (segment.length >= SUBSTRING_FLOOR && out.includes(segment)) {
      out = out.split(segment).join(maskedSecretSegment(segment));
    }
  }
  return out;
}

/**
 * `physicalId` with its secret segment rendered by {@link maskedSecretSegment};
 * any other id (and a non-string) is returned unchanged.
 */
export function displayPhysicalId<T>(resourceType: unknown, physicalId: T): T | string {
  const segment = secretPhysicalIdSegment(resourceType, physicalId);
  if (segment === undefined || typeof physicalId !== 'string') return physicalId;
  return maskSegmentsInText(physicalId, [segment]);
}

/**
 * A DISPLAY copy of `value` with every string VALUE holding one of `segments`
 * masked. Object keys are left as they are: a key is a name the record chose
 * (an attribute, a logical id), never the credential. The input is not touched;
 * no segments returns it as is.
 */
export function maskSecretSegmentsDeep<T>(value: T, segments: readonly string[]): T {
  if (segments.length === 0) return value;
  const ordered = [...new Set(segments)].sort((a, b) => b.length - a.length);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return maskSegmentsInText(v, ordered);
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v)) out[k] = walk(child);
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** The secret segment of one record-shaped value, if any. */
function segmentOfRecord(record: unknown): string | undefined {
  if (record === null || typeof record !== 'object') return undefined;
  const r = record as { resourceType?: unknown; physicalId?: unknown };
  return secretPhysicalIdSegment(r.resourceType, r.physicalId);
}

/** {@link maskSecretSegmentsDeep} of one record by its own segment. */
export function withSecretPhysicalIdMasked<T>(record: T): T {
  const segment = segmentOfRecord(record);
  return segment === undefined ? record : maskSecretSegmentsDeep(record, [segment]);
}

/** Every string leaf of `value`, walked depth-first. */
function stringLeavesOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeavesOf(v, out);
  else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value)) stringLeavesOf(v, out);
  }
  return out;
}

/**
 * The string leaves of a nested-stack row's `attributes` its record names in
 * `secretNamedAttributes`: an `Outputs.<Key>` that carried a child's secret
 * (a child ApiKey's key judged by `secretNameNeedlesOf`), which only the
 * CHILD's record otherwise says is one. A local copy of
 * `secret-name-needles.ts`'s reader: importing it would close an import cycle.
 */
function secretNamedAttributeLeavesOf(record: unknown): string[] {
  if (record === null || typeof record !== 'object') return [];
  const r = record as {
    resourceType?: unknown;
    attributes?: unknown;
    secretNamedAttributes?: unknown;
  };
  if (r.resourceType !== 'AWS::CloudFormation::Stack') return [];
  const names = r.secretNamedAttributes;
  const attributes = r.attributes;
  if (!Array.isArray(names) || attributes === null || typeof attributes !== 'object') return [];
  const leaves: string[] = [];
  for (const name of names) {
    if (typeof name !== 'string' || !Object.hasOwn(attributes, name)) continue;
    for (const leaf of stringLeavesOf((attributes as Record<string, unknown>)[name])) {
      // The mask is no secret, and a reference is masked by its own arm.
      if (leaf !== '' && leaf !== '***' && !leaf.includes('{{resolve:')) leaves.push(leaf);
    }
  }
  return leaves;
}

/**
 * Every secret segment a stack state's records hold: its resources, its
 * rollback orphans (`orphans[].state`) and its superseded copies
 * (`supersededResources[].state`). Malformed containers read as empty.
 */
export function secretSegmentsOfState(state: unknown): string[] {
  if (state === null || typeof state !== 'object') return [];
  const s = state as { resources?: unknown; orphans?: unknown; supersededResources?: unknown };
  const segments: string[] = [];
  const add = (record: unknown): void => {
    const segment = segmentOfRecord(record);
    if (segment !== undefined) segments.push(segment);
  };
  if (s.resources !== null && typeof s.resources === 'object' && !Array.isArray(s.resources)) {
    for (const record of Object.values(s.resources)) {
      add(record);
      segments.push(...secretNamedAttributeLeavesOf(record));
    }
  }
  for (const list of [s.orphans, s.supersededResources]) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (entry === null || typeof entry !== 'object') continue;
      const record = (entry as { state?: unknown }).state;
      add(record);
      segments.push(...secretNamedAttributeLeavesOf(record));
    }
  }
  return segments;
}

/**
 * A DISPLAY copy of a whole stack state with every string value holding a key
 * masked: the records' ids and attributes, and every other place the key was
 * copied to (another resource's property, a stack output, an orphan or a
 * superseded copy). `segments` defaults to the state's own
 * ({@link secretSegmentsOfState}); a nested tree passes the union of its
 * nodes', since a parent passes values to a child.
 */
export function withSecretPhysicalIdsMaskedInState<T>(
  state: T,
  segments: readonly string[] = secretSegmentsOfState(state)
): T {
  return maskSecretSegmentsDeep(state, segments);
}
