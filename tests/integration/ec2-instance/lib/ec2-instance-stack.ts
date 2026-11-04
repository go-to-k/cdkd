import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as kms from 'aws-cdk-lib/aws-kms';

/**
 * EC2 Instance example stack
 *
 * Demonstrates:
 * - VPC creation with public subnet (1 AZ, no NAT gateways for cost saving)
 * - EC2 Instance (t3.micro, Amazon Linux 2023)
 * - Security Group with SSH ingress rule
 * - Resource dependencies (Instance depends on VPC, Subnet, SecurityGroup)
 * - Fn::GetAtt for outputs (Instance ID, Public IP, Private IP)
 * - Security-focused property backfill (#609): DisableApiTermination /
 *   MetadataOptions (IMDSv2) / Monitoring / EbsOptimized / CreditSpecification
 *
 * The instance is authored as a RAW `ec2.CfnInstance` (L1) on purpose: the L2
 * `ec2.Instance` construct does not expose the five #609 security-backfill
 * props, and this fixture exists to verify each of them reaches AWS. L1 lets us
 * emit ONLY cdkd-handled top-level properties so the instance stays on the SDK
 * provider path (per the #609 backfill-fixture rule: L1 over L2, every emitted
 * prop must be handled). All five backfilled props ride on RunInstances
 * directly.
 *
 * `availabilityZone` is emitted deliberately (issue #1276). The L2 construct
 * ALWAYS emits it, and until #1276 it was in neither `handledProperties` nor
 * `unhandledByDesign`, so the #614 routing rule flipped every L2-authored
 * instance onto the Cloud Control path. Now that the SDK provider maps it onto
 * RunInstances' `Placement.AvailabilityZone`, emitting it here (a) keeps the
 * resource on the SDK path — verified by the `provisionedBy` assertion in
 * verify.sh — and (b) is the only place the new `Placement` create path runs
 * against real AWS.
 *
 * UPDATE phase (issue #5446): CDKD_TEST_UPDATE_5446=true changes InstanceType,
 * moves the instance to a second security group and adds UserData; see
 * verify.sh Phase 1h. The same phase changes InstanceInitiatedShutdownBehavior
 * terminate -> stop in place (issue #5630).
 *
 * Issue #5630 also gives the NetworkInterfaces-shaped instance CpuOptions and
 * HibernationOptions (with the encrypted root volume hibernation needs).
 *
 * Issue #5630 (second slice): the main instance launches with
 * SourceDestCheck=false (a ModifyInstanceAttribute after RunInstances, which
 * Phase 0 sends while the instance is still `pending`), a fixed
 * PrivateIpAddress, a spread PlacementGroupName and an explicit
 * Tenancy=default; Phase 1h REMOVES SourceDestCheck, which CloudFormation sets
 * back to true in place (measured, us-east-1). The NetworkInterfaces-shaped
 * instance sets PropagateTagsToVolumeOnCreation with a tag, which both of its
 * volumes must carry.
 *
 * Issue #5630 (third slice): the main instance declares PrivateDnsNameOptions
 * (resource-name hostnames with their A record); Phase 1h changes HostnameType
 * to ip-name and turns the A record off. CloudFormation applies both to the
 * SAME instance (measured: the flag in place, the hostname type with a stop and
 * a start, which Phase 1h's InstanceType change shares), and the private DNS
 * name moves with it, which the Phase 1g PrivateDnsName reader must follow.
 * Phase 1i (CDKD_TEST_DNS_5630=flag) then turns the A record on alone, in
 * place with no stop, and Phase 1j (=hostname) changes only HostnameType back
 * to resource-name, which takes a stop and a start on its own. A
 * third and fourth instance launch in an IPv6 subnet (an Amazon-provided /56 on
 * the VPC, the subnet its first /64) with Ipv6AddressCount and with a fixed
 * Ipv6Addresses entry (`<the /64>::77`), both create-only RunInstances inputs.
 *
 * REMOVAL phases (issue #1160; CloudFormation A/B in go-to-k/cdkd#1160
 * issuecomment-6281778130). CDKD_TEST_REMOVAL=true drops MetadataOptions /
 * Monitoring / CreditSpecification: CloudFormation turns a removed Monitoring
 * off and keeps the other two. CDKD_TEST_DAT selects DisableApiTermination:
 * unset keeps `true`; `remove` drops it (CloudFormation fails that update, so
 * cdkd refuses it) and adds a marker tag that must NOT land; `false` declares
 * it explicitly off, which both apply. EbsOptimized stays declared: an
 * EbsOptimized change is routed to replacement, and these phases must update
 * in place.
 */
