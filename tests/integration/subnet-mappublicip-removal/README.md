# Subnet MapPublicIpOnLaunch removal

Exercises `AWS::EC2::Subnet` on the SDK route (Refs #6342). A `CfnVPC` and one
`CfnSubnet`; no instances or traffic.

`verify.sh` creates the subnet with `MapPublicIpOnLaunch: true`, then redeploys
with the property removed (`CDKD_TEST_REMOVAL=true`) and a changed `Phase` tag.
CloudFormation keeps the live value on that removal (measured A/B, us-east-1),
so the run requires the same subnet to still read `true`, the state record to
hold no `MapPublicIpOnLaunch`, `cdkd diff --fail` to report no changes and
`cdkd drift --json` to report the VPC and subnet fully compared and clean.
Before the fix the removal sent `ModifySubnetAttribute false` and the live
read failed. A final phase
declares `false` over the record that holds no value and requires the live
value to go `false`, with diff and drift clean again. It then destroys the stack
and checks that the subnet, VPC and state are gone.

Build the repository first. The maintainer runs this fixture via `/run-integ
subnet-mappublicip-removal`, with `STATE_BUCKET` and `AWS_REGION` set. It
deploys real AWS resources and is not run as part of the local unit checks.
