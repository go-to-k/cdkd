import { SECRET_MASK } from './pairs.js';
import { isPlainObject, isSingleDynamicReferenceToken } from './rules.js';
import { identityKeyFor } from './identity-keys.js';
import { DYNAMIC_REFERENCE_TOKEN_SCAN } from './redact-path.js';

/**
 * The POSITIONAL arm of `NoEcho` redaction (go-to-k/cdkd#4043, Phase B): which
 * leaves of a resolved bag a `NoEcho: true` template PARAMETER, or an attribute
 * declared `NoEcho` (go-to-k/cdkd#2449), served, read off the TEMPLATE bag that
 * produced it.
 *
 * The value arm (a mask-only needle keyed by plaintext) cannot answer this for
 * three shapes, which is why this arm exists: a value under
 * `MIN_NEEDLE_LENGTH`, a `Number` / `List<Number>` / boolean leaf (the needle map
 * is string-keyed), and a value no needle can spell once it is embedded
 * through a non-literal route. Position needs no value at all, so the same
 * answer serves a template-only save (an untouched record of a migration
 * deploy) and the diff.
 *
 * A coordinate is a SEGMENT ARRAY, never a dotted string: a dotted key is legal
 * in a property bag.
 */
export type NoEchoCoordinate = readonly (string | number)[];

/** What counts as a `NoEcho` source when reading a template bag. */
export interface NoEchoPositionSources {
  /** The `NoEcho: true` parameters of the template the bag came from. */
  readonly parameters: ReadonlySet<string>;
  /**
   * Whether `Fn::GetAtt` of `attribute` on `logicalId` serves a value its
   * producer declared `NoEcho` (a custom resource's whole-bag declaration, a
   * nested stack's named outputs, or an attribute echoing a parameter value).
   */
  readonly attributeIsNoEcho?: (logicalId: string, attribute: string) => boolean;
  /**
   * The condition verdicts the resolution used. An `Fn::If` whose condition is
   * named here positions ONLY the branch it selected; one whose verdict is
   * unknown (the diff of a condition it cannot evaluate) is read as a whole.
   */
  readonly conditions?: Readonly<Record<string, boolean>>;
}

const SUB_VARIABLE = /\$\{([^}!][^}]*)\}/g;

function intrinsicKeyOf(node: Record<string, unknown>): string | undefined {
  const keys = Object.keys(node);
  if (keys.length !== 1) return undefined;
  const key = keys[0]!;
  return key === 'Ref' || key.startsWith('Fn::') ? key : undefined;
}

function conditionVerdict(sources: NoEchoPositionSources, name: unknown): boolean | undefined {
  if (typeof name !== 'string' || sources.conditions === undefined) return undefined;
  return Object.hasOwn(sources.conditions, name) ? sources.conditions[name] : undefined;
}

function getAttReadsNoEcho(argument: unknown, sources: NoEchoPositionSources): boolean {
  if (sources.attributeIsNoEcho === undefined) return false;
  let target: unknown;
  let attribute: unknown;
  if (typeof argument === 'string') {
    const dot = argument.indexOf('.');
    if (dot <= 0) return false;
    target = argument.slice(0, dot);
    attribute = argument.slice(dot + 1);
  } else if (Array.isArray(argument) && argument.length === 2) {
    [target, attribute] = argument as [unknown, unknown];
  } else {
    return false;
  }
  if (typeof target !== 'string') return false;
  // A computed attribute name: read whatever it might be, conservatively.
  if (typeof attribute !== 'string') return readsNoEchoSource(attribute, sources);
  return sources.attributeIsNoEcho(target, attribute);
}

function subStringReadsNoEcho(
  text: string,
  variables: Record<string, unknown> | undefined,
  sources: NoEchoPositionSources
): boolean {
  for (const match of text.matchAll(SUB_VARIABLE)) {
    const name = match[1]!.trim();
    if (variables !== undefined && Object.hasOwn(variables, name)) continue;
    if (sources.parameters.has(name)) return true;
    const dot = name.indexOf('.');
    if (dot > 0 && sources.attributeIsNoEcho?.(name.slice(0, dot), name.slice(dot + 1)) === true)
      return true;
  }
  return false;
}

