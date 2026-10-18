import { describe, it, expect } from 'vite-plus/test';
import {
  redactForState,
  isSameGenerationBag,
  recordResolvedPair,
  recordSecretResolution,
  openRecordingScope,
  maskSecretsInText,
  maskSecretsInError,
  recordLogOnlyValue,
  createSecretMasker,
  type LiveScopePolicy,
  type RedactionContext,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { redactSecretsForState } from '../../../src/deployment/secret-redaction/redact-state.js';
import {
  TEMPLATE_DERIVED_RULES,
  TEMPLATE_SOURCED_RULES,
  STATE_SOURCED_READBACK_RULES,
  STATE_SOURCED_BASELINE_RULES,
  STATE_SOURCED_CROSS_GENERATION_RULES,
  STATE_DERIVED_RULES,
} from '../../../src/deployment/secret-redaction/rules.js';
import { rulesForProvenance } from '../../../src/deployment/secret-redaction/context.js';
import { recordProvenPublicExpression } from '../../../src/deployment/secret-redaction/mask-only.js';
import { EXPORT_NAME_SCOPE } from '../../../src/deployment/deploy-engine/outputs.js';

// go-to-k/cdkd#1940: the provenance-typed choke point. The property half keys
// its oracle on the plaintext the GENERATOR planted, never on the recorded
// map the redactor reads -- a check consulting the same recording a bug skips
// inherits that bug's blind spot.

describe('redactForState: provenance selects the rules', () => {
  it('maps every positional provenance to its rules constant', () => {
    expect(rulesForProvenance('template-derived')).toBe(TEMPLATE_DERIVED_RULES);
    expect(rulesForProvenance('template-sourced')).toBe(TEMPLATE_SOURCED_RULES);
    expect(rulesForProvenance('state-readback')).toBe(STATE_SOURCED_READBACK_RULES);
    expect(rulesForProvenance('state-baseline')).toBe(STATE_SOURCED_BASELINE_RULES);
    expect(rulesForProvenance('state-cross-generation')).toBe(
      STATE_SOURCED_CROSS_GENERATION_RULES
    );
    expect(rulesForProvenance('state-derived')).toBe(STATE_DERIVED_RULES);
  });

  it('refuses at compile time a positional provenance without its source or claim', () => {
    const secrets: RecordedSecretValues = new Map();
    // @ts-expect-error -- a positional provenance must name its source
    const noSource: RedactionContext = { provenance: 'state-baseline', secrets };
    // @ts-expect-error -- the generation claim is required for template-derived
    const noClaim: RedactionContext = { provenance: 'template-derived', secrets, source: {} };
    // @ts-expect-error -- so is template-sourced's (go-to-k/cdkd#5047)
    const noSourcedClaim: RedactionContext = { provenance: 'template-sourced', secrets, source: {} };
    // @ts-expect-error -- a value scan has no source to walk
    const scanWithSource: RedactionContext = { provenance: 'value-scan', secrets, source: {} };
    const maybe = undefined as Record<string, unknown> | undefined;
    // @ts-expect-error -- a possibly-undefined source would silently become a value scan
    const maybeSource: RedactionContext = { provenance: 'state-readback', secrets, source: maybe };
    expect([noSource, noClaim, noSourcedClaim, scanWithSource, maybeSource]).toHaveLength(5);
  });

  it('keeps the same-generation mark off both the caller bag and the result', () => {
    const expr = '{{resolve:secretsmanager:s:SecretString:k}}';
    const plaintext = 'PLANTEDSECRET0001';
    const secrets: RecordedSecretValues = new Map([[plaintext, expr]]);
    const context: RedactionContext = {
      provenance: 'template-derived',
      secrets,
      source: { A: expr, B: 'public' },
      generation: 'same-generation',
    };
    const redactedIn = { A: plaintext, B: 'public' };
    const redactedOut = redactForState(redactedIn, context);
    expect(redactedOut).toEqual({ A: expr, B: 'public' });

    // Nothing to redact: the result must still not be the MARKED copy the
    // choke point handed the walk.
    const untouchedIn = { B: 'public' };
    const untouchedOut = redactForState(untouchedIn, context);
    expect(untouchedOut).toEqual(untouchedIn);
    expect(untouchedOut).not.toBe(untouchedIn);

    for (const bag of [redactedIn, redactedOut, untouchedIn, untouchedOut]) {
      expect(isSameGenerationBag(bag)).toBe(false);
    }
  });

  it('keeps the mark off the result where the walk falls back to the value scan', () => {
    // A root shape the source does not share, on an empty map: the walk hands
    // its input back by identity, which inside the choke point is the marked
    // copy.
    const secrets: RecordedSecretValues = new Map();
    const shapes: Array<[unknown, object]> = [
      [['a', 'b'], { A: 'a' }],
      [{ A: 'x' }, ['x']],
    ];
    for (const [bag, source] of shapes) {
      const out = redactForState(bag, {
        provenance: 'template-derived',
        secrets,
        source,
        generation: 'same-generation',
      });
      expect(out).toEqual(bag);
      expect(isSameGenerationBag(out)).toBe(false);
    }
  });

  it('never marks a non-plain bag, which a spread copy would strip of its prototype', () => {
    class Props {
      constructor(public readonly A: string) {}
    }
    const bag = new Props('x');
    const out = redactForState(bag, {
      provenance: 'template-derived',
      secrets: new Map(),
      source: { A: 'x' },
      generation: 'same-generation',
    });
    expect(out).toBeInstanceOf(Props);
    expect(isSameGenerationBag(out)).toBe(false);
    expect(isSameGenerationBag(bag)).toBe(false);
  });

  it('makes the generation claim reach the walk (a sub-floor embedded secret)', () => {
    // A 1-3 character secret embedded in a literal sits below the value
    // scan's needle floor; only a bag proven same-generation lets the span arm
    // write it as its token. The claim must therefore change the outcome.
    const expr = '{{resolve:secretsmanager:short:SecretString:k}}';
    const plaintext = 'q7';
    const secrets: RecordedSecretValues = new Map([[plaintext, expr]]);
    recordResolvedPair(secrets, expr, plaintext);
    const source = { Url: `https://host/${expr}/path` };
    const bag = { Url: `https://host/${plaintext}/path` };
    const viaClaim = redactForState(bag, {
      provenance: 'template-derived',
      secrets,
      source,
      generation: 'same-generation',
    });
    const viaUnproven = redactForState(bag, {
      provenance: 'template-derived',
      secrets,
      source,
      generation: 'unproven',
    });
    expect(viaClaim).toEqual(source);
    expect(viaUnproven).not.toEqual(viaClaim);
  });

  it('is byte-identical to the loose-argument call for every provenance', () => {
    const expr = '{{resolve:secretsmanager:s:SecretString:k}}';
    const plaintext = 'PLANTEDSECRET0002';
    const secrets: RecordedSecretValues = new Map([[plaintext, expr]]);
    const source = { A: expr, L: [`x-${expr}`], M: `pre-${expr}-post` };
    const bag = { A: plaintext, L: [`x-${plaintext}`], M: `pre-${plaintext}-post` };
    const positional = [
      ['template-derived', TEMPLATE_DERIVED_RULES],
      ['template-sourced', TEMPLATE_SOURCED_RULES],
      ['state-readback', STATE_SOURCED_READBACK_RULES],
      ['state-baseline', STATE_SOURCED_BASELINE_RULES],
      ['state-cross-generation', STATE_SOURCED_CROSS_GENERATION_RULES],
      ['state-derived', STATE_DERIVED_RULES],
    ] as const;
    for (const [provenance, rules] of positional) {
      const context = (
        provenance === 'template-derived' ||
        provenance === 'template-sourced' ||
        provenance === 'state-derived'
          ? { provenance, secrets, source, generation: 'unproven' }
          : { provenance, secrets, source }
      ) as RedactionContext;
      expect(redactForState(bag, context)).toEqual(
        redactSecretsForState(bag, secrets, source, rules)
      );
    }
    expect(redactForState(bag, { provenance: 'value-scan', secrets })).toEqual(
      redactSecretsForState(bag, secrets)
    );
  });
});

// ---------------------------------------------------------------------------
// Property half: generated (template, resolution, readback) triples.
// ---------------------------------------------------------------------------

/** mulberry32: a seeded PRNG, so a failing seed reproduces. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Plant {
  expression: string;
  /** The expression a PREVIOUS generation of the template / record spelled. */
  previousExpression: string;
  value: string;
  secret: boolean;
  /**
   * A `NoEcho` parameter's value: a LOG-ONLY needle (go-to-k/cdkd#1998),
   * masked in every print and deliberately not rewritten in what persists,
   * so property (c) holds for it and (a) does not. The template spells it
   * resolved, as the persist walk sees a parameter's value.
   */
  logOnly: boolean;
  /** (ii) below `MIN_NEEDLE_LENGTH`: no substring scan sees it embedded. */
  subFloor: boolean;
  /**
   * (i) Where the resolver's recording of it landed: the pass map itself, or
   * a live scope the writer opened over it and then dropped without any
   * merge-back, the route #1940's lost recordings took (a scoped map
   * discarded, a merge-back skipped by a throw).
   */
  route: 'pass' | 'scope';
}

