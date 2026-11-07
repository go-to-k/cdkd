/**
 * The `cdkd orphan` state rewriter. The code lives in `./orphan-rewriter/`;
 * this module re-exports every name it exported before the split.
 */
export type {
  OrphanRewrite,
  UnresolvableReference,
  OrphanRewriteResult,
  OrphanRewriteOptions,
} from './orphan-rewriter/types.js';
export { rewriteResourceReferences, rewriteReferencesInValue } from './orphan-rewriter/rewrite.js';
