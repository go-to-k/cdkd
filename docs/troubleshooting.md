# cdkq Troubleshooting Guide

This document summarizes common issues when using cdkq and their solutions.

## Table of Contents

1. [Lock Issues](#lock-issues)
2. [State Management Issues](#state-management-issues)
3. [Deployment Errors](#deployment-errors)
4. [Asset Publishing Issues](#asset-publishing-issues)
5. [Intrinsic Function Issues](#intrinsic-function-issues)
6. [Permission Errors](#permission-errors)
7. [Performance Issues](#performance-issues)
8. [Orphaned Resources](#orphaned-resources)

---

## Lock Issues

### Issue: "Failed to acquire lock" Error

#### Symptoms

```
Error: Failed to acquire lock for stack 'MyStack' after 3 attempts.
Locked by: user@hostname:12345, operation: deploy
```

#### Causes

- Another process is deploying the same stack
- Previous process crashed and lock remains

#### Solutions

**1. Check if another process is running**

```bash
# Check lock information
aws s3api get-object \
  --bucket ${STATE_BUCKET} \
  --key stacks/MyStack/lock.json \
  /dev/stdout

# Example output:
# {
#   "owner": "goto@macbook:12345",
#   "timestamp": 1710835200000,
#   "operation": "deploy"
# }
```

**2. Force release if lock is old**

```bash
# Delete lock file
aws s3 rm s3://${STATE_BUCKET}/stacks/MyStack/lock.json

# Or use cdkq force-unlock command
cdkq force-unlock MyStack
```

**3. Increase retry count**

```typescript
// Adjust in deploy-engine.ts
await lockManager.acquireLockWithRetry(
  stackName,
  owner,
  operation,
  5,      // maxRetries (default: 3)
  10000   // retryDelay (default: 5000ms)
);
```

---

## State Management Issues

### Issue: "State was modified by another process"

#### Symptoms

```
StateError: State was modified by another process. Expected ETag: "abc123", but state has changed.
```

#### Causes

- Two processes attempted to deploy simultaneously
- Lock was acquired but conflict occurred when saving state

#### Solutions

**1. Re-run deployment**

Protected automatically by optimistic locking, so simply re-running should succeed:

```bash
node dist/cli.js deploy --app "..." --state-bucket ${STATE_BUCKET}
```

**2. Adjust lock timeout**

```typescript
// lock-manager.ts
private readonly lockTTL = 30 * 60 * 1000;  // Extend to 30 minutes
```

### Issue: State File is Corrupted

#### Symptoms

```
SyntaxError: Unexpected token in JSON at position 123
```

#### Causes

- S3 upload was interrupted
- JSON error during manual editing

#### Solutions

**1. Restore from S3 versioning**

```bash
# Get version list
aws s3api list-object-versions \
  --bucket ${STATE_BUCKET} \
  --prefix stacks/MyStack/state.json

# Example output:
# {
#   "Versions": [
#     {
#       "Key": "stacks/MyStack/state.json",
#       "VersionId": "abc123",
#       "LastModified": "2024-03-19T10:30:00.000Z"
#     },
#     {
#       "Key": "stacks/MyStack/state.json",
#       "VersionId": "def456",
#       "LastModified": "2024-03-19T09:00:00.000Z"
#     }
#   ]
# }

# Restore old version
aws s3api get-object \
  --bucket ${STATE_BUCKET} \
  --key stacks/MyStack/state.json \
  --version-id def456 \
  /tmp/state-backup.json

# Restore
aws s3 cp /tmp/state-backup.json \
  s3://${STATE_BUCKET}/stacks/MyStack/state.json
```

**2. Reset state and redeploy**

```bash
# Delete state (resources remain)
aws s3 rm s3://${STATE_BUCKET}/stacks/MyStack/state.json

# Redeploy (will error if existing resources exist)
node dist/cli.js deploy --app "..." --state-bucket ${STATE_BUCKET}
```

### Issue: State and Resources Don't Match

#### Symptoms

- Manually deleted/modified resources in AWS Console
- cdkq tries to update non-existent resources

#### Causes

cdkq's state file and actual AWS resources have diverged.

#### Solutions

**1. Reset state**

```bash
# Delete state
aws s3 rm s3://${STATE_BUCKET}/stacks/MyStack/state.json

# Redeploy (all resources treated as CREATE)
node dist/cli.js deploy --app "..." --state-bucket ${STATE_BUCKET}
```

**2. Manually fix state (advanced)**

```bash
# Download state
aws s3 cp s3://${STATE_BUCKET}/stacks/MyStack/state.json /tmp/state.json

# Edit (remove entries for deleted resources)
vim /tmp/state.json

# Upload
aws s3 cp /tmp/state.json s3://${STATE_BUCKET}/stacks/MyStack/state.json
```

**3. Delete and recreate entire stack**

```bash
# Delete all resources
node dist/cli.js destroy MyStack --force

# Redeploy
node dist/cli.js deploy --app "..." --state-bucket ${STATE_BUCKET}
```

---

## Deployment Errors

### Issue: "Resource already exists" Error

#### Symptoms

```
ProvisioningError: Resource already exists: my-bucket-name
ResourceType: AWS::S3::Bucket
```

#### Causes

- Resource with same name already exists
- Previous deployment failed midway and state was not saved

#### Solutions

**1. Change resource name**

Make resource name unique in CDK code:

```typescript
new s3.Bucket(this, 'MyBucket', {
  bucketName: `my-app-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
});
```

**2. Delete existing resource**

```bash
# S3 bucket example
aws s3 rb s3://my-bucket-name --force
```

**3. Import existing resource to state (planned for future implementation)**

```bash
# cdkq import --stack MyStack --resource MyBucket=s3://my-bucket-name
```

### Issue: "Provider not found" Error

#### Symptoms

```
Error: No provider registered for resource type: AWS::CustomService::Resource
```

#### Causes

- Resource not supported by Cloud Control API
- SDK Provider not implemented

#### Solutions

**1. Check Cloud Control API support status**

```bash
# Check AWS documentation
# https://docs.aws.amazon.com/cloudcontrolapi/latest/userguide/supported-resources.html
```

**2. Implement SDK Provider**

Refer to [provider-development.md](./provider-development.md) to implement a custom provider.

**3. Temporarily use CloudFormation**

For resources not supported by cdkq, use regular `cdk deploy`.

### Issue: "Update requires replacement" Error

#### Symptoms

```
ProvisioningError: Cannot update property 'BucketName': Update requires replacement
```

#### Causes

- Attempting to change property marked "Update requires: Replacement" in CloudFormation
- Provider hasn't implemented replacement handling

#### Solutions

**1. Implement replacement handling in provider**

```typescript
async update(...): Promise<ResourceUpdateResult> {
  const requiresReplacement = this.checkReplacementRequired(
    properties,
    previousProperties
  );

  if (requiresReplacement) {
    // Create new resource
    const createResult = await this.create(logicalId, resourceType, properties);

    // Delete old resource
    await this.delete(logicalId, physicalId, resourceType);

    return {
      physicalId: createResult.physicalId,
      wasReplaced: true,
      attributes: createResult.attributes,
    };
  }

  // Normal update process
  // ...
}
```

**2. Manually delete and recreate resource**

```bash
# Manually delete
aws s3 rb s3://old-bucket-name --force

# Redeploy
node dist/cli.js deploy --app "..." --state-bucket ${STATE_BUCKET}
```

---

## Asset Publishing Issues

### Issue: "Asset publishing failed"

#### Symptoms

```
AssetPublisherError: Failed to publish asset: Access Denied
```

#### Causes

- Asset bucket (`cdk-hnb659fds-assets-*`) doesn't exist
- CDK Bootstrap has not been run
- Insufficient IAM permissions

#### Solutions

**1. Run CDK Bootstrap (required prerequisite)**

cdkq uses CDK's bootstrap bucket for asset uploads. The `cdkq bootstrap` command only creates the state management bucket — it does NOT create the asset bucket. You must run CDK bootstrap separately:

```bash
npx cdk bootstrap aws://123456789012/us-east-1
```

> **Custom bootstrap**: If you use a custom qualifier (e.g., `--qualifier myqualifier`), CDK synthesis will embed the custom bucket name in the asset manifest. cdkq reads destinations from the manifest, so custom bootstrap is fully supported.

**2. Skip asset publishing**

```bash
# Skip during deployment
node dist/cli.js deploy --app "..." --skip-assets
```

**3. Check IAM permissions**

The following permissions are required:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject"
      ],
      "Resource": "arn:aws:s3:::cdk-hnb659fds-assets-*/*"
    },
    {
      "Effect": "Allow",
      "Action": "sts:AssumeRole",
      "Resource": "arn:aws:iam::*:role/cdk-hnb659fds-file-publishing-role-*"
    }
  ]
}
```

### Issue: Lambda Deployment Fails

#### Symptoms

```
ProvisioningError: Failed to create Lambda function: InvalidParameterValueException
The provided execution role does not have permissions to call CreateFunction.
```

#### Causes

- Lambda asset (zip file) not published
- IAM Role not created

#### Solutions

**1. Verify asset publishing**

```bash
# Check asset manifest
cat cdk.out/MyStack.assets.json

# Check asset bucket
aws s3 ls s3://cdk-hnb659fds-assets-${AWS_ACCOUNT_ID}-${AWS_REGION}/
```

**2. Check IAM Role dependencies**

Lambda functions depend on IAM Role, so verify proper ordering in DAG:

```typescript
// Define Role first in CDK code
const role = new iam.Role(this, 'LambdaRole', { ... });

const func = new lambda.Function(this, 'MyFunction', {
  role: role,  // ← Dependency set
  // ...
});
```

---

## Intrinsic Function Issues

### Issue: "Unresolved intrinsic function" Error

#### Symptoms

```
Error: Cannot resolve intrinsic function: Fn::Select
```

#### Causes

CloudFormation intrinsic function not supported by cdkq is being used.

#### Support Status

| Function | Supported |
|----------|-----------|
| `Ref` | ✅ |
| `Fn::GetAtt` | ✅ |
| `Fn::Join` | ✅ |
| `Fn::Sub` | ✅ |
| `Fn::Select` | ✅ |
| `Fn::Split` | ✅ |
| `Fn::If` | ✅ |
| `Fn::Equals` | ✅ |
| `Fn::And` | ✅ |
| `Fn::Or` | ✅ |
| `Fn::Not` | ✅ |
| `Fn::ImportValue` | ✅ |
| `Fn::FindInMap` | ✅ |
| `Fn::GetAZs` | ✅ |
| `Fn::Base64` | ✅ |

#### Solutions

**1. All intrinsic functions are now supported**

All CloudFormation intrinsic functions are supported as of 2026-03-26, including `Fn::GetAZs`. If you encounter this error, ensure you are using the latest version of cdkq.

**2. Extend intrinsic function implementation**

If a new function needs support, add implementation to `src/deployment/intrinsic-function-resolver.ts`.

Example for Fn::Base64:

```typescript
if ('Fn::Base64' in obj) {
  const value = await this.resolveValue(obj['Fn::Base64'], context);
  return Buffer.from(String(value)).toString('base64');
}
```

### Issue: "AWS::AccountId not resolved"

#### Symptoms

```
Output value contains unresolved reference: ${AWS::AccountId}
```

#### Causes

Pseudo parameter not resolved.

#### Solutions

cdkq retrieves actual Account ID via STS GetCallerIdentity. Verify AWS credentials are properly configured:

```bash
# Check credentials
aws sts get-caller-identity

# Example output:
# {
#   "UserId": "AIDAI...",
#   "Account": "123456789012",
#   "Arn": "arn:aws:iam::123456789012:user/myuser"
# }
```

---

## Permission Errors

### Issue: "Access Denied" Error

#### Symptoms

```
ProvisioningError: Access Denied
User: arn:aws:iam::123456789012:user/myuser is not authorized to perform: s3:CreateBucket
```

#### Causes

IAM user/role lacks required permissions.

#### Solutions

**1. Grant required permissions**

Main permissions required by cdkq:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:*",
        "iam:*",
        "lambda:*",
        "dynamodb:*",
        "sqs:*",
        "cloudcontrol:*",
        "sts:GetCallerIdentity"
      ],
      "Resource": "*"
    }
  ]
}
```

**Note**: In production, follow the principle of least privilege and grant only necessary permissions.

**2. CloudFormation PassRole permission**

When using IAM Role with Lambda, etc.:

```json
{
  "Effect": "Allow",
  "Action": "iam:PassRole",
  "Resource": "arn:aws:iam::123456789012:role/MyLambdaRole"
}
```

### Issue: "You are not authorized to perform sts:AssumeRole"

#### Symptoms

```
Error: You are not authorized to perform sts:AssumeRole on arn:aws:iam::...:role/cdk-*
```

#### Causes

Lack of AssumeRole permission for roles created by CDK Bootstrap.

#### Solutions

**1. Check Bootstrap role trust policy**

```bash
aws iam get-role --role-name cdk-hnb659fds-deploy-role-123456789012-us-east-1
```

**2. Add your user/role to trust policy**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:user/myuser"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

---

## Performance Issues

### Issue: Deployment is Slow

#### Symptoms

- Takes 30+ seconds even for small stacks (5-10 resources)
- Expected speedup not achieved

#### Causes

- Dependencies are serialized (many DAG levels)
- Cloud Control API rate limits
- Asset publishing takes time

#### Solutions

**1. Check dependencies**

```bash
# Check execution plan with diff command
node dist/cli.js diff --app "..." --state-bucket ${STATE_BUCKET} --verbose

# Example output:
# Execution levels:
#   Level 0: [Bucket, Table] (2 resources, parallel)
#   Level 1: [Role] (1 resource)
#   Level 2: [Function] (1 resource)
```

**2. Remove unnecessary dependencies**

Reduce explicit dependencies in CDK code:

```typescript
// Bad example
const bucket = new s3.Bucket(this, 'Bucket');
const role = new iam.Role(this, 'Role', { ... });
role.node.addDependency(bucket);  // ← Unnecessary dependency

// Good example
const bucket = new s3.Bucket(this, 'Bucket');
const role = new iam.Role(this, 'Role', { ... });
// Dependencies auto-detected from Ref/GetAtt
```

**3. Parallelize asset publishing (planned for future implementation)**

```typescript
// Parallel execution in asset-publisher.ts
await Promise.all(
  assets.map(asset => publishAsset(asset))
);
```

### Issue: Cloud Control API Rate Limit

#### Symptoms

```
Error: TooManyRequestsException: Rate exceeded
```

#### Causes

Cloud Control API has the following rate limits:

- CreateResource: 5 TPS
- UpdateResource: 5 TPS
- DeleteResource: 5 TPS

#### Solutions

**1. Retry logic with exponential backoff (built-in)**

cdkq includes built-in retry logic with exponential backoff for CREATE operations (handling IAM propagation delays) and CC API polling (1s->2s->4s->8s->10s cap). If rate limit errors persist, consider reducing parallelism or staggering deployments.

**2. Use SDK Provider**

Implement provider that uses SDK directly instead of Cloud Control API.

---

## Orphaned Resources

### Overview

Orphaned resources are AWS resources that exist in your account but are not tracked in cdkq's state file. This can happen when a deployment fails partway through a DAG level — some resources in that level may have been successfully created while others failed.

### How cdkq Prevents Orphans

cdkq uses a multi-layered approach to prevent orphaned resources:

1. **Per-resource in-memory state update**: Each resource updates the in-memory state (`newResources`) immediately upon successful provisioning, even before the entire DAG level completes.

2. **Per-level partial state save**: After each DAG level completes successfully, state is persisted to S3. This prevents orphans if the process crashes between levels.

3. **Pre-rollback state save**: If any resource in a level fails, cdkq saves the current in-memory state (including all successfully provisioned resources from the failed level) to S3 **before** attempting rollback. This ensures that even resources created in the same level as the failure are tracked.

4. **Post-rollback state save**: After rollback completes (or is skipped with `--no-rollback`), state is saved again to reflect the rolled-back resource state.

### Detecting Orphaned Resources

If you suspect orphaned resources exist (e.g., due to a process crash before state could be saved), you can manually compare the state file against actual AWS resources:

```bash
# Download state file
aws s3 cp s3://${STATE_BUCKET}/stacks/MyStack/state.json /tmp/state.json

# List resources tracked in state
cat /tmp/state.json | jq '.resources | keys[]'

# Compare against actual AWS resources using Cloud Control API
aws cloudcontrol list-resources --type-name AWS::S3::Bucket
aws cloudcontrol list-resources --type-name AWS::Lambda::Function
```

### Future: `cdkq orphans` Command

A dedicated `cdkq orphans` (or `cdkq check`) command is planned to automate orphan detection. The approach:

1. **Read the state file** for the target stack to get all tracked resources and their physical IDs.
2. **Read the synthesized template** to get all expected resource types and logical IDs.
3. **Query AWS** for each resource type in the template using Cloud Control API `GetResource` with the expected physical ID pattern, or by listing resources and matching tags/naming conventions.
4. **Compare**: Resources that exist in AWS but are not in the state file are potential orphans. Resources in the state file but not in AWS indicate state drift.
5. **Report**: Display a table of orphaned/drifted resources with recommended actions (import to state, delete from AWS, or remove from state).

Example planned interface:

```bash
# Check for orphaned resources
cdkq orphans MyStack

# Example output:
# Orphaned Resources (exist in AWS but not in state):
#   AWS::IAM::Role    my-stack-role-abc123    (likely from failed deploy on 2026-03-25)
#   AWS::S3::Bucket   my-stack-bucket-xyz     (likely from failed deploy on 2026-03-25)
#
# Recommended: Run 'cdkq deploy MyStack' to reconcile, or delete manually.
```

### Recovering from Orphaned Resources

**If state was saved (most cases)**:

Running `cdkq deploy` again will reconcile the state — existing resources will be detected as already created and handled as updates or no-ops.

**If state was NOT saved (rare — process crash)**:

```bash
# Option 1: Delete state and redeploy (resources will error on CREATE if they exist)
aws s3 rm s3://${STATE_BUCKET}/stacks/MyStack/state.json
cdkq deploy MyStack  # May need manual cleanup of duplicates

# Option 2: Manually reconstruct state
aws s3 cp s3://${STATE_BUCKET}/stacks/MyStack/state.json /tmp/state.json
# Add entries for orphaned resources with their physical IDs
vim /tmp/state.json
aws s3 cp /tmp/state.json s3://${STATE_BUCKET}/stacks/MyStack/state.json

# Option 3: Destroy everything and start fresh
# Manually delete orphaned resources first, then:
cdkq destroy MyStack --force
cdkq deploy MyStack
```

---

## Debugging Methods

### Adjust Log Level

```bash
# Enable verbose logging
node dist/cli.js deploy --app "..." --verbose

# Set log level with environment variable
export LOG_LEVEL=debug
node dist/cli.js deploy --app "..."
```

### Check State File

```bash
# Download state file
aws s3 cp s3://${STATE_BUCKET}/stacks/MyStack/state.json /tmp/state.json

# Format and display
cat /tmp/state.json | jq .

# Check specific resource
cat /tmp/state.json | jq '.resources.MyBucket'
```

### Check API Calls with AWS CloudTrail

```bash
# Check recent events in CloudTrail
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=CreateBucket \
  --max-results 10
```

### Check Execution Plan with Dry Run

```bash
# Show plan only without actual execution
node dist/cli.js deploy --app "..." --state-bucket ${STATE_BUCKET} --dry-run
```

---

## Known Destroy Issues

### CloudFront OAI DELETE (Resolved)

**Previously**: CC API DELETE for CloudFront Origin Access Identity returned "Invalid request".

**Resolution**: Resolved via dedicated SDK Provider (`cloudfront-oai-provider.ts`). DELETE now works correctly.

### Bedrock AgentCore Runtime IAM Propagation (Resolved)

**Previously**: AgentCore Runtime creation failed due to IAM role propagation delays when using CC API.

**Resolution**: Resolved via dedicated SDK Provider (`agentcore-runtime-provider.ts`). All 21 integration examples now CREATE + DESTROY successfully.

### Lambda Permission "No policy found"

**Symptoms**: DELETE for Lambda Permission returns "No policy found" error.

**Resolution**: This is handled automatically by cdkq's idempotent delete logic (not-found errors treated as success).

---

## Frequently Asked Questions (FAQ)

### Q: Is a CloudFormation stack created?

A: No, cdkq does not use CloudFormation. Resources are provisioned directly via Cloud Control API and AWS SDK.

### Q: Can I use CloudFormation and cdkq for the same stack?

A: No. Stacks deployed with CloudFormation should be managed with `cdk deploy` or `aws cloudformation`, and stacks deployed with cdkq should be managed with `cdkq`.

### Q: What happens if I delete the state file?

A: On next deployment, all resources will be treated as CREATE. If existing resources exist, errors will occur, so manual deletion is required beforehand.

### Q: Is there a rollback feature?

A: Yes. By default, cdkq rolls back on failure. Use `--no-rollback` to skip rollback and keep partial state (Terraform-style). On next execution, remaining changes are applied as diff.

### Q: Are custom resources supported?

A: Yes, Lambda-backed custom resources (`Custom::*`) are supported.

---

## Support

### Issue Reporting

Report on GitHub Issues:
https://github.com/YOUR_REPO/cdkq/issues

### Questions

Ask questions on GitHub Discussions:
https://github.com/YOUR_REPO/cdkq/discussions

### Documentation

- [architecture.md](./architecture.md) - Overall architecture
- [state-management.md](./state-management.md) - State management details
- [provider-development.md](./provider-development.md) - Provider implementation methods
- [implementation-plan.md](./implementation-plan.md) - Implementation plan and roadmap