interface Triple {
  /** What the template spells. */
  template: object;
  /** The persisted record: secret tokens kept, public ones stored resolved. */
  stateRecord: object;
  /** The resolution. */
  resolved: object;
  /** (iii) What AWS reads back: arrays reordered, default keys added. */
  readback: object;
  /** (iii) A previous generation: a moved reference, other literals, a removed key. */
  previousTemplate: object;
  previousStateRecord: object;
  plants: Plant[];
}

interface GenerateOptions {
  /**
   * Where a sub-floor plant may sit EMBEDDED in a literal: `anywhere`, or
   * `outside-arrays`, or `nowhere` -- for a case whose positions cannot
   * certify that leaf, where the substring floor is the documented bound of
   * every mask (`MIN_NEEDLE_LENGTH`). The RNG draws are identical whatever
   * the option: only the plant index is remapped.
   */
  subFloorEmbedded: 'anywhere' | 'outside-arrays' | 'nowhere';
}

const EVERY_SHAPE: GenerateOptions = { subFloorEmbedded: 'anywhere' };

const LITERALS = ['arn-', 'prefix', 'host/', '-suffix', 'db=', ':'];
const KEYS = ['Name', 'Value', 'Url', 'Config', 'Items', 'Tags', 'Env'];
/**
 * (ii) Sub-floor values, drawn from characters no literal, key, expression,
 * long plant or JSON punctuation contains, and none a substring of another.
 */
