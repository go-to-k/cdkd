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
 * What "the same template" means: the file's name inside its REAL directory.
 *
 * The directory is `realpath`ed because a symlinked DIRECTORY (`d -> .`) makes
 * every level's joined path a new, longer string (`d/a.json`, `d/d/a.json`,
 * ...) for one and the same file, which a comparison of resolved path strings
 * never sees repeat.
 *
 * The FILE's own symlink is deliberately not followed. A template's children
 * resolve against the directory it was REACHED in, so one real file reached in
 * two directories is two different subtrees; keying on the real directory plus
 * the name makes everything below a node a function of its identity, which is
 * what lets a clean subtree be remembered. There are finitely many such pairs,
 * so the walk still terminates.
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

/**
 * The nested-stack rows of one template, as the provider would index them.
 * Unreadable or unparseable input yields `undefined`: reporting that is the
 * job of the site that actually loads the template, with its own message, and
 * a walk that cannot descend cannot loop.
 */
function readNestedRows(
  templatePath: string
): Array<{ logicalId: string; assetPath: string }> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const resources = (parsed as { Resources?: unknown }).Resources;
  if (resources === null || typeof resources !== 'object' || Array.isArray(resources)) {
    return [];
  }
  const rows: Array<{ logicalId: string; assetPath: string }> = [];
  for (const [logicalId, resource] of Object.entries(resources as Record<string, unknown>)) {
    if (resource === null || typeof resource !== 'object') continue;
    const row = resource as { Type?: unknown; Metadata?: unknown };
    if (row.Type !== NESTED_STACK_TYPE) continue;
    const meta = row.Metadata;
    if (meta === null || typeof meta !== 'object') continue;
    const assetPath = (meta as Record<string, unknown>)['aws:asset:path'];
    if (typeof assetPath !== 'string' || assetPath.length === 0) continue;
    rows.push({ logicalId, assetPath });
  }
  return rows;
}

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
  // Templates whose whole subtree was already walked clean. Sound for ANY
  // later chain: a descendant of N equal to an ancestor of N closes a cycle
  // through N, and the first walk of N's subtree would have followed it back
  // to N. Without this a tree of diamonds is walked 2^depth times.
  const clean = new Set<string>();
  const chain: NestedTemplateHop[] = [];

  const visit = (logicalId: string, templatePath: string): NestedTemplateTreeDefect | undefined => {
    const identity = templateIdentity(templatePath);
    chain.push({ logicalId, templatePath: identity });
    try {
      if (onChain.has(identity)) return { kind: 'cycle', chain: [...chain] };
      if (clean.has(identity)) return undefined;
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
      clean.add(identity);
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
  if (defect.kind === 'cycle') {
    const closing = defect.chain[defect.chain.length - 1]!;
    return (
      `The nested template tree under stack '${displaySafe(stackName)}' contains a cycle: ` +
      `${renderChain(defect.chain)}. Nested stack '${displaySafe(closing.logicalId)}' ` +
      `resolves to a template that is already on that nesting chain, so its ` +
      `Metadata['aws:asset:path'] closes a cycle. ${provenance}`
    );
  }
  return (
    `The nested template tree under stack '${displaySafe(stackName)}' has nested stack ` +
    `'${displaySafe(defect.logicalId)}' (reached through ${renderChain(defect.chain)}) with ` +
    `Metadata['aws:asset:path']='${displaySafe(defect.assetPath)}' which is absolute. ${provenance}`
  );
}
