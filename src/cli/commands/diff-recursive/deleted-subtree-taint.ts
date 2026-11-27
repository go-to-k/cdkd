import { MIN_NEEDLE_LENGTH, SECRET_MASK } from '../../../deployment/secret-redaction.js';
import { isMaskLeaf } from '../../../deployment/secret-redaction/recorded-secrecy.js';
import type { CrossStackPreview } from '../../../analyzer/cross-stack-preview.js';
import type { ResourceState } from '../../../types/state.js';
import type { DiffTreeNode } from './types.js';
import { SECURITY_TABLE_WITHHELD, mixesDynamicReference } from './passed-secret-display.js';

/**
 * go-to-k/cdkd#7097 (the deleted-subtree note): a nested row DELETED from the
 * template is diffed against an empty template, so no provenance reaches its
 * child and a REMOVE row printed a piece of a secret its child records hold
 * (a mixed parameter's text, a tainted import's value). The evidence left is
 * the row's RECORD: its stored `Parameters`. When one of them mixes a dynamic
 * reference with other text, or carries a value this run's cross-stack
 * preview marks as secret-derived, every value the deleted subtree prints is
 * shown as `***`. Display only: the rows are still reported.
 */
export function deletedRowRecordTainted(
  record: ResourceState,
  preview: CrossStackPreview | undefined
): boolean {
  const parameters = record.properties?.['Parameters'];
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) {
    return false;
  }
  const tainted = preview?.taintedValues() ?? new Set<string>();
  return Object.values(parameters as Record<string, unknown>).some((value) => {
    if (typeof value !== 'string') return false;
    if (mixesDynamicReference(value)) return true;
    for (const text of tainted) {
      if (text === '' || isMaskLeaf(text)) continue;
      if (value === text || (text.length >= MIN_NEEDLE_LENGTH && value.includes(text))) return true;
    }
    return false;
  });
}

/** `value` with every string leaf (and key) shown as `***`. */
function maskLeaves(value: unknown): unknown {
  if (typeof value === 'string') return SECRET_MASK;
  if (Array.isArray(value)) return value.map(maskLeaves);
  if (value !== null && typeof value === 'object') {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, leaf] of Object.entries(value)) out[key] = maskLeaves(leaf);
    return out;
  }
  return value;
}

/** Mask every printed value of `node` and its children, in place. */
export function maskDeletedSubtree(node: DiffTreeNode): void {
  for (const [logicalId, change] of node.changes) {
    node.changes.set(logicalId, {
      ...change,
      ...(change.currentProperties && {
        currentProperties: maskLeaves(change.currentProperties) as Record<string, unknown>,
      }),
      ...(change.desiredProperties && {
        desiredProperties: maskLeaves(change.desiredProperties) as Record<string, unknown>,
      }),
      ...(change.propertyChanges && {
        propertyChanges: change.propertyChanges.map((pc) => ({
          ...pc,
          oldValue: maskLeaves(pc.oldValue),
          newValue: maskLeaves(pc.newValue),
        })),
      }),
    });
  }
  node.outputChanges = node.outputChanges.map((oc) => ({
    ...oc,
    ...('oldValue' in oc && { oldValue: maskLeaves(oc.oldValue) }),
    ...('newValue' in oc && { newValue: maskLeaves(oc.newValue) }),
  }));
  // The IAM / security-group table prints the removed statements' values.
  const securityDiff = node.securityDiff;
  if (securityDiff !== undefined) {
    node.securityDiff = async () => {
      const shown = await securityDiff();
      return shown.rendered === '' ? shown : { ...shown, rendered: SECURITY_TABLE_WITHHELD };
    };
  }
  for (const child of node.children) maskDeletedSubtree(child);
}
