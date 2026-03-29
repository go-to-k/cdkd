# Step Functions Example

A practical example that includes a Step Functions state machine with a Lambda function.

## Configuration

This stack includes the following resources:

- **Lambda Function**: Inline Python function that processes input and returns a success/failure flag
- **Step Functions State Machine**: Orchestrates the Lambda invocation with branching logic
- **IAM Roles**: Auto-created execution roles for both Lambda and Step Functions

## State Machine Flow

```
Start → InvokeProcessor (Lambda) → WaitOneSecond (1s) → CheckResult (Choice)
                                                            ├── success=true  → ProcessingSucceeded
                                                            └── otherwise     → ProcessingFailed
```

## Features Tested in cdkd

1. **Inline Lambda Code**: Lambda function with `Code.fromInline()` (no asset publishing needed)
2. **Step Functions State Machine**: State machine creation via Cloud Control API
3. **Multiple State Types**: LambdaInvoke task, Wait, Choice, Succeed, Fail
4. **Auto-generated IAM Roles**: CDK auto-creates IAM roles for Lambda and Step Functions
5. **Resource Dependencies**: StateMachine → Lambda → IAM Role dependency chain
6. **Fn::GetAtt**: Retrieve StateMachine ARN and Lambda function name in outputs

## Deploy

```bash
# Install packages
npm install

# Deploy with cdkd
node ../../../dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket <your-state-bucket> \
  --region us-east-1 \
  --verbose
```

## Test Points

- [ ] Lambda function is created with inline code
- [ ] IAM roles are created for both Lambda and Step Functions
- [ ] State machine is created with the correct definition
- [ ] State machine definition includes all state types (Task, Wait, Choice, Succeed, Fail)
- [ ] Lambda invoke permissions are granted to the state machine role
- [ ] Outputs are correctly resolved (state machine ARN, function name)

## Clean up

```bash
node ../../../dist/cli.js destroy \
  --state-bucket <your-state-bucket> \
  --stack StepFunctionsStack \
  --region us-east-1 \
  --force
```