/**
 * Does the template node READ a `NoEcho` source anywhere beneath it? A `Ref`
 * to a `NoEcho` parameter, an `Fn::Sub` variable naming one (or a declared
 * attribute), an `Fn::GetAtt` of a declared attribute, or any intrinsic whose
 * operands do. An `Fn::If` with a known verdict reads only the branch it
 * selected. Plain strings outside `Fn::Sub` reference nothing.
 */
export function readsNoEchoSource(node: unknown, sources: NoEchoPositionSources): boolean {
  const seen = new Set<object>();
  const walk = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(walk);
    const record = value as Record<string, unknown>;
    const intrinsic = intrinsicKeyOf(record);
    if (intrinsic === 'Ref') {
      return typeof record['Ref'] === 'string' && sources.parameters.has(record['Ref']);
    }
    if (intrinsic === 'Fn::GetAtt') return getAttReadsNoEcho(record['Fn::GetAtt'], sources);
    if (intrinsic === 'Fn::Sub') {
      const argument = record['Fn::Sub'];
      if (typeof argument === 'string') return subStringReadsNoEcho(argument, undefined, sources);
      if (Array.isArray(argument)) {
        const [text, variables] = argument as [unknown, unknown];
        const vars = isPlainObject(variables) ? variables : undefined;
        if (typeof text === 'string' && subStringReadsNoEcho(text, vars, sources)) return true;
        return vars !== undefined && Object.values(vars).some(walk);
      }
      return walk(argument);
    }
    if (intrinsic === 'Fn::If') {
      const argument = record['Fn::If'];
      if (Array.isArray(argument) && argument.length === 3) {
        const verdict = conditionVerdict(sources, argument[0]);
        if (verdict !== undefined) return walk(verdict ? argument[1] : argument[2]);
        return walk(argument[1]) || walk(argument[2]);
      }
      return walk(argument);
    }
    return Object.values(record).some(walk);
  };
  return walk(node);
}

function literalIndex(index: unknown): number | undefined {
  if (typeof index === 'number' && Number.isInteger(index)) return index;
  if (typeof index === 'string' && /^\d+$/.test(index)) return Number(index);
  return undefined;
}

/**
 * The coordinates, within `resolved`, of every leaf whose TEMPLATE source in
 * `template` reads a `NoEcho` source ({@link readsNoEchoSource}).
 *
 * The two bags are walked together: a plain object descends by its own keys, a
 * literal array pairs element by element when the lengths agree (an
 * `AWS::NoValue` element that dropped out makes them disagree, and then the
 * whole array is the coordinate), and an intrinsic node is a coordinate as a
 * whole when it reads a source. Two intrinsics are opened instead, because
 * their result IS one of their operands: an `Fn::If` with a known verdict (its
 * selected branch is walked against the same resolved node), and an
 * `Fn::Select` with a literal index over a literal list. A leaf the resolution
 * dropped (`resolved` holds nothing there) is no coordinate.
 */
