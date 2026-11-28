import { SECRET_MASK } from './pairs.js';
import { noEchoLeavesOf, valueAtCoordinate } from './noecho-leaves.js';
import { isCustomResourceType, templateGetAttNamesOf } from './secret-attribute-keys.js';

/**
 * A custom resource attribute EQUAL to one of its own string `NoEcho` inputs
 * (go-to-k/cdkd#7183, option 2): the rule a value too short for a needle (or
 * one the physical id contains) is matched by. A handler's `Data` is its own
 * text, so such a value is the secret echoed back.
 *
 * The test is `undefined` (nothing matches) unless the resource is a custom
 * resource, `template` is known, and every `Fn::GetAtt` (or `Fn::Sub`
 * `${X.Attr}`) of it names a literal attribute: an attribute the template
 * reads keeps resolving in the clear, and a template that names one through
 * an expression may read any. An input equal to the stack name (public) or
 * holding the mask is no input; an attribute equal to the physical id stays.
 */
export function wholeNoEchoEchoTest(
  resourceType: unknown,
  template: object | undefined,
  logicalId: string,
  inputs: Iterable<unknown>,
  stackName: string | undefined,
  physicalId: unknown
): ((name: string, value: unknown) => boolean) | undefined {
  const whole = new Set<string>();
  for (const value of inputs) {
    if (typeof value !== 'string' || value === '' || value.includes(SECRET_MASK)) continue;
    // No floor here: a value of needle length is matched whole too.
    if (value !== stackName) whole.add(value);
  }
  if (whole.size === 0 || template === undefined || !isCustomResourceType(resourceType)) {
    return undefined;
  }
  const reads = templateGetAttNamesOf(template, logicalId);
  if (reads === 'any') return undefined;
  return (name, value) =>
    typeof value === 'string' && value !== physicalId && whole.has(value) && !reads.has(name);
}

/**
 * `record` (one read from `state.json`, as `cdkd scrub` rewrites it) with
 * every attribute {@link wholeNoEchoEchoTest} matches masked and named in
 * `noEchoAttributeNames`, so a short echo an older binary persisted in
 * plaintext is repaired (go-to-k/cdkd#7188). The inputs are the values at the
 * record's own `noEchoLeaves` in each of `bags` (the record as read, which
 * holds the mask there unless it predates v11, and what this scrub resolved
 * for it). An attribute is tested as `stored` holds it, the record as read:
 * the value scrub before this pass may have masked a long one already, which
 * is still to be declared. Returns `record` by identity when nothing matches.
 */
export function withWholeNoEchoEchoesDeclared<
  R extends {
    resourceType?: unknown;
    physicalId?: unknown;
    attributes?: Record<string, unknown>;
    noEchoAttributeNames?: unknown;
    noEchoLeaves?: unknown;
  },
>(
  record: R,
  bags: readonly unknown[],
  template: object | undefined,
  logicalId: string,
  stackName: string,
  stored?: Record<string, unknown>
): R {
  const attributes = record.attributes;
  if (attributes === undefined || attributes === null || typeof attributes !== 'object') {
    return record;
  }
  const coordinates = noEchoLeavesOf(record);
  if (coordinates === undefined || coordinates.length === 0) return record;
  const inputs = bags.flatMap((bag) =>
    coordinates.map((coordinate) => valueAtCoordinate(bag, coordinate))
  );
  const test = wholeNoEchoEchoTest(
    record.resourceType,
    template,
    logicalId,
    inputs,
    stackName,
    record.physicalId
  );
  if (test === undefined) return record;
  const echoed = Object.entries(attributes)
    .filter(([name, value]) =>
      test(name, stored !== undefined && Object.hasOwn(stored, name) ? stored[name] : value)
    )
    .map(([name]) => name);
  if (echoed.length === 0) return record;
  const masked: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(attributes)) {
    Object.defineProperty(masked, name, {
      value: echoed.includes(name) ? SECRET_MASK : value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  const declared = Array.isArray(record.noEchoAttributeNames)
    ? record.noEchoAttributeNames.filter((name): name is string => typeof name === 'string')
    : [];
  return {
    ...record,
    attributes: masked,
    noEchoAttributeNames: [...new Set([...declared, ...echoed])].sort(),
  };
}
