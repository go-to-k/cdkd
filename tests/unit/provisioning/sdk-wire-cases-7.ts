import type { TypeCase } from './sdk-wire-harness.js';
import { APPSYNC_CASES } from './sdk-wire-cases-7-appsync.js';
import { COGNITO_CASES } from './sdk-wire-cases-7-cognito.js';
import { LAMBDA_CASES } from './sdk-wire-cases-7-lambda.js';
import { S3TABLES_CASES } from './sdk-wire-cases-7-s3tables.js';

/**
 * The seventh batch of wire cases (#3723): providers whose wire bugs were
 * fixed in the same run, so each case also pins its fix (AppSync #5370,
 * Cognito #5374, Lambda function and layer #5305, S3 Tables #5319). One
 * module per service, gathered here; run by `sdk-wire-coverage-7.test.ts`,
 * which mocks the clients these providers build and also registers each
 * module's direct-call blocks.
 */
export const CASES_7: TypeCase[] = [
  ...APPSYNC_CASES,
  ...COGNITO_CASES,
  ...LAMBDA_CASES,
  ...S3TABLES_CASES,
];
