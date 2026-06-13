#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { IntrinsicsTortureStack } from '../lib/intrinsics-torture-stack.ts';

const app = new cdk.App();

new IntrinsicsTortureStack(app, 'CdkdIntrinsicsTortureExample', {
  description:
    'cdkd integ designed to surface intrinsic-function-resolution bugs (Fn::Cidr / Fn::FindInMap / Fn::GetAZs / Fn::Base64 / nested Split-Select-Join / nested Fn::Sub / all pseudo-parameters)',
});
