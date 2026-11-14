/**
 * The JSON types a custom resource handler receives in `ResourceProperties` /
 * `OldResourceProperties` (go-to-k/cdkd#6309).
 *
 * CloudFormation turns every LITERAL number and boolean of the template into a
 * string, at any depth (inside a literal list too), including the operands an
 * `Fn::If` / `Fn::Select` / `Fn::FindInMap` picks from. A `Ref` (a `Number`
 * parameter arrives as `"7"`) and every string-producing intrinsic deliver
 * strings. A value an `Fn::GetAtt` reads keeps the JSON type the attribute
 * has (`AttachmentCount` `0`, `IsAttachable` `true`, an object's numeric
 * members), even inside a literal list or object, or picked by `Fn::If` /
 * `Fn::Select`. One exception: a custom resource's (or nested stack's)
 * attribute is a string when it is a scalar (`Data: {"Num": 5}` reads `"5"`),
 * while an object attribute keeps its members' types. `OldResourceProperties`
 * and the `Delete` payload follow the same rule. All measured against
 * CloudFormation in us-east-1 for #6309.
 *
 * The resolved bag cannot tell a literal `0` from a `0` an `Fn::GetAtt`
 * served, so the TEMPLATE decides: {@link typedPayloadLeavesOf} walks the
 * template bag beside the resolved one and names the coordinates whose value
 * keeps its type; {@link serializeResourceProperties} stringifies everything
 * else. A coordinate is a SEGMENT ARRAY (keys and array indexes), never a
 * dotted string, since a dotted key is legal in a property bag.
 */

/** A position inside a resolved property bag. */
export type PayloadCoordinate = readonly (string | number)[];

/** What the walk needs to know beyond the two bags. */
export interface PayloadTypingSources {
  /**
   * The condition verdicts the resolution used. An `Fn::If` whose verdict is
   * unknown positions nothing (its value is stringified).
   */
  readonly conditions?: Readonly<Record<string, boolean>> | undefined;
  /** The resource type of a logical id an `Fn::GetAtt` reads, if known. */
  readonly resourceTypeOf: (logicalId: string) => string | undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function intrinsicKeyOf(node: Record<string, unknown>): string | undefined {
  const keys = Object.keys(node);
  if (keys.length !== 1) return undefined;
  const key = keys[0]!;
  return key === 'Ref' || key.startsWith('Fn::') ? key : undefined;
}

function literalIndex(index: unknown): number | undefined {
  if (typeof index === 'number' && Number.isInteger(index)) return index;
  if (typeof index === 'string' && /^\d+$/.test(index)) return Number(index);
  return undefined;
}

function isNoValue(node: unknown): boolean {
  return isPlainObject(node) && intrinsicKeyOf(node) === 'Ref' && node['Ref'] === 'AWS::NoValue';
}

/** The types whose scalar `Fn::GetAtt` CloudFormation serves as a string. */
function servesScalarAttributesAsStrings(resourceType: string | undefined): boolean {
  return (
    resourceType !== undefined &&
    (resourceType.startsWith('Custom::') ||
      resourceType === 'AWS::CloudFormation::CustomResource' ||
      resourceType === 'AWS::CloudFormation::Stack')
  );
}

function getAttTarget(argument: unknown): string | undefined {
  if (typeof argument === 'string') {
    const dot = argument.indexOf('.');
    return dot > 0 ? argument.slice(0, dot) : undefined;
  }
  if (Array.isArray(argument) && typeof argument[0] === 'string') return argument[0];
  return undefined;
}

/** Whether stringifying `value` would change anything. */
function holdsNonString(value: unknown): boolean {
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.some(holdsNonString);
  if (isPlainObject(value)) return Object.values(value).some(holdsNonString);
  return false;
}

/**
 * The coordinates, within `resolved`, whose value the payload keeps verbatim:
 * every value an `Fn::GetAtt` in `template` served (opened through a literal
 * object or list, an `Fn::If` of known verdict and an `Fn::Select` with a
 * literal index), minus a custom resource's / nested stack's scalar
 * attribute. A coordinate whose value holds no number or boolean is left out
 * (stringifying it changes nothing), so the list is usually empty. A literal
 * list whose length the resolution changed (an `AWS::NoValue` element that is
 * not a bare `Ref`) positions nothing inside it.
 */
export function typedPayloadLeavesOf(
  template: unknown,
  resolved: unknown,
  sources: PayloadTypingSources
): PayloadCoordinate[] {
  const coordinates: PayloadCoordinate[] = [];
  const ancestors = new Set<object>();
  const push = (path: (string | number)[], value: unknown): void => {
    if (holdsNonString(value)) coordinates.push(path);
  };
  // A custom resource's / nested stack's scalar attribute is a string.
  const pushGetAtt = (
    node: Record<string, unknown>,
    value: unknown,
    path: (string | number)[]
  ): void => {
    const target = getAttTarget(node['Fn::GetAtt']);
    const scalar = value === null || typeof value !== 'object';
    if (scalar && servesScalarAttributesAsStrings(target && sources.resourceTypeOf(target))) {
      return;
    }
    push(path, value);
  };
  const walk = (source: unknown, value: unknown, path: (string | number)[]): void => {
    if (value === undefined) return;
    if (source === null || typeof source !== 'object') return;
    if (ancestors.has(source)) return;
    ancestors.add(source);
    try {
      if (Array.isArray(source)) {
        const kept = source.filter((item) => !isNoValue(item));
        if (Array.isArray(value) && value.length === kept.length) {
          kept.forEach((item, index) => walk(item, value[index], [...path, index]));
        }
        return;
      }
      const record = source as Record<string, unknown>;
      const intrinsic = intrinsicKeyOf(record);
      if (intrinsic === undefined) {
        if (!isPlainObject(value)) return;
        for (const [key, child] of Object.entries(record)) {
          if (Object.hasOwn(value, key)) walk(child, value[key], [...path, key]);
        }
        return;
      }
      if (intrinsic === 'Fn::GetAtt') {
        pushGetAtt(record, value, path);
        return;
      }
      if (intrinsic === 'Fn::If') {
        const argument = record['Fn::If'];
        if (Array.isArray(argument) && argument.length === 3 && typeof argument[0] === 'string') {
          const conditions = sources.conditions;
          if (conditions !== undefined && Object.hasOwn(conditions, argument[0])) {
            walk(conditions[argument[0]] ? argument[1] : argument[2], value, path);
          }
        }
        return;
      }
      if (intrinsic === 'Fn::Select') {
        const argument = record['Fn::Select'];
        if (Array.isArray(argument) && argument.length === 2) {
          const index = literalIndex(argument[0]);
          const list = argument[1];
          if (index !== undefined && Array.isArray(list) && index < list.length) {
            walk(list[index], value, path);
          } else if (isPlainObject(list) && intrinsicKeyOf(list) === 'Fn::GetAtt') {
            // An element of a list attribute (unmeasured): the attribute's
            // own rule, a custom resource's scalar a string included.
            pushGetAtt(list, value, path);
          }
        }
        return;
      }
      // `Ref`, `Fn::FindInMap`, `Fn::Join`, `Fn::Sub`, `Fn::ImportValue`, ...:
      // CloudFormation delivers a string (or a list of strings).
    } finally {
      ancestors.delete(source);
    }
  };
  walk(template, resolved, []);
  return coordinates;
}

interface CoordinateTrie {
  typed: boolean;
  children: Map<string, CoordinateTrie>;
}

function segmentKey(segment: string | number): string {
  return `${typeof segment === 'number' ? 'n' : 's'}:${segment}`;
}

function trieOf(coordinates: readonly PayloadCoordinate[]): CoordinateTrie {
  const root: CoordinateTrie = { typed: false, children: new Map() };
  for (const coordinate of coordinates) {
    if (!Array.isArray(coordinate)) continue;
    let node = root;
    for (const segment of coordinate) {
      if (typeof segment !== 'string' && typeof segment !== 'number') break;
      const key = segmentKey(segment);
      let child = node.children.get(key);
      if (child === undefined) {
        child = { typed: false, children: new Map() };
        node.children.set(key, child);
      }
      node = child;
    }
    node.typed = true;
  }
  return root;
}

/**
 * An own data property, whatever `key` is: an assignment of `__proto__` would
 * set the prototype and drop the key from the payload.
 */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * The pre-#6309 rule, kept for a bag whose template positions are not known
 * (a record an earlier cdkd wrote, a rollback replay): every number and
 * boolean under plain objects becomes a string, and a list is passed as it
 * is. Some CDK handlers depend on the strings (`BucketNotificationsHandler`
 * calls `.lower()` on a boolean).
 */
function legacyStringify(properties: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === 'boolean' || typeof value === 'number') {
      setOwn(result, key, String(value));
    } else if (isPlainObject(value)) {
      setOwn(result, key, legacyStringify(value));
    } else {
      setOwn(result, key, value);
    }
  }
  return result;
}

