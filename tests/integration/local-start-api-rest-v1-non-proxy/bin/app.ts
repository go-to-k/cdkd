import * as cdk from 'aws-cdk-lib';
import { LocalStartApiRestV1NonProxyStack } from '../lib/local-start-api-rest-v1-non-proxy-stack.ts';

const app = new cdk.App();
new LocalStartApiRestV1NonProxyStack(app, 'CdkdLocalStartApiRestV1NonProxyStack', {});
