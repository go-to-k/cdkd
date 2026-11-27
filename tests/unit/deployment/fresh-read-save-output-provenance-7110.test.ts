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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseSync } from 'vite-plus';
import { describe, expect, it } from 'vite-plus/test';
import {
  carryReadOutputs,
  outputReferenceProvenanceFor,
} from '../../../src/deployment/deploy-engine/state-persist.js';
import type { DeployEngine } from '../../../src/deployment/deploy-engine.js';

const ROOT = join(__dirname, '..', '..', '..');
const SRC = join(ROOT, 'src');
const TARGETS = new Set(['withParentInfo', 'redactStateForPersist']);

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

interface Found {
  key: string;
  file: string;
  /** The enclosing function's body span. */
  fnStart: number;
  fnEnd: number;
  /** Where the reference is. */
  at: number;
  /** Each enclosing statement list (by its start) and the index of the statement holding the save. */
  blocks: Array<{ block: number; index: number }>;
}

type Node = { type: string; start: number; end: number; [k: string]: unknown };

function isNode(v: unknown): v is Node {
  return typeof v === 'object' && v !== null && typeof (v as Node).type === 'string';
}

/**
 * The name a function is known by, or undefined for a node that is no function
 * or an anonymous one (a callback): a site in a callback belongs to the named
 * function around it.
 */
function functionName(node: Node, parent: Node | undefined): string | undefined {
  const named = (n: unknown): string | undefined =>
    isNode(n) && n.type === 'Identifier' ? (n['name'] as string) : undefined;
  if (node.type === 'FunctionDeclaration') return named(node['id']);
  if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
    if (
      parent?.type === 'MethodDefinition' ||
      parent?.type === 'Property' ||
      parent?.type === 'PropertyDefinition'
    ) {
      return named(parent['key']);
    }
    if (parent?.type === 'VariableDeclarator') return named(parent['id']);
    return named(node['id']);
  }
  return undefined;
}

/** Nodes whose subtree is a TYPE position: a name there is no reference. */
const TYPE_POSITIONS = new Set([
  'TSTypeAnnotation',
  'TSTypeQuery',
  'TSTypeReference',
  'TSQualifiedName',
  'TSInterfaceDeclaration',
  'TSTypeAliasDeclaration',
  'TSTypeParameterInstantiation',
]);

/** Whether `node` names a choke-point function: an identifier, or a computed key spelled as a string. */
function namesTarget(node: Node, parent: Node | undefined, key: string): boolean {
  if (node.type === 'Identifier') return TARGETS.has(node['name'] as string);
  // `engine['withParentInfo'](x)` and `` engine[`withParentInfo`](x) ``.
  if (parent?.type !== 'MemberExpression' || parent['computed'] !== true || key !== 'property') {
    return false;
  }
  if (node.type === 'Literal') return TARGETS.has(node['value'] as string);
  if (node.type === 'TemplateLiteral' && (node['expressions'] as unknown[]).length === 0) {
    const quasi = (node['quasis'] as Node[])[0];
    return TARGETS.has((quasi?.['value'] as { cooked?: string } | undefined)?.cooked ?? '');
  }
  return false;
}

/**
 * A reference to a choke-point function, never a declaration, an import or a
 * type. Value-position TypeScript (`x!`, `x as T`, `x satisfies T`) counts.
 */
