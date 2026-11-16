import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CloudFormationTemplate } from '../types/resource/template.js';
import {
  displayAssemblyPath,
  renderAssemblyPathEscape,
  resolveAssemblyPath,
} from '../utils/assembly-path.js';
import { displaySafe } from '../utils/display-safe.js';
import { SynthesisError } from '../utils/error-handler.js';
import { listNestedTemplateRows, MAX_NESTING_DEPTH } from '../utils/nested-template-cycle.js';
import { containsMacro } from './macro-detector.js';
import type { StackInfo } from './assembly-reader.js';

/**
 * Macro expansion for NESTED templates (go-to-k/cdkd#6395).
 *
 * `expandMacrosForStacks` expands a stack's own template in memory, but a
 * `cdk.NestedStack` child is read from its FILE (`StackInfo.nestedTemplates`
 * at the top level, `Metadata['aws:asset:path']` below it) by every consumer:
 * the deploy's `NestedStackProvider`, `cdkd diff`'s tree walk, the pre-flight
 * walks. A child carrying a `Transform` (CDK's `HostedRotation.*` adds
 * `AWS::SecretsManager-2024-09-16`) was therefore deployed raw, while
 * CloudFormation expands a nested template's transforms when it creates the
 * child stack.
 *
 * The expanded child is written NEXT TO its original, as
 * `<name>.cdkd-expanded.json`, and the reference to it is re-pointed: the
 * stack's `nestedTemplates` entry for a top-level row, the parent template's
 * `aws:asset:path` (in the parent's own expanded copy) for a deeper one. The
 * same directory keeps every relative `aws:asset:path` below it resolving and
 * keeps the file inside the assembly directory `resolveAssemblyPath` checks,
 * so no consumer changes. The original file is never modified.
 */

/** Suffix of an expanded nested template, beside the file it replaces. */
export const EXPANDED_TEMPLATE_SUFFIX = '.cdkd-expanded.json';

function readTemplate(templatePath: string): CloudFormationTemplate | undefined {
  try {
    return JSON.parse(fs.readFileSync(templatePath, 'utf-8')) as CloudFormationTemplate;
  } catch {
    // Reporting an unreadable template is the job of the site that loads it.
    return undefined;
  }
}

/**
 * Write `template` as the expanded copy of `templatePath`, beside it, and
 * return the copy's path.
 *
 * The directory is the assembly's, which cdkd did not create (`-a <dir>` may
 * be anyone's), so this is the third write site `assembly-path.ts` describes:
 * the leaf may already be a symbolic link planted to point outside the
 * assembly. The name is containment-checked, a link at the leaf is refused
 * whatever it points at (`lstat`), and the bytes go to a fresh `wx` file in
 * the same directory that is then RENAMED over the leaf: `rename` replaces a
 * link that appears in between rather than following it, and a concurrent
 * reader of the leaf (a `diff` and a `deploy` over one assembly) sees the old
 * file or the new one, never a half-written one.
 */
