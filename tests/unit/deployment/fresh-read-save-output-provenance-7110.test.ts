/**
 * go-to-k/cdkd#7110: every engine save goes through `withParentInfo` and
 * `redactStateForPersist`. That path writes `outputReferenceProvenance` only
 * for an `outputs` bag it can place: the deploy's baseline, the bag this run
 * resolved, or a fresh read registered with `carryReadOutputs`. Any other bag
 * persists none, so a save that rebuilds its state from a fresh read of the
 * store, without registering the read, erases the stack's output provenance
 * (`persistDropped` did: a later consumer could never be promoted, #4852).
 *
 * This fence classifies each reference to the choke point by SITE: its file,
 * its enclosing function and the expression it saves. A new site, a moved one
 * or a second one in the same function fails here until it is classified. A
 * site that writes back a fresh read must call `carryReadOutputs(<that read>)`
 * in the same function, before the save. The sites are found by a real parser
 * (oxc, via `vite-plus`), so comments, strings and regex literals are never
 * read as code.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  carryReadOutputs,
  outputReferenceProvenanceFor,
} from '../../../src/deployment/deploy-engine/state-persist.js';
import type { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import {
  ROOT,
  SRC,
  isNode,
  parseOrThrow,
  scanSites,
  type Found,
  type Node,
} from '../_choke-point-sites.js';

// Each choke-point function, keyed on its first argument (the state it saves).
const TARGETS: ReadonlyMap<string, number> = new Map([
  ['withParentInfo', 0],
  ['redactStateForPersist', 0],
]);

type Site =
  /** Saves a state built from the deploy's own state (baseline or this run's outputs). */
  | { outputs: 'deploy-state' }
  /** Writes back a fresh read: `read` is the expression registered first. */
  | { outputs: 'written-back-read'; read: string }
  /** The choke point's own definitions, delegating to each other. */
  | { outputs: 'definition' };

/** `<file>#<enclosing function>#<saved expression>` -> how many, and what it is. */
const SITES: Record<string, Site & { count: number }> = {
  // `partialState`, `preRollbackState`, `buildState()`: `currentState.outputs`
  // (the loaded baseline). The retry's fresh read supplies its ETag only.
  'src/deployment/deploy-engine/execute.ts#savePartialState#partialState': {
    outputs: 'deploy-state',
    count: 1,
  },
  'src/deployment/deploy-engine/execute.ts#executeDeploymentBody#preRollbackState': {
    outputs: 'deploy-state',
    count: 1,
  },
  'src/deployment/deploy-engine/execute.ts#persistStateAfterOutputFailure#buildState()': {
    outputs: 'deploy-state',
    count: 2,
  },
  // The final save: this run's resolved outputs.
  'src/deployment/deploy-engine/deploy-flow.ts#doDeployWithPrefetch#conditionVerdicts ? { ...newState, conditionVerdicts } : newState':
    { outputs: 'deploy-state', count: 1 },
  // The no-change refresh: the loaded record's outputs, or this run's.
  'src/deployment/deploy-engine/deploy-flow/no-change.ts#deployWithoutChanges#refreshedState': {
    outputs: 'deploy-state',
    count: 1,
  },
  // `postRollbackState`: `currentState.outputs`; the fresh read is for its ETag.
  'src/deployment/deploy-engine/execute/rollback-after-failure.ts#rollbackFailedDeploy#postRollbackState':
    { outputs: 'deploy-state', count: 2 },
  // `persistDropped`: the fresh read, written back without the dropped rows.
  'src/deployment/deploy-engine/nested-cleanup.ts#persistDropped#next': {
    outputs: 'written-back-read',
    read: 'current.state',
    count: 1,
  },
  // The definitions: the engine's methods delegate to the module functions,
  // and `withParentInfo` runs `redactStateForPersist`.
  'src/deployment/deploy-engine.ts#redactStateForPersist#<ref>': { outputs: 'definition', count: 1 },
  'src/deployment/deploy-engine.ts#withParentInfo#<ref>': { outputs: 'definition', count: 1 },
  'src/deployment/deploy-engine/state-persist.ts#withParentInfo#state': {
    outputs: 'definition',
    count: 1,
  },
};

/**
 * `carryReadOutputs(<arg>);` STATEMENTS in `text`: each one's statement list
 * and index there. A call inside a condition, an expression or a closure is no
 * such statement, so it cannot stand in for an unconditional carry.
 */
function carriesIn(
  file: string,
  text: string
): Array<{ arg: string; at: number; block: number; index: number }> {
  const program = parseOrThrow(file, text);
  const out: Array<{ arg: string; at: number; block: number; index: number }> = [];
  const walk = (node: Node): void => {
    if (node.type === 'BlockStatement' || node.type === 'Program') {
      (node['body'] as Node[]).forEach((stmt, index) => {
        if (stmt.type !== 'ExpressionStatement') return;
        const call = stmt['expression'] as Node;
        if (call.type !== 'CallExpression') return;
        const callee = call['callee'] as Node;
        const args = call['arguments'] as Node[];
        if (callee.type === 'Identifier' && callee['name'] === 'carryReadOutputs' && args[0] !== undefined) {
          out.push({ arg: text.slice(args[0].start, args[0].end), at: stmt.start, block: node.start, index });
        }
      });
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) {
        for (const c of v) if (isNode(c)) walk(c);
      } else if (isNode(v)) {
        walk(v);
      }
    }
  };
  walk(program);
  return out;
}

