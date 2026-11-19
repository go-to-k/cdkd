/**
 * `AWS::ApiGateway::RestApi` `Policy` on the drift baseline captured right
 * after cdkd's own write (go-to-k/cdkd#6609). Split from `rest-api.ts`,
 * which sits near the source file size cap.
 */
import { GetRestApiCommand } from '@aws-sdk/client-api-gateway';
import type { ApiGatewayProvider } from '../apigateway-provider.js';
import { RESOURCE_NOT_FOUND, type ResourceNotFound } from '../../../types/resource.js';
import {
  declaredMemberDocument,
  type MemberRead,
  policyDocumentMatchesDeclared,
  settleDeclaredMember,
  warnUnsettledMember,
} from '../../settle-after-own-write.js';
import { restApiAsCfn } from './rest-api.js';

/**
 * The REST API read with its `Policy` settled: a declared policy the read
 * does not show yet (the create / `UpdateRestApi` may not be visible) is
 * re-read with `GetRestApi` until it does. Still none after the schedule, the
 * declared policy is recorded; another policy is recorded as read. A read
 * whose first answer is the declared policy, or a template that declares
 * none, makes no extra call.
 */
export async function settleRestApiPolicy(
  this: ApiGatewayProvider,
  physicalId: string,
  logicalId: string,
  read: Record<string, unknown> | ResourceNotFound | undefined,
  properties: Record<string, unknown> | undefined
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  const declared = declaredMemberDocument(properties?.['Policy']);
  if (declared === undefined || read === undefined || read === RESOURCE_NOT_FOUND) return read;
  const asMember = (policy: unknown): MemberRead<unknown> =>
    policy === undefined ? 'absent' : { value: policy };
  const policy = await settleDeclaredMember(
    asMember(read['Policy']),
    async () => {
      const resp = await this.apiGatewayClient.send(
        new GetRestApiCommand({ restApiId: physicalId })
      );
      return asMember(restApiAsCfn(resp, properties?.['Policy'])['Policy']);
    },
    (value) => policyDocumentMatchesDeclared(value, declared),
    declared,
    this.ownWriteRereadDelaysMs,
    () => warnUnsettledMember(this.logger, logicalId, 'AWS::ApiGateway::RestApi', 'Policy')
  );
  return typeof policy === 'object' ? { ...read, Policy: policy.value } : read;
}
