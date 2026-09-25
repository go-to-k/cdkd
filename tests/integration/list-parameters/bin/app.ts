#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ListParametersStack, SplitProbeStack } from '../lib/list-parameters-stack.ts';

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new cdk.App();
new ListParametersStack(app, 'CdkdListParametersExample', {
  description: 'cdkd List<...> parameter coercion integ probe (issue #2373)',
  env,
});
// Synthesized only for verify.sh's refusal phase, so a plain deploy of the app
// never trips over a stack whose whole purpose is to fail.
if (process.env.CDKD_TEST_SPLIT_PROBE === 'true') {
  new SplitProbeStack(app, 'CdkdListParametersSplitProbe', {
    description: 'cdkd Fn::Split-over-a-list-parameter refusal probe (issue #2373)',
    env,
  });
}
