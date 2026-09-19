/**
 * Issue [#1852](https://github.com/go-to-k/cdkd/issues/1852): a state record
 * written before its provider recorded an attribute is never re-recorded by a
 * no-change deploy, so `Fn::GetAtt` on it took the physical-id fallback forever
 * — a refusal for an `*Arn` name, whose "not enriched ... file an issue"
 * wording was false for a type that IS enriched.
 *
 * This file pins the RESOLVER half: when the heal is asked for (only on a
 * miss), what each heal outcome resolves or refuses with, and that the phase
 * marker cannot leak between concurrent resolutions. The ENGINE half — routing,
 * single-flight, persistence, dry-run — is in
 * `deploy-engine-stale-attribute-heal.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  isStalePlaceholderArnAttribute,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  StaleAttributeMissSignal,
  isHealExcludedType,
  mergeHealedAttributes,
  normalizeHealedAttributes,
  readHealedAttribute,
  type StaleAttributeHealOutcome,
} from '../../../src/deployment/stale-attribute-heal.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

const warnSpy = vi.hoisted(() => vi.fn());
const debugSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '111122223333',
        Arn: 'arn:aws:iam::111122223333:user/test',
      }),
    },
    ec2: { send: vi.fn() },
  }),
}));

const REAL_ARN = 'arn:aws:ssm:us-east-1:111122223333:parameter/app/config';

/** The pre-#1824 record shape the issue opens with: `{Type, Value}`, no `Arn`. */
const staleParameter = (): ResourceState => ({
  physicalId: '/app/config',
  resourceType: 'AWS::SSM::Parameter',
  properties: { Name: '/app/config', Type: 'String', Value: 'v' },
  attributes: { Type: 'String', Value: 'v' },
});

const mkContext = (
  resources: Record<string, ResourceState>,
  healer?: ResolverContext['attributeHealer']
): ResolverContext => ({
  template: {
    Resources: Object.fromEntries(
      Object.entries(resources).map(([id, r]) => [id, { Type: r.resourceType, Properties: {} }])
    ),
  } as unknown as CloudFormationTemplate,
  resources,
  ...(healer && { attributeHealer: healer }),
});

