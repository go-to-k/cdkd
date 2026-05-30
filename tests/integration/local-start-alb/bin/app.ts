import * as cdk from 'aws-cdk-lib';
import { LocalStartAlbStack } from '../lib/local-start-alb-stack.ts';

const app = new cdk.App();
new LocalStartAlbStack(app, 'CdkdLocalStartAlbFixture', {
  description:
    'Pure-local integ fixture for cdkd local start-alb — exercises the ALB front-door + ECS backing service end-to-end without an AWS deploy',
});
