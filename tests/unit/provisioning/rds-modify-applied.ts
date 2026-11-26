/**
 * go-to-k/cdkd#7006: an RDS DBInstance update waits until DescribeDBInstances
 * reports a changed port, CA certificate or Multi-AZ setting as applied. A
 * test harness whose describe answers a fixed instance reports none of them,
 * so the wait would spin to its deadline. Such a harness merges this, built
 * from the last ModifyDBInstance input, into what its describe answers: the
 * instance as RDS reports it once the modification has applied.
 */
export function appliedAfterModify(
  input: Record<string, unknown> | undefined
): Record<string, unknown> {
  if (input === undefined) return {};
  const applied: Record<string, unknown> = {};
  if (input['DBPortNumber'] !== undefined) {
    applied['Endpoint'] = { Port: input['DBPortNumber'] };
  }
  if (input['CACertificateIdentifier'] !== undefined) {
    applied['CACertificateIdentifier'] = input['CACertificateIdentifier'];
    applied['CertificateDetails'] = { CAIdentifier: input['CACertificateIdentifier'] };
  }
  if (input['MultiAZ'] !== undefined) {
    // RDS reports a boolean, whatever spelling the template sent.
    const multiAZ = String(input['MultiAZ']) === 'true';
    applied['MultiAZ'] = multiAZ;
    if (multiAZ) applied['SecondaryAvailabilityZone'] = 'us-east-1b';
  }
  return applied;
}
