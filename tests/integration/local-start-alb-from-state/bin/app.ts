import * as cdk from 'aws-cdk-lib';
import { LocalStartAlbFromStateStack } from '../lib/local-start-alb-from-state-stack.ts';

const app = new cdk.App();
new LocalStartAlbFromStateStack(app, 'CdkdLocalStartAlbFromStateFixture', {
  description:
    "Real-AWS integ for cdkd local start-alb --from-state — exercises the engine's S3 state-source dispatch + Fn::GetAtt intrinsic substitution + multi-target boot end-to-end against a deployed VPC + ALB + 2 ECS Fargate services",
});
