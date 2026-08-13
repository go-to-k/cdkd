/**
 * User-facing message builders for the nested-stack (`AWS::CloudFormation::Stack`)
 * delete path.
 *
 * **This module must stay a LEAF** — no imports, ever. It exists precisely so
 * the strings can be shared without dragging a module graph along: the obvious
 * home, `providers/nested-stack-provider.ts`, imports `destroy-runner.ts`
 * (it recurses into a child destroy), which imports `register-providers.ts`,
 * which imports every provider in the tree — including `nested-stack-provider`
 * itself. Importing the builder from there therefore pulled the whole provider
 * registry into two unrelated unit tests and closed that cycle. It is harmless
 * only for as long as nothing on the ring does module-scope work, which is not
 * a property any of those files promises. Adding an import here would silently
 * re-create the problem, so keep this file dependency-free.
 */

/**
 * The message `NestedStackProvider.delete` throws when the child stack's own
 * destroy reported `errorCount > 0` (issue
 * [#1777](https://github.com/go-to-k/cdkd/issues/1777)).
 *
 * A builder rather than an inline template literal so tests that need the exact
 * string cannot drift onto a stale hand-written copy. That matters more than
 * usual here, because both callers of `delete()` classify a delete failure by
 * MESSAGE: an already-deleted-shaped phrase (`not found` / `does not exist` /
 * `No policy found` / `NoSuchEntity` / `NotFoundException`, plus the deploy
 * engine's `was not found` / `ResourceNotFoundException`) is read as idempotent
 * success and DROPS the state row — the exact outcome this throw exists to
 * prevent. `tests/unit/provisioning/nested-stack-provider.test.ts` pins that
 * property against the union of both phrase sets.
 *
 * @param childStackName the child's `<parent>~<childLogicalId>` state key
 * @param errorCount     resources in the child that failed to delete
 * @param alsoSkippedCount resources the child SKIPPED (no AWS call issued)
 * @param alsoInterrupted  whether the child's destroy was also interrupted
 */
export function nestedStackChildFailureMessage(
  childStackName: string,
  errorCount: number,
  alsoSkippedCount: number,
  alsoInterrupted: boolean
): string {
  const extra: string[] = [];
  if (alsoSkippedCount > 0) extra.push(`${alsoSkippedCount} resource(s) were also skipped`);
  if (alsoInterrupted) extra.push('the child destroy was also interrupted');
  return (
    `Nested stack ${childStackName} failed to destroy: ${errorCount} resource(s) ` +
    `failed to delete` +
    // Empty parens would read as a dropped clause; the suffix appears only when
    // there is something to say. Fenced by a test asserting no `()` in the
    // no-extra case.
    (extra.length > 0 ? ` (${extra.join('; ')})` : '') +
    `. The child's state is PRESERVED and still lists them — inspect it with ` +
    `'cdkd state show ${childStackName}', resolve the failure, and re-run the destroy. ` +
    `The parent's record of this nested stack is kept so the child stays reachable.`
  );
}
