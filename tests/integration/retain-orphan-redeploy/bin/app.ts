#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  RetainOrphanRedeployStack,
  RetainOrphanAdoptStack,
} from '../lib/retain-orphan-redeploy-stack.ts';

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

new RetainOrphanRedeployStack(app, 'CdkdRetainOrphanRedeployExample', { env });

// The adoption arm (issue #2934) is a SEPARATE stack rather than a mode of the
// one above, because the two want opposite removal policies on their role —
// DESTROY there (the orphan is manufactured by `cdkd state orphan`, so Retain
// would only leak it) and RETAIN here (Retain is what the rollback honours, and
// it is the property under test). Both are always synthesized; each phase of
// `verify.sh` names the stack it operates on.
new RetainOrphanAdoptStack(app, 'CdkdRetainOrphanAdoptExample', { env });