/**
 * The `ResourceProperties` CloudFormation would deliver for `properties`:
 * the value at each `typedLeaves` coordinate verbatim, every other number and
 * boolean (lists included) as a string. `undefined` leaves mean the template
 * positions are unknown, and the pre-#6309 rule applies unchanged.
 */
export function serializeResourceProperties(
  properties: Record<string, unknown>,
  typedLeaves: readonly PayloadCoordinate[] | undefined
): Record<string, unknown> {
  // A malformed list (hand-edited state) reads as not known.
  const leaves = recordedTypedPayloadLeavesOf({ typedPayloadLeaves: typedLeaves });
  if (leaves === undefined) return legacyStringify(properties);
  const walk = (value: unknown, node: CoordinateTrie | undefined): unknown => {
    if (node?.typed === true) return value;
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, node?.children.get(segmentKey(index))));
    }
    if (isPlainObject(value)) {
      const result: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value)) {
        setOwn(result, key, walk(child, node?.children.get(segmentKey(key))));
      }
      return result;
    }
    return value;
  };
  return walk(properties, trieOf(leaves)) as Record<string, unknown>;
}

/**
 * `typedPayloadLeaves` as read off a state record: a list of segment arrays,
 * anything else read as ABSENT (not known).
 */
export function recordedTypedPayloadLeavesOf(record: {
  typedPayloadLeaves?: unknown;
}): PayloadCoordinate[] | undefined {
  const field: unknown = record.typedPayloadLeaves;
  if (!Array.isArray(field)) return undefined;
  const leaves: PayloadCoordinate[] = [];
  for (const coordinate of field) {
    if (
      !Array.isArray(coordinate) ||
      !coordinate.every((segment) => typeof segment === 'string' || typeof segment === 'number')
    ) {
      return undefined;
    }
    leaves.push(coordinate as (string | number)[]);
  }
  return leaves;
}
