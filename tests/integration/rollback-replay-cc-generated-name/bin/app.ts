#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RollbackReplayCcGeneratedNameStack } from '../lib/rollback-replay-cc-generated-name-stack.ts';

const app = new cdk.App();

// The stack id IS the stack name, and the stack name is the prefix cdkd's
// `generateResourceName` puts in front of the logical id when it mints a
// FALLBACK_NAME_RULES name. Keeping it short (`CdkdReplayCcName`, 16 chars)
// makes the generated role name `CdkdReplayCcName-Role` -- 21 characters
// against IAM's `maxLength: 64`, so it never reaches `generateResourceName`'s
// truncate-plus-hash branch. That is about the ASSERTION staying legible
// (verify.sh matches a plain `<stack>-` prefix), not about fitting the cap:
// there is ample headroom either way.
new RollbackReplayCcGeneratedNameStack(app, 'CdkdReplayCcName', {
  description:
    'Reverse-replacement replay-CREATE on the Cloud Control route (issue #3199): an UNNAMED ' +
    'IAM role whose name-change replacement is rolled back must be restored under the SAME ' +
    'cdkd-generated name the forward path mints',
});
