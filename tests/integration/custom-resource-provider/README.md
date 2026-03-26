# Custom Resource Provider (isCompleteHandler) Example

This example demonstrates the CDK Provider framework with the async custom resource pattern using `isCompleteHandler`.

## What it tests

- **CDK Provider framework**: Uses `aws-cdk-lib/custom-resources.Provider` with both `onEventHandler` and `isCompleteHandler`
- **Step Functions orchestration**: The Provider construct creates a Step Functions state machine to orchestrate the async polling
- **S3 pre-signed URL for cfn-response**: Long-lived (2 hour expiry) pre-signed URLs for the async callback
- **Async pattern detection**: cdkd detects `IsComplete: false` and polls via the isComplete handler
- **Long polling timeout**: Tests that cdkd properly waits for the async operation to complete

## Architecture

```
CustomResource
    |
    v
Provider (Step Functions State Machine)
    |
    +--> onEventHandler (Lambda)
    |       Returns { IsComplete: false } for Create/Update
    |       Returns { IsComplete: true } for Delete
    |
    +--> isCompleteHandler (Lambda)
            Returns { IsComplete: true, Data: { Result: "..." } }
```

## Deploy

```bash
cdkd deploy CustomResourceProviderStack
```

## Destroy

```bash
cdkd destroy CustomResourceProviderStack
```