function writeExpandedTemplate(templatePath: string, template: CloudFormationTemplate): string {
  const dir = path.dirname(templatePath);
  const name = `${path.basename(templatePath).replace(/\.json$/i, '')}${EXPANDED_TEMPLATE_SUFFIX}`;
  const resolved = resolveAssemblyPath(dir, name);
  if (!resolved.contained) {
    throw new SynthesisError(
      `Cannot write the macro-expanded copy of nested template ${displayAssemblyPath(templatePath)}: ` +
        `${displayAssemblyPath(name)} ${renderAssemblyPathEscape(resolved, dir, 'write')}`
    );
  }
  const expandedPath = path.join(dir, name);
  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(expandedPath);
  } catch {
    existing = undefined;
  }
  if (existing !== undefined && !existing.isFile()) {
    throw new SynthesisError(
      `Refusing to write the macro-expanded copy of nested template ` +
        `${displayAssemblyPath(templatePath)}: ${displayAssemblyPath(expandedPath)} already exists ` +
        `and is ${existing.isSymbolicLink() ? 'a symbolic link' : 'not a regular file'}. ` +
        `cdkd writes that file itself; remove it and re-run.`
    );
  }
  const tmpPath = path.join(dir, `.${name}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(template, null, 1), { flag: 'wx', mode: 0o644 });
    fs.renameSync(tmpPath, expandedPath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Not created, or already renamed.
    }
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    throw new SynthesisError(
      `Could not write the macro-expanded copy of nested template ` +
        `${displayAssemblyPath(templatePath)} to ${displayAssemblyPath(expandedPath)}` +
        `${typeof code === 'string' ? ` (${displaySafe(code)})` : ''}. cdkd writes it beside the ` +
        `original in the cloud assembly directory, which must be writable.`,
      err instanceof Error ? err : undefined
    );
  }
  return expandedPath;
}

/** A nested template file's serialized size, as the expander would send it; 0 when unreadable. */
export function nestedTemplateBytes(templatePath: string): number {
  const template = readTemplate(templatePath);
  return template === undefined ? 0 : JSON.stringify(template).length;
}

/** The child template files a template's nested-stack rows name, contained ones only. */
function childPaths(
  template: unknown,
  templatePath: string
): Array<{ logicalId: string; childPath: string }> {
  const dir = path.dirname(templatePath);
  const out: Array<{ logicalId: string; childPath: string }> = [];
  for (const row of listNestedTemplateRows(template)) {
    // An escaping path is refused by the tree pre-flight / the provider; it
    // is not followed here.
    const resolved = resolveAssemblyPath(dir, row.assetPath);
    if (resolved.contained) out.push({ logicalId: row.logicalId, childPath: resolved.path });
  }
  return out;
}

/**
 * The nested template files under `stack` that carry a macro, at any depth,
 * in the ORIGINAL tree. Read-only; an unreadable file and anything below it
 * are skipped.
 */
export function macroCarryingNestedTemplates(stack: Pick<StackInfo, 'nestedTemplates'>): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const walk = (templatePath: string, depth: number): void => {
    if (depth > MAX_NESTING_DEPTH || seen.has(templatePath)) return;
    seen.add(templatePath);
    const template = readTemplate(templatePath);
    if (template === undefined) return;
    if (containsMacro(template)) found.push(templatePath);
    for (const { childPath } of childPaths(template, templatePath)) walk(childPath, depth + 1);
  };
  for (const templatePath of Object.values(stack.nestedTemplates ?? {})) walk(templatePath, 1);
  return found;
}

/**
 * Expand every macro-carrying nested template under `stack` with `expand`
 * and re-point the references to the expanded copies. Bottom-up AFTER the
 * template's own expansion, so the rows a transform adds or keeps are the
 * ones followed. Returns how many templates were expanded.
 */
export async function expandNestedTemplateMacros(
  stack: Pick<StackInfo, 'nestedTemplates'>,
  expand: (
    template: CloudFormationTemplate,
    templatePath: string
  ) => Promise<CloudFormationTemplate>
): Promise<number> {
  let expandedCount = 0;
  // A path reached twice (two rows naming one file) is processed once.
  const done = new Map<string, string>();

  const processFile = async (templatePath: string, depth: number): Promise<string> => {
    const memo = done.get(templatePath);
    if (memo !== undefined) return memo;
    // A cycle or an over-deep chain is the tree pre-flight's refusal.
    done.set(templatePath, templatePath);
    if (depth > MAX_NESTING_DEPTH) return templatePath;
    // The suffix is cdkd's own: a row of this tree naming such a file could
    // be overwritten by another template's expanded copy, so expanding this
    // stack's tree is refused. Only the trees being expanded are checked (a
    // stack with no macro-carrying nested template writes nothing), and our
    // own re-pointed copies are never walked (each is returned unprocessed).
    if (templatePath.toLowerCase().endsWith(EXPANDED_TEMPLATE_SUFFIX)) {
      throw new SynthesisError(
        `Nested template ${displayAssemblyPath(templatePath)} ends in ${EXPANDED_TEMPLATE_SUFFIX}, ` +
          `the name cdkd gives the macro-expanded copy of a nested template it writes beside the ` +
          `original. Rename it in the cloud assembly; refusing to expand the nested templates.`
      );
    }
    let template = readTemplate(templatePath);
    if (template === undefined) return templatePath;

    let changed = false;
    if (containsMacro(template)) {
      template = await expand(template, templatePath);
      expandedCount++;
      changed = true;
    }
    for (const { logicalId, childPath } of childPaths(template, templatePath)) {
      const next = await processFile(childPath, depth + 1);
      if (next === childPath) continue;
      const row = (template.Resources as Record<string, { Metadata?: Record<string, unknown> }>)[
        logicalId
      ]!;
      row.Metadata = {
        ...row.Metadata,
        'aws:asset:path': path.relative(path.dirname(templatePath), next),
      };
      changed = true;
    }
    if (!changed) return templatePath;

    const expandedPath = writeExpandedTemplate(templatePath, template);
    done.set(templatePath, expandedPath);
    return expandedPath;
  };

  const top = stack.nestedTemplates;
  if (top === undefined) return 0;
  for (const [logicalId, templatePath] of Object.entries(top)) {
    const next = await processFile(templatePath, 1);
    if (next !== templatePath) top[logicalId] = next;
  }
  return expandedCount;
}
