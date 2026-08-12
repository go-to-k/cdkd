import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * Fixture for issue #1682 — the reverse-replacement replay-CREATE must record
 * the provider's `effectiveProperties`.
 *
 * Why `AWS::EC2::Route` and not the `AWS::S3::Bucket` the issue names: both
 * providers substitute on a state replay, but a bucket's reverse-replacement
 * re-create has to re-acquire a just-deleted GLOBALLY unique name, whose
 * release is not immediate — the fixture would be flaky for a reason that has
 * nothing to do with what it tests. A route's identity is
 * `<RouteTableId>|<Destination>`, scoped to this stack's own route table, so
 * the re-create is deterministic.
 *
 * Two env knobs drive the phases (see verify.sh):
 *
 * - `ROUTE_DEST` flips the route's destination CIDR. It is create-only, so the
 *   second deploy classifies the route as a REPLACEMENT — which is the op
 *   class whose rollback arm this fixture exercises.
 * - `ROLLBACK_INTEG_FAIL=true` adds an SQS queue with an out-of-range
 *   `MessageRetentionPeriod` that AWS rejects. It DependsOn the route, so the
 *   route's replacement has already COMPLETED when the failure fires and the
 *   rollback classifies it `reverse-replacement` rather than a plain CREATE.
 */
export class RollbackReplayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // A deterministic, NON-reserved tag on every resource. AWS reserves the
    // `aws:` prefix, so `aws:cdk:path` is never set on a real resource and a
    // cleanup filtered on it would return empty — vacuously passing the very
    // leak assertions it exists to make.
    cdk.Tags.of(this).add('cdkd:integ-fixture', 'rollback-replay-effective-props');

    // L1 throughout: the test asserts on the route's recorded property BAG, so
    // the template has to say exactly what this file says and nothing an L2
    // might add on its behalf.
    const vpc = new ec2.CfnVPC(this, 'Vpc', {
      cidrBlock: '10.90.0.0/16',
      enableDnsSupport: true,
      enableDnsHostnames: false,
    });

    const igw = new ec2.CfnInternetGateway(this, 'Igw', {});

    const attachment = new ec2.CfnVPCGatewayAttachment(this, 'IgwAttachment', {
      vpcId: vpc.ref,
      internetGatewayId: igw.ref,
    });

    const routeTable = new ec2.CfnRouteTable(this, 'RouteTable', {
      vpcId: vpc.ref,
    });

    // DestinationCidrBlock is create-only -> changing it forces a replacement.
    const destination = process.env['ROUTE_DEST'] ?? '0.0.0.0/0';

    const route = new ec2.CfnRoute(this, 'Route', {
      routeTableId: routeTable.ref,
      destinationCidrBlock: destination,
      gatewayId: igw.ref,
    });
    // A route to an internet gateway is only creatable once the gateway is
    // attached to the VPC.
    route.addDependency(attachment);

    if (process.env['ROLLBACK_INTEG_FAIL'] === 'true') {
      // MessageRetentionPeriod's ceiling is 1209600 (14 days); this is well
      // past it, so CreateQueue fails and the deploy rolls back.
      const failing = new sqs.CfnQueue(this, 'FailQueue', {
        messageRetentionPeriod: 999999999,
      });
      failing.addDependency(route);
    }
  }
}
