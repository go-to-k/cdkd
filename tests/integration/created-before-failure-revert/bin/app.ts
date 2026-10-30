#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  CreatedBeforeFailureEcrStack,
  CreatedBeforeFailureDeadlineStack,
  CreatedBeforeFailureNestedStack,
  CreatedBeforeFailureSnsStack,
} from '../lib/created-before-failure-revert-stack.ts';

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

new CreatedBeforeFailureEcrStack(app, 'CdkdCreatedBeforeFailureRevertEcrExample', {
  env,
  description:
    'cdkd integ: an ECR repository whose lifecycle policy AWS rejects after CreateRepository (journaled orphan, deleted by rollback --revert-failed)',
});

new CreatedBeforeFailureSnsStack(app, 'CdkdCreatedBeforeFailureRevertSnsExample', {
  env,
  description:
    'cdkd integ: an SNS topic whose data protection policy AWS rejects after CreateTopic (the provider deletes it; nothing journaled to delete)',
});

new CreatedBeforeFailureNestedStack(app, 'CdkdCreatedBeforeFailureRevertNestedExample', {
  env,
  description:
    'cdkd integ: a nested child whose only skip on destroy is the ECR repository its failed CREATE journaled (go-to-k/cdkd#4738)',
});

new CreatedBeforeFailureDeadlineStack(app, 'CdkdCreatedBeforeFailureRevertDeadlineExample', {
  env,
  description:
    'cdkd integ: an ACM certificate whose ISSUED wait outlives a 30s resource deadline after RequestCertificate returned (journaled orphan, deleted by rollback --revert-failed, go-to-k/cdkd#5511)',
});
