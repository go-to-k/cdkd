# How to Test cdkd

## Prerequisites

1. AWS Account
2. AWS CLI configured (`aws configure`)
3. Node.js 20 or higher
4. cdkd built (`npm run build`)

## 1. Create Test S3 Bucket

cdkd uses an S3 bucket for state management. You can easily create one using the `bootstrap` command:

### Method A: Using bootstrap command (Recommended)

```bash
# Set cdkd path (from cdkd root directory)
CDKD_PATH="/Users/goto/github/cdkd"

# Bucket name must be globally unique
export STATE_BUCKET="cdkd-state-$(whoami)-$(date +%s)"
export AWS_REGION="us-east-1"  # Change to your preferred region

# Create bucket with bootstrap command
node ${CDKD_PATH}/dist/cli.js bootstrap \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --verbose

echo "State bucket created: ${STATE_BUCKET}"
```

### Method B: Using AWS CLI (Traditional method)

```bash
# Bucket name must be globally unique
export STATE_BUCKET="cdkd-state-$(whoami)-$(date +%s)"
export AWS_REGION="us-east-1"  # Change to your preferred region

# Create S3 bucket
aws s3 mb s3://${STATE_BUCKET} --region ${AWS_REGION}

echo "State bucket created: ${STATE_BUCKET}"
```

## 2. Prepare Test CDK Application

cdkd provides multiple test examples:

### Option A: Use Existing Examples (Recommended)

The cdkd repository includes several examples:

#### Basic Example (Simple S3 Bucket)

```bash
cd /Users/goto/github/cdkd/tests/integration/basic
npm install
```

#### Intrinsic Functions Example (Testing Built-in Functions)

```bash
cd /Users/goto/github/cdkd/tests/integration/intrinsic-functions
npm install
```

#### Lambda Example (Lambda + DynamoDB + IAM) ✅ Recommended

A practical integration example with Lambda functions and DynamoDB tables:

```bash
cd /Users/goto/github/cdkd/tests/integration/lambda
npm install
```

**Tested features**:

- Lambda asset publishing (code upload to S3)
- ARN resolution via Fn::GetAtt
- Ref resolution in environment variables
- Automatic IAM Role/Policy creation

#### Multi-Resource Example (Complex example)

Event-driven architecture with S3 + Lambda + DynamoDB + SQS + IAM:

```bash
cd /Users/goto/github/cdkd/tests/integration/multi-resource
npm install
```

#### Parameters Example (CloudFormation Parameters) ✅ Implemented

```bash
cd /Users/goto/github/cdkd/tests/integration/parameters
npm install
```

**Tested features**:

- Parameter default values
- Type coercion (String, Number, List)
- Parameter usage in resource properties

#### Conditions Example (CloudFormation Conditions) ✅ Implemented

```bash
cd /Users/goto/github/cdkd/tests/integration/conditions
npm install
```

**Tested features**:

- Condition evaluation (Fn::And, Fn::Or, Fn::Not, Fn::Equals)
- Conditional resource creation
- AWS::NoValue pseudo parameter

#### Cross-Stack References Example (Fn::ImportValue) ✅ Implemented

```bash
cd /Users/goto/github/cdkd/tests/integration/cross-stack-references
npm install
```

**Tested features**:

- Stack outputs with Export
- Fn::ImportValue for cross-stack references
- S3 state backend for sharing exports between stacks

#### ECR Example (Docker Image Lambda with ECR)

```bash
cd /Users/goto/github/cdkd/tests/integration/ecr
npm install
```

**Tested features**:

- Docker image Lambda functions
- ECR asset publishing

#### API Gateway Example (REST API + Lambda)

```bash
cd /Users/goto/github/cdkd/tests/integration/apigateway
npm install
```

**Tested features**:

- REST API with API Gateway
- Lambda integration

#### ECS Fargate Example

```bash
cd /Users/goto/github/cdkd/tests/integration/ecs-fargate
npm install
```

#### EventBridge Example

```bash
cd /Users/goto/github/cdkd/tests/integration/eventbridge
npm install
```

#### SNS + SQS Event Example

```bash
cd /Users/goto/github/cdkd/tests/integration/sns-sqs-event
npm install
```

#### DynamoDB Streams Example

```bash
cd /Users/goto/github/cdkd/tests/integration/dynamodb-streams
npm install
```

#### Step Functions Example

```bash
cd /Users/goto/github/cdkd/tests/integration/stepfunctions
npm install
```

#### EC2 VPC Example

```bash
cd /Users/goto/github/cdkd/tests/integration/ec2-vpc
npm install
```

#### S3 + CloudFront Example

```bash
cd /Users/goto/github/cdkd/tests/integration/s3-cloudfront
npm install
```

#### CloudWatch Example

```bash
cd /Users/goto/github/cdkd/tests/integration/cloudwatch
npm install
```

#### RDS Aurora Example

```bash
cd /Users/goto/github/cdkd/tests/integration/rds-aurora
npm install
```

