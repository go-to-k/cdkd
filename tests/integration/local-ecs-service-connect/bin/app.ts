#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalEcsServiceConnectStack } from '../lib/local-ecs-service-connect-stack.ts';

const app = new cdk.App();

new LocalEcsServiceConnectStack(app, 'CdkdLocalEcsServiceConnectFixture', {
  description: 'Fixture stack for cdkd local ECS Service Connect + Cloud Map integ test (Issue #460)',
});
