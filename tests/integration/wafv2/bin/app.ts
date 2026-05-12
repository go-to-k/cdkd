#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Wafv2Stack } from '../lib/wafv2-stack.ts';

const app = new cdk.App();
new Wafv2Stack(app, 'Wafv2Stack', {
  description: 'cdkd WAFv2 example with WebACL',
});
