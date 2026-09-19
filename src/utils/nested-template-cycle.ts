import * as fs from 'node:fs';
import * as path from 'node:path';
import { displaySafe } from './display-safe.js';

/**
 * Static, READ-ONLY validation of a nested-template tree, run BEFORE anything
 * is deployed from it (issue go-to-k/cdkd#3247).
 *
 * `NestedStackProvider` follows `Metadata['aws:asset:path']` from one nested
 * template to the next and runs a whole child `DeployEngine` per level. A
 * relative path that resolves back onto the same nesting chain therefore
 * DEPLOYS every level of the cycle until S3's key limit stops it. Threading an
 * ancestor chain through the provider's recursion would only refuse at the
 * first repeat, by which point every level above it is already provisioned.
 * Everything the walk follows is on disk before the first child engine exists,
 * so the whole subtree is validated up front instead.
 *
 * Two properties are copied from the `cdkd diff --recursive` guard (issue
 * go-to-k/cdkd#3239), because re-deriving them gets them wrong:
 *
 * - The refused shape is a repeat along ONE root-to-node chain, never a repeat
 *   anywhere in the tree: two sibling rows may name the same child template,
 *   and that diamond is a legitimate assembly.
 * - It is a refusal, not a depth cap. A cyclic assembly has no correct deploy.
 *
 * `Condition`s are deliberately NOT evaluated: a row whose condition would be
 * false at deploy time still counts. A self-including template that terminates
 * through a condition is refused here exactly as the diff walk refuses it, so
 * the two commands agree about which assemblies are well-formed.
 *
 * A leaf apart from `display-safe.ts`, so any layer may import it.
 */

const NESTED_STACK_TYPE = 'AWS::CloudFormation::Stack';

/** One `AWS::CloudFormation::Stack` row on the chain, in root-to-node order. */
export interface NestedTemplateHop {
  /** The row's logical id in its parent template. Template-controlled. */
  logicalId: string;
  /** Identity of the template file the row resolves to (see `templateIdentity`). */
  templatePath: string;
}

export type NestedTemplateTreeDefect =
  | {
      kind: 'too-large';
      /** The chain the walk was on when it ran out of budget. */
      chain: NestedTemplateHop[];
    }
  | {
      kind: 'too-deep';
      /** The first `MAX_NESTING_DEPTH + 1` rows of a chain that is still descending. */
      chain: NestedTemplateHop[];
    }
  | {
      kind: 'cycle';
      /**
       * Entry row first; the LAST hop is the row that closed the cycle, and its
       * `templatePath` equals an earlier hop's (or a seeded ancestor's).
       */
      chain: NestedTemplateHop[];
    }
  | {
      kind: 'absolute-path';
      /** Rows leading to the template that declares the offending row. Never empty. */
      chain: NestedTemplateHop[];
      logicalId: string;
      assetPath: string;
    };

/**
 * Same predicate `NestedStackProvider` applies per level. The `startsWith('/')`
 * arm covers a POSIX-style absolute path consumed on Windows, where
 * `path.isAbsolute` alone answers `false`.
 */
export function isAbsoluteAssetPath(p: string): boolean {
  return path.isAbsolute(p) || p.startsWith('/');
}

/**
 * What "the same template" means ON A CHAIN: the file's name inside its REAL
 * directory.
 *
 * The directory is `realpath`ed because a symlinked DIRECTORY (`d -> .`) makes
 * every level's joined path a new, longer string (`d/a.json`, `d/d/a.json`,
 * ...) for one and the same file, which a comparison of resolved path strings
 * never sees repeat. There are finitely many (real directory, name) pairs, so
 * an endless descent must repeat one, however it is spelled.
 *
 * It is NOT what decides a template's children. Those resolve LEXICALLY
 * against the directory the template was reached in (`path.join` folds `d/..`
 * without following the link), so one identity reached through two spellings
 * can have two different subtrees. That is why the clean-subtree memo in
 * `findNestedTemplateTreeDefect` is keyed on the lexical path instead, and why
 * an identity repeat is a conservative refusal rather than an exact one: with
 * a symlinked directory AND a `..` row it can refuse a tree that would have
 * terminated. Such an assembly is hand-built by definition.
 *
 * Falls back to `path.resolve` for a directory that does not exist; the walk
 * stops there anyway.
 */
export function templateIdentity(templatePath: string): string {
  const dir = path.dirname(templatePath);
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    realDir = path.resolve(dir);
  }
  return path.join(realDir, path.basename(templatePath));
}

/** One `AWS::CloudFormation::Stack` row that names a child template file. */
export interface NestedTemplateRow {
  logicalId: string;
  /** `Metadata['aws:asset:path']`, verbatim: relative in a CDK assembly. */
  assetPath: string;
}

