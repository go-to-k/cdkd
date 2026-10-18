import { describe, it, expect } from 'vite-plus/test';
import {
  redactForState,
  isSameGenerationBag,
  recordResolvedPair,
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
        provenance === 'template-derived' || provenance === 'template-sourced'
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
  value: string;
  secret: boolean;
}

interface Triple {
  /** What the template spells. */
  template: object;
  /** The persisted record: secret tokens kept, public ones stored resolved. */
  stateRecord: object;
  /** The resolution (and the readback, which echoes it). */
  resolved: object;
  plants: Plant[];
}

const LITERALS = ['arn-', 'prefix', 'host/', '-suffix', 'db=', ':'];
const KEYS = ['Name', 'Value', 'Url', 'Config', 'Items', 'Tags', 'Env'];

function generate(seed: number): Triple {
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
      value: `P${i}${body}`,
      secret: true,
    });
  }
  plants.push({
    expression: `{{resolve:ssm:/public/p${seed}}}`,
    value: `pubvalue${seed}`,
    secret: false,
  });

  // A leaf is a list of parts; each part is a literal or a plant index.
  type Part = string | number;
  const leaf = (): Part[] => {
    const shape = Math.floor(rand() * 5);
    const plant = (): number => Math.floor(rand() * plants.length);
    switch (shape) {
      case 0:
        return [plant()];
      case 1:
        return [pick(LITERALS), plant(), pick(LITERALS)];
      case 2:
        return [pick(LITERALS), plant(), pick(LITERALS), plant()];
      case 3:
        return [pick(LITERALS)];
      default:
        return [plant(), pick(LITERALS)];
    }
  };
  type Node = Part[] | Node[] | { [k: string]: Node };
  const node = (depth: number): Node => {
    const r = rand();
    if (depth >= 3 || r < 0.4) return leaf();
    if (r < 0.6) {
      const n = 1 + Math.floor(rand() * 3);
      return Array.from({ length: n }, () => node(depth + 1)) as Node[];
    }
    const out: { [k: string]: Node } = {};
    const n = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) out[`${pick(KEYS)}${i}`] = node(depth + 1);
    return out;
  };
  const isLeaf = (n: Node): n is Part[] =>
    Array.isArray(n) && n.length > 0 && n.every((p) => typeof p !== 'object');
  const render = (n: Node, part: (p: Plant) => string): unknown => {
    if (isLeaf(n)) {
      return n.map((p) => (typeof p === 'number' ? part(plants[p]!) : p)).join('');
    }
    if (Array.isArray(n)) return (n as Node[]).map((c) => render(c, part));
    return Object.fromEntries(Object.entries(n).map(([k, c]) => [k, render(c, part)]));
  };
  const root: { [k: string]: Node } = {};
  const top = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < top; i++) root[`${pick(KEYS)}${i}`] = node(1);
  return {
    template: render(root, (p) => p.expression) as object,
    stateRecord: render(root, (p) => (p.secret ? p.expression : p.value)) as object,
    resolved: render(root, (p) => p.value) as object,
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
 * (b) every persisted expression is a planted SECRET expression, or sits at
 * the same position in the source -- a public `{{resolve:ssm:` the redactor
 * invented anywhere else would be persisted config drift.
 */
function inventedExpressions(out: unknown, source: unknown, plants: Plant[]): string[] {
  const secretExpressions = new Set(plants.filter((p) => p.secret).map((p) => p.expression));
  const invented: string[] = [];
  for (const [path, leaf] of leavesOf(out)) {
    if (typeof leaf !== 'string') continue;
    for (const token of leaf.match(/\{\{resolve:[^}]+\}\}/g) ?? []) {
      if (secretExpressions.has(token)) continue;
      const sourceLeaf = at(source, path);
      if (typeof sourceLeaf === 'string' && sourceLeaf.includes(token)) continue;
      invented.push(`${path.join('.')}: ${token}`);
    }
  }
  return invented;
}

