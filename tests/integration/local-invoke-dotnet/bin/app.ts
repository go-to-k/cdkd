#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { LocalInvokeDotnetStack } from '../lib/local-invoke-dotnet-stack.ts';

const app = new cdk.App();

new LocalInvokeDotnetStack(app, 'CdkdLocalInvokeDotnetFixture', {
  description: 'Fixture stack for cdkd local invoke .NET integ test',
});