const SHORT_VALUES = ['~', '!#', '^|@'];
const DEFAULT_VALUE = 'default-value';

function generate(seed: number, options: GenerateOptions = EVERY_SHAPE): Triple {
  const rand = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const plants: Plant[] = [];
  const secretCount = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < secretCount; i++) {
    // Upper-case + digits, a per-plant prefix: never a substring of a literal,
    // a key, a public value, or another plant.
    let body = '';
    for (let j = 0; j < 14; j++) body += pick('ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.split(''));
    plants.push({
      expression: `{{resolve:secretsmanager:s${seed}x${i}:SecretString:k${i}}}`,
      previousExpression: `{{resolve:secretsmanager:s${seed}x${i}:SecretString:k${i}:AWSPREVIOUS}}`,
      value: `P${i}${body}`,
      secret: true,
      logOnly: false,
      subFloor: false,
      route: rand() < 0.4 ? 'scope' : 'pass',
    });
  }
  const shortCount = Math.floor(rand() * (SHORT_VALUES.length + 1));
  for (let i = 0; i < shortCount; i++) {
    plants.push({
      expression: `{{resolve:secretsmanager:short${seed}x${i}:SecretString:k}}`,
      previousExpression: `{{resolve:secretsmanager:short${seed}x${i}:SecretString:k:AWSPREVIOUS}}`,
      value: SHORT_VALUES[i]!,
      secret: true,
      logOnly: false,
      subFloor: true,
      route: rand() < 0.4 ? 'scope' : 'pass',
    });
  }
  const logOnlyCount = Math.floor(rand() * 3);
  for (let i = 0; i < logOnlyCount; i++) {
    let body = '';
    for (let j = 0; j < 12; j++) body += pick('ABCDEFGHJKLMNPQRSTUVWXYZ23456789'.split(''));
    const value = `N${i}${body}`;
    plants.push({
      expression: value,
      previousExpression: value,
      value,
      secret: false,
      logOnly: true,
      subFloor: false,
      route: rand() < 0.4 ? 'scope' : 'pass',
    });
  }
  plants.push({
    expression: `{{resolve:ssm:/public/p${seed}}}`,
    previousExpression: `{{resolve:ssm:/public/p${seed}}}`,
    value: `pubvalue${seed}`,
    secret: false,
    logOnly: false,
    subFloor: false,
    route: 'pass',
  });

  // A leaf is a list of parts; each part is a literal or a plant index.
  type Part = string | number;
  const leaf = (inArray: boolean): Part[] => {
    const shape = Math.floor(rand() * 5);
    const subFloorAllowed =
      options.subFloorEmbedded === 'anywhere' ||
      (options.subFloorEmbedded === 'outside-arrays' && !inArray);
    // Plant 0 is always a long secret.
    const plant = (embedded: boolean): number => {
      const index = Math.floor(rand() * plants.length);
      return embedded && !subFloorAllowed && plants[index]!.subFloor ? 0 : index;
    };
    const pair = (): [number, number] => [plant(true), plant(true)];
    switch (shape) {
      case 0:
        return [plant(false)];
      case 1:
        return [pick(LITERALS), plant(true), pick(LITERALS)];
      case 2: {
        const [a, b] = pair();
        return [pick(LITERALS), a, pick(LITERALS), b];
      }
      case 3:
        return [pick(LITERALS)];
      default:
        return [plant(true), pick(LITERALS)];
    }
  };
  type Node = Part[] | Node[] | { [k: string]: Node };
  const node = (depth: number, inArray: boolean): Node => {
    const r = rand();
    if (depth >= 3 || r < 0.4) return leaf(inArray);
    if (r < 0.6) {
      const n = 1 + Math.floor(rand() * 3);
      return Array.from({ length: n }, () => node(depth + 1, true)) as Node[];
    }
    const out: { [k: string]: Node } = {};
    const n = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) out[`${pick(KEYS)}${i}`] = node(depth + 1, inArray);
    return out;
  };
  const isLeaf = (n: Node): n is Part[] =>
    Array.isArray(n) && n.length > 0 && n.every((p) => typeof p !== 'object');
  interface RenderOptions {
    part: (p: Plant) => string;
    /** (iii) readback: arrays reversed, a default key added to some objects. */
    readback?: boolean;
    /** (iii) previous generation: literal-only leaves and one key differ. */
    previous?: boolean;
  }
  // Decided once per object / leaf, so every rendering agrees on WHICH ones.
  const defaultKeyed = new WeakSet<object>();
  const movedLiteral = new WeakSet<object>();
  const decide = (n: Node): void => {
    if (isLeaf(n)) {
      if (n.every((p) => typeof p === 'string') && rand() < 0.5) movedLiteral.add(n);
      return;
    }
    if (Array.isArray(n)) {
      for (const c of n as Node[]) decide(c);
      return;
    }
    if (rand() < 0.5) defaultKeyed.add(n);
    for (const c of Object.values(n)) decide(c);
  };
  const render = (n: Node, o: RenderOptions): unknown => {
    if (isLeaf(n)) {
      const text = n.map((p) => (typeof p === 'number' ? o.part(plants[p]!) : p)).join('');
      return o.previous && movedLiteral.has(n) ? `old-${text}` : text;
    }
    if (Array.isArray(n)) {
      const items = (n as Node[]).map((c) => render(c, o));
      return o.readback ? items.reverse() : items;
    }
    const out: Record<string, unknown> = Object.fromEntries(
      Object.entries(n).map(([k, c]) => [k, render(c, o)])
    );
    if (o.readback && defaultKeyed.has(n)) out['DefaultSetting'] = DEFAULT_VALUE;
    return out;
  };
  const root: { [k: string]: Node } = {};
  const top = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < top; i++) root[`${pick(KEYS)}${i}`] = node(1, false);
  decide(root);
  // The previous generation also spelled a key this one removed.
  const previousOf = (rendered: unknown): object => ({
    ...(rendered as object),
    Removed: 'retired-value',
  });
  // A reference this generation MOVED (a rotation pinned to the previous
  // version stage), per secret plant.
  const moved = new Set(plants.filter((p) => p.secret && rand() < 0.5));
  const previousSpelling = (p: Plant): string =>
    moved.has(p) ? p.previousExpression : p.expression;
  return {
    template: render(root, { part: (p) => p.expression }) as object,
    stateRecord: render(root, { part: (p) => (p.secret ? p.expression : p.value) }) as object,
    resolved: render(root, { part: (p) => p.value }) as object,
    readback: render(root, { part: (p) => p.value, readback: true }) as object,
    previousTemplate: previousOf(render(root, { part: previousSpelling, previous: true })),
    previousStateRecord: previousOf(
      render(root, { part: (p) => (p.secret ? previousSpelling(p) : p.value), previous: true })
    ),
    plants,
  };
}

