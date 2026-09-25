# import-migrate-vpc

`cdkd import --migrate-from-cloudformation` adopting a CDK `ec2.Vpc` completely
(issue [#3661](https://github.com/go-to-k/cdkd/issues/3661)).

`EC2Provider.import()` returned `null` for the following types:

- route tables and routes;
- the internet gateway and its attachment;
- subnet route-table / NACL associations;
- NACLs and their entries;
- instances.

So the migration retired the CloudFormation stack with those resources
orphaned, and the next `cdkd deploy` re-created them: a duplicate route table
and a conflicting association.

## Configuration

The fixture has:

- a CDK `ec2.Vpc` with two AZs, one NAT gateway, and public + private subnets
  (`restrictDefaultSecurityGroup: false`, so there is no Custom Resource);
- a NACL with an ingress and an egress entry on the private subnets;
- a `t4g.nano` instance in a private subnet;
- an Amazon-provided IPv6 `AWS::EC2::VPCCidrBlock` (issue
  [#3672](https://github.com/go-to-k/cdkd/issues/3672)). It has no SDK
  provider, so it imports through Cloud Control, which identifies it as
  `<associationId>|<vpcId>`; CloudFormation reports only the association id.

## Flow

1. `cdk deploy` (the CloudFormation stack to migrate).
2. `cdkd import --migrate-from-cloudformation --yes`. The run asserts the
   summary reads `0 not found` and `0 failed`, and that state records the
   VPCCidrBlock as `<associationId>|<vpcId>`.
3. `cdkd deploy` with an unchanged template. The run asserts nothing is
   created or updated.
4. `cdkd destroy --force`. The run asserts the instance is terminated, the NAT
   gateway is deleted, and the VPC and state file are gone.

## Run

```bash
STATE_BUCKET=<your-cdkd-state-bucket> ./verify.sh
```
