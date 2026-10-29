import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vite-plus/test';
import type { ResourceProvider, UpdateContext } from '../../../src/types/resource.js';
import { MEMBER_RENAMES } from './sdk-wire-member-renames.js';

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
 * Every request of the run in progress, reads included, as `<Command> <path>`:
 * what a case with no properties pins (`TypeCase.noProperties`).
 */
export const calls: string[] = [];

/** The write sequence's command inputs, `[command, input]` JSON, beside `wire`. */
const inputs: string[] = [];

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

/**
 * An idempotency token the SDK fills in (`ClientToken`, `ClientRequestToken`,
 * Cloud Map's `CreatorRequestId` / `UpdaterRequestId`) is a fresh UUID per
 * call: left in, every two requests differ and no probe could ever be silent.
 * Only those members are normalized, so a declared value that happens to be a
 * UUID still reaches the comparison.
 */
const SDK_TOKEN =
  /("(?:ClientToken|ClientRequestToken|CreatorRequestId|UpdaterRequestId)"\s*:\s*")[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/gi;

/** The request body as text, the SDK-filled tokens in it normalized. */
function bodyText(body: unknown): string {
  // The JSON protocols hand the body over as bytes.
  const text =
    typeof body === 'string'
      ? body
      : body instanceof Uint8Array
        ? new TextDecoder().decode(body)
        : JSON.stringify(body ?? null);
  return text.replace(SDK_TOKEN, '$1<token>"');
}

interface Capturable {
  middlewareStack: { add(middleware: never, options: never): void };
}

function capturing<T extends Capturable>(client: T): T {
  const middleware =
    (_next: unknown, context: SmithyContext) =>
    async (args: { request: unknown; input: Record<string, unknown> }) => {
      const command = context.commandName ?? '';
      const output = fakeOutput(context, args.input);
      const req = args.request as {
        method: string;
        path: string;
        query?: Record<string, unknown>;
        headers: Record<string, string>;
        body?: unknown;
      };
      calls.push(`${command} ${req.path}`);
      if (READ_COMMAND.test(command)) return { output, response: {} };
      // The command INPUT as the provider built it, in SDK member names and
      // before any protocol wrapping (`member.N`, XML, URI labels): what
      // `landingNames` reads to say WHICH member a value went to.
      // Bytes as their text: a code blob is one value, not a member per byte.
      const text = JSON.stringify([command, args.input], (_k, v: unknown) =>
        v instanceof Uint8Array ? new TextDecoder().decode(v) : v
      );
      inputs.push(text.replace(SDK_TOKEN, '$1<token>"'));
      wire.push(
        JSON.stringify([
          command,
          req.method,
          req.path,
          req.query,
          req.headers['x-amz-target'],
          bodyText(req.body),
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
 * Whether changing `path` changes a create-only path: one at it, beneath it
 * (removing a parent removes its create-only member) or above it. Array
 * indices are dropped, as the schema's paths spell none. Path-precise, as the
 * engine's replacement check is: a nested create-only member leaves its
 * siblings updatable, unless the engine cannot walk `bag` to it. Above it,
 * only when `bag` holds a value there: removing a parent whose create-only
 * member is absent leaves that path `undefined` on both sides.
 */
export function touchesCreateOnly(
  createOnly: ReadonlySet<string>,
  path: Path,
  bag: Bag
): boolean {
  const dotted = path.filter((seg) => typeof seg === 'string').join('.');
  for (const c of createOnly) {
    if (c === dotted || dotted.startsWith(`${c}.`)) return true;
    const [top, ...rest] = c.split('.');
    if (rest.length === 0 || top !== path[0]) continue;
    const at = valueAt(bag[top!], rest);
    if (!at.resolved) return true;
    if (c.startsWith(`${dotted}.`) && at.value !== undefined) return true;
  }
  return false;
}

/**
 * `value` walked along `segments` of object keys, as the engine's
 * `valueAtPath` (`createOnlyChangeRequiresReplacement`) walks it: a `*`, or a
 * list or scalar where an object is expected, is unresolved, and the engine
 * then replaces on ANY change under that top-level. An absent container
 * resolves to `undefined`.
 */
function valueAt(value: unknown, segments: string[]): { resolved: boolean; value?: unknown } {
  let current = value;
  for (const segment of segments) {
    if (segment === '*') return { resolved: false };
    if (current === undefined || current === null) return { resolved: true, value: undefined };
    if (typeof current !== 'object' || Array.isArray(current)) return { resolved: false };
    current = (current as Record<string, unknown>)[segment];
  }
  return { resolved: true, value: current };
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

// --- Where a varied value lands ----------------------------------------------
//
// Removal and variation see THAT the wire changed, not WHERE: a provider
// writing a property into a sibling member (`ReadCapacityUnits` sent as
// `WriteCapacityUnits`) changes the wire exactly as the right mapping does.
// So each vary probe that is not silent also diffs the two runs' command
// INPUTS and names the members whose value changed; one of them must be the
// varied leaf's own member (`wrongMember`).

/** A location in a command input: member names and list indices. */
type Location = (string | number)[];

/** Every leaf of a JSON value, by location. */
function flattenJson(value: unknown, prefix: Location, out: Map<string, unknown>): void {
  // An empty container is a leaf: `{}` is a value (S3's EventBridge switch).
  if (Array.isArray(value) && value.length > 0) {
    value.forEach((v, i) => flattenJson(v, [...prefix, i], out));
  } else if (value !== null && typeof value === 'object' && Object.keys(value).length > 0) {
    for (const [k, v] of Object.entries(value)) flattenJson(v, [...prefix, k], out);
  } else if (value !== null && typeof value === 'object') {
    out.set(JSON.stringify(prefix), Array.isArray(value) ? '[]' : '{}');
  } else {
    out.set(JSON.stringify(prefix), value);
  }
}

/** A JSON document carried as a string (a policy), parsed; else undefined. */
function embeddedJson(value: unknown): unknown {
  if (typeof value !== 'string' || !/^\s*[{[]/.test(value)) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** Locations whose value differs between two flattened inputs (either side). */
function changedLocations(a: Map<string, unknown>, b: Map<string, unknown>): Location[] {
  const changed: Location[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const [va, vb] = [a.get(key), b.get(key)];
    if (va === vb) continue;
    const loc = JSON.parse(key) as Location;
    const [ja, jb] = [embeddedJson(va), embeddedJson(vb)];
    if (ja !== undefined && jb !== undefined) {
      // A policy document's statement changed: name the member INSIDE it.
      const [fa, fb] = [new Map<string, unknown>(), new Map<string, unknown>()];
      flattenJson(ja, loc, fa);
      flattenJson(jb, loc, fb);
      changed.push(...changedLocations(fa, fb));
    } else {
      changed.push(loc);
    }
  }
  return changed;
}

/**
 * The sibling members naming the entry a `<base>Value` member belongs to
 * (`Key` / `Name` for `Value`, `AttributeName` for `AttributeValue`, `path`
 * for an API Gateway patch operation's `value`); none for any other member.
 */
function entryKeys(member: string): string[] {
  const m = /^(.*)(Value|value)$/.exec(member);
  if (!m) return [];
  const base = m[1]!;
  const keys = [`${base}Key`, `${base}Name`, `${base}key`, `${base}name`];
  return base === '' ? [...keys, 'path'] : keys;
}

/**
 * The member names a changed location stands for: every member on its way
 * (a list's items sit under `Items`, a filter's values under `Values`), and
 * for an entry spelled `{Key | Name | path, Value}` (a tag, an API Gateway
 * patch operation) what that sibling names.
 */
function namesAt(loc: Location, flat: Map<string, unknown>): string[] {
  const names = loc.filter((s): s is string => typeof s === 'string');
  let at = loc.length - 1;
  while (at >= 0 && typeof loc[at] === 'number') at--;
  for (const sibling of entryKeys(at >= 0 ? (loc[at] as string) : '')) {
    const v = flat.get(JSON.stringify([...loc.slice(0, at), sibling, ...loc.slice(at + 1)]));
    if (typeof v !== 'string') continue;
    // A patch path (`/*/*/caching/enabled`) names the member by its tail.
    const segs = v.split('/');
    names.push(v, ...segs.map((_, i) => segs.slice(i).join('')));
  }
  return names;
}

/**
 * Every member name whose value differs between two runs' inputs. Requests
 * pair up by command and occurrence; an unpaired one contributes all of its
 * members.
 */
export function landingNames(from: readonly string[], to: readonly string[]): string[] {
  const byCommand = (lines: readonly string[]) => {
    const m = new Map<string, unknown[]>();
    for (const line of lines) {
      const [command, input] = JSON.parse(line) as [string, unknown];
      m.set(command, [...(m.get(command) ?? []), input]);
    }
    return m;
  };
  const [a, b] = [byCommand(from), byCommand(to)];
  const names = new Set<string>();
  for (const command of new Set([...a.keys(), ...b.keys()])) {
    const [la, lb] = [a.get(command) ?? [], b.get(command) ?? []];
    for (let i = 0; i < Math.max(la.length, lb.length); i++) {
      const [fa, fb] = [new Map<string, unknown>(), new Map<string, unknown>()];
      if (i < la.length) flattenJson(la[i], [], fa);
      if (i < lb.length) flattenJson(lb[i], [], fb);
      for (const loc of changedLocations(fa, fb)) {
        for (const n of namesAt(loc, fb.has(JSON.stringify(loc)) ? fb : fa)) names.add(n);
      }
    }
  }
  return [...names].sort();
}

/** Member names compared case- and punctuation-blind: REST JSON spells `functionName`. */
const memberKey = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * The names the leaf at `path` of `bag` may land under: its own member name;
 * for an entry's `Value`, what its `Key` / `Name` sibling names (a map keyed
 * by it); for a `Key` / `Name`, its value before and after (it IS a map key).
 */
function expectedNames(bag: Bag, alt: Bag, path: Path): string[] {
  const leaf = [...path].reverse().find((s) => typeof s === 'string') as string | undefined;
  if (leaf === undefined) return [];
  // A list element is the list's own member.
  if (typeof path[path.length - 1] !== 'string') return [leaf];
  const parent = parentOf(bag, path);
  const names = [leaf];
  for (const s of entryKeys(leaf)) {
    if (typeof parent[s] === 'string') names.push(parent[s] as string);
  }
  if (/^(key|name)$/i.test(leaf)) {
    for (const v of [parent[leaf], parentOf(alt, path)[leaf]]) {
      if (typeof v === 'string') names.push(v);
    }
  }
  return names;
}

/** A bag path as `MEMBER_RENAMES` keys it: its member names, indices dropped. */
export const renameKey = (path: Path): string =>
  path.filter((s) => typeof s === 'string').join('.');

/**
 * Whether the varied leaf at `path` landed in a member of an expected name,
 * or of one `renames` accepts for that path (recorded in `used` as
 * `<path>-><member>`). Undefined when it did; else the members it did land
 * in, which is what an accepted rename would have to name.
 */
function wrongMember(
  path: Path,
  expected: string[],
  landed: string[],
  renames: Readonly<Record<string, readonly string[]>>,
  used: Set<string>
): string | undefined {
  if (expected.length === 0) return undefined;
  const landedKeys = new Set(landed.map(memberKey));
  if (expected.some((n) => landedKeys.has(memberKey(n)))) return undefined;
  const key = renameKey(path);
  const hit = (renames[key] ?? []).find((r) => landedKeys.has(memberKey(r)));
  if (hit !== undefined) {
    used.add(`${key}->${hit}`);
    return undefined;
  }
  return landed.length === 0 ? '(nothing)' : landed.join(',');
}

export type Outcome = { threw: false; wire: string } | { threw: true; message: string };

/**
 * A recorded run's command inputs, for `landingNames`. Kept beside the
 * outcome rather than on it: suites compare outcomes whole (`{ threw: false,
 * wire: '' }`), and the wire is what they pin.
 */
const inputsOf = new WeakMap<Outcome, string[]>();

export async function record(run: () => Promise<unknown>): Promise<Outcome> {
  wire.length = 0;
  calls.length = 0;
  inputs.length = 0;
  try {
    await run();
  } catch (error) {
    return { threw: true, message: (error as Error).message };
  }
  const outcome: Outcome = { threw: false, wire: wire.join('\n') };
  inputsOf.set(outcome, [...inputs]);
  return outcome;
}

export interface ProbeCase {
  resourceType: string;
  provider: () => ResourceProvider;
  physicalId: string;
  /**
   * Dotted create-only paths (`createOnlyOf`): the engine replaces when the
   * value AT one changes, so an update probe whose change touches one (at it,
   * beneath it or above it; `touchesCreateOnly`) is skipped.
   */
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
  /** CFn leaf name -> the SDK members it may land in under another name. */
  renames?: Readonly<Record<string, readonly string[]>>;
}

export interface ProbeResult {
  /** Probes whose removal (or variation) left the write sequence unchanged. */
  silent: string[];
  /** Probes where the reduced side THREW: removal cannot observe delivery there. */
  removalThrows: string[];
  /** The message of each removal throw, for diagnosing an unexpected entry. */
  messages: Record<string, string>;
  /**
   * Vary probes whose value landed in no member of the leaf's name nor an
   * accepted rename: probe label -> the members it did land in.
   */
  wrongMembers: Record<string, string>;
  /** The renames (`<leaf>-><member>`) some probe needed. */
  usedRenames: Set<string>;
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
 * that path is probed instead by changing its value: on update,
 * `update(next=full, prev=base)` vs `update(next=alt, prev=base)`, where `base`
 * lacks the leaf's parent so both sides make the same call and only the value
 * differs.
 *
 * Removal sees only THAT a member is sent, not WHAT: a create sending a fixed
 * value whenever the member is present passes it. So every scalar leaf is also
 * varied on create, `create(full)` vs `create(alt)` (`create-vary`), whether or
 * not its removal threw: the only probe that reads the VALUE of a create-only
 * leaf, which no update observes.
 *
 * An update probe whose change touches a create-only path (at, under or above
 * it) is skipped: the engine replaces instead of calling `update()`.
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
  // The same call must send the same requests: a value drawn afresh per call
  // (a token, a timestamp, a random draw) differs on every comparison, which
  // would make every probe below pass whatever reaches the wire.
  expect(await record(create(c.bag)), 'create is not deterministic').toEqual(full);
  expect(await record(update(c.bag, c.bag)), 'update is not deterministic').toEqual(settled);
  const fullWire = (full as { wire: string }).wire;

  const silent: string[] = [];
  const removalThrows: string[] = [];
  const messages: Record<string, string> = {};
  const wrongMembers: Record<string, string> = {};
  const usedRenames = new Set<string>();
  const trace = (label: string, path: Path, alt: Bag, from: Outcome, to: Outcome): void => {
    const landed = landingNames(inputsOf.get(from) ?? [], inputsOf.get(to) ?? []);
    const expected = expectedNames(c.bag, alt, path);
    const wrong = wrongMember(path, expected, landed, c.renames ?? {}, usedRenames);
    if (wrong !== undefined) wrongMembers[label] = wrong;
  };
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
    const replaces = touchesCreateOnly(c.createOnly, path, c.bag);
    let updateThrew = false;
    if (!replaces) {
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
    const isLeaf = paths(parentOf(c.bag, [...path, ''])).length === 0;
    const leaf = parentOf(c.bag, path)[path[path.length - 1]!];
    // Every updatable scalar leaf is also varied on update, whether or not its
    // removal threw: a provider that skips its setter while next equals prev
    // makes the removal comparisons call-versus-no-call, which any call passes
    // whatever it carries. Varying the value with `prev` fixed observes WHAT
    // the call sends (an empty container has no value to vary). Every scalar
    // leaf, create-only ones included, is varied on create for the same
    // reason (`create-vary`, above `probe`).
    const scalar = isLeaf && leaf !== null && typeof leaf !== 'object';
    const varyOnUpdate = updateThrew || (scalar && !replaces);
    const varyOnCreate = createThrew || scalar;
    if (!varyOnCreate && !varyOnUpdate) continue;
    // A container whose removal throws (a required list or document) cannot be
    // varied, but each path beneath it is probed on its own: those probes are
    // its delivery evidence. An EMPTY one has none, so it stays silent below.
    if (!isLeaf) continue;
    const alt = varied(
      c.bag,
      path,
      c.variants && label in c.variants ? { value: c.variants[label] } : undefined
    );
    if (varyOnCreate) {
      const altOutcome = alt === undefined ? undefined : await record(create(alt));
      if (altOutcome === undefined || altOutcome.threw || altOutcome.wire === fullWire) {
        silent.push(`create-vary:${label}`);
      } else {
        trace(`create-vary:${label}`, path, alt!, full, altOutcome);
      }
    }
    if (varyOnUpdate) {
      const base = without(c.bag, path.length > 1 ? path.slice(0, -1) : path);
      const before = await record(update(c.bag, base));
      const after = alt === undefined ? undefined : await record(update(alt, base));
      if (before.threw || after === undefined || after.threw || after.wire === before.wire) {
        silent.push(`update-vary:${label}`);
      } else {
        trace(`update-vary:${label}`, path, alt!, before, after);
      }
    }
  }
  return { silent, removalThrows, messages, wrongMembers, usedRenames };
}

// --- Cases and the suite that runs them ---------------------------------------

/** Why a removal throws, and a needle its message must match. */
export interface Throw {
  why: string;
  says: RegExp;
}

export interface BagCase {
  name: string;
  bag: Bag;
  variants?: Record<string, unknown>;
  /** Overrides the type's `arm` for this bag, e.g. a live state no bag spells. */
  arm?: (physicalId: string, bag: Bag) => void;
  /** Probe label -> why it is silent. Exact: a fixed gap must leave the list. */
  expectedSilent?: Record<string, string>;
  /**
   * Probe label -> why removing that path throws. Exact, like `expectedSilent`,
   * and each throw's message must match its needle: a throw for another reason
   * is not the refusal the entry names.
   */
  expectedRemovalThrows?: Record<string, Throw>;
}

export interface TypeCase {
  resourceType: string;
  provider: () => ResourceProvider;
  physicalId: string;
  createOnly: ReadonlySet<string>;
  /** Arms the fake reads for a bag (default: none), e.g. what a list answers. */
  arm?: (physicalId: string, bag: Bag) => void;
  /** What every `update()` receives as its context (the record's attributes). */
  updateContext?: UpdateContext;
  /**
   * Top-levels whose `update()` re-sends the WHOLE value from `next` and never
   * reads `prev`: every `update-remove` probe at or under such a key is silent
   * by design (`next` alone delivers it, as its `update-add` probe observes).
   */
  wholeFromNext?: { keys: (key: string) => boolean; reason: string };
  /** `handledProperties` entries no bag carries, each with the reason. */
  exempt: Record<string, string>;
  /**
   * `<Top>.<path>` -> why no bag carries that nested path (array indices
   * dropped) of a carried top-level the schema fixture's `nestedPropertyPaths`
   * lists.
   */
  nestedExempt?: Record<string, string>;
  /**
   * Removal probes that only see THAT the wire changed, not WHICH member it
   * names: removing one element of a two-element list (or one key of a map)
   * from `bags[0]` must send `command` exactly once, naming `names` and not
   * `notNames` in its query string or body. With `where`, only `command`
   * requests whose body contains it count (a clear among the same command's
   * writes).
   */
  targets: { path: Path; command: string; names: string; notNames: string; where?: string }[];
  bags: BagCase[];
  /**
   * A type whose `handledProperties` is EMPTY (every schema property is
   * read-only), so there is no bag to probe: `bags`, `exempt` and `targets`
   * stay empty, and `create({})` / `update({}, {})` must succeed sending
   * exactly `calls` (`<Command> <path>`, reads included, in order). The
   * create must return `createdId` (exactly, or matching a pattern; the
   * type's `arm` answers the reads); the update must keep `physicalId`, unreplaced.
   */
  noProperties?: {
    reason: string;
    calls: { create: string[]; update: string[] };
    createdId: string | RegExp;
  };
}

interface SchemaFixture {
  createOnlyPropertyPaths: string[][];
  nestedPropertyPaths?: Record<string, string[]>;
}

/** A type's committed schema fixture. */
function fixtureOf(resourceType: string): SchemaFixture {
  const file = new URL(
    `../../fixtures/cfn-schemas/${resourceType.replaceAll('::', '-')}.json`,
    import.meta.url
  );
  return JSON.parse(readFileSync(file, 'utf8')) as SchemaFixture;
}

/** A type's create-only paths, dotted, from its committed schema fixture. */
export function createOnlyOf(resourceType: string): ReadonlySet<string> {
  return new Set(fixtureOf(resourceType).createOnlyPropertyPaths.map((p) => p.join('.')));
}

/** Top-level -> every dotted nested path beneath it (no array indices), from the fixture. */
function nestedPathsOf(resourceType: string): Record<string, string[]> {
  return fixtureOf(resourceType).nestedPropertyPaths ?? {};
}

export const TAGS_REFUSED: Throw = {
  why: 'a Tags entry without its Key or Value is refused before any call (go-to-k/cdkd#3994)',
  says: /is not a list of tags/,
};

/** `TAGS_REFUSED` for `Tags.<i>.Key` / `.Value`, i < `count`, in each direction. */
export const TAG_THROWS = (directions: string[], count: number): Record<string, Throw> =>
  Object.fromEntries(
    directions.flatMap((d) =>
      Array.from({ length: count }, (_, i) => [
        [`${d}:Tags.${i}.Key`, TAGS_REFUSED],
        [`${d}:Tags.${i}.Value`, TAGS_REFUSED],
      ]).flat()
    )
  );

// Not a gap: the value IS what the service holds when the member is unset (no
// filter, raw delivery off, type String, no pattern / description / key), so
// sending it and omitting it leave the same resource.
export const DECLARED_DEFAULT = 'the declared value is what an unset member reads as';

/** The per-type wire suite over `cases`: property coverage, path delivery, targets. */
export function describeWireCases(cases: TypeCase[]): void {
  describe.each(cases)('$resourceType', (t) => {
    const renames = MEMBER_RENAMES[t.resourceType] ?? {};
    const usedRenames = new Set<string>();
    it('its bags carry every handledProperties entry not exempted', () => {
      const handled = [...(t.provider().handledProperties?.get(t.resourceType) ?? [])].sort();
      // An empty set is a case only when the case says so, with its reason;
      // and a case saying so must handle nothing.
      if (t.noProperties) {
        expect(t.noProperties.reason).not.toBe('');
        expect(t.provider().handledProperties?.has(t.resourceType)).toBe(true);
        expect({ handled, bags: t.bags, exempt: t.exempt, targets: t.targets }).toEqual({
          handled: [],
          bags: [],
          exempt: {},
          targets: [],
        });
        return;
      }
      expect(handled.length).toBeGreaterThan(0);
      const carried = new Set(t.bags.flatMap((b) => Object.keys(b.bag)));
      for (const key of carried) expect(handled).toContain(key);
      for (const key of Object.keys(t.exempt)) expect(carried.has(key)).toBe(false);
      expect([...carried, ...Object.keys(t.exempt)].sort()).toEqual(handled);
    });

    it('its bags carry every nested path the schema lists under a carried top-level', () => {
      const nested = nestedPathsOf(t.resourceType);
      const exempt = t.nestedExempt ?? {};
      const missing: string[] = [];
      for (const [top, schemaPaths] of Object.entries(nested)) {
        const carriers = t.bags.filter((b) => top in b.bag).map((b) => b.bag[top]);
        if (carriers.length === 0) continue;
        // Path-scoped: a member counts only at the depth the schema puts it.
        const seen = new Set(
          carriers.flatMap((v) =>
            paths(v).map((p) => p.filter((seg) => typeof seg === 'string').join('.'))
          )
        );
        for (const path of schemaPaths) {
          const label = `${top}.${path}`;
          if (label in exempt) {
            // A stale exemption: a bag now carries it.
            expect(seen.has(path), label).toBe(false);
          } else if (!seen.has(path)) {
            missing.push(label);
          }
        }
      }
      expect(missing).toEqual([]);
      // An exemption naming no schema path is stale too.
      for (const label of Object.keys(exempt)) {
        const [top, ...rest] = label.split('.');
        expect(nested[top!] ?? [], label).toContain(rest.join('.'));
      }
    });

    if (t.noProperties) {
      const expected = t.noProperties.calls;
      it('creates and updates with no properties, sending only the declared calls', async () => {
        const p = t.provider();
        // `record` keeps the wire, not the result, so each run hands it out.
        let createdResult: unknown;
        armFor(t, {});
        const created = await record(async () => {
          createdResult = await p.create('L', t.resourceType, {});
        });
        expect(created).toMatchObject({ threw: false });
        expect([...calls], 'create').toEqual(expected.create);
        const createdId = (createdResult as { physicalId: string }).physicalId;
        const want = t.noProperties!.createdId;
        if (typeof want === 'string') expect(createdId).toBe(want);
        else expect(createdId).toMatch(want);
        let updatedResult: unknown;
        armFor(t, {});
        const updated = await record(async () => {
          updatedResult = await p.update('L', t.physicalId, t.resourceType, {}, {}, t.updateContext);
        });
        expect(updated).toMatchObject({ threw: false });
        expect([...calls], 'update').toEqual(expected.update);
        expect(updatedResult).toMatchObject({ physicalId: t.physicalId, wasReplaced: false });
      });
      return;
    }

    it.each(t.bags)('delivers every path of the $name bag', async (b) => {
      const { silent, removalThrows, messages, wrongMembers, ...rest } = await probe({
        ...t,
        bag: b.bag,
        variants: b.variants,
        arm: b.arm ?? t.arm,
        renames,
      });
      for (const r of rest.usedRenames) usedRenames.add(r);
      // A varied value must land in its own member (or an accepted rename):
      // probe label -> the members it landed in instead.
      expect(wrongMembers, 'landed in another member; see sdk-wire-member-renames.ts').toEqual({});
      const byDesign = t.wholeFromNext;
      const wholeFromNext = byDesign
        ? paths(b.bag)
            .filter((p) => byDesign.keys(String(p[0])) && !touchesCreateOnly(t.createOnly, p, b.bag))
            .map((p) => `update-remove:${p.join('.')}`)
            // A removal that throws is a removal throw, not a silent probe.
            .filter((label) => !(label in (b.expectedRemovalThrows ?? {})))
        : [];
      const expectedSilent = [...new Set([...Object.keys(b.expectedSilent ?? {}), ...wholeFromNext])];
      // One assertion, so a failure shows both lists and each throw's message.
      expect(
        { silent: silent.sort(), removalThrows: removalThrows.sort() },
        JSON.stringify(messages, null, 2)
      ).toEqual({
        silent: expectedSilent.sort(),
        removalThrows: Object.keys(b.expectedRemovalThrows ?? {}).sort(),
      });
      for (const [label, expected] of Object.entries(b.expectedRemovalThrows ?? {})) {
        expect(messages[label], `${label}: ${expected.why}`).toMatch(expected.says);
      }
    });

    it.each(t.targets)('removing $path sends $command naming only $names', async (target) => {
      const full = t.bags[0]!.bag;
      armFor(t, full);
      const outcome = await record(() =>
        t
          .provider()
          .update(
            'L',
            t.physicalId,
            t.resourceType,
            without(full, target.path),
            structuredClone(full),
            t.updateContext
          )
      );
      expect(outcome).toMatchObject({ threw: false });
      // A REST protocol carries the named member in the query string (DLM's
      // `UntagResource` sends `tagKeys` there, with no body), so the query
      // counts beside the body; the path and headers do not.
      const requests = (outcome as { wire: string }).wire
        .split('\n')
        .map((line) => JSON.parse(line) as unknown[])
        .filter((entry) => entry[0] === target.command)
        .map((entry) => ({
          body: entry[entry.length - 1] as string,
          query: JSON.stringify(entry[3] ?? null),
        }))
        .filter((r) => target.where === undefined || r.body.includes(target.where));
      expect(requests).toHaveLength(1);
      const named = `${requests[0]!.query}\n${requests[0]!.body}`;
      expect(named).toContain(target.names);
      expect(named).not.toContain(target.notNames);
    });

    // After the bag probes, which record what they needed: a rename no probe
    // reached is stale (the mapping now uses the member's own name, or the
    // bag no longer carries the path), and staying listed it would excuse a
    // regression into that member.
    it('uses every accepted rename', () => {
      const listed = Object.entries(renames).flatMap(([path, names]) =>
        names.map((n) => `${path}->${n}`)
      );
      expect(listed.filter((r) => !usedRenames.has(r))).toEqual([]);
    });
  });
}
