import { expect } from 'vite-plus/test';
import type { ResourceProvider, UpdateContext } from '../../../src/types/resource.js';

/**
 * The differential wire harness behind `sdk-wire-coverage.test.ts` (#3723).
 *
 * Real SDK clients run, so each client's schema-driven serializer drops any
 * member it does not know. A `build`-step middleware captures the serialized
 * request and answers without calling `next`, which skips signing, the network
 * and deserialization alike. The answer is generated from the operation's own
 * OUTPUT schema, so a provider reading a member gets a value of the declared
 * shape, never a guess from its name alone.
 *
 * Every client CLASS is wrapped (`wrapClientModule`, applied from the test's
 * `vi.mock` factories), not only the instances `getAwsClients()` hands out: a
 * provider that builds its own create client (`withoutServerErrorRetries`)
 * is captured the same way. A client from a package the test does NOT mock
 * is not captured: `tests/setup.ts`'s network fence fails the run on its call.
 */

export const ACCOUNT = '123456789012';
export const REGION = 'us-east-1';

const CREDENTIALS = { accessKeyId: 'AKIDFAKE', secretAccessKey: 'fake' };

/** The captured write sequence of the run in progress, one JSON line per request. */
export const wire: string[] = [];

/**
 * Command name (`CreateTopicCommand`) -> what it answers, merged over the
 * schema-generated output. Set per probe: a read listing what the bag under
 * probe declares, or a status a wait loop polls for.
 */
export type OutputOverride = (input: Record<string, unknown>) => Record<string, unknown>;
let overrides: Record<string, OutputOverride> = {};
export function setOutputOverrides(next: Record<string, OutputOverride> | undefined): void {
  overrides = next ?? {};
}

// A read delivers no property, so it is left out of the comparison: otherwise
// an update that lists subscriptions but never unsubscribes one still differs
// from one that does nothing.
const READ_COMMAND = /^(Get|List|Describe)/;

// --- Fake outputs from the operation's output schema --------------------------
//
// The static schema tuples `@smithy/core/schema` reads (the package is not a
// direct dependency, so they are walked here):
//   member     [ref, traits]
//   simple     [0, ns, name, traits, ref]
//   list       [1, ns, name, traits, valueRef]
//   map        [2, ns, name, traits, keyRef, valueRef]
//   structure  [3 | -3, ns, name, traits, memberNames, memberRefs]
//   union      [4, ns, name, traits, memberNames, memberRefs]
//   operation  [9, ns, name, traits, inputRef, outputRef]
// A bare number is a primitive: 0 string, 1 number, 2 boolean, 4-7 timestamp,
// 15 document, 17/19 big number, 21/42 blob, 64-127 list of (n & 63), 128-255
// map of (n & 63). A function is a lazy reference.

type SchemaRef = unknown;

const deref = (ref: SchemaRef): unknown => (typeof ref === 'function' ? ref() : ref);

function unwrap(ref: SchemaRef): unknown {
  let sc = deref(ref);
  // A member is a 2-tuple [ref, traits]; a simple schema wraps its target.
  for (;;) {
    if (Array.isArray(sc) && sc.length === 2) sc = deref(sc[0]);
    else if (Array.isArray(sc) && sc[0] === 0) sc = deref(sc[4]);
    else return sc;
  }
}

/**
 * A member a provider loops on while it is present: answering a value would
 * paginate forever, so it is left out of the OUTPUT structure, as on a last
 * page. Only at the top level, where pagination lives: a nested `SessionToken`
 * is data.
 */
const CONTINUATION = /^Next|Token$|Marker$/;

/** A string answer: an ARN or URL where the member is named for one, else a marker. */
function fakeString(member: string): string {
  if (/Arn$|ARN$/.test(member)) return `arn:aws:svc:${REGION}:${ACCOUNT}:fake-${member}`;
  if (/Url$|URL$/.test(member)) return `https://svc.${REGION}.amazonaws.com/${ACCOUNT}/fake`;
  if (member === 'Account') return ACCOUNT;
  return `fake-${member}`;
}

