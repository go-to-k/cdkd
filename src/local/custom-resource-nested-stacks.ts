/**
 * The nested stacks of a synthesized cloud assembly, as `StackInfo`s the
 * `--aws-emulator` custom-resource runtime can resolve a `ServiceToken`
 * function in (go-to-k/cdkd#6261).
 *
 * A `cdk.NestedStack`'s template is not a stack artifact: it is a file asset
 * (`<id>.nested.template.json`) the parent's `AWS::CloudFormation::Stack` row
 * names in `Metadata['aws:asset:path']`, and cdkd deploys it as the child
 * stack `<parent>~<logicalId>` (`NestedStackProvider.deriveChildStackName`).
 * The runtime looked only at the top-level templates, so a custom resource in
 * a nested stack was never found and ran in AWS Emulator's own runtime.
 *
 * Each child inherits its parent's asset manifest and asset outdir: CDK
 * registers a nested stack's assets with the top-level stack's synthesizer,
 * and stages them in the same outdir. Only the name, the display name and the
 * template are the child's own.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { StackInfo } from '../synthesis/assembly-reader.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import { resolveAssemblyPath } from '../utils/assembly-path.js';
import { safeMsg } from '../utils/display-safe.js';
import { getLogger } from '../utils/logger.js';
import {
  MAX_NESTING_DEPTH,
  isAbsoluteAssetPath,
  listNestedTemplateRows,
} from '../utils/nested-template-cycle.js';
import { nullPrototypeRecord } from '../utils/own-keys.js';

const expanded = new WeakMap<readonly StackInfo[], readonly StackInfo[]>();

/**
 * `stacks` followed by every nested stack below them, depth first, each named
 * as cdkd deploys it (`<parent>~<logicalId>`). Read once per assembly. A
 * nested template that cannot be read, or whose path is absolute or leaves
 * its parent's directory, is skipped (the deploy itself refuses it with its
 * own message); so is a template already on the path from the root (a cycle).
 */
export function withNestedStacks(stacks: readonly StackInfo[]): readonly StackInfo[] {
  const cached = expanded.get(stacks);
  if (cached !== undefined) return cached;
  const all: StackInfo[] = [];
  for (const stack of stacks) {
    all.push(stack);
    collectChildren(stack, stack.nestedTemplates, new Set(), 1, all);
  }
  expanded.set(stacks, all);
  return all;
}

function collectChildren(
  parent: StackInfo,
  nestedTemplates: Readonly<Record<string, string>> | undefined,
  ancestors: ReadonlySet<string>,
  depth: number,
  out: StackInfo[]
): void {
  if (nestedTemplates === undefined || depth > MAX_NESTING_DEPTH) return;
  for (const [logicalId, templatePath] of Object.entries(nestedTemplates)) {
    if (ancestors.has(templatePath)) continue;
    const child = readNestedTemplate(templatePath);
    if (child === undefined) continue;
    const childStack: StackInfo = {
      ...parent,
      stackName: `${parent.stackName}~${logicalId}`,
      displayName: `${parent.displayName}/${logicalId}`,
      template: child.template,
      nestedTemplates: child.nestedTemplates,
      messages: [],
    };
    out.push(childStack);
    collectChildren(
      childStack,
      child.nestedTemplates,
      new Set([...ancestors, templatePath]),
      depth + 1,
      out
    );
  }
}

function readNestedTemplate(
  templatePath: string
): { template: CloudFormationTemplate; nestedTemplates: Record<string, string> } | undefined {
  let template: CloudFormationTemplate;
  try {
    template = JSON.parse(fs.readFileSync(templatePath, 'utf-8')) as CloudFormationTemplate;
  } catch (err) {
    getLogger().debug(
      safeMsg`Nested template ${templatePath} not read for local custom resources: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
  if (template === null || typeof template !== 'object') return undefined;
  const dir = path.dirname(templatePath);
  const nestedTemplates = nullPrototypeRecord<string>();
  for (const { logicalId, assetPath } of listNestedTemplateRows(template)) {
    if (isAbsoluteAssetPath(assetPath)) continue;
    const resolved = resolveAssemblyPath(dir, assetPath);
    if (!resolved.contained) continue;
    nestedTemplates[logicalId] = resolved.path;
  }
  return { template, nestedTemplates };
}
