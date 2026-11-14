#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RefShapeCompoundCcIdsStack } from '../lib/ref-shape-compound-cc-ids-stack.ts';

const app = new cdk.App();
new RefShapeCompoundCcIdsStack(app, 'CdkdRefShapeCompoundCcIdsExample', {
  description:
    'cdkd Ref of LogStream / SubscriptionFilter / MaintenanceWindowTarget / MaintenanceWindowTask / DeploymentGroup integ probe (issue #6293)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
