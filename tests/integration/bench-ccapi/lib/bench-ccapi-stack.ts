import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as athena from 'aws-cdk-lib/aws-athena';

/**
 * Benchmark stack: Cloud Control API only.
 *
 * All 5 resources fall back to the CC API path because cdkd has no native
 * SDK provider registered for AWS::SSM::Document or AWS::Athena::WorkGroup.
 * Resources are independent so cdkd can provision them in parallel.
 */
export class BenchCcapiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    for (let i = 0; i < 3; i++) {
      new ssm.CfnDocument(this, `Document${i}`, {
        name: `${this.stackName}-doc-${i}`,
        documentType: 'Command',
        content: {
          schemaVersion: '2.2',
          description: `Benchmark SSM document ${i}`,
          mainSteps: [
            {
              action: 'aws:runShellScript',
              name: `step${i}`,
              inputs: { runCommand: [`echo "benchmark ${i}"`] },
            },
          ],
        },
      });
    }

    for (let i = 0; i < 2; i++) {
      new athena.CfnWorkGroup(this, `WorkGroup${i}`, {
        name: `${this.stackName}-wg-${i}`,
        recursiveDeleteOption: true,
        workGroupConfiguration: {
          enforceWorkGroupConfiguration: false,
          publishCloudWatchMetricsEnabled: false,
          requesterPaysEnabled: false,
        },
      });
    }
  }
}
