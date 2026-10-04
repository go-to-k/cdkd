/**
 * The cloud-assembly reader behind {@link MaskedInputSources.childTemplate}
 * (go-to-k/cdkd#4565): a nested stack's template, read from the file its
 * parent row's `Metadata['aws:asset:path']` names, so a parent can classify
 * that stack's outputs from the templates alone. The deploy and `cdkd diff`
 * build it from the same per-level index (`StackInfo.nestedTemplates` at the
 * top, `NestedStackProvider`'s grandchild index below), so both sides read
 * the same tree.
 *
 * Fails closed and silently: a file that cannot be read or parsed, a non-object
 * template, and a row whose path is absolute or escapes the assembly yield no
 * template, which classifies every output of that stack `unknown` (kept as
 * written). The deploy itself refuses such a tree with its own message.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAssemblyPath } from '../utils/assembly-path.js';
import {
  isAbsoluteAssetPath,
  listNestedTemplateRows,
  templateIdentity,
} from '../utils/nested-template-cycle.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import type { ChildTemplateLoader, NestedTemplate } from './masked-property-fingerprints.js';

/**
 * A loader over `nestedTemplates` (logical id -> template file path, one
 * level below the stack it belongs to). Each file is read and parsed at most
 * once per loader, and the parsed template is never mutated. `undefined` when
 * there is no index (a context with no assembly).
 */
export function childTemplateLoader(
  nestedTemplates: Readonly<Record<string, string>> | undefined
): ChildTemplateLoader | undefined {
  if (nestedTemplates === undefined) return undefined;
  const read = new Map<string, NestedTemplate | undefined>();
  const loaderOver =
    (index: Readonly<Record<string, string>>): ChildTemplateLoader =>
    (logicalId) => {
      // A prototype member (a plain-object index) is never a string.
      const templatePath: unknown = index[logicalId];
      if (typeof templatePath !== 'string') return undefined;
      const key = path.resolve(templatePath);
      if (read.has(key)) return read.get(key);
      let entry: NestedTemplate | undefined;
      try {
        const parsed: unknown = JSON.parse(fs.readFileSync(templatePath, 'utf-8'));
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          entry = {
            template: parsed as CloudFormationTemplate,
            identity: templateIdentity(templatePath),
            childTemplate: loaderOver(childIndex(parsed, templatePath)),
          };
        }
      } catch {
        entry = undefined;
      }
      read.set(key, entry);
      return entry;
    };
  return loaderOver(nestedTemplates);
}

/** The rows of `template` (read from `templatePath`) that name a contained child file. */
function childIndex(template: unknown, templatePath: string): Record<string, string> {
  const dir = path.dirname(templatePath);
  // Null-prototype: a logical id is a template key (go-to-k/cdkd#3480).
  const index = Object.create(null) as Record<string, string>;
  for (const { logicalId, assetPath } of listNestedTemplateRows(template)) {
    if (isAbsoluteAssetPath(assetPath)) continue;
    const resolved = resolveAssemblyPath(dir, assetPath);
    if (resolved.contained) index[logicalId] = resolved.path;
  }
  return index;
}
