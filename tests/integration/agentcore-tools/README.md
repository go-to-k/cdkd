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
  A second, LLM-as-a-judge evaluator carries a multi-dimensional rating scale
  (issue #5432): two dimensions on create, a third added by the Phase 2 update.
  Creating it names a Bedrock model but does not invoke one.

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
3. **Phase 3 (REMOVAL, `CDKD_TEST_REMOVAL=true`)** — `Description` is removed
   from the template and Level goes back to `TRACE` (issue #1160). A
   CloudFormation A/B kept a removed Evaluator `Description`, so the live one
   must survive, in place; the Level change proves the redeploy reached
   `UpdateEvaluator`.

   Across Phases 1-2 the judge evaluator's `RatingScale.MultiDimensional` must
   read back as `accuracy tone`, then `accuracy tone brevity`, same evaluator
   id. Before the `@aws-sdk/client-bedrock-agentcore-control` 3.1157.0 bump
   cdkd's client dropped the member and AWS refused the create's empty
   `RatingScale` (RED on Phase 1, named as #5432 by `verify.sh`).
   The read goes through the repo's own SDK client, not the AWS CLI (an older
   CLI drops the member too).
4. **Phase 4 (destroy)** — the evaluator is deleted; the AWS-managed default
   browser / code interpreter still exist (`READY`) — the adopt-only providers'
   no-op delete must never touch them; the cdkd state file is removed.

## Run

```bash
/run-integ agentcore-tools
```

## Prerequisites

- Bedrock AgentCore must be available in the target region (`us-east-1` is).
