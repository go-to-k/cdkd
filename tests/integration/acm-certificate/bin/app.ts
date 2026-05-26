#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AcmCertificateStack } from '../lib/acm-certificate-stack.ts';

const app = new cdk.App();

new AcmCertificateStack(app, 'CdkdAcmCertificateExample', {
  description: 'Verifies ACMCertificateProvider end-to-end against real AWS (no-wait mode)',
  env: { region: 'us-east-1' },
});