#### Bedrock AgentCore Example

```bash
cd /Users/goto/github/cdkd/tests/integration/bedrock-agentcore
npm install
```

#### CloudFront + Lambda Function URL Example

```bash
cd /Users/goto/github/cdkd/tests/integration/cloudfront-function-url
npm install
```

**Tested features**:

- CloudFront distribution with Lambda Function URL origin
- Lambda FunctionUrl attribute enrichment (GetFunctionUrlConfig API)
- 6 resources: CREATE + DESTROY verified

#### VPC Lookup Example (Context Provider Loop)

```bash
cd /Users/goto/github/cdkd/tests/integration/vpc-lookup
npm install
```

**Tested features**:

- Context provider loop (missing context → SDK resolution → cdk.context.json save → re-synthesis)
- `Vpc.fromLookup()` triggers VPC context provider
- Verifies `cdk.context.json` is generated with resolved VPC info
- Deploy uses the resolved VPC ID in SSM Parameter

```bash
# Synth (generates cdk.context.json on first run)
node ../../../dist/cli.js synth --region us-east-1

# Verify cdk.context.json was created
cat cdk.context.json

# Deploy
node ../../../dist/cli.js deploy --region us-east-1 --state-bucket <your-state-bucket>

# Destroy
node ../../../dist/cli.js destroy --region us-east-1 --state-bucket <your-state-bucket> --force
```

#### CDK Provider Framework Example (isCompleteHandler/onEventHandler)

```bash
cd /Users/goto/github/cdkd/tests/integration/custom-resource-provider
npm install
```

**Tested features**:

- CDK Provider framework with isCompleteHandler/onEventHandler
- Async pattern detection and polling
- Pre-signed URL for cfn-response (2hr validity)

For details on each example, refer to the README.md in each directory.

### Option B: Create a New CDK Application

You can also create and test a simple CDK application:

```bash
# Create test directory
directory="/tmp/cdkd-test"
mkdir -p ${directory}
cd ${directory}

# Initialize CDK project
npx aws-cdk@latest init app --language typescript

# Change to a simple stack
cat > lib/cdkd-test-stack.ts <<'EOF'
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

export class CdkdTestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create a simple S3 bucket
    const bucket = new s3.Bucket(this, 'TestBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false, // Custom::S3AutoDeleteObjects is not supported
    });

    // Output bucket name to verify (supports CloudFormation intrinsic functions)
    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'Name of the test bucket',
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: bucket.bucketArn,
      description: 'ARN of the test bucket',
    });
  }
}
EOF

# Build
npm run build
```

## 3. Deploy Using cdkd

```bash
# Set cdkd path (from cdkd root directory)
CDKD_PATH="/Users/goto/github/cdkd"

# First, check changes with diff
# --app and --state-bucket can be omitted if set via env vars or cdk.json
node ${CDKD_PATH}/dist/cli.js diff \
  --app "npx ts-node --prefer-ts-exts bin/cdkd-test.ts" \
  --output cdk.out \
  --state-bucket ${STATE_BUCKET} \
  --state-prefix "stacks" \
  --region ${AWS_REGION} \
  --verbose

# Execute deployment (first time will create all resources)
# Stack name is a positional argument (auto-detected if single stack)
node ${CDKD_PATH}/dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/cdkd-test.ts" \
  --output cdk.out \
  --state-bucket ${STATE_BUCKET} \
  --state-prefix "stacks" \
  --region ${AWS_REGION} \
  --verbose
```

## 4. Verify Deployment Results

```bash
# Check if bucket was created via AWS Console or CLI
aws s3 ls | grep cdkd-test-bucket

# Check state files
aws s3 ls s3://${STATE_BUCKET}/cdkd/ --recursive
```

## 5. Test UPDATE Operations (JSON Patch)

cdkd supports resource updates via Cloud Control API JSON Patch (RFC 6902). Test UPDATE operations to verify changes are applied without recreating resources:

### Method A: Using the basic example with environment variable

```bash
cd /Users/goto/github/cdkd/tests/integration/basic

# First deployment (CREATE)
# Stack name is positional; auto-detected if single stack
node ../../../../dist/cli.js deploy CdkdBasicExample \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION}

# Second deployment with UPDATE test tag (UPDATE)
CDKD_TEST_UPDATE=true node ../../../../dist/cli.js deploy CdkdBasicExample \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION}

# Verify the output shows UPDATE operations:
# Expected: "Changes: +0 ~1 -0" (1 resource updated)
```

The `CDKD_TEST_UPDATE=true` environment variable adds an additional tag to the S3 bucket without modifying the code. This allows testing UPDATE operations repeatedly.

### Failure injection (CDKD_TEST_FAIL)

To verify rollback against real AWS, the `basic` stack supports a third toggle:

