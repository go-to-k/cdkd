/**
 * The drift reads of an `AWS::IAM::Policy` whose per-principal copies differ
 * (go-to-k/cdkd#6609, slice C2). Such a read surfaces ONE copy, the first the
 * comparator reports against the baseline (go-to-k/cdkd#6616), which can be
 * the declared document while another principal's copy is not: the drift
 * heal (`preFixBaselineUncomparedDriftKeys`) must then keep `PolicyDocument`
 * compared, and only this marker tells it so. Keyed by the returned bag, which
 * `runDriftForStack` hands to the heal by reference; nothing is stored.
 */
const readsWithDifferingCopies = new WeakSet<object>();

/** Mark a drift read's returned bag as surfacing one of several differing copies. */
export function markDifferingCopies(read: object): void {
  readsWithDifferingCopies.add(read);
}

/** Whether `read` is a bag {@link markDifferingCopies} marked. */
export function readHadDifferingCopies(read: object): boolean {
  return readsWithDifferingCopies.has(read);
}
