#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ProfileRegionDefaultStack } from '../lib/profile-region-default-stack.ts';

const app = new cdk.App();
// ENV-AGNOSTIC on purpose: no `env`. A stack with `env.region` carries its own
// region through the Cloud Assembly and never reaches the CLI's region
// fallback this fixture exists to exercise (go-to-k/cdkd#2100).
new ProfileRegionDefaultStack(app, 'CdkdProfileRegionDefaultExample', {
  description: 'cdkd bare-invocation region resolution integ probe (#2100)',
});
