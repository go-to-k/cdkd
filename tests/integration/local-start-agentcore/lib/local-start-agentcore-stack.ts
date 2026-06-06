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
 * `agent/` Dockerfile) serves GET /ping + POST /invocations + the bidirectional
 * /ws WebSocket on 8080. /invocations echoes the request body + the received
 * session-id / Authorization / GREETING; the /ws handler echoes the first frame,
 * and when that frame carries `{"loop": true}` it enters a REPL mode that echoes
 * each subsequent frame as `loop-echo:<text>` until the client closes.
 *
 * No AWS deploy required. The integ exercises the local-build warm serve path:
 * `cdkd local start-agentcore` builds the asset, boots the container ONCE + keeps
 * it warm, then proxies the HTTP contract (POST /invocations + GET /ping, with
 * the session-id injected) and fronts the /ws bridge — so both a plain HTTP
 * client and a header-less WebSocket client (the browser path) can drive the
 * same warm container.
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