/**
 * A value of the schema's shape. Lists and maps answer empty (a list a
 * provider must see populated is an override); a structure recursion stops at
 * a shape already on the path, so a self-referencing shape terminates.
 */
export function fakeValue(
  ref: SchemaRef,
  member = '',
  seen: ReadonlySet<unknown> = new Set()
): unknown {
  const sc = unwrap(ref);
  if (typeof sc === 'number') {
    if (sc >= 64) return sc >= 128 ? {} : [];
    if (sc === 0) return fakeString(member);
    if (sc === 1 || sc === 17 || sc === 19) return 1;
    if (sc === 2) return false;
    if (sc >= 4 && sc <= 7) return new Date(0);
    if (sc === 15) return {};
    if (sc === 21 || sc === 42) return new Uint8Array();
    return undefined;
  }
  if (!Array.isArray(sc)) return undefined; // 'unit'
  if (sc[0] === 1) return [];
  if (sc[0] === 2) return {};
  if (sc[0] === 4) return undefined; // a union: no member chosen
  if (sc[0] === 3 || sc[0] === -3) {
    if (seen.has(sc)) return undefined;
    const inner = new Set(seen).add(sc);
    const names = sc[4] as string[];
    const refs = sc[5] as SchemaRef[];
    const out: Record<string, unknown> = {};
    names.forEach((name, i) => {
      if (seen.size === 0 && CONTINUATION.test(name)) return;
      const value = fakeValue(refs[i], name, inner);
      if (value !== undefined) out[name] = value;
    });
    return out;
  }
  return undefined;
}

interface SmithyContext {
  commandName?: string;
  __smithy_context?: { operationSchema?: unknown[] };
}

function fakeOutput(context: SmithyContext, input: Record<string, unknown>): unknown {
  const op = context.__smithy_context?.operationSchema;
  // Every client this harness wraps is schema-serialized; one that is not
  // would silently answer nothing, so it fails instead.
  if (!Array.isArray(op) || op[0] !== 9) {
    throw new Error(`no operation schema on ${context.commandName ?? '?'}`);
  }
  const generated = (fakeValue(op[5]) ?? {}) as Record<string, unknown>;
  const override = overrides[context.commandName ?? ''];
  return { ...generated, ...(override ? override(input) : {}), $metadata: {} };
}

// --- Capture -----------------------------------------------------------------

interface Capturable {
  middlewareStack: { add(middleware: never, options: never): void };
}

function capturing<T extends Capturable>(client: T): T {
  const middleware =
    (_next: unknown, context: SmithyContext) =>
    async (args: { request: unknown; input: Record<string, unknown> }) => {
      const command = context.commandName ?? '';
      const output = fakeOutput(context, args.input);
      if (READ_COMMAND.test(command)) return { output, response: {} };
      const req = args.request as {
        method: string;
        path: string;
        query?: Record<string, unknown>;
        headers: Record<string, string>;
        body?: unknown;
      };
      wire.push(
        JSON.stringify([
          command,
          req.method,
          req.path,
          req.query,
          req.headers['x-amz-target'],
          // The JSON protocols hand the body over as bytes.
          typeof req.body === 'string'
            ? req.body
            : req.body instanceof Uint8Array
              ? new TextDecoder().decode(req.body)
              : JSON.stringify(req.body ?? null),
        ])
      );
      return { output, response: {} };
    };
  const options = { step: 'build', name: 'wireCapture', priority: 'low' };
  client.middlewareStack.add(middleware as never, options as never);
  return client;
}

/**
 * The module with `className` replaced by a subclass that captures every
 * instance, with fake credentials and a default region. For a `vi.mock`
 * factory: `vi.mock('@aws-sdk/client-sns', async (orig) => (await
 * import('./sdk-wire-harness.js')).wrapClientModule(await orig(), 'SNSClient'))`.
 */
export function wrapClientModule<M extends Record<string, unknown>>(mod: M, className: string): M {
  const Base = mod[className] as new (config: Record<string, unknown>) => Capturable;
  const Wrapped = class extends Base {
    constructor(config: Record<string, unknown> = {}) {
      super({ ...config, region: config['region'] ?? REGION, credentials: CREDENTIALS });
      capturing(this);
    }
  };
  Object.defineProperty(Wrapped, 'name', { value: className });
  return { ...mod, [className]: Wrapped };
}

