import * as cdk from 'aws-cdk-lib';
import { DestroyDataGuardStack } from '../lib/destroy-data-guard-stack.ts';

const app = new cdk.App();

new DestroyDataGuardStack(app, 'CdkdDestroyDataGuardExample', {
  env: { region: process.env.AWS_REGION ?? 'us-east-1' },
});
