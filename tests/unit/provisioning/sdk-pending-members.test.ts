import { describe, it, expect } from 'vite-plus/test';
import { CreateEventSourceMappingCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { CreateNetworkConnectorCommand, LambdaCoreClient } from '@aws-sdk/client-lambda-core';

/**
 * CFn members the installed AWS SDK does not SEND yet, for which a provider
 * refuses the member rather than letting the serializer drop it. Each row
 * serializes a real command offline and asserts the member is still absent
 * from the request body. When an SDK bump starts sending it, the row goes red:
 * remove the provider's refusal, forward and read back the member, then delete
 * the row.
 */
interface PendingMember {
  /** The CFn path, for the failure message. */
  readonly cfnPath: string;
  /** Where the provider refuses it. */
  readonly refusedBy: string;
  /** The member name as it would appear in the serialized body. */
  readonly member: string;
  /** A value the row sends BESIDE the member, proving the capture saw its block. */
  readonly sentinel: string;
  readonly serialize: () => Promise<string>;
}

const CLIENT_CONFIG = {
  region: 'us-east-1',
  credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
};

/** The serialized body `client` would send for `command`; the request is never sent. */
async function requestBody(
  client: LambdaClient | LambdaCoreClient,
  command: CreateEventSourceMappingCommand | CreateNetworkConnectorCommand
): Promise<string> {
  let body: string | undefined;
  client.middlewareStack.add(
    () => async (args) => {
      const raw = (args.request as { body?: unknown }).body;
      body = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      throw new Error('captured');
    },
    { step: 'build', priority: 'low' }
  );
  await (client.send as (c: typeof command) => Promise<unknown>)(command).catch(() => undefined);
  client.destroy();
  if (body === undefined) throw new Error('the request body was never captured');
  return body;
}

const PENDING_MEMBERS: readonly PendingMember[] = [
  {
    cfnPath: 'AWS::Lambda::EventSourceMapping SelfManagedKafkaEventSourceConfig.ConsumptionMode',
    refusedBy:
      'src/provisioning/providers/lambda-eventsource-provider.ts (issue #3848; forward it per #3850, on create and in kafkaConfigForUpdate)',
    member: 'ConsumptionMode',
    sentinel: 'group-sentinel',
    serialize: () =>
      requestBody(
        new LambdaClient(CLIENT_CONFIG),
        new CreateEventSourceMappingCommand({
          FunctionName: 'fn',
          SelfManagedKafkaEventSourceConfig: {
            ConsumerGroupId: 'group-sentinel',
            ConsumptionMode: 'Queue',
          } as never,
        })
      ),
  },
  {
    cfnPath:
      'AWS::Lambda::NetworkConnector Configuration.VpcEgressConfiguration.ElasticIpConfiguration',
    refusedBy:
      'src/provisioning/providers/lambda-network-connector-provider.ts (#5123; forward it on create AND update, and read it back)',
    member: 'ElasticIpConfiguration',
    sentinel: 'subnet-sentinel',
    serialize: () =>
      requestBody(
        new LambdaCoreClient(CLIENT_CONFIG),
        new CreateNetworkConnectorCommand({
          Name: 'nc',
          Configuration: {
            VpcEgressConfiguration: {
              SubnetIds: ['subnet-sentinel'],
              ElasticIpConfiguration: 'AUTO',
            },
          } as never,
        })
      ),
  },
];

describe('CFn members the installed SDK does not send yet', () => {
  it.each(PENDING_MEMBERS.map((row) => [row.cfnPath, row] as const))(
    '%s is still dropped by the serializer',
    async (_path, row) => {
      const body = await row.serialize();
      // An absent member is a drop only if the capture saw its block.
      expect(body).toContain(row.sentinel);
      expect(
        body.includes(`"${row.member}"`),
        `The installed SDK now sends ${row.cfnPath}. Remove the refusal in ${row.refusedBy}, ` +
          'forward and read back the member, and delete this row.'
      ).toBe(false);
    }
  );
});
