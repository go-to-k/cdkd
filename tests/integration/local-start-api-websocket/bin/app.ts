#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalStartApiWebSocketStack } from '../lib/stack.ts';

const app = new cdk.App();

new LocalStartApiWebSocketStack(app, 'CdkdLocalStartApiWebSocket', {
  description: 'Fixture stack for cdkd local start-api WebSocket integ test (#462)',
});
