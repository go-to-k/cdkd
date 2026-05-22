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
 * Single source of truth — consumed by both `cdkd migrate`'s pre-flight
 * check (`src/cli/commands/migrate/cfn-stack-prefetch.ts`) and the
 * `cdkd import --migrate-from-cloudformation` retirement flow
 * (`src/cli/commands/retire-cfn-stack.ts`).
 */
export const STABLE_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'CREATE_COMPLETE',
  'UPDATE_COMPLETE',
  'UPDATE_ROLLBACK_COMPLETE',
  'IMPORT_COMPLETE',
  'IMPORT_ROLLBACK_COMPLETE',
]);
