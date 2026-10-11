// A LEAF: `destroy.ts` and `state.ts` throw this, and their tests mock
// `destroy-runner.js` whole, so it cannot live there.

/**
 * The run-level message a `cdkd destroy` / `cdkd state destroy` ending in
 * skips throws (exit 2), from the run's `skippedCount` and
 * `journaledOrphanSkips` totals. Skips a record holds are counted in ENTRIES,
 * not resources: a skipped nested-stack row contributes exactly 1 however
 * many of the child's resources were skipped, and the per-stack summaries
 * above give the exact breakdown. A journaled orphan keeps no record
 * (go-to-k/cdkd#4738), so the "State preserved" clause covers only the
 * others, and a run whose every skip is one says no state was kept.
 */
export function skippedDestroyMessage(
  totalSkipped: number,
  totalOrphanSkips: number,
  rerunCommand: 'cdkd destroy' | 'cdkd state destroy'
): string {
  const recordSkips = totalSkipped - totalOrphanSkips;
  const orphanSentence =
    `${totalOrphanSkips} resource(s) a failed deploy created were left in AWS, and no state ` +
    `records them any more. The warning naming each says what to do with it.`;
  if (recordSkips <= 0) {
    return `Destroy finished, but ${orphanSentence}`;
  }
  return (
    `Destroy skipped ${recordSkips} entr${recordSkips === 1 ? 'y' : 'ies'} whose delete cdkd ` +
    `did not confirm, so the underlying resources may still exist in AWS. A skipped nested stack ` +
    `counts as ONE entry and may cover several of its own resources — the per-stack ` +
    `summaries above give the exact breakdown. State preserved (the records are kept). ` +
    `The per-resource 'skipped (...)' lines and their warnings name each cause and whether ` +
    `repairing the record in state.json helps: where it does, repair it and re-run '${rerunCommand}'; ` +
    `otherwise (for example a custom-resource Delete handler that reported FAILED), delete ` +
    `the resources by hand and drop the records with 'cdkd state orphan <stack> --stack-region <region>'.` +
    (totalOrphanSkips > 0 ? ` Separately, ${orphanSentence}` : '')
  );
}