export function noEchoCoordinatesOf(
  template: unknown,
  resolved: unknown,
  sources: NoEchoPositionSources
): NoEchoCoordinate[] {
  const coordinates: NoEchoCoordinate[] = [];
  const ancestors = new Set<object>();
  const parametersOnly: NoEchoPositionSources = {
    parameters: sources.parameters,
    ...(sources.conditions !== undefined && { conditions: sources.conditions }),
  };
  const isBareDeclaredGetAtt = (node: unknown): boolean =>
    isPlainObject(node) &&
    intrinsicKeyOf(node) === 'Fn::GetAtt' &&
    getAttReadsNoEcho(node['Fn::GetAtt'], sources);
  const walk = (source: unknown, value: unknown, path: (string | number)[]): void => {
    if (value === undefined) return;
    if (source === null || typeof source !== 'object') return;
    if (ancestors.has(source)) return;
    ancestors.add(source);
    try {
      if (Array.isArray(source)) {
        if (!readsNoEchoSource(source, sources)) return;
        if (Array.isArray(value) && value.length === source.length) {
          source.forEach((item, index) => walk(item, value[index], [...path, index]));
        } else if (readsNoEchoSource(source, parametersOnly) || source.some(isBareDeclaredGetAtt)) {
          coordinates.push(path);
        }
        return;
      }
      const record = source as Record<string, unknown>;
      const intrinsic = intrinsicKeyOf(record);
      if (intrinsic === undefined) {
        if (!isPlainObject(value)) {
          if (readsNoEchoSource(record, parametersOnly)) coordinates.push(path);
          return;
        }
        for (const [key, child] of Object.entries(record)) {
          if (Object.hasOwn(value, key)) walk(child, value[key], [...path, key]);
        }
        return;
      }
      if (intrinsic === 'Fn::If') {
        const argument = record['Fn::If'];
        if (Array.isArray(argument) && argument.length === 3) {
          const verdict = conditionVerdict(sources, argument[0]);
          if (verdict !== undefined) {
            walk(verdict ? argument[1] : argument[2], value, path);
            return;
          }
          // Unknown verdict: either branch being a bare declared GetAtt
          // positions the leaf.
          if (isBareDeclaredGetAtt(argument[1]) || isBareDeclaredGetAtt(argument[2])) {
            coordinates.push(path);
            return;
          }
        }
      }
      if (intrinsic === 'Fn::Select') {
        const argument = record['Fn::Select'];
        if (Array.isArray(argument) && argument.length === 2 && Array.isArray(argument[1])) {
          const index = literalIndex(argument[0]);
          const list = argument[1] as unknown[];
          if (index !== undefined && index < list.length) {
            walk(list[index], value, path);
            return;
          }
        }
      }
      // A declared `NoEcho` ATTRIBUTE positions only a leaf that IS its
      // `Fn::GetAtt`: there the value arm already masks the whole leaf, and
      // position adds the values it cannot key (a `Number`, one under the
      // needle floor). A leaf that embeds one (`Fn::Join`, `Fn::Sub`) is left
      // to the value arm's containment rule, which spares an echoed PUBLIC
      // value (the region, the stack name) that position cannot tell apart.
      if (intrinsic === 'Fn::GetAtt') {
        if (getAttReadsNoEcho(record['Fn::GetAtt'], sources)) coordinates.push(path);
        return;
      }
      if (readsNoEchoSource(record, parametersOnly)) coordinates.push(path);
    } finally {
      ancestors.delete(source);
    }
  };
  walk(template, resolved, []);
  return coordinates;
}

/**
 * The persisted form of a leaf a `NoEcho` source served: every scalar becomes
 * {@link SECRET_MASK}, and a container keeps its shape with each leaf masked,
 * so a list stays a list of the same length (the comparison sides and
 * `carriesSecretMask` both still read it). `null` / `undefined` carry no value
 * and are kept, and so is a whole `{{resolve:...}}` expression.
 */
