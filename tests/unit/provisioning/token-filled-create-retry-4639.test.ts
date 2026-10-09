/**
 * Issue #4639 left five creates on the SDK's full retry ON PURPOSE: AgentCore
 * `CreateAgentRuntime` / `CreateEvaluator`, the Cloud Map namespace and
 * service creates, Lambda MicroVMs `CreateMicrovmImage` and Secrets Manager
 * `CreateSecret`. Each input carries a member with Smithy's `idempotencyToken`
 * trait that the SDK fills when cdkd omits it. The fill happens when the
 * request is SERIALIZED, before the retry middleware, so the SDK's own replay
 * of a 5xx inside one `send` repeats the SAME token and the service answers it
 * with what the first request made -- the replay #4639 closes elsewhere cannot
 * collide here. Refusing that replay would trade a replay the service absorbs
 * for a failed deploy.
 *
 * A REAL client per package (no module mock) against a stub HTTP handler, so
 * an SDK upgrade that moved the fill per attempt turns this red. (Across two
 * `send`s the fill is fresh -- `docs/_contents/provider-rules.md`, "Do not assume the
 * SDK's auto-fill is a fix" -- which is not the path this pins.)
 */
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vite-plus/test';
import {
  BedrockAgentCoreControlClient,
  CreateAgentRuntimeCommand,
  CreateEvaluatorCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  CreateHttpNamespaceCommand,
  CreatePrivateDnsNamespaceCommand,
  CreatePublicDnsNamespaceCommand,
  CreateServiceCommand,
  ServiceDiscoveryClient,
} from '@aws-sdk/client-servicediscovery';
import { CreateMicrovmImageCommand, LambdaMicrovmsClient } from '@aws-sdk/client-lambda-microvms';
import { CreateSecretCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

interface Sendable {
  send: (command: never) => Promise<unknown>;
}

/** Build `Client` whose handler answers 500 once, then 200, recording each request body. */
function stubbedClient(Client: new (config: object) => Sendable): {
  client: Sendable;
  bodies: string[];
} {
  const bodies: string[] = [];
  const client = new Client({
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    requestHandler: {
      handle: async (request: { body?: unknown }) => {
        bodies.push(
          typeof request.body === 'string'
            ? request.body
            : Buffer.from(request.body as Uint8Array).toString('utf8')
        );
        const first = bodies.length === 1;
        return {
          response: {
            statusCode: first ? 500 : 200,
            headers: { 'content-type': 'application/json' },
            body: Readable.from([
              Buffer.from(first ? '{"__type":"InternalServerException","message":"boom"}' : '{}'),
            ]),
          },
        };
      },
    },
  });
  return { client, bodies };
}

const CASES: Array<[string, new (config: object) => Sendable, () => unknown, string]> = [
  [
    'CreateAgentRuntime',
    BedrockAgentCoreControlClient as never,
    () =>
      new CreateAgentRuntimeCommand({
        agentRuntimeName: 'rt',
        agentRuntimeArtifact: { containerConfiguration: { containerUri: 'uri' } },
        roleArn: 'arn:aws:iam::123456789012:role/r',
        networkConfiguration: { networkMode: 'PUBLIC' },
      }),
    'clientToken',
  ],
  [
    'CreateEvaluator',
    BedrockAgentCoreControlClient as never,
    () =>
      new CreateEvaluatorCommand({
        evaluatorName: 'ev',
        evaluatorConfig: {
          llmAsAJudge: {
            instructions: 'i',
            ratingScale: { numerical: [] },
            modelConfig: { bedrockEvaluatorModelConfig: { modelId: 'm' } },
          },
        },
        level: 'TRACE',
      }),
    'clientToken',
  ],
  [
    'CreateHttpNamespace',
    ServiceDiscoveryClient as never,
    () => new CreateHttpNamespaceCommand({ Name: 'ns' }),
    'CreatorRequestId',
  ],
  [
    'CreatePrivateDnsNamespace',
    ServiceDiscoveryClient as never,
    () => new CreatePrivateDnsNamespaceCommand({ Name: 'ns.local', Vpc: 'vpc-1' }),
    'CreatorRequestId',
  ],
  [
    'CreatePublicDnsNamespace',
    ServiceDiscoveryClient as never,
    () => new CreatePublicDnsNamespaceCommand({ Name: 'example.com' }),
    'CreatorRequestId',
  ],
  [
    'CreateService',
    ServiceDiscoveryClient as never,
    () => new CreateServiceCommand({ Name: 'svc' }),
    'CreatorRequestId',
  ],
  [
    'CreateMicrovmImage',
    LambdaMicrovmsClient as never,
    () => new CreateMicrovmImageCommand({} as never),
    'clientToken',
  ],
  [
    'CreateSecret',
    SecretsManagerClient as never,
    () => new CreateSecretCommand({ Name: 'app-secret' }),
    'ClientRequestToken',
  ],
];

describe('creates whose SDK-filled idempotency token makes the in-send replay safe (issue #4639)', () => {
  it.each(CASES)(
    '%s: the SDK replays a 500 inside one send with the SAME %s',
    async (_name, Client, command, tokenKey) => {
      const { client, bodies } = stubbedClient(Client);

      await client.send(command() as never);

      // The replay happened (the full SDK retry is kept)...
      expect(bodies).toHaveLength(2);
      const tokens = bodies.map((body) => (JSON.parse(body) as Record<string, unknown>)[tokenKey]);
      // ...and carried the token the first request did.
      expect(typeof tokens[0]).toBe('string');
      expect((tokens[0] as string).length).toBeGreaterThan(0);
      expect(tokens[1]).toBe(tokens[0]);
    }
  );
});
