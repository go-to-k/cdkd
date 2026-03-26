# How to Test cdkq

## Prerequisites

1. AWS Account
2. AWS CLI configured (`aws configure`)
3. Node.js 20 or higher
4. cdkq built (`npm run build`)

## 1. Create Test S3 Bucket

cdkq uses an S3 bucket for state management. You can easily create one using the `bootstrap` command:

### Method A: Using bootstrap command (Recommended)

```bash
# Set cdkq path (from cdkq root directory)
CDKQ_PATH="/Users/goto/github/cdkq"

# Bucket name must be globally unique
export STATE_BUCKET="cdkq-state-$(whoami)-$(date +%s)"
export AWS_REGION="us-east-1"  # Change to your preferred region

# Create bucket with bootstrap command
node ${CDKQ_PATH}/dist/cli.js bootstrap \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --verbose

echo "State bucket created: ${STATE_BUCKET}"
```

### Method B: Using AWS CLI (Traditional method)

```bash
# Bucket name must be globally unique
export STATE_BUCKET="cdkq-state-$(whoami)-$(date +%s)"
export AWS_REGION="us-east-1"  # Change to your preferred region

# Create S3 bucket
aws s3 mb s3://${STATE_BUCKET} --region ${AWS_REGION}

echo "State bucket created: ${STATE_BUCKET}"
```

## 2. Prepare Test CDK Application

cdkq provides multiple test examples:

### Option A: Use Existing Examples (Recommended)

The cdkq repository includes several examples:

#### Basic Example (Simple S3 Bucket)

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/basic
npm install
```

#### Intrinsic Functions Example (Testing Built-in Functions)

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/intrinsic-functions
npm install
```

#### Lambda Example (Lambda + DynamoDB + IAM) ✅ Recommended

A practical integration example with Lambda functions and DynamoDB tables:

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/lambda
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
cd /Users/goto/github/cdkq/tests/integration/examples/multi-resource
npm install
```

#### Parameters Example (CloudFormation Parameters) ✅ Implemented

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/parameters
npm install
```

**Tested features**:

- Parameter default values
- Type coercion (String, Number, List)
- Parameter usage in resource properties

#### Conditions Example (CloudFormation Conditions) ✅ Implemented

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/conditions
npm install
```

**Tested features**:

- Condition evaluation (Fn::And, Fn::Or, Fn::Not, Fn::Equals)
- Conditional resource creation
- AWS::NoValue pseudo parameter

#### Cross-Stack References Example (Fn::ImportValue) ✅ Implemented

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/cross-stack-references
npm install
```

**Tested features**:

- Stack outputs with Export
- Fn::ImportValue for cross-stack references
- S3 state backend for sharing exports between stacks

#### ECR Example (Docker Image Lambda with ECR)

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/ecr
npm install
```

**Tested features**:

- Docker image Lambda functions
- ECR asset publishing

#### API Gateway Example (REST API + Lambda)

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/apigateway
npm install
```

**Tested features**:

- REST API with API Gateway
- Lambda integration

#### ECS Fargate Example

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/ecs-fargate
npm install
```

#### EventBridge Example

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/eventbridge
npm install
```

#### SNS + SQS Event Example

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/sns-sqs-event
npm install
```

#### DynamoDB Streams Example

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/dynamodb-streams
npm install
```

#### Step Functions Example

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/stepfunctions
npm install
```

#### EC2 VPC Example

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/ec2-vpc
npm install
```

#### S3 + CloudFront Example

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/s3-cloudfront
npm install
```

#### CloudWatch Example

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/cloudwatch
npm install
```

#### RDS Aurora Example

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/rds-aurora
npm install
```

#### Bedrock Agent Example

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/bedrock-agent
npm install
```

#### CloudFront + Lambda Function URL Example

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/cloudfront-function-url
npm install
```

**Tested features**:

- CloudFront distribution with Lambda Function URL origin
- Lambda FunctionUrl attribute enrichment (GetFunctionUrlConfig API)
- 6 resources: CREATE + DESTROY verified

#### CDK Provider Framework Example (isCompleteHandler/onEventHandler)

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/custom-resource-provider
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
directory="/tmp/cdkq-test"
mkdir -p ${directory}
cd ${directory}

# Initialize CDK project
npx aws-cdk@latest init app --language typescript

# Change to a simple stack
cat > lib/cdkq-test-stack.ts <<'EOF'
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

export class CdkqTestStack extends cdk.Stack {
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

## 3. Deploy Using cdkq

```bash
# Set cdkq path (from cdkq root directory)
CDKQ_PATH="/Users/goto/github/cdkq"

