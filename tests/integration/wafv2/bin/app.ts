#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Wafv2Stack } from '../lib/wafv2-stack';

const app = new cdk.App();
new Wafv2Stack(app, 'Wafv2Stack', {
  description: 'cdkd WAFv2 example with WebACL',
});
