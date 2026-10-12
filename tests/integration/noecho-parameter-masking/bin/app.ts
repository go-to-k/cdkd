#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NoechoParameterMaskingStack } from '../lib/noecho-parameter-masking-stack.ts';
import { NoechoValueArmStack } from '../lib/noecho-value-arm-stack.ts';

const app = new cdk.App();
new NoechoParameterMaskingStack(app, 'CdkdNoechoParameterMaskingExample', {
  description: 'cdkd NoEcho template parameter masking integ probe (issue #1998)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
// go-to-k/cdkd#4831: deployed only by the two-binary arm (Phase 4v).
new NoechoValueArmStack(app, 'CdkdNoechoValueArmExample', {
  description: 'cdkd NoEcho string-form value arm, two-binary integ probe (issue #4831)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