// --- The differential probe --------------------------------------------------

export type Bag = Record<string, unknown>;
export type Path = (string | number)[];

/** Every key path in the bag, so nested members are probed individually. */
export function paths(value: unknown, prefix: Path = []): Path[] {
  if (Array.isArray(value)) {
    return value.flatMap((v, i) => [[...prefix, i], ...paths(v, [...prefix, i])]);
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [[...prefix, k], ...paths(v, [...prefix, k])]);
  }
  return [];
}

/** The node holding the last segment of `path` (with `[...p, '']`, the node AT `p`). */
function parentOf(bag: Bag, path: Path): Record<string | number, unknown> {
  let node: Record<string | number, unknown> = bag;
  for (const seg of path.slice(0, -1)) node = node[seg] as Record<string | number, unknown>;
  return node;
}

export function without(bag: Bag, path: Path): Bag {
  const copy = structuredClone(bag);
  const node = parentOf(copy, path);
  const last = path[path.length - 1]!;
  if (Array.isArray(node)) node.splice(last as number, 1);
  else delete node[last];
  return copy;
}

/**
 * The bag with the leaf at `path` changed: to `variant` when given (an enum
 * member needs a valid alternative), else to another value of its type.
 * Undefined for a non-leaf.
 */
function varied(bag: Bag, path: Path, variant?: { value: unknown }): Bag | undefined {
  const copy = structuredClone(bag);
  const node = parentOf(copy, path);
  const last = path[path.length - 1]!;
  const value = node[last];
  if (variant) node[last] = variant.value;
  else if (typeof value === 'string') node[last] = `${value}-alt`;
  else if (typeof value === 'number') node[last] = value + 1;
  else if (typeof value === 'boolean') node[last] = !value;
  else return undefined;
  return copy;
}

export type Outcome = { threw: false; wire: string } | { threw: true; message: string };

export async function record(run: () => Promise<unknown>): Promise<Outcome> {
  wire.length = 0;
  try {
    await run();
  } catch (error) {
    return { threw: true, message: (error as Error).message };
  }
  return { threw: false, wire: wire.join('\n') };
}

export interface ProbeCase {
  resourceType: string;
  provider: () => ResourceProvider;
  physicalId: string;
  /** Top-levels the engine replaces on instead of updating; skipped on update. */
  createOnly: ReadonlySet<string>;
  bag: Bag;
  /** Path label -> the value a removal-throwing leaf is varied to. */
  variants?: Record<string, unknown>;
  /**
   * Arms the fake reads for the live resource `bag` describes, before each
   * provider call: the previous bag on an update, `{}` on a create.
   */
  arm?: (physicalId: string, bag: Bag) => void;
  /**
   * What every `update()` receives as its context, e.g. the record's
   * `recordedAttributes`. The `drift --revert` / rollback flags
   * (`desiredFromAwsReadback`, `replayingState`) are not probed here: their
   * arms are outside what the template-path comparisons observe.
   */
  updateContext?: UpdateContext;
}

export interface ProbeResult {
  /** Probes whose removal (or variation) left the write sequence unchanged. */
  silent: string[];
  /** Probes where the reduced side THREW: removal cannot observe delivery there. */
  removalThrows: string[];
  /** The message of each removal throw, for diagnosing an unexpected entry. */
  messages: Record<string, string>;
}

/**
 * Removing any one path must change what reaches the wire; if it does not, the
 * member is dropped. Probed on create, and on update in both directions, with
 * ONE argument varying per comparison: an `update()` that re-sends every desired
 * attribute would otherwise mask a change on the side under test.
 *
 * - `create`: `create(full)` vs `create(full - P)`
 * - `update-add`: `update(next=full, prev=full-P)` vs `update(next=full-P, prev=full-P)`
 *   (only `next` varies)
 * - `update-remove`: `update(next=full-P, prev=full)` vs `update(next=full-P, prev=full-P)`
 *   (only `prev` varies, so the removal-reset path is what is observed)
 *
 * A reduced side that THROWS is not delivery: it lands in `removalThrows`, and
 * that path is probed instead by changing its value, in each direction that
 * threw: on create, `create(full)` vs `create(alt)`; on update,
 * `update(next=full, prev=base)` vs `update(next=alt, prev=base)`, where `base`
 * lacks the leaf's parent so both sides make the same call and only the value
 * differs.
 */
