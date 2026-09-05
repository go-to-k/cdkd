#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RecreateNestedCollisionStack } from '../lib/collision-stack.ts';

const app = new cdk.App();

new RecreateNestedCollisionStack(app, 'CdkdRecreateNestedCollision', {
  description:
    'cdkd #2567 integ - a --recreate-via-* target must not match a nested child that shares the logical id',
});
