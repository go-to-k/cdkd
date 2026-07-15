#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalRunTaskCdkdAssetsStack } from '../lib/local-run-task-cdkd-assets-stack.ts';

const app = new cdk.App();

// Custom bootstrap qualifier so the `fromAsset` container image synthesizes as
// `cdk-myqual99-container-assets-<acct>-<region>` instead of the default
// `cdk-hnb659fds-...`. This is what exercises cdkd's generalized
// container-assets qualifier match (issue #1002 PR 3): before the fix, the
// local run-task resolver matched only the hardcoded `hnb659fds` default and
// would try a (broken) ECR pull for a custom-qualifier asset image rather than
// building it from cdk.out.
new LocalRunTaskCdkdAssetsStack(app, 'CdkdLocalRunTaskCdkdAssetsFixture', {
  description:
    'Fixture for cdkd local run-task custom-qualifier container-assets classification (#1002 PR 3)',
  synthesizer: new cdk.DefaultStackSynthesizer({ qualifier: 'myqual99' }),
});