/**
 * The nested-stack rows of a parsed template that name a child template file.
 *
 * THE ONE SPELLING, shared by this module's walk and by
 * `NestedStackProvider.indexGrandchildTemplates`, because the walk is only a
 * guard if it follows exactly the rows the deploy follows. Two hand-written
 * copies disagreed on an ARRAY-valued `Resources`: `Object.entries` indexes an
 * array as `'0'`, `'1'`, ..., the deploy followed those rows, and a walk that
 * skipped them accepted a cyclic tree. So this takes whatever `Object.entries`
 * takes, and does not pre-judge the container's shape.
 */
export function listNestedTemplateRows(template: unknown): NestedTemplateRow[] {
  if (template === null || typeof template !== 'object') return [];
  const resources = (template as { Resources?: unknown }).Resources;
  if (resources === null || resources === undefined) return [];
  const rows: NestedTemplateRow[] = [];
  for (const [logicalId, resource] of Object.entries(resources as object)) {
    const row = resource as { Type?: unknown; Metadata?: unknown } | null | undefined;
    if (row?.Type !== NESTED_STACK_TYPE) continue;
    const meta = row.Metadata as Record<string, unknown> | null | undefined;
    const assetPath = meta?.['aws:asset:path'];
    if (typeof assetPath !== 'string' || assetPath.length === 0) continue;
    rows.push({ logicalId, assetPath });
  }
  return rows;
}

/**
 * The rows of the template FILE at `templatePath`. Unreadable or unparseable
 * input yields `undefined`: reporting that is the job of the site that
 * actually loads the template, with its own message, and a walk that cannot
 * descend cannot loop.
 */
function readNestedRows(templatePath: string): NestedTemplateRow[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
  } catch {
    return undefined;
  }
  return listNestedTemplateRows(parsed);
}

/**
 * Deeper than this cannot deploy at all, so it is refused rather than walked.
 * A child's state key is `cdkd/<root>~<id>~<id>.../<region>/state.json`; each
 * level adds at least two bytes (`~` plus a one-character logical id) and S3
 * caps a key at 1024 bytes. The bound exists so a hostile chain of tens of
 * thousands of DISTINCT templates is a readable refusal instead of a
 * `RangeError` from the recursion below. It is not a cycle heuristic: a cycle
 * is refused at its first repeat, long before this.
 */
export const MAX_NESTING_DEPTH = 512;

/**
 * Rows the walk will follow before it refuses the tree as too large.
 *
 * The clean-subtree memo is keyed on the LEXICAL path (it has to be, see
 * `templateIdentity`), and symlinked directories give one file arbitrarily
 * many lexical spellings: with `d1 -> .` and `d2 -> .`, rows naming
 * `t.json`, `d1/t.json` and `d2/t.json` at every level multiply the spellings
 * per level while no chain ever repeats an identity. Such a walk is finite but
 * exponential, so it needs a budget rather than a better key. Far above any
 * real assembly: a CDK app's nested templates number in the tens, and a memo
 * hit costs one row, not a subtree.
 */
export const MAX_ROWS_FOLLOWED = 10_000;

/**
 * Walk every nested template reachable from `nestedTemplates` (logical id ->
 * template file path, the shape `AssemblyReader` and the provider's own
 * per-level index produce) and return the first defect, or `undefined` when
 * the tree is well-formed.
 *
 * `ancestorTemplatePaths` seeds the chain with templates ABOVE the entry rows,
 * for a caller that knows them. Detection does not depend on it: a cycle
 * through an unseeded ancestor is followed once around and refused when it
 * re-enters the first template the walk did see.
 */
export function findNestedTemplateTreeDefect(
  nestedTemplates: Readonly<Record<string, string>>,
  ancestorTemplatePaths: Iterable<string> = []
): NestedTemplateTreeDefect | undefined {
  const onChain = new Set<string>();
  for (const p of ancestorTemplatePaths) onChain.add(templateIdentity(p));
  // LEXICAL paths whose whole subtree was already walked to its leaves, i.e.
  // proven FINITE. Keyed on the lexical path, not on the identity, because a
  // template's content and its children's paths are both functions of the
  // lexical path and of nothing else (see `templateIdentity`). Skipping a
  // finite subtree can never hide an endless descent, whatever chain it is
  // reached on. Without this a tree of diamonds is walked 2^depth times.
  const clean = new Set<string>();
  const chain: NestedTemplateHop[] = [];
  let rowsFollowed = 0;

  const visit = (logicalId: string, templatePath: string): NestedTemplateTreeDefect | undefined => {
    const identity = templateIdentity(templatePath);
    const lexical = path.resolve(templatePath);
    chain.push({ logicalId, templatePath: identity });
    try {
      if (onChain.has(identity)) return { kind: 'cycle', chain: [...chain] };
      if (chain.length > MAX_NESTING_DEPTH) return { kind: 'too-deep', chain: [...chain] };
      if (++rowsFollowed > MAX_ROWS_FOLLOWED) return { kind: 'too-large', chain: [...chain] };
      if (clean.has(lexical)) return undefined;
      const rows = readNestedRows(templatePath);
      if (rows === undefined) return undefined;
      onChain.add(identity);
      try {
        const dir = path.dirname(templatePath);
        for (const row of rows) {
          if (isAbsoluteAssetPath(row.assetPath)) {
            return {
              kind: 'absolute-path',
              chain: [...chain],
              logicalId: row.logicalId,
              assetPath: row.assetPath,
            };
          }
          const defect = visit(row.logicalId, path.join(dir, row.assetPath));
          if (defect) return defect;
        }
      } finally {
        onChain.delete(identity);
      }
      clean.add(lexical);
      return undefined;
    } finally {
      chain.pop();
    }
  };

  for (const [logicalId, templatePath] of Object.entries(nestedTemplates)) {
    const defect = visit(logicalId, templatePath);
    if (defect) return defect;
  }
  return undefined;
}