# First, check changes with diff
# --app and --state-bucket can be omitted if set via env vars or cdk.json
node ${CDKQ_PATH}/dist/cli.js diff \
  --app "npx ts-node --prefer-ts-exts bin/cdkq-test.ts" \
  --output cdk.out \
  --state-bucket ${STATE_BUCKET} \
  --state-prefix "stacks" \
  --region ${AWS_REGION} \
  --verbose

# Execute deployment (first time will create all resources)
# Stack name is a positional argument (auto-detected if single stack)
node ${CDKQ_PATH}/dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/cdkq-test.ts" \
  --output cdk.out \
  --state-bucket ${STATE_BUCKET} \
  --state-prefix "stacks" \
  --region ${AWS_REGION} \
  --verbose
```

## 4. Verify Deployment Results

```bash
# Check if bucket was created via AWS Console or CLI
aws s3 ls | grep cdkq-test-bucket

# Check state files
aws s3 ls s3://${STATE_BUCKET}/stacks/ --recursive
```

## 5. Test UPDATE Operations (JSON Patch)

cdkq supports resource updates via Cloud Control API JSON Patch (RFC 6902). Test UPDATE operations to verify changes are applied without recreating resources:

### Method A: Using the basic example with environment variable

```bash
cd /Users/goto/github/cdkq/tests/integration/examples/basic

# First deployment (CREATE)
# Stack name is positional; auto-detected if single stack
node ../../../../dist/cli.js deploy CdkqBasicExample \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION}

# Second deployment with UPDATE test tag (UPDATE)
CDKQ_TEST_UPDATE=true node ../../../../dist/cli.js deploy CdkqBasicExample \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION}

# Verify the output shows UPDATE operations:
# Expected: "Changes: +0 ~1 -0" (1 resource updated)
```

The `CDKQ_TEST_UPDATE=true` environment variable adds an additional tag to the S3 bucket without modifying the code. This allows testing UPDATE operations repeatedly.

### Method B: Manual code changes

Alternatively, modify the stack code directly and re-deploy to test updates.

## 6. Test CloudFormation Intrinsic Functions

cdkq supports CloudFormation intrinsic functions (Ref, Fn::GetAtt, Fn::Join, Fn::Sub).
Verify that resources using these functions can be deployed:

```bash
# Change to a stack using intrinsic functions
cat > lib/cdkq-test-stack.ts <<'EOF'
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

export class CdkqTestStack extends cdk.Stack {
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
      description: 'Test role for cdkq',
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
node ${CDKQ_PATH}/dist/cli.js diff \
  --app "npx ts-node --prefer-ts-exts bin/cdkq-test.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --verbose

# Deploy updates
node ${CDKQ_PATH}/dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/cdkq-test.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --verbose
```

## 6. Test Dry Run

Display execution plan only without making actual changes:

```bash
node ${CDKQ_PATH}/dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/cdkq-test.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --dry-run \
  --verbose
```

## 7. Delete Stack

```bash
# Delete resources with destroy command (stack name is positional)
node ${CDKQ_PATH}/dist/cli.js destroy CdkqTestStack \
  --app "npx ts-node --prefer-ts-exts bin/cdkq-test.ts" \
  --state-bucket ${STATE_BUCKET} \
  --state-prefix "stacks" \
  --region ${AWS_REGION} \
  --verbose

# To skip confirmation prompt
node ${CDKQ_PATH}/dist/cli.js destroy CdkqTestStack \
  --app "npx ts-node --prefer-ts-exts bin/cdkq-test.ts" \
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
node ${CDKQ_PATH}/dist/cli.js deploy \
  --app "..." \
  --state-bucket ${STATE_BUCKET} \
  --skip-assets
```

### Resource Type Support

**cdkq automatically supports all resource types supported by Cloud Control API (over 200 types).**

For resources not supported by Cloud Control API, you can implement SDK providers. cdkq currently includes 34 SDK provider resource types (see `src/provisioning/providers/` for the full list). Key providers include IAM Role/Policy, S3 Bucket/BucketPolicy, Lambda Function/Permission/Url/EventSourceMapping, DynamoDB Table, SQS Queue/QueuePolicy, SNS Topic/Subscription, EC2 VPC/Subnet/SecurityGroup and related networking resources, API Gateway, EventBridge, CloudWatch, Logs, SecretsManager, SSM, CloudFront OAI, and Custom::* resources.

If you use other resources not supported by Cloud Control API, an error message will be displayed.

### Verbose Logging

Add the `--verbose` flag to display detailed logs:

```bash
node ${CDKQ_PATH}/dist/cli.js deploy ... --verbose
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
