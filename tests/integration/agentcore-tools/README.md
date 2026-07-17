# agentcore-tools

Bedrock AgentCore tool-side resources via cdkd's SDK Providers
(issues #1038 / #1039 / #1058):

- `AWS::BedrockAgentCore::Browser` — adopt-only singleton for the AWS-managed
  default browser (`aws.browser.v1`). The CFn registry declares the type
  read-only (`NON_PROVISIONABLE`, read/list handlers only), so cdkd adopts the
  default instead of creating anything; destroy is a no-op that must NOT touch
  the AWS-owned resource.
- `AWS::BedrockAgentCore::CodeInterpreter` — adopt-only singleton for the
  AWS-managed default code interpreter (`aws.codeinterpreter.v1`), same
  semantics.
- `AWS::BedrockAgentCore::Evaluator` — a custom code-based evaluator backed by
  a fixture Lambda (`CreateEvaluator` / `UpdateEvaluator` / `DeleteEvaluator`).

The Browser / CodeInterpreter types have no L1 constructs in aws-cdk-lib (CDK
ships only the `*Custom` variants) and `CfnEvaluator` predates the `CodeBased`
config member, so all three are raw `cdk.CfnResource`s — which also exercises
cdkd's raw-CFn template path.

## What it verifies

1. **Phase 1 (deploy)** — the default browser / code interpreter are adopted
   (stack outputs surface their ARNs/ids via `Fn::GetAtt`), and the evaluator
   is created at `TRACE` level with a `cdkd-integ` tag.
2. **Phase 2 (UPDATE, `CDKD_TEST_UPDATE=true`)** — Description / Level
   (`TRACE` -> `SESSION`) / an added tag are applied via an in-place
   `UpdateEvaluator` + `TagResource`; the evaluator id must NOT change
   (`EvaluatorName` is the only createOnly property and stays fixed).
3. **Phase 3 (destroy)** — the evaluator is deleted; the AWS-managed default
   browser / code interpreter still exist (`READY`) — the adopt-only providers'
   no-op delete must never touch them; the cdkd state file is removed.

## Run

```bash
/run-integ agentcore-tools
```

## Prerequisites

- Bedrock AgentCore must be available in the target region (`us-east-1` is).
