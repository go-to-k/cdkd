# Cache Streaming Integration Test

This example demonstrates cdkd deployment of a caching and streaming pattern.

## Resources

- **VPC** - VPC with 1 AZ, public subnet only (no NAT to save cost)
- **Security Group** - Allows Redis access (port 6379) from within the VPC
- **ElastiCache Subnet Group** - Subnet group for Redis cluster
- **ElastiCache Redis Cluster** - Single-node cache.t3.micro Redis cluster
- **Kinesis Data Stream** - Data stream with 1 shard
- **Lambda Function** - Inline Python function that processes Kinesis records
- **Event Source Mapping** - Connects Kinesis stream to Lambda function

## What it tests

- VPC with public subnet creation (L2)
- Security Group with ingress rules (L2)
- ElastiCache Subnet Group creation (L1 CfnSubnetGroup)
- ElastiCache Redis cluster creation (L1 CfnCacheCluster)
- Kinesis Data Stream creation (L2)
- Lambda Function with inline code and environment variables (L2)
- Kinesis event source mapping (L2)
- Cross-resource references (Ref, Fn::GetAtt)
- Redis endpoint attributes (attrRedisEndpointAddress, attrRedisEndpointPort)
- CfnOutputs for resource attributes
- RemovalPolicy.DESTROY for cleanup

## Deploy

```bash
cd tests/integration/cache-streaming
npm install
cdkd deploy CacheStreamingStack
```

## Destroy

```bash
cdkd destroy CacheStreamingStack
```
