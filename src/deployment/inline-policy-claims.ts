/**
 * go-to-k/cdkd#4156 / #4225 / #4227 / #4408 / #4821: whether ANOTHER resource
 * of this deploy has ALREADY written an inline policy name onto a principal,
 * the rollback twin of that writer map, and the dispatch-time / rollback-time
 * orderings of the rows that may share a (principal, name) pair. The
 * implementation lives in `inline-policy-claims/*.ts` (go-to-k/cdkd#5835); this
 * module re-exports exactly the names it always exported, so no importer
 * changes.
 *
 * The family imports only types from outside `inline-policy-claims/`, and
 * `names.ts` imports nothing from inside it, so the module graph has no cycle.
 */
export {
  type InlinePolicyWrite,
  isInlinePolicyClaimedByCompletedWriter,
} from './inline-policy-claims/claimed.js';
export {
  RollbackInlinePolicyWriters,
  type HeldInlinePolicyRemoval,
  type InlinePolicyHolder,
  inlinePolicyHolders,
} from './inline-policy-claims/rollback-writers.js';
export {
  POLICY_LIST_FIELDS,
  isStandaloneInlinePolicyType,
  standaloneInlinePolicyOf,
  standaloneInlinePolicyHandedOff,
  isInlinePolicyPrincipalType,
} from './inline-policy-claims/names.js';
export { orderInlinePolicyWriters } from './inline-policy-claims/order-writers.js';
export { orderInlinePolicyReversals } from './inline-policy-claims/order-reversals.js';
