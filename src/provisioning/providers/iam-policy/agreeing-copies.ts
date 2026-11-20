/**
 * The drift reads of an `AWS::IAM::Policy` that read EVERY principal's copy
 * and found them all agreeing under the drift comparator (go-to-k/cdkd#6609,
 * slice C2). Copies that differ surface ONE copy (go-to-k/cdkd#6616), which
 * can be the declared document while another principal's copy is not, so the
 * drift heal (`preFixBaselineUncomparedDriftKeys`) skips `PolicyDocument` only
 * on a bag carrying this mark. A POSITIVE mark: a bag that lost its identity
 * on the way (a copy, a spread) is unmarked and stays compared, never healed.
 * Keyed by the returned bag; nothing is stored.
 */
const readsWithAgreeingCopies = new WeakSet<object>();

/** Mark a drift read's returned bag as one whose every principal's copy agreed. */
export function markCopiesAgreed(read: object): void {
  readsWithAgreeingCopies.add(read);
}

/** Whether `read` is a bag {@link markCopiesAgreed} marked. */
export function readHadAgreeingCopies(read: object): boolean {
  return readsWithAgreeingCopies.has(read);
}