```bash
# Deploy with a deliberately-failing SQS Queue injected.
# The good resources (S3 bucket, SSM Document) succeed in parallel;
# the SQS Queue's invalid MessageRetentionPeriod is rejected by AWS,
# triggering rollback that deletes the already-completed siblings.
CDKD_TEST_FAIL=true node ../../../../dist/cli.js deploy CdkdBasicExample \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION}

# Expected: deploy fails with rollback log, and `aws s3 ls
# s3://${STATE_BUCKET}/cdkd/` shows no leftover state.
```

Use this to sanity-check the dispatcher's rollback path against AWS without writing a separate failing CDK app each time.

### Method B: Manual code changes

Alternatively, modify the stack code directly and re-deploy to test updates.

## 6. Test CloudFormation Intrinsic Functions

cdkd supports CloudFormation intrinsic functions (Ref, Fn::GetAtt, Fn::Join, Fn::Sub).
Verify that resources using these functions can be deployed:

```bash
# Change to a stack using intrinsic functions
cat > lib/cdkd-test-stack.ts <<'EOF'
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

export class CdkdTestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create S3 bucket
    const bucket = new s3.Bucket(this, 'TestBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    // Create IAM role (using Ref to reference bucket)
    const role = new iam.Role(this, 'TestRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Test role for cdkd',
    });

    // Grant read permissions to bucket (using Fn::GetAtt)
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
      })
    );

    // Test intrinsic functions with Outputs
    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'Bucket name (Ref)',
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: bucket.bucketArn,
      description: 'Bucket ARN (Fn::GetAtt)',
    });

    new cdk.CfnOutput(this, 'RoleArn', {
      value: role.roleArn,
      description: 'Role ARN (Fn::GetAtt)',
    });
  }
}
EOF

npm run build

# Check changes with diff
node ${CDKD_PATH}/dist/cli.js diff \
  --app "npx ts-node --prefer-ts-exts bin/cdkd-test.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --verbose

# Deploy updates
node ${CDKD_PATH}/dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/cdkd-test.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --verbose
```

## 6. Test Dry Run

Display execution plan only without making actual changes:

```bash
node ${CDKD_PATH}/dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/cdkd-test.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --dry-run \
  --verbose
```

## 7. Delete Stack

```bash
# Delete resources with destroy command (stack name is positional)
node ${CDKD_PATH}/dist/cli.js destroy CdkdTestStack \
  --app "npx ts-node --prefer-ts-exts bin/cdkd-test.ts" \
  --state-bucket ${STATE_BUCKET} \
  --state-prefix "stacks" \
  --region ${AWS_REGION} \
  --verbose

# To skip confirmation prompt
node ${CDKD_PATH}/dist/cli.js destroy CdkdTestStack \
  --app "npx ts-node --prefer-ts-exts bin/cdkd-test.ts" \
  --state-bucket ${STATE_BUCKET} \
  --state-prefix "stacks" \
  --region ${AWS_REGION} \
  --force
```

## 8. Cleanup

After testing, delete the state bucket as well:

```bash
# Delete objects in bucket
aws s3 rm s3://${STATE_BUCKET} --recursive

# Delete bucket itself
aws s3 rb s3://${STATE_BUCKET}
```

## Troubleshooting

### Asset Publishing Errors

If your CDK application uses assets (such as Lambda function code), asset publishing may fail:

```bash
# Skip asset publishing
node ${CDKD_PATH}/dist/cli.js deploy \
  --app "..." \
  --state-bucket ${STATE_BUCKET} \
  --skip-assets
```

### Resource Type Support

**cdkd automatically supports all resource types supported by Cloud Control API.**

For resources not supported by Cloud Control API, you can implement SDK providers. cdkd includes SDK provider resource types for common services (see `src/provisioning/providers/` for the full list). Key providers include IAM Role/Policy, S3 Bucket/BucketPolicy, Lambda Function/Permission/Url/EventSourceMapping, DynamoDB Table, SQS Queue/QueuePolicy, SNS Topic/Subscription, EC2 VPC/Subnet/SecurityGroup and related networking resources, API Gateway, EventBridge, CloudWatch, Logs, SecretsManager, SSM, CloudFront OAI, and Custom::* resources.

If you use other resources not supported by Cloud Control API, an error message will be displayed.

### Verbose Logging

Add the `--verbose` flag to display detailed logs:

```bash
node ${CDKD_PATH}/dist/cli.js deploy ... --verbose
```

## Known Issues and Limitations

1. **Cloud Control API Update Processing**: The current implementation performs differential updates using JSON Patch, but complete updates may fail for some resources.

2. **CloudFormation Intrinsic Functions**: All intrinsic functions are now supported.

3. **Pseudo Parameters**: All pseudo parameters are supported:
   - ✅ `AWS::AccountId` - Retrieves actual value from STS GetCallerIdentity
   - ✅ `AWS::Region` - Uses configured region
   - ✅ `AWS::Partition` - Default "aws"
   - ✅ `AWS::StackName` - From stack configuration
   - ✅ `AWS::StackId` - Generated unique identifier
   - ✅ `AWS::URLSuffix` - "amazonaws.com"
   - ✅ `AWS::NoValue` - For conditional property omission
