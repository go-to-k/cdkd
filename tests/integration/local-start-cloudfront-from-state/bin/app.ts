import * as cdk from 'aws-cdk-lib';
import { LocalStartCloudFrontFromStateStack } from '../lib/local-start-cloudfront-from-state-stack.ts';

const app = new cdk.App();
new LocalStartCloudFrontFromStateStack(app, 'CdkdLocalStartCloudFrontFromStateFixture', {
  description:
    'Real-AWS integ for cdkd local start-cloudfront --from-state: an S3 origin with no BucketDeployment, served from the deployed bucket named by cdkd state',
});
