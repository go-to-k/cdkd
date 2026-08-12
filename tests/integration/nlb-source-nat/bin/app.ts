#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NlbSourceNatStack } from '../lib/nlb-source-nat-stack.ts';

const app = new cdk.App();

new NlbSourceNatStack(app, 'NlbSourceNatStack', {
  description: 'cdkd NLB flag-omission A/B (issue #1619)',
  // A CONCRETE env is required, not cosmetic: an env-agnostic stack resolves
  // `availabilityZones` to two DUMMY AZs, so `maxAzs: 3` silently yields only
  // two public subnets and the removal phase's "add a third subnet" change —
  // the thing that makes SetSubnets fire at all — never happens. With a real
  // account/region CDK goes through the `availability-zones` context provider
  // (which cdkd implements) and gets the region's actual AZ list.
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
