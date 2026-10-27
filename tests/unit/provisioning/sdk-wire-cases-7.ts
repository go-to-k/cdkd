import type { TypeCase } from './sdk-wire-harness.js';
import { APPSYNC_CASES } from './sdk-wire-cases-7-appsync.js';
import { S3TABLES_CASES } from './sdk-wire-cases-7-s3tables.js';

/**
 * The seventh batch of wire cases (#3723): providers whose wire bugs were
 * fixed in the same run, so each case also pins its fix (AppSync #5370,
 * S3 Tables #5319, and the Lambda function and layer #5305 in
 * `sdk-wire-cases-7-lambda.ts`). One module per service, gathered here; run
 * by `sdk-wire-coverage-7.test.ts`, which mocks the clients these providers
 * build and also registers each module's direct-call blocks.
 *
 * `LAMBDA_CASES` is NOT in this list: its `Code.ZipFile` is zipped with the
 * wall-clock time, so the test file runs it on its own under a pinned `Date`,
 * leaving these cases on the real clock, where the harness's determinism guard
 * can still catch a value drawn from it.
 */
export const CASES_7: TypeCase[] = [...APPSYNC_CASES, ...S3TABLES_CASES];
