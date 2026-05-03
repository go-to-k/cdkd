# Cross-Stack References Example

This example demonstrates two cross-stack reference mechanisms with cdkd:

- `Fn::ImportValue` — references a `CfnOutput` by `Export.Name`
- `Fn::GetStackOutput` — references a `CfnOutput` by its **logical id**, no Export required (CloudFormation's newer intrinsic; cdkd resolves it from the producer's S3 state record)

## Architecture

This example consists of two stacks:

1. **ExporterStack** - Creates resources and exports their values
   - Creates an S3 bucket
   - Exports the bucket name and ARN using `CfnOutput` with `exportName`

2. **ConsumerStack** - Imports and uses the exported values
   - Uses `Fn::ImportValue` to import bucket name and ARN by `Export.Name`
   - Uses `Fn::GetStackOutput` (injected via `addPropertyOverride` to stay compatible with older `aws-cdk-lib`) to read the same bucket name back by **the producer output's logical id** — no Export needed for this path

## Setup

Install dependencies:

```bash
npm install
```

## Deployment

### Step 1: Deploy the Exporter Stack

First, deploy the exporter stack that creates resources and exports values:

```bash
cd /Users/goto/github/cdkd
export STATE_BUCKET="your-state-bucket"
export AWS_REGION="us-east-1"

# Deploy exporter stack
node dist/cli.js deploy \
  --app "npx ts-node tests/integration/cross-stack-references/bin/app.ts" \
  --stack CdkdExporterStack \
  --state-bucket $STATE_BUCKET \
  --region $AWS_REGION \
  --verbose
```

### Step 2: Deploy the Consumer Stack

After the exporter stack is deployed, deploy the consumer stack that imports the values:

```bash
# Deploy consumer stack
node dist/cli.js deploy \
  --app "npx ts-node tests/integration/cross-stack-references/bin/app.ts" \
  --stack CdkdConsumerStack \
  --state-bucket $STATE_BUCKET \
  --region $AWS_REGION \
  --verbose
```

## What to Expect

1. **Exporter Stack Deployment**:
   - Creates an S3 bucket
   - Saves exported values to state file (`s3://<bucket>/stacks/CdkdExporterStack/state.json`)
   - Outputs include `BucketNameExport` and `BucketArnExport`

2. **Consumer Stack Deployment**:
   - Reads exported values from exporter stack's state file
   - Resolves `Fn::ImportValue('SharedBucketName')` to actual bucket name
   - Resolves `Fn::ImportValue('SharedBucketArn')` to actual bucket ARN
   - Resolves `Fn::GetStackOutput { StackName: "CdkdExporterStack", OutputName: "BucketNameExport" }` to the same bucket name and stores it in an SSM Parameter (proves Fn::GetStackOutput works for in-resource property values, not just Outputs)
   - Outputs show both the imported values and the SSM Parameter name

## Cleanup

Delete stacks in reverse order (consumer first, then exporter):

```bash
# Delete consumer stack
node dist/cli.js destroy \
  --stack CdkdConsumerStack \
  --state-bucket $STATE_BUCKET \
  --region $AWS_REGION \
  --force

# Delete exporter stack
node dist/cli.js destroy \
  --stack CdkdExporterStack \
  --state-bucket $STATE_BUCKET \
  --region $AWS_REGION \
  --force
```

## How It Works

cdkd implements both intrinsics on top of its S3 state:

- `Fn::ImportValue` searches every stack's `outputs` for a key matching the requested `Export.Name`. The export name is stored alongside the output's logical id when `Export.Name` is set on a `CfnOutput`.
- `Fn::GetStackOutput` reads the producer's state record directly at `s3://<bucket>/cdkd/<StackName>/<Region>/state.json` and returns `outputs[<OutputName>]` — `OutputName` is the **logical id** of the producer's `CfnOutput`. No `Export.Name` required, and `Region` may differ from the consumer's deploy region (same-account cross-region works because cdkd's state bucket is account-scoped, not region-scoped). Cross-account `RoleArn` is currently rejected with a clear error.

This allows cross-stack and cross-region references to work without CloudFormation stacks!
