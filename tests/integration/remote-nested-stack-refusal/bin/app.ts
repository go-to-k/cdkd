#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RemoteNestedStackRefusalStack } from '../lib/remote-nested-stack-refusal-stack.ts';

const app = new cdk.App();
const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

new RemoteNestedStackRefusalStack(app, 'CdkdIntegRemoteNested', {
  description:
    'cdkd integ fixture (go-to-k/cdkd#6385): a HostedRotation secret whose transform expands to a remote-TemplateURL nested stack, refused before anything is provisioned.',
  env: { region },
  secretName: `cdkd-integ-remote-nested-${region}`,
});
