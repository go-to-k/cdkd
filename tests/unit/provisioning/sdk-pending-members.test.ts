import { describe, it, expect } from 'vite-plus/test';
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

/** A build-step middleware that records the serialized body and stops the send. */
function captureBody(onBody: (body: string) => void) {
  return () => async (args: { request: unknown }) => {
    const raw = (args.request as { body?: unknown }).body;
    onBody(typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array));
    throw new Error('captured');
  };
}

const CAPTURE_STEP = { step: 'build', priority: 'low' } as const;

async function lambdaCoreRequestBody(command: CreateNetworkConnectorCommand): Promise<string> {
  const client = new LambdaCoreClient(CLIENT_CONFIG);
  let body: string | undefined;
  client.middlewareStack.add(captureBody((b) => (body = b)) as never, CAPTURE_STEP);
  await client.send(command).catch(() => undefined);
  client.destroy();
  if (body === undefined) throw new Error('the request body was never captured');
  return body;
}

const PENDING_MEMBERS: readonly PendingMember[] = [
  {
    cfnPath:
      'AWS::Lambda::NetworkConnector Configuration.VpcEgressConfiguration.ElasticIpConfiguration',
    refusedBy:
      'src/provisioning/providers/lambda-network-connector-provider.ts (#5123; forward it on create AND update, and read it back)',
    member: 'ElasticIpConfiguration',
    sentinel: 'subnet-sentinel',
    serialize: () =>
      lambdaCoreRequestBody(
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
