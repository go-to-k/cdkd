/**
 * Stable terminal CloudFormation stack states.
 *
 * Sourced from the AWS CloudFormation API documentation: a stack in any
 * of these states has settled (success or rolled-back) and is safe to
 * read / mutate. Every other status (`*_IN_PROGRESS`, `*_FAILED`,
 * `REVIEW_IN_PROGRESS`) means the stack is mid-operation or in an
 * unhealthy state — callers gate AWS-side mutations behind this set so
 * the user can settle the source before paying for further work.
 *
 * Consumed by the `cdkd import --migrate-from-cloudformation` retirement
 * flow (`src/cli/commands/retire-cfn-stack.ts`). It had a second consumer,
 * `cdkd migrate`'s pre-flight check, until that command was removed (issue
 * #2572); the module stays separate so the next CloudFormation-reading
 * surface shares the set instead of re-spelling it.
 */
export const STABLE_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
  'IMPORT_COMPLETE',
  'IMPORT_ROLLBACK_COMPLETE',
]);
