import type { RDSDBProxyProvider } from '../rds-dbproxy-provider.js';
import {
  DescribeDBProxiesCommand,
  ListTagsForResourceCommand,
  DBProxyNotFoundFault,
} from '@aws-sdk/client-rds';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../../import-helpers.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { injectiveKey } from '../../../state/record-keys.js';

export async function getAttribute(
  this: RDSDBProxyProvider,
  physicalId: string,
  _resourceType: string,
  attributeName: string
): Promise<unknown> {
  // ENCODED, not separated (go-to-k/cdkd#3496). A PRINTABLE separator here,
  // and both halves are unchecked: `physicalId` comes from a state record
  // that `parseStateBody` casts, and `attributeName` is template text. The
  // cache is read BEFORE the attribute switch below, so a hit answers
  // whatever was asked -- one AWS::RDS::DBProxy's attribute served for
  // another's `Fn::GetAtt`.
  const cacheKey = injectiveKey(physicalId, attributeName);
  const cached = this.attributeCache.get(cacheKey);
  if (cached !== undefined) return cached;

  if (attributeName !== 'Endpoint' && attributeName !== 'DBProxyArn' && attributeName !== 'VpcId') {
    this.logger.warn(
      `Unknown attribute ${attributeName} for AWS::RDS::DBProxy, returning undefined`
    );
    return undefined;
  }

  try {
    const describe = await this.getClient().send(
      new DescribeDBProxiesCommand({ DBProxyName: physicalId })
    );
    const proxy = describe.DBProxies?.[0];
    if (!proxy) return undefined;
    const map: Record<string, unknown> = {
      Endpoint: proxy.Endpoint,
      DBProxyArn: proxy.DBProxyArn,
      VpcId: proxy.VpcId,
    };
    const value = map[attributeName];
    if (value !== undefined) this.attributeCache.set(cacheKey, value);
    return value;
  } catch (error) {
    if (error instanceof DBProxyNotFoundFault) return undefined;
    throw error;
  }
}

export async function importImpl(
  this: RDSDBProxyProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicit = resolveExplicitPhysicalId(input, 'DBProxyName');
  if (explicit) {
    return this.buildImportResult(explicit);
  }

  // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
  // that tag never exists on a real resource and the walk could not match
  // (issue #1134). Auto-mode import resolves ids from CloudFormation's
  // `DescribeStackResources` or the template's physical-name property; a
  // DB proxy reaching here needs an explicit `--resource` override.
  return null;
}

/**
 * Reads the AWS-current configuration. Drift comparator uses this as the
 * authoritative snapshot for resources written under schema v3+.
 */
export async function readCurrentState(
  this: RDSDBProxyProvider,
  physicalId: string
): Promise<Record<string, unknown> | ResourceNotFound> {
  const client = this.getClient();
  let proxy: unknown;
  try {
    const describe = await client.send(new DescribeDBProxiesCommand({ DBProxyName: physicalId }));
    proxy = describe.DBProxies?.[0];
    if (!proxy) return RESOURCE_NOT_FOUND;
  } catch (error) {
    if (error instanceof DBProxyNotFoundFault) return RESOURCE_NOT_FOUND;
    throw error;
  }
  const p = proxy as {
    DBProxyName?: string;
    DBProxyArn?: string;
    EngineFamily?: string;
    RoleArn?: string;
    VpcSubnetIds?: string[];
    VpcSecurityGroupIds?: string[];
    RequireTLS?: boolean;
    IdleClientTimeout?: number;
    DebugLogging?: boolean;
    DefaultAuthScheme?: string;
    EndpointNetworkType?: string;
    TargetConnectionNetworkType?: string;
    Auth?: Array<{
      Description?: string;
      UserName?: string;
      AuthScheme?: string;
      SecretArn?: string;
      IAMAuth?: string;
      ClientPasswordAuthType?: string;
    }>;
  };
  const result: Record<string, unknown> = {
    DBProxyName: p.DBProxyName,
    EngineFamily: p.EngineFamily,
    RoleArn: p.RoleArn,
    VpcSubnetIds: p.VpcSubnetIds ?? [],
    VpcSecurityGroupIds: p.VpcSecurityGroupIds ?? [],
    RequireTLS: p.RequireTLS ?? false,
    IdleClientTimeout: p.IdleClientTimeout,
    DebugLogging: p.DebugLogging ?? false,
    // Each member AWS does not report is OMITTED, never set to `undefined`
    // (go-to-k/cdkd#5723). The baseline is persisted as JSON, which drops an
    // `undefined` member, while the drift comparator's array-element walk
    // counts own keys: a secrets-auth proxy (no `Description` / `UserName`)
    // reported phantom `Auth` drift on a fresh deploy, and `--accept` could
    // not converge it.
    Auth: (p.Auth ?? []).map((a) => ({
      ...(a.Description !== undefined && { Description: a.Description }),
      ...(a.UserName !== undefined && { UserName: a.UserName }),
      ...(a.AuthScheme !== undefined && { AuthScheme: a.AuthScheme }),
      ...(a.SecretArn !== undefined && { SecretArn: a.SecretArn }),
      ...(a.IAMAuth !== undefined && { IAMAuth: a.IAMAuth }),
      ...(a.ClientPasswordAuthType !== undefined && {
        ClientPasswordAuthType: a.ClientPasswordAuthType,
      }),
    })),
    // Omitted when AWS reports none: the drift comparator ignores a key
    // state does not hold, and a proxy created without the property records
    // none (go-to-k/cdkd#2762).
    ...(p.DefaultAuthScheme !== undefined && { DefaultAuthScheme: p.DefaultAuthScheme }),
    ...(p.EndpointNetworkType !== undefined && { EndpointNetworkType: p.EndpointNetworkType }),
    ...(p.TargetConnectionNetworkType !== undefined && {
      TargetConnectionNetworkType: p.TargetConnectionNetworkType,
    }),
  };

  // Tags via ListTagsForResource.
  if (p.DBProxyArn) {
    try {
      const tagResp = await client.send(
        new ListTagsForResourceCommand({ ResourceName: p.DBProxyArn })
      );
      result['Tags'] = normalizeAwsTagsToCfn(tagResp.TagList ?? []);
    } catch (error) {
      this.logger.debug(
        `ListTagsForResource failed for ${physicalId}: ${describeAwsFailure(error).detail}`
      );
      result['Tags'] = [];
    }
  } else {
    result['Tags'] = [];
  }

  return result;
}

export async function buildImportResult(
  this: RDSDBProxyProvider,
  physicalId: string
): Promise<ResourceImportResult> {
  // Recover attributes via DescribeDBProxies so the imported resource
  // gets the same shape a fresh create() would produce.
  try {
    const describe = await this.getClient().send(
      new DescribeDBProxiesCommand({ DBProxyName: physicalId })
    );
    const proxy = describe.DBProxies?.[0];
    // Only include keys the read-back actually resolved. Persisting `''`
    // is worse than omitting: the intrinsic resolver treats any
    // non-undefined flat attribute as a hit, so an empty string shadows
    // constructAttribute's fallback and Fn::GetAtt resolves to ''.
    return {
      physicalId,
      attributes: {
        ...(proxy?.DBProxyArn && { DBProxyArn: proxy.DBProxyArn }),
        ...(proxy?.Endpoint && { Endpoint: proxy.Endpoint }),
        ...(proxy?.VpcId && { VpcId: proxy.VpcId }),
      },
    };
  } catch {
    // Describe failed — we know nothing about the attributes. Return an
    // empty map rather than a set of empty-string placeholders.
    return { physicalId, attributes: {} };
  }
}