function leavesOf(value: unknown, path: string[] = []): Array<[string[], unknown]> {
  if (Array.isArray(value)) return value.flatMap((v, i) => leavesOf(v, [...path, String(i)]));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => leavesOf(v, [...path, k]));
  }
  return [[path, value]];
}

function at(value: unknown, path: string[]): unknown {
  let cur = value;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** (a) no planted SECRET plaintext survives anywhere in the persisted bag. */
function leakedPlaintexts(out: unknown, plants: Plant[]): string[] {
  const text = JSON.stringify(out);
  return plants.filter((p) => p.secret && text.includes(p.value)).map((p) => p.value);
}

/**
 * (b) every persisted expression sits where the source spells it, or where
 * the bag held the plaintext of a planted SECRET it names (in either
 * generation's spelling). A public `{{resolve:ssm:` the redactor invented
 * would be persisted config drift; a secret expression at a leaf that held
 * ANOTHER secret's value (a walk mis-pairing reordered positions) would
 * persist the wrong reference with no plaintext left to show it.
 */
function inventedExpressions(
  out: unknown,
  source: unknown,
  plants: Plant[],
  bag: unknown
): string[] {
  const invented: string[] = [];
  for (const [path, leaf] of leavesOf(out)) {
    if (typeof leaf !== 'string') continue;
    for (const token of leaf.match(/\{\{resolve:[^}]+\}\}/g) ?? []) {
      const sourceLeaf = at(source, path);
      if (typeof sourceLeaf === 'string' && sourceLeaf.includes(token)) continue;
      const bagLeaf = at(bag, path);
      const heldItsValue = plants.some(
        (p) =>
          p.secret &&
          (p.expression === token || p.previousExpression === token) &&
          typeof bagLeaf === 'string' &&
          bagLeaf.includes(p.value)
      );
      if (heldItsValue) continue;
      invented.push(`${path.join('.')}: ${token}`);
    }
    // Within the leaf too: each secret token, read back as its plant's
    // value, must give the bag's leaf. Two tokens swapped inside one leaf
    // pass the per-token checks above, not this one.
    const bagLeaf = at(bag, path);
    if (typeof bagLeaf !== 'string') continue;
    let rendered = leaf;
    for (const p of plants) {
      if (!p.secret) continue;
      rendered = rendered.replaceAll(p.expression, p.value).replaceAll(p.previousExpression, p.value);
    }
    if (rendered !== bagLeaf && rendered !== leaf) {
      invented.push(`${path.join('.')}: ${leaf} does not read back as ${bagLeaf}`);
    }
  }
  return invented;
}