export function maskWholeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  // A whole `{{resolve:...}}` token is an EXPRESSION, never plaintext: the
  // dynamic-reference arm persists it so a reader can re-resolve it (a nested
  // child's `NoEcho` parameter fed a parent's secret reference).
  if (typeof value === 'string' && isSingleDynamicReferenceToken(value)) return value;
  if (Array.isArray(value)) return value.map(maskWholeValue);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(out, key, {
        value: maskWholeValue(child),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return SECRET_MASK;
}

function readAt(bag: unknown, coordinate: NoEchoCoordinate): { found: boolean; value: unknown } {
  let node: unknown = bag;
  for (const segment of coordinate) {
    if (typeof segment === 'number') {
      if (!Array.isArray(node) || segment >= node.length) return { found: false, value: undefined };
      node = node[segment];
      continue;
    }
    if (!isPlainObject(node) || !Object.hasOwn(node, segment)) {
      return { found: false, value: undefined };
    }
    node = node[segment];
  }
  return { found: true, value: node };
}

/** The value at `coordinate` in `bag`, or `undefined` where the path does not exist. */
export function valueAtCoordinate(bag: unknown, coordinate: NoEchoCoordinate): unknown {
  return readAt(bag, coordinate).value;
}

function cloneContainer(node: unknown): unknown {
  if (Array.isArray(node)) return [...node];
  if (isPlainObject(node)) return { ...node };
  return node;
}

/**
 * A copy of `bag` with the leaf at each coordinate replaced by
 * {@link maskWholeValue} of itself. Only the containers on a coordinate's path
 * are copied; `bag` itself is never mutated. A coordinate that does not exist
 * in `bag` is skipped.
 */
export function maskAtCoordinates<T>(bag: T, coordinates: readonly NoEchoCoordinate[]): T {
  if (coordinates.length === 0) return bag;
  let root: unknown = bag;
  for (const coordinate of coordinates) {
    if (!readAt(root, coordinate).found) continue;
    if (coordinate.length === 0) {
      root = maskWholeValue(root);
      continue;
    }
    root = cloneContainer(root);
    let node = root as Record<string | number, unknown>;
    for (let i = 0; i < coordinate.length - 1; i++) {
      const segment = coordinate[i]!;
      const next = cloneContainer(node[segment]);
      node[segment] = next;
      node = next as Record<string | number, unknown>;
    }
    const last = coordinate[coordinate.length - 1]!;
    node[last] = maskWholeValue(node[last]);
  }
  return root as T;
}

/**
 * Mask an AWS READBACK (`observedProperties`) at the coordinates `properties`
 * names (go-to-k/cdkd#4043 B4). A readback's lists may come back REORDERED, so
 * a numeric segment never addresses the readback by bare index: the element
 * is found by the identity field the two lists share ({@link identityKeyFor}),
 * and where no such field pairs them the WHOLE readback list is masked. A key
 * the readback lacks has nothing to mask.
 */
export function maskReadbackAtCoordinates(
  readback: Record<string, unknown>,
  properties: unknown,
  coordinates: readonly NoEchoCoordinate[]
): Record<string, unknown> {
  let result: Record<string, unknown> = readback;
  for (const coordinate of coordinates) {
    const target = readbackPathFor(result, properties, coordinate);
    if (target !== undefined) result = maskAtCoordinates(result, [target]);
  }
  return result;
}

function readbackPathFor(
  readback: unknown,
  properties: unknown,
  coordinate: NoEchoCoordinate
): NoEchoCoordinate | undefined {
  const path: (string | number)[] = [];
  let live: unknown = readback;
  let desired: unknown = properties;
  for (const segment of coordinate) {
    if (typeof segment === 'number') {
      if (!Array.isArray(live)) return path.length === 0 ? undefined : path;
      const key = Array.isArray(desired) ? identityKeyFor(live, desired) : undefined;
      const element = Array.isArray(desired) ? (desired[segment] as unknown) : undefined;
      if (key === undefined || !isPlainObject(element)) return path;
      const identity = element[key];
      const index = live.findIndex((item) => isPlainObject(item) && item[key] === identity);
      // Not found (AWS may normalize the identity value): mask the whole list.
      if (index < 0) return path;
      path.push(index);
      live = live[index];
      desired = element;
      continue;
    }
    if (!isPlainObject(live) || !Object.hasOwn(live, segment)) return undefined;
    path.push(segment);
    live = live[segment];
    desired = isPlainObject(desired) ? desired[segment] : undefined;
  }
  return path;
}

/**
 * Sort and de-duplicate coordinates, dropping one that another contains (the
 * outer coordinate masks the inner leaf already), so the persisted field is
 * canonical whatever order the walk found them in.
 */
export function canonicalCoordinates(
  coordinates: readonly NoEchoCoordinate[]
): (string | number)[][] {
  const keyed = new Map<string, (string | number)[]>();
  for (const coordinate of coordinates) keyed.set(JSON.stringify(coordinate), [...coordinate]);
  const all = [...keyed.values()];
  const covered = (inner: readonly (string | number)[]): boolean =>
    all.some(
      (outer) => outer.length < inner.length && outer.every((segment, i) => segment === inner[i])
    );
  return all
    .filter((coordinate) => !covered(coordinate))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/**
 * Read a persisted `noEchoLeaves` field, tolerating a malformed one as ABSENT
 * (an older binary never wrote it; a hand-edited record is not trusted).
 */
export function noEchoLeavesOf(record: { noEchoLeaves?: unknown }): NoEchoCoordinate[] | undefined {
  const field = record.noEchoLeaves;
  if (!Array.isArray(field)) return undefined;
  const out: NoEchoCoordinate[] = [];
  for (const entry of field) {
    if (!Array.isArray(entry)) return undefined;
    if (
      !entry.every((s) => typeof s === 'string' || (typeof s === 'number' && Number.isInteger(s)))
    )
      return undefined;
    out.push(entry as (string | number)[]);
  }
  return out;
}

/**
 * Is `coordinate` one of `marked`, or inside one? The drift report and the
 * rollback refusal ask this of a path they meet.
 */
export function isMarkedCoordinate(
  coordinate: NoEchoCoordinate,
  marked: readonly NoEchoCoordinate[]
): boolean {
  return marked.some(
    (outer) =>
      outer.length <= coordinate.length && outer.every((segment, i) => segment === coordinate[i])
  );
}

/**
 * The MIGRATION WITNESS (go-to-k/cdkd#4043 §4.1 step 4, review B2): a record
 * written before v11 carries no `noEchoLeaves`, so where this deploy persists
 * `***` the record may still hold the plaintext it last SENT. That plaintext is
 * an exact witness: comparing it with what the persist walk would have written
 * WITHOUT the `NoEcho` arms (`today`, the dynamic-reference form) says whether
 * the value moved, with no readback.
 *
 * Returns a copy of `stored` in which every leaf `v11` masks, and that `stored`
 * holds as the same value `today` holds, is replaced by the mask, so the
 * ordinary comparison against `v11` reads it as unchanged. A leaf `stored`
 * already holds as the mask, or does not hold at all, is not a witness and is
 * left as it is. `confirmed` / `differing` name the leaf coordinates either
 * way.
 */
export function witnessNormalize(
  stored: unknown,
  today: unknown,
  v11: unknown
): { current: unknown; confirmed: NoEchoCoordinate[]; differing: NoEchoCoordinate[] } {
  const confirmed: NoEchoCoordinate[] = [];
  const differing: NoEchoCoordinate[] = [];
  const walk = (s: unknown, t: unknown, v: unknown, path: (string | number)[]): unknown => {
    // A shape the mask no longer lines up with (a list that changed length, a
    // list where a string stood) is compared WHOLE, so a differing stored
    // value is reported as differing and never shown leaf by leaf.
    const shapeMoved =
      v !== SECRET_MASK &&
      containsMask(v) &&
      (Array.isArray(v)
        ? !Array.isArray(s) || s.length !== v.length
        : isPlainObject(v)
          ? !isPlainObject(s)
          : false);
    if (shapeMoved) {
      if (s === undefined || containsMask(s)) return s;
      if (jsonEqual(s, t)) {
        confirmed.push(path);
        return v;
      }
      differing.push(path);
      return s;
    }
    if (v === SECRET_MASK) {
      // Absent, or already the mask (a v11 write, or the custom-resource
      // class): no witness here.
      if (s === undefined || containsMask(s)) return s;
      if (jsonEqual(s, t)) {
        confirmed.push(path);
        return v;
      }
      differing.push(path);
      return s;
    }
    if (Array.isArray(v) && Array.isArray(s)) {
      if (s.length !== v.length) return s;
      const tt = Array.isArray(t) ? t : [];
      let changed = false;
      const out = s.map((item, i) => {
        const next = walk(item, tt[i], v[i], [...path, i]);
        if (next !== item) changed = true;
        return next;
      });
      return changed ? out : s;
    }
    if (isPlainObject(v) && isPlainObject(s)) {
      const tt = isPlainObject(t) ? t : {};
      let out: Record<string, unknown> | undefined;
      for (const key of Object.keys(v)) {
        if (!Object.hasOwn(s, key)) continue;
        const next = walk(s[key], tt[key], v[key], [...path, key]);
        if (next !== s[key]) {
          out ??= { ...s };
          out[key] = next;
        }
      }
      return out ?? s;
    }
    return s;
  };
  const current = walk(stored, today, v11, []);
  return { current, confirmed, differing };
}

function containsMask(value: unknown): boolean {
  if (value === SECRET_MASK) return true;
  if (Array.isArray(value)) return value.some(containsMask);
  if (isPlainObject(value)) return Object.values(value).some(containsMask);
  return false;
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Key-order-free JSON, the equality the engine's comparisons use. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, node: unknown) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) return node;
    const sorted = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(node).sort())
      sorted[key] = (node as Record<string, unknown>)[key];
    return sorted;
  });
}