function isReference(node: Node, chain: Array<{ node: Node; key: string }>): boolean {
  const parentEntry = chain[chain.length - 1];
  const parent = parentEntry?.node;
  const key = parentEntry?.key ?? '';
  if (parent === undefined || !namesTarget(node, parent, key)) return false;
  if (chain.some((c) => TYPE_POSITIONS.has(c.node.type))) return false;
  if (
    parent.type === 'ImportSpecifier' ||
    parent.type === 'ExportSpecifier' ||
    parent.type === 'TSMethodSignature' ||
    parent.type === 'TSPropertySignature' ||
    (parent.type === 'FunctionDeclaration' && key === 'id') ||
    ((parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') &&
      key === 'key')
  ) {
    return false;
  }
  // An object literal's key names nothing; a destructuring pattern's key reads
  // the function off the object (`const { withParentInfo: save } = engine`).
  if (parent.type === 'Property' && key === 'key' && parent['shorthand'] !== true) {
    return chain[chain.length - 2]?.node.type === 'ObjectPattern';
  }
  return true;
}

/** Each statement list around the end of `chain`, with the index of the statement holding it. */
function statementBlocks(
  chain: Array<{ node: Node; key: string }>,
  child: Node
): Array<{ block: number; index: number }> {
  const out: Array<{ block: number; index: number }> = [];
  for (let i = chain.length - 1; i >= 0; i--) {
    const holder = chain[i]!.node;
    if ((holder.type === 'BlockStatement' || holder.type === 'Program') && chain[i]!.key === 'body') {
      const inner = i + 1 < chain.length ? chain[i + 1]!.node : child;
      out.push({ block: holder.start, index: (holder['body'] as Node[]).indexOf(inner) });
    }
  }
  return out;
}

function sitesIn(file: string, text: string): Found[] {
  const parsed = parseSync(file, text);
  if (parsed.errors.length > 0) throw new Error(`cannot parse ${file}: ${parsed.errors[0]!.message}`);
  const out: Found[] = [];
  const walk = (node: Node, chain: Array<{ node: Node; key: string }>, fn: { name: string; node: Node } | undefined): void => {
    const parentEntry = chain[chain.length - 1];
    const parent = parentEntry?.node;
    const ownName = functionName(node, parent);
    const here = ownName !== undefined ? { name: ownName, node } : fn;
    if (isReference(node, chain)) {
      // The call this reference is the callee of (anything else is a bare
      // reference, keyed `<ref>`): `x(…)`, `a.x(…)`, `a.x?.(…)`.
      let callee: Node = node;
      let i = chain.length - 1;
      if (chain[i]?.node.type === 'MemberExpression' && chain[i]!.key === 'property') {
        callee = chain[i]!.node;
        i--;
      }
      if (chain[i]?.node.type === 'ChainExpression') i--;
      const call = chain[i]?.node;
      const args = call?.type === 'CallExpression' && call['callee'] === callee ? (call['arguments'] as Node[]) : undefined;
      const saved = args !== undefined && args[0] !== undefined ? text.slice(args[0].start, args[0].end) : '<ref>';
      const name = here?.name ?? '<module>';
      const rel = relative(ROOT, file).split('\\').join('/');
      out.push({
        key: `${rel}#${name}#${saved.replace(/\s+/g, ' ')}`,
        file: rel,
        fnStart: here?.node.start ?? 0,
        fnEnd: here?.node.end ?? text.length,
        at: node.start,
        blocks: statementBlocks(chain, node),
      });
    }
    for (const [k, v] of Object.entries(node)) {
      if (Array.isArray(v)) {
        for (const c of v) if (isNode(c)) walk(c, [...chain, { node, key: k }], here);
      } else if (isNode(v)) {
        walk(v, [...chain, { node, key: k }], here);
      }
    }
  };
  walk(parsed.program as unknown as Node, [], undefined);
  return out;
}

/**
 * `carryReadOutputs(<arg>);` STATEMENTS in `text`: each one's statement list
 * and index there. A call inside a condition, an expression or a closure is no
 * such statement, so it cannot stand in for an unconditional carry.
 */
function carriesIn(
  file: string,
  text: string
): Array<{ arg: string; at: number; block: number; index: number }> {
  const parsed = parseSync(file, text);
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
  walk(parsed.program as unknown as Node);
  return out;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsFiles(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** Every site under `srcDir`, with `extra` (path -> text) overriding or adding files. */
function scan(srcDir: string, extra: Record<string, string> = {}): { sites: Found[]; texts: Map<string, string> } {
  const sites: Found[] = [];
  const texts = new Map<string, string>();
  const files = new Map<string, string>();
  for (const path of tsFiles(srcDir)) {
    const text = readFileSync(path, 'utf8');
    // A file naming neither function holds no site: skip parsing it.
    if (![...TARGETS].some((t) => text.includes(t))) continue;
    files.set(path, text);
  }
  for (const [path, text] of Object.entries(extra)) files.set(path, text);
  for (const [path, text] of files) {
    const found = sitesIn(path, text);
    if (found.length > 0) texts.set(relative(ROOT, path).split('\\').join('/'), text);
    sites.push(...found);
  }
  return { sites, texts };
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