/**
 * (c) no planted SECRET plaintext appears in any LOG line or error text the
 * pass's maskers render, keyed on the plants. The lines are the ones a deploy
 * prints about a resolved bag: the whole bag, each leaf alone, and an error
 * quoting a leaf, through each masker (`maskSecretsInText`, the
 * `createSecretMasker` capability a provider gets, `maskSecretsInError`).
 * A sub-floor plant is judged where the maskers' documented floor reaches
 * it: a line that IS the value (an embedded one is below every substring
 * scan, `MIN_NEEDLE_LENGTH`).
 */
function printedPlaintexts(bag: unknown, pass: RecordedSecretValues, plants: Plant[]): string[] {
  const leaves = leavesOf(bag)
    .map(([, leaf]) => leaf)
    .filter((leaf): leaf is string => typeof leaf === 'string');
  const lines = [JSON.stringify(bag), ...leaves];
  const masker = createSecretMasker(pass);
  const printed: string[] = [];
  for (const line of lines) {
    // Each masker over the line as a WHOLE text, and an error quoting it.
    const whole = [
      maskSecretsInText(line, pass),
      masker(line),
      maskSecretsInError(new Error(line), pass).message,
    ];
    const quoted = maskSecretsInError(new Error(`failed to apply ${line}`), pass).message;
    for (const p of plants) {
      if (!p.secret && !p.logOnly) continue;
      const leaked = p.subFloor
        ? line === p.value && whole.some((r) => r.includes(p.value))
        : [...whole, quoted].some((r) => r.includes(p.value));
      if (leaked) printed.push(`${p.value} via ${JSON.stringify(line).slice(0, 60)}`);
    }
  }
  return printed;
}

/** Every recording kind carried: the scope a writer opens over a VALUE's pass. */
const CARRY_ALL: LiveScopePolicy = {
  pairs: 'carry',
  'log-only': 'carry',
  'mask-only-marks': 'carry',
  'reference-provenance': 'carry',
  'physical-name-copies': 'carry',
  'public-proofs': 'carry',
};

/**
 * The pass map as the resolver leaves it: each secret plant recorded through
 * its route (i). The scope is opened and DROPPED: no merge-back, no release.
 */
/**
 * How a plant routed through a scope (i) is recorded: a scope a writer opens
 * over a VALUE's pass (`carry-all`), the one production scope policy
 * (`export-name`, `EXPORT_NAME_SCOPE`: pairs withheld), or NOWHERE
 * (`missing`: the pass truly lacks the plant, as a recording that never ran).
 */
type Route = 'carry-all' | 'export-name' | 'missing';

function passFor(plants: Plant[], route: Route): RecordedSecretValues {
  const pass: RecordedSecretValues = new Map();
  const scope = openRecordingScope(pass, route === 'export-name' ? EXPORT_NAME_SCOPE : CARRY_ALL);
  const orphan: RecordedSecretValues = new Map();
  for (const p of plants) {
    const into = p.route === 'pass' ? pass : route === 'missing' ? orphan : scope.secrets;
    if (p.logOnly) recordLogOnlyValue(into, p.value);
    // A public `ssm` lookup records its proof, as the resolver's does.
    else if (!p.secret) recordProvenPublicExpression(into, p.expression, p.value);
    else recordSecretResolution(into, p.expression, p.value, { pairEvidence: true });
  }
  return pass;
}

const SEEDS = Array.from({ length: 600 }, (_, i) => i + 1);

interface PropertyCase {
  name: string;
  /** Persist `bag` under `context`; `source` is what oracle (b) positions against. */
  build: (
    t: Triple,
    route: Route
  ) => { bag: unknown; context: RedactionContext; source: unknown };
  /** The recording routes (i) the case is held to; default the two scopes. */
  routes?: readonly Route[];
  /** Narrower shapes under `export-name`, whose scope withholds the pairs. */
  exportNameShapes?: GenerateOptions;
  /** The shapes the case is held to; each narrowing names its bound. */
  shapes: GenerateOptions;
  /** Whether property (c) applies: the case's pass recorded the plants. */
  logs: boolean;
}

