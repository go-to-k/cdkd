import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';
import { parseSync } from 'vite-plus';

/**
 * The site scanner behind the choke-point fences (go-to-k/cdkd#7110,
 * go-to-k/cdkd#7061): every REFERENCE to a named function in a source tree,
 * keyed `<file>#<enclosing function>#<the argument it is handed>`, read with a
 * real parser (oxc, via `vite-plus`), so a comment, a string or a regex
 * literal is never read as code, and a type-position name is no reference.
 *
 * A fence classifies each key: a new site, a moved one or a second one in the
 * same function then fails until someone classifies it.
 */

export const ROOT = join(import.meta.dirname, '..', '..');
export const SRC = join(ROOT, 'src');

export interface Found {
  key: string;
  file: string;
  /** The function the reference sits in (`<module>` at the top level). */
  fn: string;
  /** The text of the argument the fence keys on, `<ref>` for a bare reference. */
  saved: string;
  /** The enclosing function's span. */
  fnStart: number;
  fnEnd: number;
  /** Where the reference is. */
  at: number;
  /** Each enclosing statement list (by its start) and the index of the statement holding the site. */
  blocks: Array<{ block: number; index: number }>;
}

export type Node = { type: string; start: number; end: number; [k: string]: unknown };

export function isNode(v: unknown): v is Node {
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

/** Whether `node` names a target: an identifier, or a computed key spelled as a string. */
function namesTarget(
  targets: ReadonlyMap<string, number>,
  node: Node,
  parent: Node | undefined,
  key: string
): string | undefined {
  const hit = (name: unknown): string | undefined =>
    typeof name === 'string' && targets.has(name) ? name : undefined;
  if (node.type === 'Identifier') return hit(node['name']);
  // `engine['withParentInfo'](x)`, `` engine[`withParentInfo`](x) ``, and a
  // computed destructuring key (`const { ['withParentInfo']: w } = engine`).
  const computedMember =
    parent?.type === 'MemberExpression' && parent['computed'] === true && key === 'property';
  const computedKey = parent?.type === 'Property' && parent['computed'] === true && key === 'key';
  if (!computedMember && !computedKey) return undefined;
  if (node.type === 'Literal') return hit(node['value']);
  if (node.type === 'TemplateLiteral' && (node['expressions'] as unknown[]).length === 0) {
    const quasi = (node['quasis'] as Node[])[0];
    return hit((quasi?.['value'] as { cooked?: string } | undefined)?.cooked);
  }
  return undefined;
}

/**
 * The target a node references, never a declaration, an import or a type.
 * Value-position TypeScript (`x!`, `x as T`, `x satisfies T`) counts.
 */
function referencedTarget(
  targets: ReadonlyMap<string, number>,
  node: Node,
  chain: Array<{ node: Node; key: string }>
): string | undefined {
  const parentEntry = chain[chain.length - 1];
  const parent = parentEntry?.node;
  const key = parentEntry?.key ?? '';
  if (parent === undefined) return undefined;
  const name = namesTarget(targets, node, parent, key);
  if (name === undefined) return undefined;
  if (chain.some((c) => TYPE_POSITIONS.has(c.node.type))) return undefined;
  if (
    parent.type === 'ImportSpecifier' ||
    parent.type === 'ExportSpecifier' ||
    parent.type === 'TSMethodSignature' ||
    parent.type === 'TSPropertySignature' ||
    (parent.type === 'FunctionDeclaration' && key === 'id') ||
    ((parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') &&
      key === 'key')
  ) {
    return undefined;
  }
  // An object literal's key names nothing; a destructuring pattern's key reads
  // the function off the object (`const { withParentInfo: save } = engine`).
  if (parent.type === 'Property' && key === 'key' && parent['shorthand'] !== true) {
    return chain[chain.length - 2]?.node.type === 'ObjectPattern' ? name : undefined;
  }
  return name;
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

/**
 * A callback argument is keyed by a short digest of its text rather than the
 * text itself: the key stays readable, and an edit to the body still changes
 * it, so the entry is classified again.
 */
function callbackOrText(normalized: string, arg: Node): string {
  if (arg.type !== 'ArrowFunctionExpression' && arg.type !== 'FunctionExpression') return normalized;
  return `<callback:${createHash('sha256').update(normalized).digest('hex').slice(0, 10)}>`;
}

/** Parse `text`, refusing a file the parser cannot read (a scan of half a file proves nothing). */
export function parseOrThrow(file: string, text: string): Node {
  const parsed = parseSync(file, text);
  if (parsed.errors.length > 0) throw new Error(`cannot parse ${file}: ${parsed.errors[0]!.message}`);
  return parsed.program as unknown as Node;
}

/** Walk every node under `root`, depth first. */
export function walkNodes(root: Node, visit: (node: Node) => void): void {
  visit(root);
  for (const v of Object.values(root)) {
    if (Array.isArray(v)) {
      for (const c of v) if (isNode(c)) walkNodes(c, visit);
    } else if (isNode(v)) {
      walkNodes(v, visit);
    }
  }
}

/**
 * Each reference to a target in one file. `targets` maps a function name to
 * the index of the argument a site is keyed on (the value it saves).
 */
export function sitesIn(
  targets: ReadonlyMap<string, number>,
  file: string,
  text: string
): Found[] {
  const program = parseOrThrow(file, text);
  const out: Found[] = [];
  const walk = (
    node: Node,
    chain: Array<{ node: Node; key: string }>,
    fn: { name: string; node: Node } | undefined
  ): void => {
    const parentEntry = chain[chain.length - 1];
    const parent = parentEntry?.node;
    const ownName = functionName(node, parent);
    const here = ownName !== undefined ? { name: ownName, node } : fn;
    const target = referencedTarget(targets, node, chain);
    if (target !== undefined) {
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
      const args =
        call?.type === 'CallExpression' && call['callee'] === callee
          ? (call['arguments'] as Node[])
          : undefined;
      const arg = args?.[targets.get(target)!];
      const saved =
        args === undefined
          ? '<ref>'
          : arg === undefined
            ? '<ref>'
            : callbackOrText(text.slice(arg.start, arg.end).replace(/\s+/g, ' '), arg);
      const name = here?.name ?? '<module>';
      const rel = relative(ROOT, file).split('\\').join('/');
      out.push({
        key: `${rel}#${name}#${saved}`,
        file: rel,
        fn: name,
        saved,
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
  walk(program, [], undefined);
  return out;
}

/** Every `.ts` file under `dir`, recursively. */
export function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsFiles(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/**
 * Every site under `srcDir`, with `extra` (absolute path -> text) overriding or
 * adding files. `texts` holds the text of each file that has a site.
 */
export function scanSites(
  targets: ReadonlyMap<string, number>,
  srcDir: string,
  extra: Record<string, string> = {}
): { sites: Found[]; texts: Map<string, string> } {
  const sites: Found[] = [];
  const texts = new Map<string, string>();
  const files = new Map<string, string>();
  for (const path of tsFiles(srcDir)) {
    const text = readFileSync(path, 'utf8');
    // A file naming no target holds no site: skip parsing it.
    if (![...targets.keys()].some((t) => text.includes(t))) continue;
    files.set(path, text);
  }
  for (const [path, text] of Object.entries(extra)) files.set(path, text);
  for (const [path, text] of files) {
    const found = sitesIn(targets, path, text);
    if (found.length > 0) texts.set(relative(ROOT, path).split('\\').join('/'), text);
    sites.push(...found);
  }
  return { sites, texts };
}
