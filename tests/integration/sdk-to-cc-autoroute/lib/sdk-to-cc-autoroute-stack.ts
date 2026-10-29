import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';

/**
 * What a still-SDK resource does when the template gains a property cdkd's SDK
 * provider would silently drop -- issue
 * [2744](https://github.com/go-to-k/cdkd/issues/2744).
 *
 * `docs/cli-deploy-safety.md` answered that question twice, oppositely, about
 * seventy lines apart: the `--allow-unsupported-properties` section said the
 * next deploy AUTO-ROUTES the resource through Cloud Control (and that the
 * flag exists to prevent that), while `--recreate-via-cc-api` said the
 * property "will not reach AWS, because the SDK update path drops it
 * silently" and a destroy-and-recreate is required. A reader acts on the
 * difference: one of them costs downtime.
 *
 * `ProviderRegistry.getProviderFor` enters the sticky rule only for a record
 * already at `'cc-api'`, so a `'sdk'` record falls through to the silent-drop
 * check every deploy -- which reads like the first passage. But reading the
 * routing code does not settle whether the resulting Cloud Control UPDATE
 * SUCCEEDS against a physical id the SDK provider minted, nor whether the
 * property actually lands. This fixture observes it on a live resource.
 *
 * WHY `AWS::Logs::LogGroup` / `ResourcePolicyDocument`. The conditions are
 * scarce together:
 *
 *  - the type has an SDK provider, so a fresh deploy records
 *    `provisionedBy: 'sdk'` -- the state this question is about;
 *  - `ResourcePolicyDocument` sits in its `silentDrop` map as an
 *    `unhandledByDesign` entry (`logs-loggroup-provider.ts`, issue #1412), not
 *    as backlog: the go-to-k/cdkd#2762 backfill burns down every `not yet
 *    implemented by cdkd` entry, and it ended the fixture's first premise
 *    (the CloudWatch alarm's `EvaluationWindow`, go-to-k/cdkd#5524);
 *  - the committed schema's `createOnlyProperties` is `['LogGroupName']`
 *    alone, so a failure to apply the policy cannot be explained away as
 *    create-only semantics;
 *  - the physical id is the log group NAME, which the template fixes, so a
 *    destroy-and-recreate mints the same id and the out-of-band tag in
 *    verify.sh is the only identity witness -- the shape the arm needs;
 *  - `RetentionInDays` is a handled scalar that moves with the phase.
 *
 * It is also free and provisions instantly, so the arm costs nothing to re-run.
 * A log group is a STATEFUL type for cdkd, so the one genuine recreate (phase
 * 3) passes `--force-stateful-recreation`; the group holds no events.
 *
 * The policy is set through `addPropertyOverride` to keep the property in the
 * same escape-hatch shape a user without the L1 prop would reach for. It is a
 * log-group-scoped resource policy, letting this account's root write to this
 * log group only. NOT YET confirmed against a live Cloud Control create when
 * written: verify.sh's phase 2b readback is a FAIL line, not an assumption.
 *
 * Phase env `CDKD_TEST_PHASE`, set by verify.sh:
 *   base      -- handled properties only; the resource must land on the SDK route
 *   drop      -- PLUS ResourcePolicyDocument, deployed with NO flag. THE ARM.
 *   rebase    -- back to handled properties only, so the resource is eligible
 *                for `--recreate-via-sdk-provider`. Control for the IDENTITY
 *                WITNESS: a genuine destroy-and-recreate must kill the
 *                out-of-band tag, or the tag surviving the arm witnesses
 *                nothing.
 *   allowdrop -- PLUS ResourcePolicyDocument, deployed WITH
 *                `--prefer-sdk-route`. Control for the PREMISE:
 *                proves the SDK route really does drop the property, which the
 *                arm otherwise imports from the generated coverage map.
 *   allowmeta -- `allowdrop`'s properties byte for byte, plus
 *                `UpdateReplacePolicy: Retain`, deployed with the same flag.
 *                go-to-k/cdkd#2809: a policy-only flip must refresh state and
 *                skip the provider. The flip back deploys `allowdrop` again.
 *                UpdateReplacePolicy rather than DeletionPolicy, because a
 *                run that dies between the flip and the flip back would leave
 *                a Retain DeletionPolicy that orphans the log group at destroy.
 *   dropagain -- the same property again with NO flag, after `allowdrop`.
 *                Closes go-to-k/cdkd#2750: the opt-out deploy used to RECORD
 *                the property it never wrote, so the Cloud Control patch
 *                diffed it as unchanged and it never reached AWS. Same
 *                operation as the arm; the only difference is the recorded
 *                bag, which is what makes the pair a clean A/B.
 *
 *   subnet / subnettag -- go-to-k/cdkd#2790: the log group stays at
 *                `dropagain` (already on Cloud Control, so it no longer
 *                moves), and a VPC + `AWS::EC2::Subnet` join the stack carrying
 *                `AvailabilityZoneId`, which is a CREATE-ONLY silent drop for
 *                that type (the log group has none). `subnettag` differs from
 *                `subnet` by the subnet's Name tag alone, an ordinary in-place
 *                change. verify.sh deploys them with and without
 *                `--prefer-sdk-route` and with `--recreate-via-cc-api`; the AZ
 *                id comes from `CDKD_TEST_AZ_ID`, resolved from the account's
 *                region.
 *
 *   badpolicy -- go-to-k/cdkd#4904: `base` plus a ResourcePolicyDocument that
 *                is an object but no valid policy, which the update through
 *                Cloud Control refuses. Deployed with NO flag from `base`, so the
 *                update is auto-routed from the SDK provider and FAILS;
 *                verify.sh reads the remedy note on that failure. Retention
 *                stays at `base`'s, so the property is the only change.
 *
 * The retention moves with the phase for the same reason the sibling
 * `cc-to-sdk-reroute` fixture varies its DisplayName: routing is decided while
 * PROVISIONING, so a deploy the differ classifies NO_CHANGE never calls the
 * provider and never re-routes. Without a real property delta the second phase
 * would be a no-op and every assertion after it would pass vacuously. Every
 * value is one CloudWatch Logs accepts.
 */
