- **`cdkd import` now records the attributes `create()` records for ELBv2 load balancers and target groups, EC2 subnets, Cloud Map services, EFS access points and CloudFront origin access identities (issue [#3627](https://github.com/go-to-k/cdkd/issues/3627))** -- `src/provisioning/providers/{elbv2,ec2,servicediscovery,efs,cloudfront-oai}-provider.ts`, their unit tests, and the new `tests/integration/import-attribute-readback-network/` fixture. After `cdkd import`, including `--migrate-from-cloudformation`, a sibling's `Fn::GetAtt` got these values:

  | Resource | Attributes | Value before the fix |
  |---|---|---|
  | ELBv2 load balancer | `DNSName`, `CanonicalHostedZoneID`, `LoadBalancerFullName`, `LoadBalancerName` | the load balancer ARN |
  | ELBv2 target group | `TargetGroupFullName`, `TargetGroupName` | the target group ARN |
  | EC2 subnet | `AvailabilityZone` | the subnet id |
  | Cloud Map service | `Name` | the `srv-` id |
  | EFS access point | `Arn` | refused |
  | CloudFront OAI | `S3CanonicalUserId` | the OAI id |

  Each `import()` now reads these back, and the #1852 deploy-time heal serves them for records imported earlier. The OAI `import()` now verifies the id exists and needs `cloudfront:GetCloudFrontOriginAccessIdentity`. Separately, ELBv2 `TargetGroupFullName` is now CloudFormation's `targetgroup/<name>/<id>`. `create()` / `update()` dropped the `targetgroup/` prefix, which broke a CloudWatch `TargetGroup` dimension built from it. A target group created before this fix keeps the old value until its next update or re-import.
