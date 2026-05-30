import * as cdk from 'aws-cdk-lib';
import { LocalInvokeAgentcoreFromStateStack } from '../lib/local-invoke-agentcore-from-state-stack.js';

const app = new cdk.App();
new LocalInvokeAgentcoreFromStateStack(app, 'CdkdLocalInvokeAgentcoreFromStateFixture', {
  description:
    "Real-AWS integ fixture for cdkd local invoke-agentcore --from-state — closes G2 of the PR #717 3-axis review",
});