const PROPERTY_CASES: PropertyCase[] = [
  {
    name: 'template-derived, same-generation',
    build: (t, route) => ({
      bag: t.resolved,
      context: {
        provenance: 'template-derived',
        secrets: passFor(t.plants, route),
        source: t.template,
        generation: 'same-generation',
      },
      source: t.template,
    }),
    // The claim certifies an embedded span (`positionByEmbeddedSpan`), beside
    // a public token too, from its proven value (go-to-k/cdkd#5056).
    shapes: EVERY_SHAPE,
    // That certification reads the pass's PAIR for the token, which
    // `EXPORT_NAME_SCOPE` withholds by design (a name positions no leaf):
    // under it, the sub-floor span is the value scan's, below its floor.
    exportNameShapes: { subFloorEmbedded: 'nowhere' },
    logs: true,
  },
  {
    name: 'template-derived, unproven, current template',
    build: (t, route) => ({
      bag: t.resolved,
      context: {
        provenance: 'template-derived',
        secrets: passFor(t.plants, route),
        source: t.template,
        generation: 'unproven',
      },
      source: t.template,
    }),
    // No claim: an embedded span needs the value scan's agreement, which a
    // sub-floor plant cannot give.
    shapes: { subFloorEmbedded: 'nowhere' },
    logs: true,
  },
  {
    name: 'template-derived, unproven, previous-generation template',
    build: (t, route) => ({
      bag: t.resolved,
      context: {
        provenance: 'template-derived',
        secrets: passFor(t.plants, route),
        source: t.previousTemplate,
        generation: 'unproven',
      },
      source: t.previousTemplate,
    }),
    // No claim: an embedded span needs the value scan's agreement, which a
    // sub-floor plant cannot give.
    shapes: { subFloorEmbedded: 'nowhere' },
    logs: true,
  },
  {
    name: 'template-sourced readback',
    build: (t, route) => ({
      bag: t.readback,
      context: {
        provenance: 'template-sourced',
        secrets: passFor(t.plants, route),
        source: t.template,
        generation: 'unproven',
      },
      source: t.template,
    }),
    // Unproven, as above; a readback array may also be reordered.
    shapes: { subFloorEmbedded: 'nowhere' },
    logs: true,
  },
  {
    name: 'state-derived replay, same-generation',
    build: (t, route) => ({
      bag: t.resolved,
      context: {
        provenance: 'state-derived',
        secrets: passFor(t.plants, route),
        source: t.stateRecord,
        generation: 'same-generation',
      },
      source: t.stateRecord,
    }),
    // The replay's claim certifies a sub-floor span (go-to-k/cdkd#5056).
    shapes: EVERY_SHAPE,
    // Except under `EXPORT_NAME_SCOPE`, which withholds the pair the span
    // arm reads.
    exportNameShapes: { subFloorEmbedded: 'nowhere' },
    logs: true,
  },
  {
    name: 'state-derived replay, unproven',
    build: (t, route) => ({
      bag: t.resolved,
      context: {
        provenance: 'state-derived',
        secrets: passFor(t.plants, route),
        source: t.stateRecord,
        generation: 'unproven',
      },
      source: t.stateRecord,
    }),
    // No claim: an embedded span needs the value scan's agreement, which a
    // sub-floor plant cannot give.
    shapes: { subFloorEmbedded: 'nowhere' },
    logs: true,
  },
  {
    name: 'state-readback',
    build: (t, route) => ({
      bag: t.readback,
      context: { provenance: 'state-readback', secrets: passFor(t.plants, route), source: t.stateRecord },
      source: t.stateRecord,
    }),
    // A reordered unkeyed readback array refuses positioning (the keyed
    // descent needs an identity field), leaving the value scan.
    shapes: { subFloorEmbedded: 'outside-arrays' },
    logs: true,
  },
  {
    name: 'state-baseline',
    build: (t, route) => ({
      bag: t.readback,
      context: { provenance: 'state-baseline', secrets: passFor(t.plants, route), source: t.stateRecord },
      source: t.stateRecord,
    }),
    shapes: EVERY_SHAPE,
    logs: true,
  },
  {
    name: 'state-baseline, EMPTY map (fails closed)',
    build: (t) => ({
      bag: t.readback,
      context: { provenance: 'state-baseline', secrets: new Map(), source: t.stateRecord },
      source: t.stateRecord,
    }),
    shapes: EVERY_SHAPE,
    // Nothing was resolved, so nothing was recorded: the walk alone fails
    // closed, and no masker of this pass knows a value.
    logs: false,
    routes: ['carry-all'],
  },
  {
    // (i) with the recording truly MISSING the scope-routed plants (they were
    // recorded nowhere), not merely missing from the writer's own writes. Only
    // a baseline holds it: the walk fails closed on what the map cannot
    // certify. Every other provenance needs the recording -- a value scan
    // finds only recorded needles, and a span or skeleton arm only a recorded
    // pair -- which is why recording must be structural (`recording.ts`), and
    // why the generator's other routes record through a scope.
    name: 'state-baseline, map MISSING plants (fails closed)',
    build: (t, route) => ({
      bag: t.readback,
      context: {
        provenance: 'state-baseline',
        secrets: passFor(t.plants, route),
        source: t.stateRecord,
      },
      source: t.stateRecord,
    }),
    shapes: EVERY_SHAPE,
    routes: ['missing'],
    // No masker can mask a value nothing recorded, so (c) cannot hold.
    logs: false,
  },
  {
    name: 'state-cross-generation',
    build: (t, route) => ({
      bag: t.resolved,
      context: {
        provenance: 'state-cross-generation',
        secrets: passFor(t.plants, route),
        source: t.previousStateRecord,
      },
      source: t.previousStateRecord,
    }),
    // The source is a PREVIOUS generation: nothing proves a framed middle is
    // the token's plaintext.
    shapes: { subFloorEmbedded: 'nowhere' },
    logs: true,
  },
  {
    name: 'value-scan',
    build: (t, route) => ({
      bag: t.resolved,
      context: { provenance: 'value-scan', secrets: passFor(t.plants, route) },
      source: undefined,
    }),
    // No source: the value scan alone, whose substring floor is the bound.
    shapes: { subFloorEmbedded: 'nowhere' },
    logs: true,
  },
];

