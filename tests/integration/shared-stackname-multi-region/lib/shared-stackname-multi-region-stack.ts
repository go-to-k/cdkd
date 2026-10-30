import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * The producer: one SSM parameter whose NAME carries its region, so a value
 * read from it says which region's producer answered.
 *
 * covers: AWS::SSM::Parameter
 */
export class ProducerStack extends cdk.Stack {
  readonly parameter: ssm.StringParameter;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);
    this.parameter = new ssm.StringParameter(this, 'ProducerParam', {
      parameterName: `/cdkd-5176/producer-${this.region}`,
      stringValue: 'producer',
    });
  }
}

export interface ConsumerStackProps extends cdk.StackProps {
  /** The producer parameter's name, a cross-stack reference (`Fn::ImportValue`). */
  readonly producerParameterName: string;
}

/**
 * The consumer: one SSM parameter whose VALUE is the imported producer
 * parameter name. `CDKD_TEST_UPDATE=true` changes its prefix from `v1:` to
 * `v2:`, so an update re-resolves the import.
 *
 * covers: AWS::SSM::Parameter
 */
export class ConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ConsumerStackProps) {
    super(scope, id, props);
    const prefix = process.env['CDKD_TEST_UPDATE'] === 'true' ? 'v2' : 'v1';
    new ssm.StringParameter(this, 'ConsumerParam', {
      parameterName: '/cdkd-5176/consumer',
      stringValue: `${prefix}:${props.producerParameterName}`,
    });
  }
}
