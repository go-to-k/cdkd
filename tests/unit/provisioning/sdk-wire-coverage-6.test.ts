import { describe, expect, it, vi } from 'vite-plus/test';
import { armFor, describeWireCases, record, type Bag } from './sdk-wire-harness.js';
import { WAFv2WebACLProvider } from '../../../src/provisioning/providers/wafv2-provider.js';

// The client classes the sixth batch reaches (`sdk-wire-cases-6.ts`), wrapped
// as in `sdk-wire-coverage.test.ts`. Both providers build their own clients (a
// shared one and a create client without 5xx retries), so every instance is
// captured through the package.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-wafv2', (orig) => wrap(orig, 'WAFV2Client'));
vi.mock('@aws-sdk/client-pipes', (orig) => wrap(orig, 'PipesClient'));

import {
  CASES_6,
  CONVERSION_CARRIERS,
  LOCK_TOKEN,
  RULES_CARRIED,
  WEB_ACL_ARN,
  armWebAcl,
  rulesExemptions,
} from './sdk-wire-cases-6.js';

describe('SDK wire coverage (batch 6)', () => {
  describeWireCases(CASES_6);
});

// The WAFv2 `Rules` exemptions are derived from what RULES carries, so the
// nested-path check cannot notice RULES shrinking: a dropped path only becomes
// another exemption. The conversions are pinned by name, and the exemptions by
// a cap at today's count, which a shrinking RULES exceeds.
describe('AWS::WAFv2::WebACL Rules bag', () => {
  it.each(CONVERSION_CARRIERS)('carries the conversion path %s', (path) => {
    expect(RULES_CARRIED.has(path)).toBe(true);
  });

  it('exempts no more Rules paths than it does today', () => {
    expect(Object.keys(rulesExemptions()).length).toBeLessThanOrEqual(388);
  });
});

// The bag probes compare two updates that both carry the same lock token, so
// none of them can tell whether the token sent is the one `GetWebACL` handed
// out. Read here on the call itself, with the web ACL addressed by the name,
// id and scope inside the recorded ARN.
describe('AWS::WAFv2::WebACL UpdateWebACL lock token and address', () => {
  it('sends the LockToken GetWebACL returned, addressed by the ARN', async () => {
    armWebAcl();
    // Name and Scope differ from the ARN's, so only an address read from the
    // ARN passes (both are create-only: the engine never changes them in place).
    const bag = {
      Name: 'acl-template',
      Scope: 'REGIONAL',
      DefaultAction: { Allow: {} },
      VisibilityConfig: {
        CloudWatchMetricsEnabled: false,
        MetricName: 'acl',
        SampledRequestsEnabled: false,
      },
    };
    const outcome = await record(() =>
      new WAFv2WebACLProvider().update('L', WEB_ACL_ARN, 'AWS::WAFv2::WebACL', bag, bag)
    );
    expect(outcome).toMatchObject({ threw: false });
    const updates = (outcome as { wire: string }).wire
      .split('\n')
      .filter((line) => line.startsWith('["UpdateWebACLCommand"'))
      .map((line) => JSON.parse(JSON.parse(line)[5] as string) as Record<string, unknown>);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      LockToken: LOCK_TOKEN,
      Name: 'acl',
      Id: 'abc-123',
      Scope: 'CLOUDFRONT',
    });
  });
});

// A removal on update reaches the wire as a reset VALUE, but a bag probe sees
// only that UpdatePipe is sent at all: its reduced side changes nothing and
// sends no call, so any call passes. Read here on the call itself.
describe('AWS::Pipes::Pipe removals on update send their reset values', () => {
  const sentBody = async (next: Bag, prev: Bag): Promise<Record<string, unknown>> => {
    const c = CASES_6.find((t) => t.resourceType === 'AWS::Pipes::Pipe')!;
    armFor(c, prev);
    const outcome = await record(() =>
      c.provider().update('L', c.physicalId, c.resourceType, next, prev)
    );
    expect(outcome).toMatchObject({ threw: false });
    const updates = (outcome as { wire: string }).wire
      .split('\n')
      .map((line) => JSON.parse(line) as unknown[])
      .filter((entry) => entry[0] === 'UpdatePipeCommand');
    expect(updates).toHaveLength(1);
    return JSON.parse(updates[0]![updates[0]!.length - 1] as string) as Record<string, unknown>;
  };

  const base = {
    Name: 'p',
    Source: 'arn:aws:sqs:us-east-1:123456789012:q',
    Target: 't',
    RoleArn: 'r',
  };

  it('a removed source block is sent empty and a removed filter as an empty list', async () => {
    const body = await sentBody(
      { ...base, SourceParameters: { DynamoDBStreamParameters: { BatchSize: 5 } } },
      {
        ...base,
        SourceParameters: {
          DynamoDBStreamParameters: { BatchSize: 5 },
          SqsQueueParameters: { BatchSize: 10 },
          FilterCriteria: { Filters: [{ Pattern: '{}' }] },
        },
      }
    );
    expect(body['SourceParameters']).toEqual({
      DynamoDBStreamParameters: { BatchSize: 5 },
      SqsQueueParameters: {},
      FilterCriteria: { Filters: [] },
    });
  });

  it('a removed description, enrichment, key, state and logging reset', async () => {
    const body = await sentBody(
      { ...base },
      {
        ...base,
        Description: 'd',
        Enrichment: 'arn:aws:lambda:us-east-1:123456789012:function:e',
        KmsKeyIdentifier: 'alias/k',
        DesiredState: 'STOPPED',
        LogConfiguration: { Level: 'INFO' },
      }
    );
    expect(body).toMatchObject({
      Description: '',
      Enrichment: '',
      KmsKeyIdentifier: '',
      DesiredState: 'RUNNING',
      LogConfiguration: { Level: 'OFF' },
    });
  });
});