const DEFAULT_ROUTES: readonly Route[] = ['carry-all', 'export-name'];

function propertyFailures(c: PropertyCase, triple: Triple, route: Route): string[] {
  const { bag, context, source } = c.build(triple, route);
  const out = redactForState(bag, context);
  const leaked = leakedPlaintexts(out, triple.plants);
  const invented = inventedExpressions(out, source, triple.plants, bag);
  const printed = c.logs ? printedPlaintexts(bag, context.secrets, triple.plants) : [];
  if (leaked.length === 0 && invented.length === 0 && printed.length === 0) return [];
  return [
    `leaked=${JSON.stringify(leaked)} invented=${JSON.stringify(invented)} printed=${JSON.stringify(printed)}`,
  ];
}

describe('redactForState: planted-plaintext properties over generated triples', () => {
  for (const c of PROPERTY_CASES) {
    for (const route of c.routes ?? DEFAULT_ROUTES) {
      it(`${c.name} [${route}]: no planted plaintext persists or prints, no expression is invented`, () => {
        const shapes = route === 'export-name' ? (c.exportNameShapes ?? c.shapes) : c.shapes;
        const failures: string[] = [];
        for (const seed of SEEDS) {
          const triple = generate(seed, shapes);
          for (const f of propertyFailures(c, triple, route)) {
            failures.push(`seed ${seed}: ${f}`);
          }
        }
        expect(failures).toEqual([]);
      });
    }
  }

  it('routes the MISSING-map case through plants the pass truly lacks', () => {
    // The population that case is about: scope-routed secret plants present
    // in the readback but absent from the pass map.
    let missing = 0;
    for (const seed of SEEDS) {
      const t = generate(seed);
      const pass = passFor(t.plants, 'missing');
      const text = JSON.stringify(t.readback);
      missing += t.plants.filter(
        (p) => p.secret && p.route === 'scope' && !pass.has(p.value) && text.includes(p.value)
      ).length;
    }
    expect(missing).toBeGreaterThan(50);
  });

  it('generates the populations the properties are about, per shape', () => {
    // An aggregate floor hides one dead shape, so each has its own: a
    // generator that stopped producing one would let a property above pass
    // vacuously for it.
    const count: Record<string, number> = {
      whole: 0,
      embedded: 0,
      logOnlyLeaves: 0,
      publicLeaves: 0,
      subFloorWhole: 0,
      subFloorEmbedded: 0,
      scopeRecorded: 0,
      reorderedArrays: 0,
      defaultKeys: 0,
      movedReferences: 0,
      movedLiterals: 0,
      subFloorBesidePublic: 0,
    };
    for (const seed of SEEDS) {
      const t = generate(seed);
      for (const [path, leaf] of leavesOf(t.template)) {
        if (typeof leaf !== 'string') continue;
        for (const p of t.plants) {
          if (!leaf.includes(p.expression)) continue;
          const whole = leaf === p.expression;
          if (p.logOnly) count.logOnlyLeaves!++;
          else if (!p.secret) count.publicLeaves!++;
          else if (p.subFloor) count[whole ? 'subFloorWhole' : 'subFloorEmbedded']!++;
          else count[whole ? 'whole' : 'embedded']!++;
          if ((p.secret || p.logOnly) && p.route === 'scope') count.scopeRecorded!++;
          const previous = at(t.previousTemplate, path);
          if (typeof previous === 'string' && previous.includes(p.previousExpression)) {
            if (p.previousExpression !== p.expression) count.movedReferences!++;
          }
        }
        const previous = at(t.previousTemplate, path);
        if (typeof previous === 'string' && previous === `old-${leaf}`) count.movedLiterals!++;
        // go-to-k/cdkd#5056's shape: a sub-floor secret beside a public token.
        const has = (pred: (p: Plant) => boolean): boolean =>
          t.plants.some((p) => pred(p) && leaf.includes(p.expression));
        if (has((p) => p.subFloor) && has((p) => !p.secret && !p.logOnly)) {
          count.subFloorBesidePublic!++;
        }
      }
      const reordered = (resolved: unknown, readback: unknown): void => {
        if (Array.isArray(resolved) && Array.isArray(readback)) {
          if (JSON.stringify(resolved) !== JSON.stringify(readback)) count.reorderedArrays!++;
          resolved.forEach((v, i) => reordered(v, readback[readback.length - 1 - i]));
        } else if (resolved !== null && typeof resolved === 'object') {
          const r = readback as Record<string, unknown>;
          if ('DefaultSetting' in r) count.defaultKeys!++;
          for (const [k, v] of Object.entries(resolved)) reordered(v, r[k]);
        }
      };
      reordered(t.resolved, t.readback);
    }
    for (const [shape, n] of Object.entries(count)) {
      expect(`${shape}: ${n > 50 ? 'populated' : n}`).toBe(`${shape}: populated`);
    }
  });

  it('holds each case to sub-floor embedded plants wherever its shapes allow them', () => {
    // A narrowing must not empty the population it narrows: a case allowing
    // sub-floor plants somewhere has to generate them there.
    for (const c of PROPERTY_CASES) {
      if (c.shapes.subFloorEmbedded === 'nowhere') continue;
      let n = 0;
      for (const seed of SEEDS) {
        const t = generate(seed, c.shapes);
        for (const [, leaf] of leavesOf(t.template)) {
          if (typeof leaf !== 'string') continue;
          n += t.plants.filter(
            (p) => p.subFloor && leaf.includes(p.expression) && leaf !== p.expression
          ).length;
        }
      }
      expect(`${c.name}: ${n > 50 ? 'populated' : n}`).toBe(`${c.name}: populated`);
    }
  });

  it('detects a leak when redaction is skipped (oracle self-check)', () => {
    // The first triple planting a public leaf, so the forgery has one to move.
    const triple = SEEDS.map((seed) => generate(seed)).find((t) =>
      JSON.stringify(t.template).includes('ssm:/public/')
    )!;
    expect(leakedPlaintexts(triple.resolved, triple.plants).length).toBeGreaterThan(0);
    const forged = JSON.parse(
      JSON.stringify(triple.template).replaceAll('ssm:/public/', 'ssm:/forged/')
    );
    expect(
      inventedExpressions(forged, triple.template, triple.plants, triple.resolved).length
    ).toBeGreaterThan(0);
    // ...and a secret reference written at a leaf that held ANOTHER secret's
    // value: two secret plants' tokens swapped in a correct persist.
    const swapped = SEEDS.map((seed) => generate(seed)).find((t) => {
      const [a, b] = t.plants.filter((p) => p.secret && !p.subFloor);
      const text = JSON.stringify(t.template);
      return a && b && text.includes(a.expression) && text.includes(b.expression);
    })!;
    const [a, b] = swapped.plants.filter((p) => p.secret && !p.subFloor);
    const crossed = JSON.parse(
      JSON.stringify(swapped.template)
        .replaceAll(a!.expression, '\u0000')
        .replaceAll(b!.expression, a!.expression)
        .replaceAll('\u0000', b!.expression)
    );
    expect(
      inventedExpressions(crossed, swapped.template, swapped.plants, swapped.resolved).length
    ).toBeGreaterThan(0);
    // ...and the two swapped INSIDE one leaf that embeds both.
    const inLeaf = {
      source: { L: `x-${a!.expression}-y-${b!.expression}` },
      bag: { L: `x-${a!.value}-y-${b!.value}` },
      out: { L: `x-${b!.expression}-y-${a!.expression}` },
    };
    expect(inventedExpressions(inLeaf.out, inLeaf.source, swapped.plants, inLeaf.bag)).toEqual([
      expect.stringContaining('does not read back'),
    ]);
    expect(inventedExpressions(inLeaf.source, inLeaf.source, swapped.plants, inLeaf.bag)).toEqual(
      []
    );
    // The log oracle sees a print no masker touched.
    expect(printedPlaintexts(triple.resolved, new Map(), triple.plants).length).toBeGreaterThan(0);
  });

  it('fails the properties when a scope-routed recording is dropped (oracle self-check)', () => {
    // The recording route (i) is load-bearing: the same plants recorded into
    // a map that reaches nothing -- the pre-#5048 shape of a scoped map whose
    // merge-back never ran -- must make the persisted and printed properties
    // fail, or the scope route proves nothing.
    const dropped = (plants: Plant[]): RecordedSecretValues => {
      const pass: RecordedSecretValues = new Map();
      const orphan: RecordedSecretValues = new Map();
      for (const p of plants) {
        const into = p.route === 'pass' ? pass : orphan;
        if (p.logOnly) recordLogOnlyValue(into, p.value);
        else if (p.secret) recordSecretResolution(into, p.expression, p.value, { pairEvidence: true });
      }
      return pass;
    };
    // Counted only where the DROP is the cause: the same seed through the
    // scope must hold, so a seed failing for another reason adds nothing.
    const persist = (t: Triple, pass: RecordedSecretValues): unknown =>
      redactForState(t.resolved, {
        provenance: 'template-derived',
        secrets: pass,
        source: t.template,
        generation: 'same-generation',
      });
    let persisted = 0;
    let printed = 0;
    for (const seed of SEEDS) {
      const t = generate(seed);
      const scoped = passFor(t.plants, 'carry-all');
      const pass = dropped(t.plants);
      if (
        leakedPlaintexts(persist(t, pass), t.plants).length > 0 &&
        leakedPlaintexts(persist(t, scoped), t.plants).length === 0
      ) {
        persisted++;
      }
      if (
        printedPlaintexts(t.resolved, pass, t.plants).length > 0 &&
        printedPlaintexts(t.resolved, scoped, t.plants).length === 0
      ) {
        printed++;
      }
    }
    expect(persisted).toBeGreaterThan(50);
    expect(printed).toBeGreaterThan(50);
  });
});

