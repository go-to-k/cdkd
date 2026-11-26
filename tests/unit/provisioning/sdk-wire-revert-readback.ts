import { it, expect } from 'vite-plus/test';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource/read-state.js';
import {
  addOutputOverrides,
  armFor,
  flattenJson,
  inputsOfOutcome,
  paths,
  record,
  setFakeShape,
  touchesCreateOnly,
  without,
  type Bag,
  type FakeShape,
  type Outcome,
  type Path,
  type TypeCase,
} from './sdk-wire-harness.js';
import {
  REVERT_DECLARED_SKIPPED,
  REVERT_FAILED_READBACKS,
  REVERT_NO_PLACEHOLDERS,
  REVERT_PLACEHOLDER_ALLOWED,
  REVERT_READBACK_EXEMPT,
} from './sdk-wire-revert-readback-allowed.js';
import { READBACK_ARMS } from './sdk-wire-revert-readback-arms.js';

/**
 * go-to-k/cdkd#7025 step 7: `cdkd drift --revert` hands `update()` the
 * provider's own read-back as both sides (`desiredFromAwsReadback`), with the
 * drifted member put back. A read-back placeholder (`{}`, `[]`, `''`, a
 * defaulted `0`: what `readCurrentState` writes for a block AWS reports none
 * of) forwarded as written is refused or misread by many services (#6777,
 * #6986, #7019, #7027, #7028, #7029).
 *
 * Per type: read the live resource with its optional blocks unset (the fake
 * answers `shallow` and `bare`, `full` only when neither reverts; the reads
 * are armed by `READBACK_ARMS`, then the case's `arm` for an unconfigured
 * resource, then for its first bag), revert one changed scalar member through
 * `update()`, and compare that wire with the same revert after each
 * placeholder is taken out of both sides. A placeholder whose presence
 * changes what is sent reached the wire: the check fails unless
 * `sdk-wire-revert-readback-allowed.ts` names it with its AWS behavior.
 */

/** A read-back placeholder: an empty block, list or string, or a zero. */
function isPlaceholder(value: unknown): boolean {
  if (value === '' || value === 0) return true;
  if (Array.isArray(value)) return value.length === 0;
  return value !== null && typeof value === 'object' && Object.keys(value).length === 0;
}

/** What a changed leaf carries on the wire when it is a placeholder sent as written. */
function isEmptyLeaf(value: unknown): boolean {
  return value === '' || value === 0 || value === '{}' || value === '[]';
}

/**
 * The live resource with its optional blocks unset (`shallow`, `bare`); a
 * `full` answer (every member, lists empty) only when neither reverts.
 */
const MINIMAL_SHAPES: FakeShape[] = ['shallow', 'bare'];
const FALLBACK_SHAPES: FakeShape[] = ['full'];

interface Readback {
  shape: FakeShape;
  /** Arms the fake reads for the live resource this read-back came from. */
  arm: () => void;
  bag: Bag;
}

export interface Hit {
  /** `<Type>#<read-back path>`, the allow-list key. */
  key: string;
  /** `sent`: an empty leaf or zero reached the wire; `changed`: another member did; `throws`. */
  kind: 'sent' | 'changed' | 'throws';
  detail: string;
}

export interface RevertReadbackResult {
  /** Why no revert could be checked; undefined when one was. */
  unchecked?: string;
  readbacks: number;
  /** The distinct placeholder paths some revert probed. */
  placeholders: number;
  /** Per read-back no revert of which succeeded, while another one did: why. */
  failedReadbacks: string[];
  hits: Hit[];
}

