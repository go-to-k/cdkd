# RDS Aurora Serverless v2 Example

This example deploys an Aurora Serverless v2 (MySQL) cluster with minimal cost configuration.

## Resources

- **VPC** - 1 AZ, no NAT gateways, isolated subnets only
- **Security Group** - Allows MySQL (3306) access from within the VPC
- **Aurora Serverless v2 Cluster** - MySQL 3.08.0, 0.5-1 ACU capacity
- **Secrets Manager Secret** - Auto-generated database credentials (created by CDK)

## Outputs

- `ClusterEndpoint` - Aurora cluster endpoint hostname
- `SecretArn` - Secrets Manager secret ARN for database credentials
- `VpcId` - VPC ID

## Deploy

```bash
cdkq deploy RdsAuroraStack
```

## Destroy

```bash
cdkq destroy RdsAuroraStack
```

## Cost Notes

- Serverless v2 with minCapacity 0.5 ACU keeps costs minimal
- No NAT gateways (isolated subnets only) avoids NAT gateway charges
- Single AZ deployment reduces costs further
