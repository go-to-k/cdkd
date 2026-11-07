/**
 * The `cdkd diff` Outputs preview. The code lives in `./outputs-diff/`;
 * this module re-exports every name it exported before the split.
 */
export type {
  OutputChangeType,
  OutputChange,
  ResolvedTemplateOutputs,
} from './outputs-diff/types.js';
export {
  secretSpanInStoredKey,
  isUnresolvedValue,
  templateUsesSub,
  isWholeSecretReferenceToken,
  templateHasSecretDynamicReference,
  templateLetsConditionsReachOutputs,
} from './outputs-diff/values.js';
export { resolveTemplateOutputs } from './outputs-diff/resolve.js';
export { computeOutputsDiff } from './outputs-diff/compute.js';
