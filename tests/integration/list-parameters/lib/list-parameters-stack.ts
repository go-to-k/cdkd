import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ssm from 'aws-cdk-lib/aws-ssm';

export const PARAM_PREFIX = '/cdkd-integ/list-parameters';
export const SUBNET_GROUP_NAME = 'cdkd-integ-list-parameters';
export const VPC_TAG = 'cdkd-integ-list-parameters';

/**
 * The child receives the SAME comma-joined subnet-id string twice, once as
 * `List<AWS::EC2::Subnet::Id>` and once as `CommaDelimitedList`. The two
 * parameters differ only in declared type, so the CommaDelimitedList readers
 * are the control: they must render exactly what the List<...> readers render.
 * A nested stack is the host because its parameters arrive as a STRING from
 * the parent, which is the input `coerceParameterTypedValue` turns into a list.
 */
class ListParameterChild extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: cdk.NestedStackProps) {
    super(scope, id, props);
    // Pinned so the child's state key is `<parent>~Child` (issue #575).
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');

    const subnetIds = new cdk.CfnParameter(this, 'SubnetIds', {
      type: 'List<AWS::EC2::Subnet::Id>',
    });
    subnetIds.overrideLogicalId('SubnetIds');
    const subnetIdsCsv = new cdk.CfnParameter(this, 'SubnetIdsCsv', {
      type: 'CommaDelimitedList',
    });
    subnetIdsCsv.overrideLogicalId('SubnetIdsCsv');

    // The wire-shape arm: a bare Ref into a property the RDS schema declares a
    // list. Before #2347 the provider received one comma-joined string here.
    new rds.CfnDBSubnetGroup(this, 'SubnetGroup', {
      dbSubnetGroupName: SUBNET_GROUP_NAME,
      dbSubnetGroupDescription: 'cdkd list-parameters integ - SubnetIds from a List<> Ref',
      subnetIds: subnetIds.valueAsList,
    });

    const param = (id: string, value: string) =>
      new ssm.CfnParameter(this, id, {
        name: `${PARAM_PREFIX}/${id.toLowerCase()}`,
        type: 'String',
        value,
      });
    param('Select', cdk.Fn.select(1, subnetIds.valueAsList));
    param('Join', cdk.Fn.join('|', subnetIds.valueAsList));
    param('Sub', cdk.Fn.sub('subnets=${SubnetIds}'));
    param('CsvSelect', cdk.Fn.select(1, subnetIdsCsv.valueAsList));
    param('CsvJoin', cdk.Fn.join('|', subnetIdsCsv.valueAsList));
  }
}

/**
 * covers: AWS::EC2::VPC
 * covers: AWS::EC2::Subnet
 * covers: AWS::RDS::DBSubnetGroup
 * covers: AWS::SSM::Parameter
 * covers: AWS::CloudFormation::Stack
 *
 * L1 VPC + two subnets, no route tables or gateways: the subnets only need to
 * be real ids in two AZs so the DBSubnetGroup accepts them.
 */
export class ListParametersStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const vpc = new ec2.CfnVPC(this, 'Vpc', {
      cidrBlock: '10.73.0.0/16',
      tags: [{ key: 'Name', value: VPC_TAG }],
    });
    const subnets = [0, 1].map(
      (i) =>
        new ec2.CfnSubnet(this, `Subnet${i}`, {
          vpcId: vpc.ref,
          cidrBlock: `10.73.${i}.0/24`,
          availabilityZone: cdk.Fn.select(i, cdk.Fn.getAzs()),
          tags: [{ key: 'Name', value: `${VPC_TAG}-${i}` }],
        })
    );
    const joined = cdk.Fn.join(
      ',',
      subnets.map((s) => s.ref)
    );

    new ListParameterChild(this, 'Child', {
      parameters: { SubnetIds: joined, SubnetIdsCsv: joined },
    });
  }
}

/**
 * Deployed only to be REFUSED: Fn::Split over a List<...> parameter is not
 * valid CloudFormation, and cdkd must fail before creating anything. cdkd has
 * no `--parameters` flag, so the value comes from the Default; the ids never
 * reach AWS, since the refusal happens while resolving the property.
 */
export class SplitProbeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const subnetIds = new cdk.CfnParameter(this, 'SubnetIds', {
      type: 'List<AWS::EC2::Subnet::Id>',
      default: 'subnet-0000000000000000a,subnet-0000000000000000b',
    });
    subnetIds.overrideLogicalId('SubnetIds');
    new ssm.CfnParameter(this, 'Split', {
      name: `${PARAM_PREFIX}/split`,
      type: 'String',
      value: cdk.Fn.select(
        0,
        cdk.Fn.split(',', cdk.Token.asString(subnetIds.value))
      ),
    });
  }
}