/** Every site under `srcDir`, with `extra` (path -> text) overriding or adding files. */
function scan(srcDir: string, extra: Record<string, string> = {}): { sites: Found[]; texts: Map<string, string> } {
  return scanSites(TARGETS, srcDir, extra);
}

/** The fence's verdicts: unclassified or miscounted sites, and unregistered write-backs. */
function violations(sites: Found[], texts: Map<string, string>): string[] {
  const problems: string[] = [];
  const counts = new Map<string, number>();
  for (const s of sites) counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
  for (const [key, n] of counts) {
    const site = SITES[key];
    if (site === undefined) problems.push(`unclassified save site: ${key}`);
    else if (site.count !== n) problems.push(`${key}: ${n} sites, classified ${site.count}`);
  }
  for (const [key, site] of Object.entries(SITES)) {
    if (!counts.has(key)) problems.push(`classified site gone: ${key}`);
    if (site.outputs !== 'written-back-read') continue;
    for (const s of sites.filter((x) => x.key === key)) {
      const carried = carriesIn(s.file, texts.get(s.file)!).some(
        (c) =>
          c.arg === site.read &&
          c.at > s.fnStart &&
          c.at < s.fnEnd &&
          // An EARLIER statement of a statement list around the save.
          s.blocks.some((b) => b.block === c.block && c.index < b.index)
      );
      if (!carried) problems.push(`${key}: no carryReadOutputs(${site.read}) before the save in its function`);
    }
  }
  return problems;
}