/** Arm the fake reads for `bag`: the case's own `arm`, else no overrides. */
export function armFor(c: Pick<ProbeCase, 'arm' | 'physicalId'>, bag: Bag): void {
  if (c.arm) c.arm(c.physicalId, bag);
  else setOutputOverrides(undefined);
}

export async function probe(c: ProbeCase): Promise<ProbeResult> {
  const p = c.provider();
  // What the fake reads answer is the live resource: on an update, the
  // PREVIOUS bag, which is what the last deploy left there. A provider that
  // plans against AWS rather than `previousProperties` then sees the same
  // difference one that diffs the two bags does.
  const create = (bag: Bag) => () => {
    armFor(c, {});
    return p.create('L', c.resourceType, structuredClone(bag));
  };
  const update = (next: Bag, prev: Bag) => () => {
    armFor(c, prev);
    return p.update(
      'L',
      c.physicalId,
      c.resourceType,
      structuredClone(next),
      structuredClone(prev),
      c.updateContext
    );
  };

  const full = await record(create(c.bag));
  const settled = await record(update(c.bag, c.bag));
  // Every create comparison is made against `full`, so a throwing `full` would
  // make them vacuous; `settled` guards that a no-op update succeeds at all.
  expect(full).toMatchObject({ threw: false });
  expect(settled).toMatchObject({ threw: false });
  const fullWire = (full as { wire: string }).wire;

  const silent: string[] = [];
  const removalThrows: string[] = [];
  const messages: Record<string, string> = {};
  const compare = (direction: string, label: string, a: Outcome, b: Outcome): boolean => {
    if (a.threw || b.threw) {
      removalThrows.push(`${direction}:${label}`);
      messages[`${direction}:${label}`] = a.threw ? a.message : (b as { message: string }).message;
      return true;
    }
    if (a.wire === b.wire) silent.push(`${direction}:${label}`);
    return false;
  };

  for (const path of paths(c.bag)) {
    const label = path.join('.');
    const reduced = without(c.bag, path);
    const createThrew = compare('create', label, await record(create(reduced)), full);
    let updateThrew = false;
    if (!c.createOnly.has(String(path[0]))) {
      updateThrew =
        compare(
          'update-add',
          label,
          await record(update(c.bag, reduced)),
          await record(update(reduced, reduced))
        ) || updateThrew;
      updateThrew =
        compare(
          'update-remove',
          label,
          await record(update(reduced, c.bag)),
          await record(update(reduced, reduced))
        ) || updateThrew;
    }
    if (!createThrew && !updateThrew) continue;
    // A container whose removal throws (a required list or document) cannot be
    // varied, but each path beneath it is probed on its own: those probes are
    // its delivery evidence. An EMPTY one has none, so it stays silent below.
    if (paths(parentOf(c.bag, [...path, ''])).length > 0) continue;
    const alt = varied(
      c.bag,
      path,
      c.variants && label in c.variants ? { value: c.variants[label] } : undefined
    );
    if (createThrew) {
      const altOutcome = alt === undefined ? undefined : await record(create(alt));
      if (altOutcome === undefined || altOutcome.threw || altOutcome.wire === fullWire) {
        silent.push(`create-vary:${label}`);
      }
    }
    if (updateThrew) {
      const base = without(c.bag, path.length > 1 ? path.slice(0, -1) : path);
      const before = await record(update(c.bag, base));
      const after = alt === undefined ? undefined : await record(update(alt, base));
      if (before.threw || after === undefined || after.threw || after.wire === before.wire) {
        silent.push(`update-vary:${label}`);
      }
    }
  }
  return { silent, removalThrows, messages };
}
