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

## Run

This test uses a `verify.sh` that owns its full deploy + assert + destroy cycle:

```bash
# via the run-integ skill (preferred)
/run-integ cache-streaming

# or directly
cd tests/integration/cache-streaming
AWS_REGION=us-east-1 STATE_BUCKET=cdkd-state-<accountId> bash verify.sh
```

`verify.sh` asserts (failure-seeking):

- **LOAD-BEARING**: the Redis endpoint (a `Fn::GetAtt` on
  `attrRedisEndpointAddress`, read back from the Lambda's `REDIS_ENDPOINT` env
  var) resolves to a real `*.cache.amazonaws.com` hostname, not the cluster
  physicalId (guards the GetAtt-enrichment path).
- the Kinesis Data Stream is `ACTIVE`,
- an ElastiCache cluster exists on the stack's subnet group,
- the Lambda has an event source mapping wired to the Kinesis stream,
- after destroy: state file, Kinesis stream, Lambda, and ElastiCache cluster
  are all gone (0 orphans).
