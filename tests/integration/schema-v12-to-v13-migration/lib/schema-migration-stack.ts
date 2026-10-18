import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * State schema v12 -> v13 migration fixture (issue #5064).
 *
 * v13 records `StackState.stackInstanceId`, minted at a stack's FIRST state
 * write and written ahead to `stack-instance.json`. A stack whose record a v12
 * binary (the npm pin in verify.sh) wrote is a LEGACY stack and must stay one:
 * the v13 deploy over it mints nothing.
 *
 * Every input is an ENVIRONMENT variable verify.sh sets, read at synth time,
 * so the v12 and the v13 binary synthesize the same template:
 *
 *   CDKD_V13_PREFIX  the per-run SSM parameter name prefix
 *   CDKD_V13_EDIT    a token folded into `Param`'s value, so a deploy has an
 *                    ordinary UPDATE to save (an unchanged template saves no
 *                    state record)
 *
 * Resources: two SSM parameters, `Param` (edited per phase) and `Plain`.
 */
export class SchemaV12ToV13MigrationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const prefix = process.env.CDKD_V13_PREFIX ?? '/cdkd-integ/schema-v12-to-v13/unset';
    const edit = process.env.CDKD_V13_EDIT ?? 'initial';

    const param = new ssm.CfnParameter(this, 'Param', {
      name: `${prefix}/param`,
      type: 'String',
      value: `schema-v13-param-${edit}`,
    });
    param.overrideLogicalId('Param');

    const plain = new ssm.CfnParameter(this, 'Plain', {
      name: `${prefix}/plain`,
      type: 'String',
      value: 'schema-v13-plain-control',
    });
    plain.overrideLogicalId('Plain');
  }
}
