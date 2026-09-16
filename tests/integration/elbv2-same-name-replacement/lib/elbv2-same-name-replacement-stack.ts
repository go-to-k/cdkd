import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';

/**
 * Integ fixture for issue
 * [#3208](https://github.com/go-to-k/cdkd/issues/3208) — `cdkd deploy
 * --replace` must complete a SAME-NAME replacement of a cdkd-named ELBv2
 * target group.
 *
 * covers: AWS::ElasticLoadBalancingV2::TargetGroup
 *
 * WHAT IS UNDER TEST
 *
 * A property-driven replacement runs CloudFormation's safe order: create the
 * new resource first, then delete the old one. When the new resource must
 * carry the SAME physical name as the old one, that create COLLIDES, and
 * `--replace`'s delete-first fallback is the only way forward. The fallback is
 * gated on a name-collision predicate, and before the fix that predicate read
 * only the rendered MESSAGE, matching `already exist` / `AlreadyExists`.
 *
 * MEASURED live in us-east-1 before the fix, creating a second target group
 * under a live name:
 *
 *   name    = DuplicateTargetGroupNameException
 *   message = A target group with the same name 'X' exists, but with different
 *             settings
 *
 * The message never says "already exists" and carries no code, so the
 * predicate missed it, the delete-first fallback never engaged, and the deploy
 * died at the forward replacement reporting `No completed operations to roll
 * back` — a create-only change to a cdkd-NAMED target group could not be
 * deployed at all. `isNameCollisionErrorFrom` fixes it by reading the exception
 * NAME off the bounded cause chain. This fixture is the end-to-end proof that
 * `--replace` now COMPLETES such a replacement; the unit tests only pin the
 * predicate.
 *
 * WHY THE TARGET GROUP MUST STAY UNNAMED — AND SO KEEP THE SAME NAME
 *
 * The collision IS the test. cdkd mints `<stackName>-<logicalId>` for a target
 * group the template does not name (`FALLBACK_NAME_RULES` /
 * `generateResourceNameWithFallback`, `nameProperty: 'Name'`, `maxLength: 32`),
 * and it mints the SAME name on every deploy because the inputs are the stack
 * name and the logical id — neither of which changes here. So the replacement's
 * create asks AWS for a name the OLD target group still holds, and ELBv2
 * refuses with the exception above.
 *
 * Declaring a `name` and CHANGING it between phases would replace the target
 * group under a DIFFERENT name. That create never collides, the fallback is
 * never reached, and the run would pass identically on a tree with and without
 * the fix — a vacuous test. Hence: no `name` property, on any phase.
 *
 * WHY `Port` IS THE CHANGED PROPERTY
 *
 * `Port` is in `createOnlyProperties` for
 * `AWS::ElasticLoadBalancingV2::TargetGroup`
 * (`tests/fixtures/cfn-schemas/AWS-ElasticLoadBalancingV2-TargetGroup.json`,
 * alongside `IpAddressType`, `Name`, `Protocol`, `ProtocolVersion`,
 * `TargetType` and `VpcId`), so changing it classifies as a REPLACEMENT. And
 * `primaryIdentifier` is `TargetGroupArn`, not `Name` — so the replacement
 * produces a NEW ARN while the NAME is reused verbatim. That pairing is what
 * makes this the cheap same-name replacement: the identity changes, the name
 * does not, and `verify.sh` can therefore use the ARN as a positive
 * "replacement really happened" sentinel while asserting the name held.
 *
 * `TG_PORT` is the only seam. Unset it synthesizes 8080; `TG_PORT=8081`
 * synthesizes 8081 and nothing else moves.
 *
 * WHY A VPC, AND WHY IT IS FREE
 *
 * An `ip`-target-type target group requires a `VpcId`, and the VPC is also the
 * enumeration scope `verify.sh` counts target groups in (by `VpcId`, never by
 * name prefix — see that file's header). `natGateways: 0` with a single PUBLIC
 * subnet group means VPC + IGW + 2 subnets + route tables and nothing billable:
 * no NAT, no instances, no load balancer. The target group itself is free while
 * it is not attached to a load balancer.
 *
 * REMOVAL POLICIES
 *
 * None are set, deliberately. `scripts/check-fixture-removal-policy.ts` scopes
 * its STATEFUL_CONSTRUCTS list to eleven L2 families; `elbv2.CfnTargetGroup` is
 * an L1 whose CloudFormation template default is already `Delete`, and
 * `ec2.Vpc` is not a stateful L2. Nothing here would survive a destroy.
 */
export class Elbv2SameNameReplacementStack extends cdk.Stack {
  /** The port the fixture synthesizes when `TG_PORT` is unset. */
  public static readonly DEFAULT_PORT = 8080;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Parsed and validated here rather than trusted: a typo'd `TG_PORT` would
    // otherwise synthesize `Port: NaN`, which CloudFormation renders as `null`
    // and AWS rejects deep inside the deploy — a failure that looks like the
    // #3208 arm failing when it is really a harness mistake.
    const rawPort = process.env['TG_PORT'];
    const port = Number(rawPort ?? Elbv2SameNameReplacementStack.DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(
        `TG_PORT must be an integer TCP port in [1, 65535] (got '${String(rawPort)}')`
      );
    }

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // UNNAMED on purpose — see the header. cdkd fills
    // `${this.stackName}-Tg`, which is 20 characters against the type's
    // 32-character cap, so `generateResourceName` never takes its
    // truncate-plus-hash branch and `verify.sh` can assert a plain
    // `<stack>-` prefix.
    const targetGroup = new elbv2.CfnTargetGroup(this, 'Tg', {
      protocol: 'HTTP',
      targetType: 'ip',
      vpcId: vpc.vpcId,
      port,
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'The enumeration scope: verify.sh counts target groups by this VpcId',
    });

    // `Ref` on AWS::ElasticLoadBalancingV2::TargetGroup resolves to the target
    // group ARN, which is also its primaryIdentifier and its cdkd physicalId —
    // so verify.sh can cross-check state, output and live AWS against each
    // other after the replacement.
    new cdk.CfnOutput(this, 'TargetGroupArn', {
      value: targetGroup.ref,
      description: 'Target group ARN (Ref) — the primaryIdentifier the replacement changes',
    });
  }
}
