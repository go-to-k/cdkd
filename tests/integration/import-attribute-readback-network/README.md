# import-attribute-readback-network

`cdkd import --migrate-from-cloudformation` recording the attribute maps
`create()` records (issue [#3627](https://github.com/go-to-k/cdkd/issues/3627)),
second batch. Before the fix, each attribute below resolved to the physical id
after an import, or was refused:

| Resource | Attributes |
|---|---|
| `AWS::ElasticLoadBalancingV2::LoadBalancer` (internal) | `DNSName`, `CanonicalHostedZoneID`, `LoadBalancerFullName`, `LoadBalancerName` |
| `AWS::ElasticLoadBalancingV2::TargetGroup` | `TargetGroupFullName`, `TargetGroupName` |
| `AWS::EC2::Subnet` | `AvailabilityZone` |
| `AWS::ServiceDiscovery::Service` (HTTP namespace) | `Name` |
| `AWS::EFS::AccessPoint` | `Arn` (refused: the physical id is `fsap-...`) |
| `AWS::CloudFront::CloudFrontOriginAccessIdentity` | `S3CanonicalUserId` |

The VPC is L1 with no route tables: a CDK `ec2.Vpc`'s route tables and
associations cannot be adopted by `--migrate-from-cloudformation` yet
([#3661](https://github.com/go-to-k/cdkd/issues/3661)).

One SSM parameter per attribute carries the `Fn::GetAtt`. The assertion reads
each imported parameter record against what AWS reports, and reports every
row before it fails. The run then does an unchanged `cdkd deploy` (nothing
updated, no `Unknown attribute` line) and a destroy with gone-probes.

## Run

```bash
STATE_BUCKET=<your-cdkd-state-bucket> ./verify.sh
```
