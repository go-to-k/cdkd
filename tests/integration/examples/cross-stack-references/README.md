# Cross-Stack References Example

This example demonstrates cross-stack references using `Fn::ImportValue` with cdkd.

## Architecture

This example consists of two stacks:

1. **ExporterStack** - Creates resources and exports their values
   - Creates an S3 bucket
   - Exports the bucket name and ARN using `CfnOutput` with `exportName`

2. **ConsumerStack** - Imports and uses the exported values
   - Uses `Fn::ImportValue` to import bucket name and ARN
   - Demonstrates that cross-stack references work correctly

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
  --app "npx ts-node tests/integration/examples/cross-stack-references/bin/app.ts" \
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
  --app "npx ts-node tests/integration/examples/cross-stack-references/bin/app.ts" \
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
   - Outputs show the imported values

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

cdkd implements `Fn::ImportValue` by:

1. **Export**: When a stack has `CfnOutput` with `exportName`, cdkd saves the resolved value in the state file under `exports`:
   ```json
   {
     "exports": {
       "SharedBucketName": "actual-bucket-name-xyz"
     }
   }
   ```

2. **Import**: When another stack uses `Fn::ImportValue`, cdkd:
   - Queries all stacks in the state bucket
   - Finds the export with matching name
   - Resolves the imported value during template processing

This allows cross-stack references to work without CloudFormation stacks!
