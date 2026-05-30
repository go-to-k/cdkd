import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import {
  Runtime,
  AgentRuntimeArtifact,
  AgentCoreRuntime,
  RuntimeAuthorizerConfiguration,
  RuntimeCustomClaim,
  ProtocolType,
} from 'aws-cdk-lib/aws-bedrockagentcore';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture stack for the `cdkd local invoke-agentcore` integ test.
 *
 * Uses the stable L2 `Runtime` construct + `AgentRuntimeArtifact.fromAsset`
 * — the shape real users author — whose container is built from a local
 * Dockerfile in `agent/`. The container serves the AgentCore HTTP contract
 * on 8080 (GET /ping + POST /invocations) and the `/invocations` handler
 * echoes the request body, the received session-id header, and the injected
 * `GREETING` env var so verify.sh can assert each.
 *
 * No AWS deploy required. The integ exercises the local-build path:
 * `cdkd local invoke-agentcore` finds the asset via the cdk.out asset manifest,
 * `docker build`s it (linux/arm64, the AgentCore-required arch), runs it on
 * 8080, waits for /ping, and POSTs to /invocations. The L2 construct
 * auto-creates the execution role; the default invoke path forwards the
 * developer's shell credentials, so that role is never assumed locally.
 */
export class LocalInvokeAgentCoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new Runtime(this, 'EchoAgent', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(__dirname, '../agent'), {
        platform: Platform.LINUX_ARM64,
      }),
      environmentVariables: { GREETING: 'hello-from-agent' },
    });

    // A JWT-protected runtime for the inbound-auth tests. The discovery URL
    // is deliberately unreachable (localhost:1), so `cdkd local invoke-agentcore`
    // falls back to JWKS/discovery pass-through (accept + warn) — exercising
    // the auth wiring end-to-end offline: a missing token is rejected before
    // the container starts, `--no-verify-auth` skips, and `--bearer-token` is
    // forwarded to /invocations.
    new Runtime(this, 'ProtectedAgent', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(__dirname, '../agent'), {
        platform: Platform.LINUX_ARM64,
      }),
      environmentVariables: { GREETING: 'hello-from-agent' },
      authorizerConfiguration: RuntimeAuthorizerConfiguration.usingJWT(
        'https://127.0.0.1:1/.well-known/openid-configuration',
        ['client-9'],
        ['aud-1']
      ),
    });

    // An MCP-protocol runtime (ProtocolConfiguration = MCP). Its container
    // serves the MCP Streamable-HTTP contract on 8000 at POST /mcp (no /ping).
    // `cdkd local invoke-agentcore` runs the session handshake then one JSON-RPC
    // request — tools/list by default, or the method/params from --event.
    new Runtime(this, 'McpAgent', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(__dirname, '../mcp-agent'), {
        platform: Platform.LINUX_ARM64,
      }),
      protocolConfiguration: ProtocolType.MCP,
    });

    // A JWT-protected runtime whose customJwtAuthorizer also declares
    // `allowedScopes` + `customClaims` — exercises the resolver's extraction
    // of the new fields end-to-end (the discovery URL is again deliberately
    // unreachable; the verifier's pass-through path then accepts every Bearer
    // token without firing the scope / claim checks). The unit tests cover the
    // verifier behavior with a working discovery + JWKS + signed token.
    new Runtime(this, 'ProtectedAgentClaims', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(__dirname, '../agent'), {
        platform: Platform.LINUX_ARM64,
      }),
      environmentVariables: { GREETING: 'hello-from-agent' },
      authorizerConfiguration: RuntimeAuthorizerConfiguration.usingJWT(
        'https://127.0.0.1:1/.well-known/openid-configuration',
        ['client-9'],
        ['aud-1'],
        ['read', 'write'],
        [
          RuntimeCustomClaim.withStringValue('department', 'engineering'),
          RuntimeCustomClaim.withStringArrayValue('groups', ['admins']),
        ]
      ),
    });

    // A CodeConfiguration (managed-runtime) runtime authored as plain source
    // (no Dockerfile) via fromCodeAsset. `cdkd local invoke-agentcore` builds it from
    // source for the declared runtime (pip install + run the entrypoint), which
    // self-serves the same 8080 HTTP contract.
    new Runtime(this, 'CodeAgent', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromCodeAsset({
        path: path.join(__dirname, '../code-agent'),
        runtime: AgentCoreRuntime.PYTHON_3_12,
        entrypoint: ['app.py'],
      }),
      environmentVariables: { GREETING: 'hello-from-code' },
    });

    // An A2A-protocol runtime (ProtocolConfiguration = A2A). The container
    // serves the Agent2Agent JSON-RPC 2.0 contract on 9000 at POST / (no
    // /ping). `cdkd local invoke-agentcore` POSTs one JSON-RPC request — defaults
    // to `agent/getCard` (the agent's discovery card), or the method/params
    // from --event.
    new Runtime(this, 'A2aAgent', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(__dirname, '../a2a-agent'), {
        platform: Platform.LINUX_ARM64,
      }),
      protocolConfiguration: ProtocolType.A2A,
    });

    // An AGUI-protocol runtime (ProtocolConfiguration = AGUI). The container
    // serves the AG-UI HTTP-compatible contract on 8080 (GET /ping + POST
    // /invocations); /invocations returns a text/event-stream of AG-UI events
    // (RUN_STARTED, MESSAGE_CONTENT, RUN_FINISHED). The HTTP-path SSE handler
    // streams these incrementally — AGUI reuses the HTTP routing transparently.
    new Runtime(this, 'AguiAgent', {
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(path.join(__dirname, '../agui-agent'), {
        platform: Platform.LINUX_ARM64,
      }),
      protocolConfiguration: ProtocolType.AGUI,
    });
  }
}