const refusalOf = async (run: Promise<unknown>): Promise<Error> => {
  try {
    await run;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the resolution to throw');
};

const accessDenied = (): Error => {
  const err = new Error(
    'User: arn:aws:sts::111122223333:assumed-role/Deployer/session is not authorized to perform: ssm:GetParameter'
  );
  err.name = 'AccessDeniedException';
  (err as Error & { $metadata?: unknown }).$metadata = { httpStatusCode: 403 };
  return err;
};

describe('stale attribute heal — resolver (#1852)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    warnSpy.mockClear();
    debugSpy.mockClear();
    resetAccountInfoCache();
    resolver = new IntrinsicFunctionResolver('us-east-1');
  });

  describe('when the heal is asked for', () => {
    it('serves the re-read value on a miss, asking exactly once with the record', async () => {
      const record = staleParameter();
      const healer = vi
        .fn()
        .mockResolvedValue({ kind: 'read', attributes: { Arn: REAL_ARN } } as const);
      const value = await resolver.resolve(
        { 'Fn::GetAtt': ['Param', 'Arn'] },
        mkContext({ Param: record }, healer)
      );
      expect(value).toBe(REAL_ARN);
      expect(healer).toHaveBeenCalledTimes(1);
      expect(healer).toHaveBeenCalledWith('Param', record);
      // Not a fallback: nothing was substituted, nothing is counted or warned.
      expect(resolver.getPhysicalIdFallbackCount()).toBe(0);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('issues NO heal when the record already holds the attribute', async () => {
      const healer = vi.fn();
      const record = { ...staleParameter(), attributes: { Arn: REAL_ARN } };
      const value = await resolver.resolve(
        { 'Fn::GetAtt': ['Param', 'Arn'] },
        mkContext({ Param: record }, healer)
      );
      expect(value).toBe(REAL_ARN);
      expect(healer).not.toHaveBeenCalled();
    });

    it('issues NO heal when a per-type arm can CONSTRUCT the attribute', async () => {
      // `AWS::Lambda::Function.Arn` is built from the physical id — a miss in
      // the cached map that never reaches the fallback, so it must stay free.
      const healer = vi.fn();
      const value = await resolver.resolve(
        { 'Fn::GetAtt': ['Fn', 'Arn'] },
        mkContext(
          {
            Fn: {
              physicalId: 'my-fn',
              resourceType: 'AWS::Lambda::Function',
              properties: {},
              attributes: {},
            },
          },
          healer
        )
      );
      expect(value).toBe('arn:aws:lambda:us-east-1:111122223333:function:my-fn');
      expect(healer).not.toHaveBeenCalled();
    });

    it('heals through Fn::Sub — the miss signal is not swallowed by the Sub catch', async () => {
      const healer = vi
        .fn()
        .mockResolvedValue({ kind: 'read', attributes: { Arn: REAL_ARN } } as const);
      const value = await resolver.resolve(
        { 'Fn::Sub': 'prefix-${Param.Arn}' },
        mkContext({ Param: staleParameter() }, healer)
      );
      expect(value).toBe(`prefix-${REAL_ARN}`);
    });

    it('reads a Cloud Control NESTED shape for a dotted attribute name', async () => {
      const healer = vi.fn().mockResolvedValue({
        kind: 'read',
        attributes: { Endpoint: { Address: 'db.example.com', Port: '5432' } },
      } as const);
      const record: ResourceState = {
        physicalId: 'mydb',
        resourceType: 'AWS::RDS::DBInstance',
        properties: {},
        attributes: {},
        provisionedBy: 'cc-api',
      };
      const ctx = mkContext({ Db: record }, healer);
      expect(await resolver.resolve({ 'Fn::GetAtt': ['Db', 'Endpoint.Address'] }, ctx)).toBe(
        'db.example.com'
      );
    });
  });

  describe('the --no-wait DBInstance row (go-to-k/cdkd#3077)', () => {
    const creatingInstance = (): ResourceState => ({
      physicalId: 'mydb',
      resourceType: 'AWS::RDS::DBInstance',
      properties: {},
      // `definedAttributes` recorded nothing: the instance was `creating`.
      attributes: { Arn: 'arn:aws:rds:us-east-1:111122223333:db:mydb' },
    });

    it('heals Endpoint.Address / Endpoint.Port once the instance reports them', async () => {
      const healer = vi.fn().mockResolvedValue({
        kind: 'read',
        attributes: { 'Endpoint.Address': 'mydb.abc.rds.amazonaws.com', 'Endpoint.Port': '3306' },
      } as const);
      const ctx = mkContext({ Db: creatingInstance() }, healer);
      expect(await resolver.resolve({ 'Fn::GetAtt': ['Db', 'Endpoint.Address'] }, ctx)).toBe(
        'mydb.abc.rds.amazonaws.com'
      );
      expect(await resolver.resolve({ 'Fn::GetAtt': ['Db', 'Endpoint.Port'] }, ctx)).toBe('3306');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('keeps the warn + physical-id fallback while the instance still has no endpoint', async () => {
      const healer = vi.fn().mockResolvedValue({ kind: 'read', attributes: {} } as const);
      const ctx = mkContext({ Db: creatingInstance() }, healer);
      expect(await resolver.resolve({ 'Fn::GetAtt': ['Db', 'Endpoint.Address'] }, ctx)).toBe(
        'mydb'
      );
      expect(resolver.getPhysicalIdFallbackCount()).toBe(1);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0]![0])).toContain('returning physical ID');
    });

    it('never serves an EMPTY healed value (a healer that forgot to normalize)', async () => {
      const healer = vi
        .fn()
        .mockResolvedValue({ kind: 'read', attributes: { 'Endpoint.Address': '' } } as const);
      const ctx = mkContext({ Db: creatingInstance() }, healer);
      expect(await resolver.resolve({ 'Fn::GetAtt': ['Db', 'Endpoint.Address'] }, ctx)).toBe(
        'mydb'
      );
    });

    it('a FAILED read degrades to the same fallback — never a thrown deploy', async () => {
      const healer = vi.fn().mockResolvedValue({ kind: 'failed', error: accessDenied() } as const);
      const ctx = mkContext({ Db: creatingInstance() }, healer);
      expect(await resolver.resolve({ 'Fn::GetAtt': ['Db', 'Endpoint.Address'] }, ctx)).toBe(
        'mydb'
      );
      const warned = String(warnSpy.mock.calls[0]![0]);
      expect(warned).toContain('tried to re-read');
      expect(warned).not.toContain('Unknown attribute');
    });

    it('a healer that THROWS is a failed read, not a failed resolution', async () => {
      const healer = vi.fn().mockRejectedValue(new Error('boom'));
      const ctx = mkContext({ Db: creatingInstance() }, healer);
      expect(await resolver.resolve({ 'Fn::GetAtt': ['Db', 'Endpoint.Address'] }, ctx)).toBe(
        'mydb'
      );
    });
  });

  describe('the refusal tells the truth per case', () => {
    const refuse = (outcome: StaleAttributeHealOutcome | undefined): Promise<Error> =>
      refusalOf(
        resolver.resolve(
          { 'Fn::GetAtt': ['Param', 'Arn'] },
          mkContext(
            { Param: staleParameter() },
            outcome === undefined ? undefined : vi.fn().mockResolvedValue(outcome)
          )
        )
      );

    it('read FAILED: says the record is stale, that cdkd tried, the error CLASS, the remedy', async () => {
      const error = await refuse({ kind: 'failed', error: accessDenied() });
      expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
      expect(error.message).toContain('the state record holds no value for it');
      expect(error.message).toContain('tried to re-read the attributes from AWS');
      expect(error.message).toContain('AccessDeniedException, HTTP 403');
      expect(error.message).toContain('deploy again');
      // The false pre-#1852 sentence is gone on this arm...
      expect(error.message).not.toContain('not enriched');
      expect(error.message).not.toContain('file an issue');
      // ...and AWS's own text (account, role, session) stays behind --verbose.
      expect(error.message).not.toContain('assumed-role');
      expect(error.message).not.toContain('is not authorized');
      expect(isMarkedNonRetryable(error)).toBe(true);
    });

    it('NOT FOUND: names the out-of-band deletion, not an enrichment gap', async () => {
      const error = await refuse({ kind: 'not-found' });
      expect(error.message).toContain('AWS reports no resource behind the recorded physical id');
      expect(error.message).not.toContain('not enriched');
      expect(isMarkedNonRetryable(error)).toBe(true);
    });

    it('read OK but no such attribute: the type genuinely does not supply it', async () => {
      const error = await refuse({ kind: 'read', attributes: { Other: 'x' } });
      expect(error.message).toContain('attributes are not enriched for this resource type');
      expect(error.message).toContain('re-read the resource');
      expect(error.message).toContain('file an issue');
      expect(isMarkedNonRetryable(error)).toBe(true);
    });

    it('NOT ATTEMPTED (a record this deploy wrote): the pre-#1852 sentence, unchanged', async () => {
      const error = await refuse({ kind: 'not-attempted' });
      expect(error.message).toContain('attributes are not enriched for this resource type');
      expect(error.message).toContain('file an issue at https://github.com/go-to-k/cdkd/issues');
      expect(error.message).not.toContain('re-read');
    });

    it('NO healer (cdkd diff / drift): points at the command that heals', async () => {
      const error = await refuse(undefined);
      expect(error.message).toContain('attributes are not enriched for this resource type');
      expect(error.message).toContain("'cdkd deploy' re-reads it from AWS and heals the record");
      expect(isMarkedNonRetryable(error)).toBe(true);
    });

    it('--strict-getatt words a failed read the same way', async () => {
      const strict = new IntrinsicFunctionResolver('us-east-1', { strictGetAtt: true });
      const error = await refusalOf(
        strict.resolve(
          { 'Fn::GetAtt': ['Db', 'Endpoint.Address'] },
          mkContext(
            {
              Db: {
                physicalId: 'mydb',
                resourceType: 'AWS::RDS::DBInstance',
                properties: {},
                attributes: {},
              },
            },
            vi.fn().mockResolvedValue({ kind: 'failed', error: accessDenied() })
          )
        )
      );
      expect(error.message).toContain('--strict-getatt');
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(error.message).toContain('tried to re-read');
      expect(error.message).not.toContain('not enriched');
    });

    it('renders a template-borne logical id display-safely in the stale refusal', async () => {
      const id = 'Par\u001b[31mam';
      const error = await refusalOf(
        resolver.resolve(
          { 'Fn::GetAtt': [id, 'Arn'] },
          mkContext({ [id]: staleParameter() }, vi.fn().mockResolvedValue({ kind: 'not-found' }))
        )
      );
      expect(error.message).not.toContain('\u001b');
    });
  });

  describe('the pre-#1681 placeholder ARN (issue #1727) has the same no-change gap', () => {
    const PLACEHOLDER = 'arn:aws:appsync:*:*:apis/abc/datasources/ds';
    const REAL = 'arn:aws:appsync:us-east-1:111122223333:apis/abc/datasources/ds';
    const dataSource = (): ResourceState => ({
      physicalId: 'abc|ds',
      resourceType: 'AWS::AppSync::DataSource',
      properties: {},
      attributes: { DataSourceArn: PLACEHOLDER, Name: 'ds' },
    });

    it('serves the re-read ARN instead of refusing', async () => {
      const healer = vi
        .fn()
        .mockResolvedValue({ kind: 'read', attributes: { DataSourceArn: REAL } } as const);
      const value = await resolver.resolve(
        { 'Fn::GetAtt': ['Ds', 'DataSourceArn'] },
        mkContext({ Ds: dataSource() }, healer)
      );
      expect(value).toBe(REAL);
      expect(healer).toHaveBeenCalledTimes(1);
    });

    it('still refuses when the re-read is a placeholder too, with a remedy that is true', async () => {
      const healer = vi
        .fn()
        .mockResolvedValue({ kind: 'read', attributes: { DataSourceArn: PLACEHOLDER } } as const);
      const error = await refusalOf(
        resolver.resolve(
          { 'Fn::GetAtt': ['Ds', 'DataSourceArn'] },
          mkContext({ Ds: dataSource() }, healer)
        )
      );
      expect(error.message).toContain('is a placeholder');
      // The old remedy promised a heal a no-change re-deploy never performed.
      expect(error.message).not.toContain("so the resource's next update heals the record");
      expect(error.message).toContain('change any property of the resource');
      expect(isMarkedNonRetryable(error)).toBe(true);
    });

    it('does not ask the healer for a NON-placeholder attribute of the same type', async () => {
      const healer = vi.fn();
      expect(
        await resolver.resolve(
          { 'Fn::GetAtt': ['Ds', 'Name'] },
          mkContext({ Ds: dataSource() }, healer)
        )
      ).toBe('ds');
      expect(healer).not.toHaveBeenCalled();
    });

    it('isStalePlaceholderArnAttribute is scoped to the declared ARN keys', () => {
      expect(
        isStalePlaceholderArnAttribute('AWS::AppSync::DataSource', 'DataSourceArn', PLACEHOLDER)
      ).toBe(true);
      expect(isStalePlaceholderArnAttribute('AWS::AppSync::DataSource', 'DataSourceArn', REAL)).toBe(
        false
      );
      expect(isStalePlaceholderArnAttribute('AWS::AppSync::DataSource', 'Name', PLACEHOLDER)).toBe(
        false
      );
      expect(isStalePlaceholderArnAttribute('AWS::SSM::Parameter', 'Arn', PLACEHOLDER)).toBe(false);
    });
  });

  describe('the DBProxy VpcId refusal has the same gap and takes the same heal', () => {
    const proxy = (): ResourceState => ({
      physicalId: 'my-proxy',
      resourceType: 'AWS::RDS::DBProxy',
      properties: {},
      attributes: { DBProxyArn: 'arn:aws:rds:us-east-1:111122223333:db-proxy:prx-1' },
    });

    it('serves the re-read VpcId', async () => {
      const healer = vi
        .fn()
        .mockResolvedValue({ kind: 'read', attributes: { VpcId: 'vpc-0abc' } } as const);
      expect(
        await resolver.resolve(
          { 'Fn::GetAtt': ['Proxy', 'VpcId'] },
          mkContext({ Proxy: proxy() }, healer)
        )
      ).toBe('vpc-0abc');
    });

    it('refuses with the outcome-worded remedy when the re-read fails', async () => {
      const error = await refusalOf(
        resolver.resolve(
          { 'Fn::GetAtt': ['Proxy', 'VpcId'] },
          mkContext(
            { Proxy: proxy() },
            vi.fn().mockResolvedValue({ kind: 'failed', error: accessDenied() })
          )
        )
      );
      expect(error.message).toContain('the state record holds no VpcId');
      expect(error.message).toContain('tried to re-read');
      expect(error.message).not.toContain('Update the resource so its next deploy records');
      expect(isMarkedNonRetryable(error)).toBe(true);
    });

    it('points at cdkd deploy on a context with no healer', async () => {
      const error = await refusalOf(
        resolver.resolve({ 'Fn::GetAtt': ['Proxy', 'VpcId'] }, mkContext({ Proxy: proxy() }))
      );
      expect(error.message).toContain("Run 'cdkd deploy'");
      expect(error.message).toContain('Referencing the VPC directly also works');
    });

    it('DBProxyEndpoint: a read WITHOUT VpcId refuses, saying the read had nothing', async () => {
      const error = await refusalOf(
        resolver.resolve(
          { 'Fn::GetAtt': ['Ep', 'VpcId'] },
          mkContext(
            { Ep: { ...proxy(), resourceType: 'AWS::RDS::DBProxyEndpoint' } },
            vi.fn().mockResolvedValue({ kind: 'read', attributes: { Endpoint: 'e' } })
          )
        )
      );
      expect(error.message).toContain('reports no usable value for this attribute either');
    });
  });

  describe('a MASKED read-back is never a value (CloudControl import masks what it cannot certify)', () => {
    it('refuses instead of serving *** for an *Arn, flat or nested', async () => {
      const healer = vi.fn().mockResolvedValue({
        kind: 'read',
        attributes: { Arn: '***', Endpoint: { Address: '***' } },
      } as const);
      const reads: unknown[] = [];
      const ctx = {
        ...mkContext({ Param: { ...staleParameter(), provisionedBy: 'cc-api' as const } }, healer),
        redactedAttributeReads: reads as never,
      };
      const error = await refusalOf(resolver.resolve({ 'Fn::GetAtt': ['Param', 'Arn'] }, ctx));
      expect(error.message).toContain('reports none by that name');
      // A non-Arn name falls back to the physical id — never to the mask.
      expect(await resolver.resolve({ 'Fn::GetAtt': ['Param', 'Endpoint.Address'] }, ctx)).toBe(
        '/app/config'
      );
    });

    it('says the value was WITHHELD, not that the read reports none', async () => {
      const healer = vi.fn().mockResolvedValue({
        kind: 'read',
        attributes: { Tier: 'Standard' },
        withheldKeys: ['Arn'],
      } as const);
      const error = await refusalOf(
        resolver.resolve(
          { 'Fn::GetAtt': ['Param', 'Arn'] },
          mkContext({ Param: staleParameter() }, healer)
        )
      );
      expect(error.message).toContain('withheld the value');
      expect(error.message).toContain('cloudformation:DescribeType');
      expect(error.message).not.toContain('reports none by that name');
      expect(error.message).not.toContain('file an issue');
      expect(isMarkedNonRetryable(error)).toBe(true);
      // A DIFFERENT withheld key does not change this attribute's wording.
      const other = await refusalOf(
        resolver.resolve(
          { 'Fn::GetAtt': ['Param', 'OtherArn'] },
          mkContext({ Param: staleParameter() }, healer)
        )
      );
      expect(other.message).toContain('reports none by that name');
    });

    it('a placeholder ARN is not "healed" by a masked read', async () => {
      const error = await refusalOf(
        resolver.resolve(
          { 'Fn::GetAtt': ['Ds', 'DataSourceArn'] },
          mkContext(
            {
              Ds: {
                physicalId: 'abc|ds',
                resourceType: 'AWS::AppSync::DataSource',
                properties: {},
                attributes: { DataSourceArn: 'arn:aws:appsync:*:*:apis/abc/datasources/ds' },
              },
            },
            vi.fn().mockResolvedValue({ kind: 'read', attributes: { DataSourceArn: '***' } })
          )
        )
      );
      expect(error.message).toContain('is a placeholder');
    });
  });

  describe('concurrency — the phase rides a derived context, not the resolver', () => {
    it('a slow heal on one resource does not turn a sibling fallback into a probe', async () => {
      // One resolver instance serves every concurrently resolving resource of a
      // stack. If the probe marker lived on the instance (or on the SHARED
      // context), the sibling resolving during the slow heal would see `probe`
      // and leak the internal signal out of `resolve()`.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const healer = vi.fn(async (logicalId: string): Promise<StaleAttributeHealOutcome> => {
        if (logicalId === 'Slow') {
          await gate;
          return { kind: 'read', attributes: { Arn: REAL_ARN } };
        }
        return { kind: 'not-attempted' };
      });
      const ctx = mkContext(
        {
          Slow: staleParameter(),
          Fast: {
            physicalId: 'mydb',
            resourceType: 'AWS::RDS::DBInstance',
            properties: {},
            attributes: {},
          },
        },
        healer
      );
      const slow = resolver.resolve({ 'Fn::GetAtt': ['Slow', 'Arn'] }, ctx);
      const fast = await resolver.resolve({ 'Fn::GetAtt': ['Fast', 'Endpoint.Address'] }, ctx);
      expect(fast).toBe('mydb');
      release();
      expect(await slow).toBe(REAL_ARN);
      // The caller's context object was never written to.
      expect(ctx.staleAttributeHeal).toBeUndefined();
    });

    it('the miss signal never escapes resolve()', async () => {
      const error = await refusalOf(
        resolver.resolve(
          { 'Fn::GetAtt': ['Param', 'Arn'] },
          mkContext({ Param: staleParameter() }, vi.fn().mockResolvedValue({ kind: 'not-found' }))
        )
      );
      expect(error).not.toBeInstanceOf(StaleAttributeMissSignal);
    });
  });

  describe('leaf helpers', () => {
    it('normalizeHealedAttributes drops undefined / null / empty, keeps falsy VALUES', () => {
      expect(
        normalizeHealedAttributes({ a: undefined, b: null, c: '', d: 0, e: false, f: 'x' })
      ).toEqual({ d: 0, e: false, f: 'x' });
      expect(normalizeHealedAttributes(undefined)).toEqual({});
    });

    it('readHealedAttribute uses own keys only', () => {
      expect(readHealedAttribute({}, 'constructor')).toBeUndefined();
      expect(readHealedAttribute({ Endpoint: {} }, 'Endpoint.constructor')).toBeUndefined();
      expect(readHealedAttribute({ 'Endpoint.Port': '1' }, 'Endpoint.Port')).toBe('1');
    });

    it('mergeHealedAttributes ADDS absent keys and never rewrites a recorded one', () => {
      const recorded = { Type: 'String', Value: 'v' };
      const merged = mergeHealedAttributes(
        recorded,
        { Type: 'SecureString', Arn: REAL_ARN },
        () => false
      );
      expect(merged).toEqual({ Type: 'String', Value: 'v', Arn: REAL_ARN });
      // Not in place: the loaded record is the rollback baseline.
      expect(recorded).toEqual({ Type: 'String', Value: 'v' });
    });

    it('mergeHealedAttributes returns the SAME reference when nothing is added', () => {
      const recorded = { Arn: REAL_ARN };
      expect(mergeHealedAttributes(recorded, { Arn: 'other', Empty: '' }, () => false)).toBe(
        recorded
      );
      expect(mergeHealedAttributes(undefined, {}, () => false)).toBeUndefined();
    });

    it('mergeHealedAttributes overwrites only what the stale predicate names', () => {
      expect(
        mergeHealedAttributes({ A: 'old', B: 'keep' }, { A: 'new', B: 'new' }, (k) => k === 'A')
      ).toEqual({ A: 'new', B: 'keep' });
    });

    it('isHealExcludedType covers custom resources and nested stacks only', () => {
      expect(isHealExcludedType('Custom::Thing')).toBe(true);
      expect(isHealExcludedType('AWS::CloudFormation::CustomResource')).toBe(true);
      expect(isHealExcludedType('AWS::CloudFormation::Stack')).toBe(true);
      expect(isHealExcludedType('AWS::SSM::Parameter')).toBe(false);
    });
  });
});
