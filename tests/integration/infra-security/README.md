# Infrastructure & Security Example

Combines infrastructure and security resources in a single stack.

## Resources Created

- **VPC** - 2 AZs, 1 NAT Gateway, public + private subnets
- **KMS Key** - With alias and key rotation enabled
- **S3 Bucket** - Encrypted with the KMS key
- **SSM StringParameter** - Stores config values (VPC ID, bucket name)
- **IAM Role** - With inline KMS decrypt policy + AmazonS3ReadOnlyAccess managed policy

## Demonstrates

- VPC with multi-AZ and NAT Gateway configuration
- KMS encryption for S3 buckets
- SSM Parameter for configuration storage
- IAM Role with both inline and managed policies
- Resource dependencies (Bucket → KMS Key, Parameter → VPC + Bucket, Role → KMS Key)
- `Fn::GetAtt` for outputs (VPC ID, KMS ARN, Bucket name, Role ARN)

## Deploy

```bash
cdkd deploy InfraSecurityStack
```

## Destroy

```bash
cdkd destroy InfraSecurityStack
```

## Test Points

- [ ] VPC is created with 2 AZs, public and private subnets
- [ ] NAT Gateway is created in one of the public subnets
- [ ] KMS Key is created with key rotation enabled
- [ ] KMS Alias is created and associated with the key
- [ ] S3 Bucket is created with KMS encryption
- [ ] SSM Parameter is created with JSON config value
- [ ] IAM Role is created with inline policy and managed policy attached
- [ ] All outputs are correctly resolved
- [ ] Destroy removes all resources cleanly