/** The literal text a witness that DIFFERS shows in place of the old value. */
export const PREVIOUS_NOECHO_VALUE = '(previous NoEcho value)';

/**
 * The names of the `NoEcho` parameters a template bag reads
 * ({@link readsNoEchoSource}, parameter by parameter).
 */
function parametersReadBy(node: unknown, sources: NoEchoPositionSources): string[] {
  return [...sources.parameters].filter((name) =>
    readsNoEchoSource(node, {
      parameters: new Set([name]),
      ...(sources.conditions !== undefined && { conditions: sources.conditions }),
    })
  );
}

/**
 * The comparison twin of the persist side (go-to-k/cdkd#4043 §4.1), for the
 * deploy's diff and `cdkd diff`: given a resource's template bag, its
 * resolved desired bag and its recorded bag, return the two bags to compare.
 *
 * - The desired side is masked at every `NoEcho` position, and every string
 *   leaf equal to or containing (from `MIN_NEEDLE_LENGTH`) the value of a
 *   `NoEcho` parameter the resource reads becomes `***`, which is what the
 *   persist walk writes.
 * - A record no v11 binary wrote (no `noEchoLeaves`) is read through
 *   {@link witnessNormalize} against the unmasked desired side: an equal
 *   stored plaintext compares as unchanged, and a different one shows
 *   {@link PREVIOUS_NOECHO_VALUE} rather than the old value.
 */