function secretsOf(plants: Plant[]): RecordedSecretValues {
  return new Map(plants.filter((p) => p.secret).map((p) => [p.value, p.expression]));
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

describe('redactForState: planted-plaintext properties over generated triples', () => {
  const cases: Array<[string, (t: Triple) => [unknown, RedactionContext, unknown]]> = [
    [
      'template-derived, same-generation',
      (t) => [
        t.resolved,
        {
          provenance: 'template-derived',
          secrets: secretsOf(t.plants),
          source: t.template,
          generation: 'same-generation',
        },
        t.template,
      ],
    ],
    [
      'template-derived, unproven',
      (t) => [
        t.resolved,
        {
          provenance: 'template-derived',
          secrets: secretsOf(t.plants),
          source: t.template,
          generation: 'unproven',
        },
        t.template,
      ],
    ],
    [
      'template-sourced readback',
      (t) => [
        t.resolved,
        {
          provenance: 'template-sourced',
          secrets: secretsOf(t.plants),
          source: t.template,
          generation: 'unproven',
        },
        t.template,
      ],
    ],
    [
      'state-derived replay',
      (t) => [
        t.resolved,
        { provenance: 'state-derived', secrets: secretsOf(t.plants), source: t.stateRecord },
        t.stateRecord,
      ],
    ],
    [
      'state-readback',
      (t) => [
        t.resolved,
        { provenance: 'state-readback', secrets: secretsOf(t.plants), source: t.stateRecord },
        t.stateRecord,
      ],
    ],
    [
      'state-baseline',
      (t) => [
        t.resolved,
        { provenance: 'state-baseline', secrets: secretsOf(t.plants), source: t.stateRecord },
        t.stateRecord,
      ],
    ],
    [
      'state-baseline, EMPTY map (fails closed)',
      (t) => [
        t.resolved,
        { provenance: 'state-baseline', secrets: new Map(), source: t.stateRecord },
        t.stateRecord,
      ],
    ],
    [
      'state-cross-generation',
      (t) => [
        t.resolved,
        {
          provenance: 'state-cross-generation',
          secrets: secretsOf(t.plants),
          source: t.stateRecord,
        },
        t.stateRecord,
      ],
    ],
    [
      'value-scan',
      (t) => [t.resolved, { provenance: 'value-scan', secrets: secretsOf(t.plants) }, undefined],
    ],
  ];

  for (const [name, build] of cases) {
    it(`${name}: no planted plaintext persists, no expression is invented`, () => {
      const failures: string[] = [];
      for (const seed of SEEDS) {
        const triple = generate(seed);
        const [bag, context, source] = build(triple);
        const out = redactForState(bag, context);
        const leaked = leakedPlaintexts(out, triple.plants);
        const invented = inventedExpressions(out, source, triple.plants);
        if (leaked.length > 0 || invented.length > 0) {
          failures.push(
            `seed ${seed}: leaked=${JSON.stringify(leaked)} invented=${JSON.stringify(invented)}`
          );
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it('generates the populations the properties are about', () => {
    // A generator that stopped planting embedded or public leaves would let
    // every property above pass vacuously.
    let embedded = 0;
    let whole = 0;
    let publicLeaves = 0;
    for (const seed of SEEDS) {
      const { template, plants } = generate(seed);
      for (const [, leaf] of leavesOf(template)) {
        if (typeof leaf !== 'string') continue;
        for (const p of plants) {
          if (!leaf.includes(p.expression)) continue;
          if (!p.secret) publicLeaves++;
          else if (leaf === p.expression) whole++;
          else embedded++;
        }
      }
    }
    expect(whole).toBeGreaterThan(100);
    expect(embedded).toBeGreaterThan(100);
    expect(publicLeaves).toBeGreaterThan(100);
  });

  it('detects a leak when redaction is skipped (oracle self-check)', () => {
    const triple = generate(7);
    expect(leakedPlaintexts(triple.resolved, triple.plants).length).toBeGreaterThan(0);
    const forged = JSON.parse(JSON.stringify(triple.template).replaceAll('ssm:/public/', 'ssm:/forged/'));
    expect(inventedExpressions(forged, triple.template, triple.plants).length).toBeGreaterThan(0);
  });
});