const RETENTION_BY_PHASE: Record<string, number> = {
  base: 1,
  badpolicy: 1,
  drop: 3,
  rebase: 5,
  allowdrop: 7,
  // Same retention as `allowdrop` on purpose: the phase must differ from it by
  // the policy attribute ALONE, or the property diff it tests is not empty.
  allowmeta: 7,
  dropagain: 14,
  // The log group is on Cloud Control after `dropagain`; the subnet phases
  // leave it exactly as that phase did, so only the subnet moves.
  subnet: 14,
  subnettag: 14,
};

/** The go-to-k/cdkd#2790 phases, which add the VPC and subnet. */
const SUBNET_PHASES = new Set(['subnet', 'subnettag']);

/** The phases whose template carries the silently-dropped property. */
const PHASES_WITH_DROP = new Set([
  'drop',
  'allowdrop',
  'allowmeta',
  'dropagain',
  'subnet',
  'subnettag',
]);

/** The `Sid` verify.sh reads back to tell this policy from any other. */
export const POLICY_SID = 'CdkdSdkToCcAutoroute';

export class SdkToCcAutorouteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = process.env.CDKD_TEST_PHASE ?? 'base';
    const logGroupName = `${this.stackName}-log-group`;

    const logGroup = new logs.CfnLogGroup(this, 'AutorouteLogGroup', {
      logGroupName,
      retentionInDays: RETENTION_BY_PHASE[phase] ?? 1,
    });

    if (PHASES_WITH_DROP.has(phase)) {
      // The whole point of the fixture: a top-level CFn property that IS in
      // the committed schema and IS in this type's silentDrop map.
      logGroup.addPropertyOverride('ResourcePolicyDocument', {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: POLICY_SID,
            Effect: 'Allow',
            Principal: { AWS: `arn:${this.partition}:iam::${this.account}:root` },
            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            Resource: `arn:${this.partition}:logs:${this.region}:${this.account}:log-group:${logGroupName}:*`,
          },
        ],
      });
    }

    if (phase === 'badpolicy') {
      // An OBJECT, so cdkd's own pre-flight shape check (`property-shape.ts`,
      // which would refuse a number before any route is chosen) lets it
      // through, but not a usable resource policy: no Principal and no
      // Resource. Cloud Control's handler hands it to the service, which
      // refuses it.
      logGroup.addPropertyOverride('ResourcePolicyDocument', {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: 'logs:PutLogEvents' }],
      });
    }

    if (phase === 'allowmeta') {
      logGroup.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;
    }

    new cdk.CfnOutput(this, 'LogGroupName', { value: logGroup.ref });

    if (SUBNET_PHASES.has(phase)) {
      const azId = process.env.CDKD_TEST_AZ_ID;
      if (!azId) throw new Error(`phase ${phase} needs CDKD_TEST_AZ_ID (set by verify.sh)`);
      // The tag is what verify.sh's cleanup sweeps by, should a run die before
      // destroy. The STACK name, not a fixture-wide constant: the sweep must
      // never reach another stack's VPC, and this stack's state key already
      // makes one run per stack name per account the unit of ownership.
      const fixtureTag = { key: 'cdkd-integ-fixture', value: this.stackName };
      const vpc = new ec2.CfnVPC(this, 'CreateOnlyVpc', {
        cidrBlock: '10.42.0.0/16',
        tags: [fixtureTag],
      });
      // `AvailabilityZoneId` is the create-only drop; `AvailabilityZone` is
      // left out so the SDK route (which drops the id) lets EC2 pick the AZ.
      const subnet = new ec2.CfnSubnet(this, 'CreateOnlySubnet', {
        vpcId: vpc.ref,
        cidrBlock: '10.42.0.0/24',
        availabilityZoneId: azId,
        tags: [fixtureTag, { key: 'Name', value: `${this.stackName}-${phase}` }],
      });
      new cdk.CfnOutput(this, 'SubnetId', { value: subnet.ref });
    }
  }
}