/** A command input's leaves keyed `<command>#<occurrence> <location>`. */
function flatInputs(lines: readonly string[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const seen = new Map<string, number>();
  for (const line of lines) {
    const [command, input] = JSON.parse(line) as [string, unknown];
    const n = seen.get(command) ?? 0;
    seen.set(command, n + 1);
    const flat = new Map<string, unknown>();
    flattenJson(input, [], flat);
    for (const [loc, v] of flat) out.set(`${command}#${n} ${loc}`, v);
  }
  return out;
}

/** The leaves that differ, as `<key>: <with> vs <without>`, and whether one sent an empty leaf. */
function wireDelta(a: Outcome, b: Outcome): { lines: string[]; sentEmpty: boolean } {
  const [fa, fb] = [flatInputs(inputsOfOutcome(a)), flatInputs(inputsOfOutcome(b))];
  const lines: string[] = [];
  let sentEmpty = false;
  for (const key of new Set([...fa.keys(), ...fb.keys()])) {
    const [va, vb] = [fa.get(key), fb.get(key)];
    if (va === vb) continue;
    if (fa.has(key) && isEmptyLeaf(va)) sentEmpty = true;
    lines.push(`${key}: ${JSON.stringify(va)} vs ${JSON.stringify(vb)}`);
  }
  return { lines, sentEmpty };
}

/**
 * The reverts to try: the read-back with one scalar member changed (a drift
 * put back), shallowest first; then each top-level member set to the case's
 * declared value. Each with the path it changed.
 */
function revertedMember(
  t: TypeCase,
  readback: Bag,
  handled: ReadonlySet<string>
): { desired: Bag; changed: Path }[] {
  const out: { desired: Bag; changed: Path }[] = [];
  const leaves = paths(readback)
    .filter((path) => handled.has(String(path[0])))
    .filter((path) => !touchesCreateOnly(t.createOnly, path, readback))
    .sort((x, y) => x.length - y.length);
  for (const path of leaves) {
    const value = valueAtPath(readback, path);
    let alt: unknown;
    if (typeof value === 'string' && value !== '') alt = `${value}-alt`;
    else if (typeof value === 'number' && value !== 0) alt = value + 1;
    else if (typeof value === 'boolean') alt = !value;
    else continue;
    const desired = structuredClone(readback);
    let node = desired as Record<string | number, unknown>;
    for (const seg of path.slice(0, -1)) node = node[seg] as Record<string | number, unknown>;
    node[path[path.length - 1]!] = alt;
    out.push({ desired, changed: path });
  }
  const declared = t.bags[0]?.bag ?? {};
  for (const [key, value] of Object.entries(declared)) {
    if (touchesCreateOnly(t.createOnly, [key], declared)) continue;
    if (JSON.stringify(readback[key]) === JSON.stringify(value)) continue;
    if (`${t.resourceType}#${key}` in REVERT_DECLARED_SKIPPED) continue;
    out.push({
      desired: { ...structuredClone(readback), [key]: structuredClone(value) },
      changed: [key],
    });
  }
  return out;
}

async function readbacksOf(
  t: TypeCase,
  shapes: readonly FakeShape[],
  misses: string[]
): Promise<Readback[]> {
  const p = t.provider();
  const out: Readback[] = [];
  const seen = new Set<string>();
  const declared = t.bags[0]?.bag ?? {};
  for (const shape of shapes) {
    const live = READBACK_ARMS[t.resourceType];
    const arms: [string, () => void][] = [
      ...(live
        ? [
            [
              'readback-arm',
              () => {
                armFor(t, {});
                addOutputOverrides(live(t.physicalId));
              },
            ] as [string, () => void],
          ]
        : []),
      ['unconfigured', () => armFor(t, {})],
      ['declared', () => armFor(t, declared)],
    ];
    for (const [armName, arm] of arms) {
      setFakeShape(shape);
      arm();
      let bag: unknown;
      try {
        bag = await p.readCurrentState!(t.physicalId, 'L', t.resourceType, structuredClone(declared));
      } catch (error) {
        misses.push(`${shape}/${armName} read throws: ${(error as Error).message.slice(0, 120)}`);
        continue;
      }
      if (bag === RESOURCE_NOT_FOUND) {
        misses.push(`${shape}/${armName} read: not found`);
        continue;
      }
      if (bag === undefined || bag === null || typeof bag !== 'object') {
        misses.push(`${shape}/${armName} read: ${String(bag)}`);
        continue;
      }
      if (Object.keys(bag).length === 0) {
        misses.push(`${shape}/${armName} read: {}`);
        continue;
      }
      const spelled = JSON.stringify(bag);
      if (seen.has(spelled)) continue;
      seen.add(spelled);
      out.push({ shape, arm, bag: bag as Bag });
    }
  }
  setFakeShape('full');
  return out;
}

/**
 * `bag` without `path`, and without each ancestor that removal leaves empty:
 * an emptied parent would itself be a placeholder the other run lacks.
 */
function withoutPruned(bag: Bag, path: Path): Bag {
  let out = without(bag, path);
  for (let up = path.slice(0, -1); up.length > 0; up = up.slice(0, -1)) {
    if (!isPlaceholder(valueAtPath(out, up))) break;
    out = without(out, up);
  }
  return out;
}

function valueAtPath(bag: Bag, path: Path): unknown {
  let node: unknown = bag;
  for (const seg of path) node = (node as Record<string | number, unknown>)[seg];
  return node;
}

/**
 * Revert each changed member of `rb` in turn and compare each wire with the
 * same revert without each placeholder, into `hits` (`probed` collects the
 * placeholder paths a successful revert probed); why not, when no revert of
 * `rb` succeeds.
 */
async function checkOne(
  t: TypeCase,
  rb: Readback,
  handled: ReadonlySet<string>,
  hits: Map<string, Hit>,
  probed: Set<string>
): Promise<string | undefined> {
  const p = t.provider();
  const context = { ...t.updateContext, desiredFromAwsReadback: true };
  const update = (next: Bag, prev: Bag) => () => {
    rb.arm();
    return p.update('L', t.physicalId, t.resourceType, structuredClone(next), structuredClone(prev), context);
  };
  const placeholderPaths = paths(rb.bag).filter((path) => isPlaceholder(valueAtPath(rb.bag, path)));
  const reasons: string[] = [];
  const probedOn = new Set<string>();
  let reverted = false;
  // One successful revert per top-level member: a member set whole to the
  // template's value (which may start a slow transition, such as a Firehose
  // destination's) only when no scalar under it reverted.
  const revertedTops = new Set<unknown>();
  for (const { desired, changed } of revertedMember(t, rb.bag, handled)) {
    if (revertedTops.has(changed[0])) continue;
    const changedKey = changed.join('.');
    const base = await record(update(desired, rb.bag));
    const again = await record(update(desired, rb.bag));
    if (JSON.stringify(base) !== JSON.stringify(again)) {
      reasons.push(`revert of ${changedKey} is not deterministic`);
      continue;
    }
    // A placeholder under a member set whole is part of that change; one
    // already probed on a revert making the same calls says nothing new.
    const calls = base.threw ? 'threw' : base.wire.split('\n').map((l) => l.slice(0, l.indexOf(','))).join(' ');
    const probes = placeholderPaths.filter(
      (path) =>
        !changed.every((seg, i) => path[i] === seg) && !probedOn.has(`${calls} ${path.join('.')}`)
    );
    for (const path of probes) probedOn.add(`${calls} ${path.join('.')}`);
    const outcomes: [Path, Outcome][] = [];
    for (const path of probes) {
      outcomes.push([
        path,
        await record(update(withoutPruned(desired, path), withoutPruned(rb.bag, path))),
      ]);
    }
    if (base.threw && outcomes.every(([, o]) => o.threw)) {
      reasons.push(`revert of ${changedKey} throws: ${base.message.slice(0, 160)}`);
      continue;
    }
    reverted = true;
    revertedTops.add(changed[0]);
    for (const [path, o] of outcomes) {
      const key = `${t.resourceType}#${path.join('.')}`;
      probed.add(key);
      if (hits.has(key)) continue;
      if (base.threw && !o.threw) {
        hits.set(key, { key, kind: 'throws', detail: base.message });
      } else if (!base.threw && !o.threw && base.wire !== o.wire) {
        const { lines, sentEmpty } = wireDelta(base, o);
        hits.set(key, {
          key,
          kind: sentEmpty ? 'sent' : 'changed',
          detail: `revert of ${changedKey}: ${lines.slice(0, 6).join('; ') || '(wire differs outside the inputs)'}`,
        });
      }
    }
  }
  if (reverted) return undefined;
  return `${rb.shape}: ${reasons.join('; ') || 'no updatable member to revert'}`;
}

/** Run the check for one type (exposed so the exemptions can prove they are still needed). */
export async function checkRevertReadback(t: TypeCase): Promise<RevertReadbackResult> {
  return runCheck(t);
}

async function runCheck(t: TypeCase): Promise<RevertReadbackResult> {
  const p = t.provider();
  const result: RevertReadbackResult = {
    readbacks: 0,
    placeholders: 0,
    failedReadbacks: [],
    hits: [],
  };
  if (t.noProperties) return { ...result, unchecked: 'handles no properties' };
  if (typeof p.readCurrentState !== 'function') {
    return { ...result, unchecked: 'no readCurrentState' };
  }
  const handled = new Set(p.handledProperties?.get(t.resourceType) ?? []);
  const hits = new Map<string, Hit>();
  const probed = new Set<string>();
  const reasons: string[] = [];
  const failed: string[] = [];
  let reverted = 0;
  try {
    for (const shapes of [MINIMAL_SHAPES, FALLBACK_SHAPES]) {
      const readbacks = await readbacksOf(t, shapes, reasons);
      result.readbacks += readbacks.length;
      for (const rb of readbacks) {
        // The update's own reads (a status a wait polls, the live value it
        // diffs against) answer `shallow` after a `bare` read: a bare answer
        // reports no status, so every wait would run to its timeout.
        setFakeShape(rb.shape === 'bare' ? 'shallow' : rb.shape);
        const why = await checkOne(t, rb, handled, hits, probed);
        if (why === undefined) reverted++;
        else failed.push(why);
      }
      if (reverted > 0) break;
    }
  } finally {
    setFakeShape('full');
  }
  result.hits = [...hits.values()];
  result.placeholders = probed.size;
  if (reverted === 0) return { ...result, unchecked: [...reasons, ...failed].join(' | ') };
  result.failedReadbacks = failed;
  return result;
}

/** Whether an allow-list reason does not record a measured AWS behavior. */
export const isUnmeasured = (why: string): boolean => !why.startsWith('measured:');

/** The per-type read-back revert check, registered inside `describeWireCases`. */
export function describeRevertReadback(t: TypeCase): void {
  const exempt = REVERT_READBACK_EXEMPT[t.resourceType];
  if (exempt !== undefined) {
    it('is exempt from the read-back revert check for a reason that still holds (#7025)', async () => {
      const r = await checkRevertReadback(t);
      expect(r.unchecked, `stale exemption: ${exempt.why}`).toMatch(exempt.says);
    });
    return;
  }
  const allowed = Object.entries(REVERT_PLACEHOLDER_ALLOWED).filter(([k]) =>
    k.startsWith(`${t.resourceType}#`)
  );
  for (const [key, why] of allowed) {
    if (isUnmeasured(why)) it.todo(`allows a read-back placeholder not measured on AWS: ${key} (${why})`);
  }
  it('reverts its own read-back without sending a placeholder back (#7025)', async () => {
    const r = await checkRevertReadback(t);
    expect(r.unchecked, 'no revert of the read-back could be checked').toBeUndefined();
    // It saw its input: a placeholder was probed, unless none is listed.
    const none = REVERT_NO_PLACEHOLDERS[t.resourceType];
    if (none === undefined) {
      expect(r.placeholders, 'no placeholder probed; list it in REVERT_NO_PLACEHOLDERS').toBeGreaterThan(0);
    } else {
      expect(r.placeholders, `stale REVERT_NO_PLACEHOLDERS entry: ${none}`).toBe(0);
    }
    // Every read-back shape reverted, or the one that does not is listed.
    const failed = REVERT_FAILED_READBACKS[t.resourceType];
    if (failed === undefined) {
      expect(r.failedReadbacks, 'a read-back no revert of which succeeds').toEqual([]);
    } else {
      expect(r.failedReadbacks.join(' | '), failed.why).toMatch(failed.says);
    }
    const refused = r.hits.filter((h) => !(h.key in REVERT_PLACEHOLDER_ALLOWED));
    expect(
      refused.map((h) => `${h.key} [${h.kind}] ${h.detail}`),
      'a read-back placeholder reached the wire; omit it under desiredFromAwsReadback, or allow-list it with the measured AWS behavior (sdk-wire-revert-readback-allowed.ts)'
    ).toEqual([]);
    const hit = new Set(r.hits.map((h) => h.key));
    expect(
      allowed.map(([k]) => k).filter((k) => !hit.has(k)),
      'stale allow-list entries'
    ).toEqual([]);
  }, 60_000);
}
