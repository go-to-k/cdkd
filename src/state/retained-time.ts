/**
 * go-to-k/cdkd#4705 review F-1: `S3StateBackend.saveRetainedResources`
 * recorded the entries, stamped with this machine's clock, but could not
 * re-stamp them with S3's. Its own module, so a test that mocks the backend
 * module still sees the class.
 */
export class RetainedTimeUnconfirmedError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super('the kept-resource record was written, but its time could not be confirmed from S3');
    this.name = 'RetainedTimeUnconfirmedError';
    this.cause = cause;
  }
}
