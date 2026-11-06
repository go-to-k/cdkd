/**
 * The recursive `cdkd diff` walk. The code lives in `./diff-recursive/`;
 * this module re-exports every name it exported before the split.
 */
export type {
  DiffTreeNode,
  CcRouteUnavailableReason,
  UnreadableContainer,
  StackDiffResult,
  NodeTrust,
} from './diff-recursive/types.js';
export {
  findUnroutableDropRefusals,
  findUnwrittenCreateOnlyRefusals,
} from './diff-recursive/refusals.js';
export { readNestedTemplate, indexNestedChildTemplates } from './diff-recursive/nested-template.js';
export { maskDiffValue, maskOutputChangeForDisplay } from './diff-recursive/printing.js';
export { computeStackDiff } from './diff-recursive/compute-stack-diff.js';
export { healerUnderRecordPrintingBag } from './diff-recursive/child-parameters.js';
export { buildDiffTree } from './diff-recursive/build-tree.js';
export { SDK_MIGRATION_TOKEN, collectCcApiRoutes } from './diff-recursive/routes.js';
export {
  nodeHasChanges,
  countBlocking,
  treeIsWorthRendering,
  treeHasChanges,
  treeDestructiveChanges,
} from './diff-recursive/tree.js';
export { diffTreeToJson } from './diff-recursive/json.js';
export type {
  DiffChangeJson,
  DiffOutputChangeJson,
  DiffNodeJson,
  DestructiveChangeJson,
} from './diff-recursive/json.js';
export {
  renderChangeLines,
  renderOutputChangeLines,
  renderDiffTree,
} from './diff-recursive/render.js';
