#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { DeletionOrderingComplexStack } from '../lib/deletion-ordering-complex-stack.ts';

const app = new cdk.App();

new DeletionOrderingComplexStack(app, 'CdkdDeletionOrderingComplexExample', {
  description:
    'cdkd failure-seeking integ: ALB + TargetGroup + Listener + ListenerRule + a registered EC2 IP target in a minimal VPC (natGateways:0). Stresses ELBv2 destroy-ordering: Listener before TargetGroup, TG before the LB, LB-ENI release before Subnet/SG, then IGW/VPC.',
});