describe('engine saves carry output reference provenance (go-to-k/cdkd#7110)', () => {
  it('every save site is classified, and each write-back registers its read first', () => {
    const { sites, texts } = scan(SRC);
    // Floor: the scan reads the real tree, so too few sites means a broken scan.
    expect(sites.length).toBeGreaterThanOrEqual(Object.keys(SITES).length);
    expect(violations(sites, texts)).toEqual([]);
  });

  // Self-probes: each hole the fence must close, injected into a copy of the
  // real file it would land in.
  const real = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');
  const probe = (rel: string, text: string): string[] => {
    const { sites, texts } = scan(SRC, { [join(ROOT, rel)]: text });
    return violations(sites, texts);
  };

  it('probe: a second write-back in nested-cleanup.ts fails', () => {
    const rel = 'src/deployment/deploy-engine/nested-cleanup.ts';
    const text =
      real(rel) +
      `\nexport async function persistAgain(engine: DeployEngine, fresh: { state: StackState }): Promise<void> {\n` +
      `  const next = { ...fresh.state };\n` +
      `  await engine.stateBackend.saveState('s', 'r', engine.withParentInfo(next));\n}\n`;
    expect(probe(rel, text)).toEqual([
      'unclassified save site: src/deployment/deploy-engine/nested-cleanup.ts#persistAgain#next',
    ]);
  });

  it('probe: a write-back without its carry fails', () => {
    const rel = 'src/deployment/deploy-engine/nested-cleanup.ts';
    const text = real(rel).replace('carryReadOutputs(current.state);', '');
    expect(text).not.toBe(real(rel));
    expect(probe(rel, text)).toEqual([
      'src/deployment/deploy-engine/nested-cleanup.ts#persistDropped#next: no carryReadOutputs(current.state) before the save in its function',
    ]);
  });

  it('probe: a new write-back in a deploy-state file fails', () => {
    const rel = 'src/deployment/deploy-engine/execute.ts';
    const text =
      real(rel) +
      `\nexport async function rewriteFresh(engine: DeployEngine): Promise<void> {\n` +
      `  const fresh = await engine.stateBackend.getState('s', 'r');\n` +
      `  await engine.stateBackend.saveState('s', 'r', engine.withParentInfo(fresh!.state));\n}\n`;
    expect(probe(rel, text)).toEqual([
      'unclassified save site: src/deployment/deploy-engine/execute.ts#rewriteFresh#fresh!.state',
    ]);
  });

  it('probe: a save added to deploy-engine.ts fails', () => {
    const rel = 'src/deployment/deploy-engine.ts';
    const text =
      real(rel) +
      `\nexport function saveFresh(engine: DeployEngine, s: StackState): unknown {\n` +
      `  return engine.withParentInfo(s);\n}\n`;
    expect(probe(rel, text)).toEqual([
      'unclassified save site: src/deployment/deploy-engine.ts#saveFresh#s',
    ]);
  });

  it('probe: a call in a comment, a string or a regex is no site', () => {
    const rel = 'src/deployment/deploy-engine/zz-probe.ts';
    const text =
      `const GLOB = 'resources/*'; const R = /a\\/\\/b/;\n` +
      `// engine.withParentInfo(x)\nconst S = 'engine.withParentInfo(y)';\n/** doc */\n`;
    expect(probe(rel, text)).toEqual([]);
  });

  it('probe: a bare reference (a method passed on) is a site', () => {
    const rel = 'src/deployment/deploy-engine/zz-probe.ts';
    const text = `export const f = (engine: { withParentInfo: unknown }) => engine.withParentInfo;\n`;
    expect(probe(rel, text)).toEqual([
      'unclassified save site: src/deployment/deploy-engine/zz-probe.ts#f#<ref>',
    ]);
  });

  const ZZ = 'src/deployment/deploy-engine/zz-probe.ts';
  it.each([
    ['a renamed destructuring', `export function a(engine: E) { const { withParentInfo: w } = engine; return w; }\n`, `${ZZ}#a#<ref>`],
    ['a computed destructuring key', `export function a2(engine: E) { const { ['withParentInfo']: w } = engine; return w; }\n`, `${ZZ}#a2#<ref>`],
    ['an element access', `export function b(engine: E, s: S) { return engine['withParentInfo'](s); }\n`, `${ZZ}#b#s`],
    ['a template-literal element access', `export function c(engine: E, s: S) { return engine[\`withParentInfo\`](s); }\n`, `${ZZ}#c#s`],
    ['a non-null reference', `export function d(engine: E) { return engine.withParentInfo!.call(engine, s); }\n`, `${ZZ}#d#<ref>`],
    ['an as-cast reference', `export function e(engine: E) { return (engine.withParentInfo as F).call(engine, s); }\n`, `${ZZ}#e#<ref>`],
    ['a class field value', `export class G { save = withParentInfo; }\n`, `${ZZ}#<module>#<ref>`],
  ])('probe: %s is a site', (_what, text, key) => {
    expect(probe(ZZ, text)).toEqual([`unclassified save site: ${key}`]);
  });

  it('probe: a type-position name is no site', () => {
    expect(
      probe(ZZ, `type T = typeof withParentInfo; interface I { withParentInfo(s: unknown): unknown }\n`)
    ).toEqual([]);
  });

  it.each([
    ['inside a never-taken branch', 'if (Math.random() < 0) carryReadOutputs(current.state);'],
    ['inside a closure never called', 'const later = () => { carryReadOutputs(current.state); };'],
  ])('probe: a carry %s does not count', (_what, carry) => {
    const rel = 'src/deployment/deploy-engine/nested-cleanup.ts';
    const text = real(rel).replace('carryReadOutputs(current.state);', carry);
    expect(text).not.toBe(real(rel));
    expect(probe(rel, text)).toEqual([
      'src/deployment/deploy-engine/nested-cleanup.ts#persistDropped#next: no carryReadOutputs(current.state) before the save in its function',
    ]);
  });

  // The mechanism the fence relies on, on the persist writer itself.
  const TOKEN = '{{resolve:secretsmanager:s:SecretString:k::}}';
  const engineStub = (): DeployEngine =>
    ({
      provenanceBaseline: undefined,
      outputsRun: {
        outputProvenanceSinks: new Map(),
        outputsResolvedThisRun: new WeakSet(),
        resolvedOutputsBag: undefined,
      },
    }) as unknown as DeployEngine;

  it("a registered read's bag carries its outputReferenceProvenance whole", () => {
    const read = {
      outputs: { QueueArn: `arn:aws:sqs:us-east-1:1:${TOKEN}` },
      outputReferenceProvenance: { QueueArn: { [TOKEN]: { versions: ['v2'] } } },
    };
    carryReadOutputs(read);
    expect(
      outputReferenceProvenanceFor.call(engineStub(), read.outputs, { ...read.outputs })
    ).toEqual(read.outputReferenceProvenance);
  });

  it('a registered bag edited after registration (a merge) carries nothing', () => {
    const read = {
      outputs: { QueueArn: `arn:aws:sqs:us-east-1:1:${TOKEN}` } as Record<string, unknown>,
      outputReferenceProvenance: { QueueArn: { [TOKEN]: { versions: ['v2'] } } },
    };
    carryReadOutputs(read);
    read.outputs['QueueArn'] = 'arn:aws:sqs:us-east-1:1:another-queue';
    expect(
      outputReferenceProvenanceFor.call(engineStub(), read.outputs, { ...read.outputs })
    ).toBe(undefined);
  });

  it('an unregistered bag (a merge) still persists none', () => {
    const outputs = { QueueArn: `arn:aws:sqs:us-east-1:1:${TOKEN}` };
    expect(outputReferenceProvenanceFor.call(engineStub(), outputs, { ...outputs })).toBe(
      undefined
    );
  });

  it('a registered read without the field persists none', () => {
    const read = { outputs: { QueueArn: `arn:aws:sqs:us-east-1:1:${TOKEN}` } };
    carryReadOutputs(read);
    expect(
      outputReferenceProvenanceFor.call(engineStub(), read.outputs, { ...read.outputs })
    ).toBe(undefined);
  });
});
