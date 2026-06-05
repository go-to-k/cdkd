import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Runtime, AgentRuntimeArtifact } from 'aws-cdk-lib/aws-bedrockagentcore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for the `cdkd local start-agentcore` integ test.
 *
 * One HTTP-protocol AgentCore `Runtime` whose container (built from the local
 * `agent/` Dockerfile) serves GET /ping + the bidirectional /ws WebSocket on
 * 8080. The /ws handler echoes the first frame, and when that frame carries
 * `{"loop": true}` it enters a REPL mode that echoes each subsequent frame as
 * `loop-echo:<text>` until the client closes.
 *
 * No AWS deploy required. The integ exercises the local-build serve path:
 * `cdkd local start-agentcore` builds the asset, boots the container, waits for
 * /ping, and runs the host WebSocket bridge that injects the session-id on the
 * container /ws upgrade — so a header-less client (the browser path) can hold
 * an interactive multi-frame session.
 */
export class LocalStartAgentCoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new Runtime(this, 'EchoAgent', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(__dirname, '../agent'), {
        platform: Platform.LINUX_ARM64,
      }),
      environmentVariables: { GREETING: 'hello-from-agent' },
    });
  }
}