export function noEchoComparison(options: {
  sources: NoEchoPositionSources;
  /** The bound value of each `NoEcho` parameter, by name. */
  values: Readonly<Record<string, unknown>>;
  minNeedleLength: number;
  /**
   * Values state holds in the clear (the region, the stack name): the
   * persist side keeps them out of the CONTAINMENT arm, so does this.
   */
  publicTokens?: ReadonlySet<string>;
}): (input: {
  templateProperties: Record<string, unknown>;
  desired: Record<string, unknown>;
  current: Record<string, unknown>;
  record: { noEchoLeaves?: unknown };
}) => { desired: Record<string, unknown>; current: Record<string, unknown> } | undefined {
  const { sources, values, minNeedleLength, publicTokens } = options;
  return ({ templateProperties, desired, current, record }) => {
    const coordinates = noEchoCoordinatesOf(templateProperties, desired, sources);
    const needles: string[] = [];
    for (const name of parametersReadBy(templateProperties, sources)) {
      const value = values[name];
      const leaves = Array.isArray(value) ? value : [value];
      for (const leaf of leaves) {
        if (
          typeof leaf === 'string' &&
          leaf.length >= minNeedleLength &&
          !isSingleDynamicReferenceToken(leaf)
        ) {
          needles.push(leaf);
        }
      }
    }
    if (coordinates.length === 0 && needles.length === 0) return undefined;
    let masked = maskAtCoordinates(desired, coordinates);
    if (needles.length > 0) {
      const walk = (node: unknown): unknown => {
        if (typeof node === 'string') {
          if (node === SECRET_MASK) return node;
          // As the persist side: a whole equal leaf, or one CONTAINING a
          // needle outside every `{{resolve:...}}` span, where the needle is
          // not a public token.
          const outside = node.replace(DYNAMIC_REFERENCE_TOKEN_SCAN, '');
          return needles.some(
            (needle) =>
              node === needle || (publicTokens?.has(needle) !== true && outside.includes(needle))
          )
            ? SECRET_MASK
            : node;
        }
        if (Array.isArray(node)) {
          const out = node.map(walk);
          return out.some((item, i) => item !== node[i]) ? out : node;
        }
        if (isPlainObject(node)) {
          let out: Record<string, unknown> | undefined;
          for (const [key, child] of Object.entries(node)) {
            const next = walk(child);
            if (next !== child) {
              out ??= { ...node };
              out[key] = next;
            }
          }
          return out ?? node;
        }
        return node;
      };
      masked = walk(masked) as Record<string, unknown>;
    }
    if (noEchoLeavesOf(record) !== undefined) return { desired: masked, current };
    const witnessed = witnessNormalize(current, desired, masked);
    const shown = maskAtCoordinatesWith(
      witnessed.current as Record<string, unknown>,
      witnessed.differing,
      PREVIOUS_NOECHO_VALUE
    );
    return { desired: masked, current: shown };
  };
}