/** Hops rendered in full before the middle of a long chain is elided. */
const MAX_RENDERED_HOPS = 8;

/**
 * `'A' (/x/a.json) -> 'B' (/x/b.json)`. Every interpolation goes through
 * `displaySafe`: this text exists FOR a hand-modified assembly, so a logical id
 * (a template key) and a path (derived from `aws:asset:path`) are both
 * attacker-controlled, and a bare `Error` message is not sanitized downstream.
 * A long chain keeps both ends, since the entry row and the closing row are
 * the two a reader needs.
 */
function renderChain(chain: readonly NestedTemplateHop[]): string {
  const hop = (h: NestedTemplateHop): string =>
    `'${displaySafe(h.logicalId)}' (${displaySafe(h.templatePath)})`;
  if (chain.length <= MAX_RENDERED_HOPS) return chain.map(hop).join(' -> ');
  const keep = MAX_RENDERED_HOPS / 2;
  return [
    ...chain.slice(0, keep).map(hop),
    `... ${chain.length - 2 * keep} more ...`,
    ...chain.slice(-keep).map(hop),
  ].join(' -> ');
}

/**
 * The refusal text for a defect found under `stackName`. `action` completes
 * "Refusing to ..." so each caller states what it declined to do.
 */
export function renderNestedTemplateTreeDefect(
  defect: NestedTemplateTreeDefect,
  stackName: string,
  action: string
): string {
  const provenance =
    `CDK emits an acyclic nested template tree with relative asset paths, so this ` +
    `indicates the synth output was hand-modified or generated by a non-CDK toolchain. ` +
    `Refusing to ${action}.`;
  // The stack that DECLARES the last row: every hop above it appends one
  // `~<logicalId>`, the same derivation the provider uses for a child's name.
  // Elided like the chain itself, so a long chain of long ids cannot put an
  // unbounded name into the message.
  const owner = (chain: readonly NestedTemplateHop[]): string => {
    const ids = chain.slice(0, -1).map((h) => h.logicalId);
    const keep = MAX_RENDERED_HOPS / 2;
    const shown =
      ids.length <= MAX_RENDERED_HOPS
        ? ids
        : [...ids.slice(0, keep), `...${ids.length - 2 * keep} more...`, ...ids.slice(-keep)];
    return displaySafe([stackName, ...shown].join('~'));
  };
  if (defect.kind === 'cycle') {
    const closing = defect.chain[defect.chain.length - 1]!;
    return (
      `The nested template tree under stack '${displaySafe(stackName)}' contains a cycle: ` +
      `${renderChain(defect.chain)}. Nested stack '${displaySafe(closing.logicalId)}' ` +
      `(declared in stack '${owner(defect.chain)}') resolves to a template that is already ` +
      `on that nesting chain, so its Metadata['aws:asset:path'] closes a cycle. ${provenance}`
    );
  }
  if (defect.kind === 'too-large') {
    return (
      `The nested template tree under stack '${displaySafe(stackName)}' has more than ` +
      `${MAX_ROWS_FOLLOWED} nested-stack rows to follow (the walk stopped at ` +
      `${renderChain(defect.chain)}). Symlinked directories can give one template file many ` +
      `paths, which multiplies the tree without ever repeating on one chain. ${provenance}`
    );
  }
  if (defect.kind === 'too-deep') {
    return (
      `The nested template tree under stack '${displaySafe(stackName)}' nests more than ` +
      `${MAX_NESTING_DEPTH} levels deep: ${renderChain(defect.chain)}. No tree that deep can ` +
      `deploy, because each level lengthens the child's state key and S3 caps a key at 1024 ` +
      `bytes. ${provenance}`
    );
  }
  return (
    `The nested template tree under stack '${displaySafe(stackName)}' has nested stack ` +
    `'${displaySafe(defect.logicalId)}' (reached through ${renderChain(defect.chain)}) with ` +
    `Metadata['aws:asset:path']='${displaySafe(defect.assetPath)}' which is absolute. ${provenance}`
  );
}