export class Ec2InstanceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isRemoval = process.env.CDKD_TEST_REMOVAL === 'true';
    // Issue #5446 (verify.sh Phase 1h): the in-place update of InstanceType,
    // SecurityGroupIds and UserData. CloudFormation applies all three to the
    // SAME instance (a stop and a start for the type and the user data).
    const isUpdate5446 = process.env.CDKD_TEST_UPDATE_5446 === 'true';
    // Issue #5446 (verify.sh Phases 1g-1h): a RESOURCE reading the instance's
    // public address, added once the instance is running (a --no-wait Phase 0
    // has no address to give it), so Phase 1h's stop/start has to PROMOTE it.
    const withIpReader = process.env.CDKD_TEST_IP_READER === 'true';
    const datMode = process.env.CDKD_TEST_DAT;
    // Issue #5630 (verify.sh Phases 1i-1j, after Phase 1h): `flag` turns the
    // A record on alone (in place, no stop); `hostname` then changes only
    // HostnameType back to resource-name (a stop and a start).
    const dnsMode = process.env.CDKD_TEST_DNS_5630;

    // Create VPC with 1 AZ and no NAT gateways (cost saving)
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    // Create Security Group allowing SSH
    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSG', {
      vpc,
      description: 'Security group for EC2 instance',
      allowAllOutbound: true,
    });

    securityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(22),
      'Allow SSH from anywhere'
    );

    // Issue #5446: a second group, always present, so Phase 1h only moves the
    // instance's reference from the first group to this one.
    const updateSecurityGroup = new ec2.SecurityGroup(this, 'InstanceSG5446', {
      vpc,
      description: 'cdkd ec2-instance integ (issue #5446): the group Phase 1h moves the instance to',
      allowAllOutbound: true,
    });

    // Issue #5630: a spread placement group (t3 supports spread, not cluster).
    const placementGroup = new ec2.CfnPlacementGroup(this, 'PlacementGroup5630', {
      strategy: 'spread',
    });

    // Resolve the Amazon Linux 2023 AMI for this stack's region.
    const ami = ec2.MachineImage.latestAmazonLinux2023().getImage(this).imageId;

    // Raw L1 instance — emit only cdkd-handled top-level props so the resource
    // stays on the SDK provider path (see class doc above).
    const instance = new ec2.CfnInstance(this, 'Instance', {
      imageId: ami,
      instanceType: isUpdate5446 ? 't3.small' : 't3.micro',
      subnetId: vpc.publicSubnets[0].subnetId,
      // The property #1276 added to the SDK provider. Emitting it alongside
      // SubnetId mirrors what the L2 construct synthesizes, and RunInstances
      // accepts both as long as they agree.
      availabilityZone: vpc.publicSubnets[0].availabilityZone,
      securityGroupIds: [
        isUpdate5446 ? updateSecurityGroup.securityGroupId : securityGroup.securityGroupId,
      ],
      ...(isUpdate5446 ? { userData: cdk.Fn.base64('#!/bin/bash\necho cdkd-5446\n') } : {}),
      // Issue #5630: `terminate` (non-default) rides RunInstances; Phase 1h
      // changes it to `stop` in place (ModifyInstanceAttribute), as
      // CloudFormation does with no interruption (measured, us-east-1). It
      // stays declared in every phase: CloudFormation fails a removal.
      instanceInitiatedShutdownBehavior: isUpdate5446 ? 'stop' : 'terminate',
      // Issue #5630 (second slice). SourceDestCheck=false is the non-default
      // value; Phase 1h removes it, which CloudFormation resets to true in
      // place. PrivateIpAddress / PlacementGroupName / Tenancy are replacing
      // properties, so they stay identical in every phase. The address sits in
      // the public subnet (10.0.0.0/24, the first /24 of the VPC's default
      // 10.0.0.0/16). Tenancy=default proves only the SDK route: a dedicated
      // instance carries an hourly region fee, and the wire is unit-tested.
      ...(isUpdate5446 ? {} : { sourceDestCheck: false }),
      privateIpAddress: '10.0.0.200',
      placementGroupName: placementGroup.ref,
      tenancy: 'default',
      // Issue #5630 (third slice): both members stay declared in every phase
      // (CloudFormation fails an update removing one). No AAAA flag: the
      // subnet is IPv4-only.
      privateDnsNameOptions: !isUpdate5446
        ? { hostnameType: 'resource-name', enableResourceNameDnsARecord: true }
        : dnsMode === 'hostname'
          ? { hostnameType: 'resource-name', enableResourceNameDnsARecord: true }
          : dnsMode === 'flag'
            ? { hostnameType: 'ip-name', enableResourceNameDnsARecord: true }
            : { hostnameType: 'ip-name', enableResourceNameDnsARecord: false },
      // Security-focused property backfill (#609):
      // Termination protection — a silent-drop here would let a user believe
      // the instance is protected when it is not. `cdkd destroy
      // --remove-protection` (exercised by verify.sh) flips this off before
      // terminate.
      // The removal phases (issue #1160) drop the properties below that
      // update() modifies in place; see the class doc.
      ...(datMode === 'remove'
        ? { tags: [{ key: 'Cdkd1160Refused', value: 'must-not-land' }] }
        : { disableApiTermination: datMode !== 'false' }),
      ...(isRemoval
        ? {}
        : {
            // IMDSv2 enforcement inline on the instance (no LaunchTemplate).
            metadataOptions: {
              httpTokens: 'required',
              httpEndpoint: 'enabled',
              // Non-default on purpose (the AL2023 default is 2): the issue
              // #1160 removal phase asserts CloudFormation's KEEP, which a reset
              // to the default would otherwise pass.
              httpPutResponseHopLimit: 3,
            },
            // Detailed CloudWatch monitoring.
            monitoring: true,
            // T-family burstable CPU credit mode. `standard` is non-default
            // for t3 (whose default is `unlimited`), for the same reason.
            creditSpecification: { cpuCredits: 'standard' },
          }),
      // Dedicated EBS throughput.
      ebsOptimized: true,
    });

    // Outputs
    new cdk.CfnOutput(this, 'InstanceId', {
      value: instance.ref,
      description: 'EC2 Instance ID',
    });

    new cdk.CfnOutput(this, 'PublicIp', {
      value: instance.attrPublicIp,
      description: 'EC2 Instance Public IP',
    });

    if (withIpReader) {
      const ipReader = new ssm.CfnParameter(this, 'PublicIpReader5446', {
        type: 'String',
        value: instance.attrPublicIp,
        description: 'cdkd ec2-instance integ (issue #5446): reads Fn::GetAtt Instance.PublicIp',
      });
      new cdk.CfnOutput(this, 'IpReaderParamName', {
        value: ipReader.ref,
        description: 'The SSM parameter reading the instance public IP (issue #5446)',
      });
      // Issue #5630: Phase 1h's HostnameType change moves the private DNS
      // name in place, so this reader must be promoted and follow it.
      const dnsReader = new ssm.CfnParameter(this, 'PrivateDnsNameReader5630', {
        type: 'String',
        value: instance.attrPrivateDnsName,
        description: 'cdkd ec2-instance integ (issue #5630): reads Fn::GetAtt Instance.PrivateDnsName',
      });
      new cdk.CfnOutput(this, 'DnsReaderParamName', {
        value: dnsReader.ref,
        description: 'The SSM parameter reading the instance private DNS name (issue #5630)',
      });
    }

    new cdk.CfnOutput(this, 'PrivateIp', {
      value: instance.attrPrivateIp,
      description: 'EC2 Instance Private IP',
    });

    new cdk.CfnOutput(this, 'UpdateSgId', {
      value: updateSecurityGroup.securityGroupId,
      description: 'The group verify.sh Phase 1h moves the instance to (issue #5446)',
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
      description: 'VPC ID',
    });

    // Issue #1281: a SECOND instance authored the associatePublicIpAddress
    // way -- the CDK L2 construct drops SubnetId / SecurityGroupIds and
    // emits a single NetworkInterfaces entry instead. This is the only
    // place the RunInstances `NetworkInterfaces` mapping runs against real
    // AWS; verify.sh asserts the instance stays on the SDK path (before
    // #1281 the unhandled property routed it to Cloud Control) and that
    // the public IP the association asked for actually exists.
    // Issue #5445: a fixture-owned customer managed key for the data volume
    // below. DESTROY + the 7-day minimum window so the stack's destroy
    // schedules it for deletion rather than retaining it.
    const ebsKey = new kms.Key(this, 'EbsKey', {
      description: 'cdkd ec2-instance integ (issue #5445): EBS data volume CMK',
      pendingWindow: cdk.Duration.days(7),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const publicInstance = new ec2.CfnInstance(this, 'PublicInstance', {
      imageId: ami,
      instanceType: 't3.nano',
      availabilityZone: vpc.publicSubnets[0].availabilityZone,
      // Issue #5445: before the fix only DeviceName and
      // Ebs.{VolumeSize,VolumeType,DeleteOnTermination} reached RunInstances,
      // so this volume launched without the CMK and at the gp3 baseline of
      // 3000 IOPS. verify.sh reads it back with DescribeVolumes: KmsKeyId must
      // be THIS key (an account's encryption-by-default would satisfy
      // `Encrypted` alone, never the key) and Iops must be 3500, not the
      // baseline. 8 GiB because gp3 caps IOPS at 500 per GiB. No Throughput:
      // CloudFormation's AWS::EC2::Instance Ebs has none.
      // Issue #5630: launch-only CPU and hibernation options (create-only).
      // One thread per core (t3.nano's default is two), and hibernation, which
      // needs an encrypted root volume large enough for the RAM: the /dev/xvda
      // entry below (the AL2023 root device). CloudFormation launches this
      // exact shape (measured, us-east-1, t3.nano + AL2023).
      cpuOptions: { coreCount: 1, threadsPerCore: 1 },
      hibernationOptions: { configured: true },
      // Issue #5630: both block-device volumes must carry this tag.
      propagateTagsToVolumeOnCreation: true,
      tags: [{ key: 'Cdkd5630Propagate', value: 'volume-tag' }],
      blockDeviceMappings: [
        {
          deviceName: '/dev/xvda',
          ebs: { encrypted: true, volumeType: 'gp3', volumeSize: 8, deleteOnTermination: true },
        },
        {
          deviceName: '/dev/sdf',
          ebs: {
            encrypted: true,
            kmsKeyId: ebsKey.keyArn,
            volumeType: 'gp3',
            volumeSize: 8,
            iops: 3500,
            deleteOnTermination: true,
          },
        },
      ],
      networkInterfaces: [
        {
          deviceIndex: '0',
          associatePublicIpAddress: true,
          subnetId: vpc.publicSubnets[0].subnetId,
          groupSet: [securityGroup.securityGroupId],
          deleteOnTermination: true,
        },
      ],
    });

    // Issue #5630: the main instance claims the fixed 10.0.0.200 in the same
    // /24 this instance takes an auto-assigned address from, so launch it
    // first; otherwise this one could be handed .200 and the main launch fail.
    publicInstance.addDependency(instance);

    new cdk.CfnOutput(this, 'PublicInstanceId', {
      value: publicInstance.ref,
      description: 'NetworkInterfaces-shaped EC2 Instance ID (issue #1281)',
    });

    new cdk.CfnOutput(this, 'PlacementGroupName', {
      value: placementGroup.ref,
      description: 'The spread placement group the main instance launches in (issue #5630)',
    });

    // Issue #5630 (third slice): an Amazon-provided IPv6 /56 on the VPC and a
    // subnet holding its first /64 (Fn::Cidr). The fixed address is that /64's
    // first four hextets plus `::77`; they are read off the Fn::Cidr result,
    // which cdkd writes uncompressed, so a zero fourth hextet still yields four
    // fields (the /56 AWS reports would compress it away). Nothing routes out
    // of the subnet: the instances only need their addresses.
    const ipv6Block = new ec2.CfnVPCCidrBlock(this, 'Ipv6Block5630', {
      vpcId: vpc.vpcId,
      amazonProvidedIpv6CidrBlock: true,
    });
    const v6Subnet64 = cdk.Fn.select(
      0,
      cdk.Fn.cidr(cdk.Fn.select(0, vpc.vpcIpv6CidrBlocks), 1, '64')
    );
    const v6Hextets = cdk.Fn.split(':', v6Subnet64);
    const v6Prefix = cdk.Fn.join(':', [0, 1, 2, 3].map((i) => cdk.Fn.select(i, v6Hextets)));
    const ipv6Subnet = new ec2.CfnSubnet(this, 'Ipv6Subnet5630', {
      vpcId: vpc.vpcId,
      availabilityZone: vpc.publicSubnets[0].availabilityZone,
      cidrBlock: '10.0.255.0/24',
      ipv6CidrBlock: v6Subnet64,
    });
    ipv6Subnet.addDependency(ipv6Block);
    const ipv6Address = cdk.Fn.join('', [v6Prefix, '::77']);
    const ipv6CountInstance = new ec2.CfnInstance(this, 'Ipv6CountInstance5630', {
      imageId: ami,
      instanceType: 't3.nano',
      subnetId: ipv6Subnet.ref,
      ipv6AddressCount: 1,
    });
    const ipv6AddressInstance = new ec2.CfnInstance(this, 'Ipv6AddressInstance5630', {
      imageId: ami,
      instanceType: 't3.nano',
      subnetId: ipv6Subnet.ref,
      ipv6Addresses: [{ ipv6Address: ipv6Address }],
    });
    new cdk.CfnOutput(this, 'Ipv6CountInstanceId', {
      value: ipv6CountInstance.ref,
      description: 'The instance launched with Ipv6AddressCount 1 (issue #5630)',
    });
    new cdk.CfnOutput(this, 'Ipv6AddressInstanceId', {
      value: ipv6AddressInstance.ref,
      description: 'The instance launched with a fixed Ipv6Addresses entry (issue #5630)',
    });
    new cdk.CfnOutput(this, 'Ipv6AddressExpected', {
      value: ipv6Address,
      description: 'The address Ipv6AddressInstance5630 must hold (issue #5630)',
    });

    new cdk.CfnOutput(this, 'EbsKeyArn', {
      value: ebsKey.keyArn,
      description: 'CMK the #5445 data volume must be encrypted with',
    });

    // Issue #3097: a RAW L1 security group declared with NO `vpcId`. AWS puts
    // it in the account's default VPC, so the template has no VpcId for the
    // provider to copy -- the shape whose `Fn::GetAtt [.., VpcId]` used to
    // resolve to '' (the record) or the literal 'undefined' (the resolver
    // arm). The provider now reads the group's VpcId back from
    // `DescribeSecurityGroups` at create, and verify.sh asserts the Output
    // equals the default VPC's id (read live via `is-default`, never
    // hardcoded). The L2 `ec2.SecurityGroup` cannot express this: it requires
    // a `vpc`. The explicit GroupName is what verify.sh's teardown sweeps by,
    // so a run killed between create and state write cannot leave a
    // same-named group that fails the next run with InvalidGroup.Duplicate.
    // Nothing references this group, so the stack's own destroy deletes it;
    // the default VPC itself is never touched.
    const defaultVpcSg = new ec2.CfnSecurityGroup(this, 'DefaultVpcSg', {
      groupDescription: 'cdkd ec2-instance integ (issue #3097): declared without VpcId',
      groupName: 'CdkdEc2InstanceIntegDefaultVpcSg',
    });

    new cdk.CfnOutput(this, 'DefaultVpcSgVpcId', {
      value: defaultVpcSg.attrVpcId,
      description: 'VpcId of a security group declared without one (issue #3097)',
    });
  }
}
