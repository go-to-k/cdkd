import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import {
  AgentCoreRuntime,
  AgentRuntimeArtifact,
  Runtime,
} from 'aws-cdk-lib/aws-bedrockagentcore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The runtime's name: verify.sh finds it by this, with no state. */
export const RUNTIME_NAME = 'cdkdNoWaitEndpointRuntime';
/** The endpoint's name. */
export const ENDPOINT_NAME = 'live';

/**
 * go-to-k/cdkd#6962 (rule 3 of #6940): AWS refuses
 * `CreateAgentRuntimeEndpoint` while the runtime is `CREATING`
 * (`ConflictException: Agent version 1 must be in READY status. Current
 * status: CREATING.`, measured). Under `cdkd deploy --no-wait` the runtime's
 * create returns while it is `CREATING`, so its endpoint must wait for the
 * runtime's skipped `READY` wait first. Before #6962 the endpoint's create
 * reached AWS at once and the deploy failed with that refusal.
 *
 * A CodeConfiguration (managed Python) runtime: no container image to build.
 * `CDKD_TEST_UPDATE=true` changes its environment, so the update mints a new
 * version and the endpoint is updated to it (the same refusal applies).
 *
 * covers: AWS::BedrockAgentCore::Runtime
 * covers: AWS::BedrockAgentCore::RuntimeEndpoint
 */
export class NoWaitAgentcoreRuntimeEndpointStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const runtime = new Runtime(this, 'Runtime', {
      runtimeName: RUNTIME_NAME,
      agentRuntimeArtifact: AgentRuntimeArtifact.fromCodeAsset({
        path: path.join(__dirname, '../code-agent'),
        runtime: AgentCoreRuntime.PYTHON_3_12,
        entrypoint: ['app.py'],
      }),
      // CDKD_TEST_UPDATE changes the runtime, so its update mints a new version.
      environmentVariables: { PHASE: process.env.CDKD_TEST_UPDATE === 'true' ? '2' : '1' },
    });
    const endpoint = runtime.addEndpoint(ENDPOINT_NAME);

    new cdk.CfnOutput(this, 'RuntimeId', { value: runtime.agentRuntimeId });
    new cdk.CfnOutput(this, 'EndpointName', { value: endpoint.endpointName });
  }
}
