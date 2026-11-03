#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { EcsServiceGatewayConnectorsStack } from '../lib/ecs-service-gateway-connectors-stack.ts';

const app = new cdk.App();
new EcsServiceGatewayConnectorsStack(app, 'CdkdEcsServiceGatewayConnectorsExample', {
  description: 'cdkd AWS::ECS::Service GatewayConnectors SDK-route integ probe (issue #5634)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
