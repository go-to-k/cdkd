#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  FsxCopyStack,
  FsxNetworkStack,
  StackCopyCreateTokensStack,
} from '../lib/stack-copy-create-tokens-stack.ts';

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};
// Two copies of ONE stack class in one account and region -- a Dev and a
// Staging copy. Same logical ids, same create-only inputs (go-to-k/cdkd#4428).
new StackCopyCreateTokensStack(app, 'CdkdTokenScopeA', { env });
new StackCopyCreateTokensStack(app, 'CdkdTokenScopeB', { env });

// The FSx arm. The FSx token hashes SubnetIds / SecurityGroupIds, so the two
// copies must share one subnet and one security group for their tokens to have
// collided before the fix: both come from a shared network stack.
const net = new FsxNetworkStack(app, 'CdkdTokenScopeNet', { env });
new FsxCopyStack(app, 'CdkdTokenScopeFsxA', { env, net });
new FsxCopyStack(app, 'CdkdTokenScopeFsxB', { env, net });