function maskAtCoordinatesWith<T>(
  bag: T,
  coordinates: readonly NoEchoCoordinate[],
  replacement: string
): T {
  let root: unknown = bag;
  for (const coordinate of coordinates) {
    if (coordinate.length === 0 || !readAt(root, coordinate).found) continue;
    root = cloneContainer(root);
    let node = root as Record<string | number, unknown>;
    for (let i = 0; i < coordinate.length - 1; i++) {
      const segment = coordinate[i]!;
      const next = cloneContainer(node[segment]);
      node[segment] = next;
      node = next as Record<string | number, unknown>;
    }
    node[coordinate[coordinate.length - 1]!] = replacement;
  }
  return root as T;
}

/**
 * The OUTPUTS twin of {@link noEchoComparison} (go-to-k/cdkd#4043): `cdkd diff`
 * compares an output a `NoEcho` source serves as the persisted `***` on both
 * sides. `templateValues` maps each output name to its template `Value`; an
 * export alias key (not in `templateValues`) is masked when its value is the
 * value of an output masked here. A stored pre-v11 plaintext is the migration
 * witness: equal reads as unchanged, different shows
 * {@link PREVIOUS_NOECHO_VALUE}, never the old value.
 */
export function noEchoOutputsComparison(
  templateValues: Readonly<Record<string, unknown>>,
  sources: NoEchoPositionSources
): (
  current: Record<string, unknown> | undefined,
  desired: Record<string, unknown>
) => {
  current: Record<string, unknown> | undefined;
  desired: Record<string, unknown>;
  masked: string[];
} {
  return (current, desired) => {
    const coordinates = noEchoCoordinatesOf(templateValues, desired, sources);
    const maskedKeys = new Set(
      coordinates
        .map((coordinate) => coordinate[0])
        .filter((key): key is string => typeof key === 'string')
    );
    const maskedValues = new Set([...maskedKeys].map((key) => canonicalJson(desired[key])));
    for (const key of Object.keys(desired)) {
      if (!Object.hasOwn(templateValues, key) && maskedValues.has(canonicalJson(desired[key]))) {
        maskedKeys.add(key);
      }
    }
    if (maskedKeys.size === 0) return { current, desired, masked: [] };
    const maskedDesired: Record<string, unknown> = { ...desired };
    for (const key of maskedKeys) maskedDesired[key] = maskWholeValue(desired[key]);
    let normalized = current;
    if (current !== undefined && current !== null && typeof current === 'object') {
      for (const key of maskedKeys) {
        if (!Object.hasOwn(current, key)) continue;
        const stored = current[key];
        if (containsMask(stored)) continue;
        normalized = { ...(normalized ?? {}) };
        normalized[key] =
          canonicalJson(stored) === canonicalJson(desired[key])
            ? maskedDesired[key]
            : PREVIOUS_NOECHO_VALUE;
      }
    }
    return { current: normalized, desired: maskedDesired, masked: [...maskedKeys] };
  };
}
