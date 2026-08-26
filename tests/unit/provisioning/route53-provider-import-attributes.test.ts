/**
 * `AWS::Route53::HostedZone` ADOPTION records the same `Fn::GetAtt` attribute
 * set a `cdkd deploy` CREATE records (issue #1875).
 *
 * Before the fix `importHostedZone` returned `attributes: {}` from BOTH of its
 * branches, so a zone that entered state through `cdkd import` (or
 * `cdkd import --migrate-from-cloudformation`) had no `NameServers`. Nothing
 * downstream rescued that: `IntrinsicFunctionResolver.resolveGetAtt`'s
 * flat-attribute branch missed (taking PR #1868's legacy comma-string
 * normalization with it, since that lives in the same branch),
 * `constructAttribute` has no `AWS::Route53::HostedZone` case, and resolution
 * fell through to `guardedPhysicalIdFallback`, which warns and hands back the
 * zone id STRING — so a downstream `Fn::Join` threw and the Output was
 * silently dropped.
 *
 * The end-to-end block at the bottom drives that ACTUAL symptom rather than
 * only the provider's return value: an imported record's own attributes are
 * fed to the real resolver, with the pre-fix `{}` shape kept beside it as a
 * negative control.
 *
 * **Which arm carries which guarantee**, because the two are not
 * interchangeable and reading the e2e block as a superset overstates it:
 *
 * - The e2e arms cover the ABSENCE of `NameServers` — the `Fn::Join` symptom.
 *   They are blind to the comma-STRING shape by construction, because
 *   `resolveGetAtt`'s #1868 legacy normalization converts a comma string back
 *   to a list at the read boundary, so both e2e arms stay GREEN under a
 *   `.join(',')` mutation (measured).
 * - The unit `toEqual`s are the ONLY thing that pins the LIST shape, and
 *   therefore the only thing standing between an imported zone and a
 *   deployed one recording divergent state. Do not weaken them into
 *   `physicalId`-only assertions.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-route-53', async () => {
  const actual = await vi.importActual('@aws-sdk/client-route-53');
  return {
    ...actual,
    Route53Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

// Mock STS (issue #2081). The NEGATIVE CONTROL at the bottom feeds an EMPTY
// attribute set to the real resolver, which falls through to the
// physical-id fallback — and that path resolves the caller's account identity
// through `getAwsClients().sts`, an `STSClient` built inside
// `src/utils/aws-clients.ts`. Mocking the Route53 package above does not reach
// it, so the test issued a REAL `sts:GetCallerIdentity` against whatever
// account the runner is authenticated to.
//
// The call is mocked to SUCCEED with a realistic `GetCallerIdentity` response,
// because success is what a real deploy does — the healthy answer keeps the
// fallback path measuring its own mechanism rather than a degraded one.
//
// Stated plainly, since a comment here previously claimed otherwise: NO assertion
// in this file distinguishes the two polarities. Measured — the file is green with
// this mock resolving and green with it rejecting. What it asserts is the
// `Fn::Join` refusal over a non-list attribute, which never consults the account
// id, so the `fabricated: true` degraded branch is simply not observed here. The
// choice is about fidelity, not coverage.
const stsMockSend = vi.fn(async () => ({
  Account: '123456789012',
  Arn: 'arn:aws:iam::123456789012:user/test',
  UserId: 'AIDATESTUSERID',
}));

vi.mock('@aws-sdk/client-sts', async () => {
  const actual = await vi.importActual('@aws-sdk/client-sts');
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({ send: stsMockSend, destroy: vi.fn() })),
  };
});

const childLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn().mockReturnThis(),
};

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const NS = ['ns-1.awsdns-01.com', 'ns-2.awsdns-02.net'];

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    logicalId: 'Zone',
    resourceType: 'AWS::Route53::HostedZone',
    stackName: 'MyStack',
    region: 'us-east-1',
    properties: {},
    ...overrides,
  };
}

function listPage(id: string, name = 'example.com.') {
  return {
    HostedZones: [{ Id: `/hostedzone/${id}`, Name: name, Config: { PrivateZone: false } }],
    IsTruncated: false,
  };
}

describe('Route53Provider hosted-zone import attributes (issue #1875)', () => {
  let provider: Route53Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new Route53Provider();
  });

  // ─── the knownPhysicalId branch ────────────────────────────────────

  describe('--resource override branch', () => {
    it('records NameServers off the verification response, adding no AWS call', async () => {
      mockSend.mockResolvedValueOnce({
        HostedZone: { Id: '/hostedzone/ZKNOWN' },
        DelegationSet: { NameServers: NS },
      });

      const result = await provider.import(makeInput({ knownPhysicalId: 'ZKNOWN' }));

      expect(result).toEqual({
        physicalId: 'ZKNOWN',
        attributes: { Id: 'ZKNOWN', NameServers: NS },
      });
      // The GetHostedZone that VERIFIES the override is the same one that
      // carries the delegation set, so this branch is free.
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0][0].constructor.name).toBe('GetHostedZoneCommand');
    });

    it('records an EMPTY delegation set as a LIST, never as a comma string', async () => {
      // A private hosted zone has no delegation set at all. `?? []` is what
      // `createHostedZone` / `updateHostedZone` / `getHostedZoneAttribute` all
      // do, and a divergence here would resolve differently for an imported
      // zone than for a deployed one (issue #1868's shape).
      mockSend.mockResolvedValueOnce({ HostedZone: { Id: '/hostedzone/ZPRIVATE' } });

      const result = await provider.import(makeInput({ knownPhysicalId: 'ZPRIVATE' }));

      expect(result?.attributes?.['NameServers']).toEqual([]);
      expect(Array.isArray(result?.attributes?.['NameServers'])).toBe(true);
      expect(typeof result?.attributes?.['NameServers']).not.toBe('string');
    });

    it('reports an EMPTY delegation-set array as the same empty LIST', async () => {
      mockSend.mockResolvedValueOnce({
        HostedZone: { Id: '/hostedzone/ZEMPTY' },
        DelegationSet: { NameServers: [] },
      });

      const result = await provider.import(makeInput({ knownPhysicalId: 'ZEMPTY' }));

      expect(result?.attributes).toEqual({ Id: 'ZEMPTY', NameServers: [] });
    });

    it('still returns null for a NoSuchHostedZone override (attribute read did not change it)', async () => {
      const err = new Error('no such zone');
      err.name = 'NoSuchHostedZone';
      mockSend.mockRejectedValueOnce(err);

      await expect(provider.import(makeInput({ knownPhysicalId: 'ZGONE' }))).resolves.toBeNull();
    });

    it('STRIPS the /hostedzone/ prefix from a prefixed override before recording Id', async () => {
      // The prefixed form is reachable: the SDK's idNormalizerMiddleware
      // removes it on the wire, so `--resource MyZone=/hostedzone/Z123`
      // verifies fine. Recording it verbatim would persist an `Id` a deploy
      // never produces, breaking the parity this method promises.
      mockSend.mockResolvedValueOnce({
        HostedZone: { Id: '/hostedzone/ZPREFIXED' },
        DelegationSet: { NameServers: NS },
      });

      const result = await provider.import(
        makeInput({ knownPhysicalId: '/hostedzone/ZPREFIXED' })
      );

      expect(result?.attributes?.['Id']).toBe('ZPREFIXED');
      // physicalId is deliberately recorded as SUPPLIED — normalizing it is a
      // separate decision about resource identity, not about this attribute.
      expect(result?.physicalId).toBe('/hostedzone/ZPREFIXED');
    });
  });

  // ─── the name-lookup branch ────────────────────────────────────────

  describe('template-Name lookup branch', () => {
    it('reads the delegation set with a follow-up GetHostedZone on the resolved id', async () => {
      mockSend.mockResolvedValueOnce(listPage('ZAUTO'));
      mockSend.mockResolvedValueOnce({ DelegationSet: { NameServers: NS } });

      const result = await provider.import(makeInput({ properties: { Name: 'example.com' } }));

      expect(result).toEqual({
        physicalId: 'ZAUTO',
        attributes: { Id: 'ZAUTO', NameServers: NS },
      });
      // ListHostedZonesByName does not return a delegation set, so this branch
      // — unlike the override one — pays one extra call.
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend.mock.calls[0][0].constructor.name).toBe('ListHostedZonesByNameCommand');
      expect(mockSend.mock.calls[1][0].constructor.name).toBe('GetHostedZoneCommand');
      expect(mockSend.mock.calls[1][0].input).toEqual({ Id: 'ZAUTO' });
    });

    it('records an EMPTY delegation set as a LIST on this branch too', async () => {
      mockSend.mockResolvedValueOnce(listPage('ZAUTOPRIV'));
      mockSend.mockResolvedValueOnce({});

      const result = await provider.import(makeInput({ properties: { Name: 'example.com' } }));

      expect(result?.attributes).toEqual({ Id: 'ZAUTOPRIV', NameServers: [] });
    });

    it('ADOPTS the zone anyway when the extra GetHostedZone fails, reporting an EMPTY map', async () => {
      // An import must not hard-fail because one optional attribute could not
      // be read: `import.ts` only aborts when ZERO resources import, so under
      // `--migrate-from-cloudformation` a throw here would cost the row at the
      // exact moment the CloudFormation stack is being retired.
      mockSend.mockResolvedValueOnce(listPage('ZDEGRADED'));
      mockSend.mockRejectedValueOnce(new Error('AccessDenied: route53:GetHostedZone'));

      const result = await provider.import(makeInput({ properties: { Name: 'example.com' } }));

      expect(result?.physicalId).toBe('ZDEGRADED');
      // EMPTY, not a partial `{ Id }`. `import.ts`'s attribute carry-over is
      // gated on the returned map being NON-empty, so a partial map would
      // OVERWRITE a previously-recorded good `NameServers`. The `import.ts`
      // block at the bottom of this file drives that end to end.
      expect(result?.attributes).toEqual({});
      expect(Object.keys(result?.attributes ?? {})).toHaveLength(0);
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('could not read its NameServers')
      );
    });

    it('names a remedy that WORKS — re-import, not a plain deploy', async () => {
      // `deploy-engine.ts` `continue`s on NO_CHANGE, so an unchanged zone
      // never reaches update() and its attributes are never rewritten.
      // Pointing the operator at `cdkd deploy` would be a silent no-op.
      mockSend.mockResolvedValueOnce(listPage('ZREMEDY'));
      mockSend.mockRejectedValueOnce(new Error('AccessDenied: route53:GetHostedZone'));

      await provider.import(makeInput({ properties: { Name: 'example.com' } }));

      const warning = childLogger.warn.mock.calls.at(-1)?.[0] as string;
      expect(warning).toContain('cdkd import --resource Zone=ZREMEDY --force');
      expect(warning).toContain('does NOT heal the record');
    });

    it('DECLINES the row when the zone vanished between the lookup and the read', async () => {
      // Same condition the --resource branch answers with null /
      // skipped-not-found. Adopting a zone AWS demonstrably no longer has is
      // worse than declining it, and the two branches must not disagree.
      const gone = new Error('no such hosted zone');
      gone.name = 'NoSuchHostedZone';
      mockSend.mockResolvedValueOnce(listPage('ZRACED'));
      mockSend.mockRejectedValueOnce(gone);

      const result = await provider.import(makeInput({ properties: { Name: 'example.com' } }));

      expect(result).toBeNull();
      expect(childLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining('could not read its NameServers')
      );
    });

    it('does NOT swallow the resolution failure itself', async () => {
      // The best-effort attribute read must not widen into a catch-all: an
      // ambiguous name still has to reach `importOne` as `failed`.
      mockSend.mockResolvedValueOnce({
        HostedZones: [
          { Id: '/hostedzone/ZA', Name: 'example.com.', Config: { PrivateZone: false } },
          { Id: '/hostedzone/ZB', Name: 'example.com.', Config: { PrivateZone: false } },
        ],
        IsTruncated: false,
      });

      await expect(
        provider.import(makeInput({ properties: { Name: 'example.com' } }))
      ).rejects.toThrow(/matches 2 hosted zones/);
    });
  });

  // ─── parity with the deploy-created zone ───────────────────────────

  describe('parity with the deploy-created zone', () => {
    async function createdAttributes() {
      mockSend.mockResolvedValueOnce({
        HostedZone: { Id: '/hostedzone/ZPARITY' },
        DelegationSet: { NameServers: NS },
      });
      const created = await provider.create('Zone', 'AWS::Route53::HostedZone', {
        Name: 'example.com',
      });
      return created.attributes;
    }

    // BOTH override spellings, because only the prefixed one can diverge —
    // asserting the bare form alone would have passed with the Id recorded
    // verbatim.
    it.each([
      ['a BARE override', 'ZPARITY'],
      ['a /hostedzone/-PREFIXED override', '/hostedzone/ZPARITY'],
    ])('an IMPORTED zone via %s records the identical attribute set', async (_label, known) => {
      mockSend.mockResolvedValueOnce({
        HostedZone: { Id: '/hostedzone/ZPARITY' },
        DelegationSet: { NameServers: NS },
      });
      const imported = await provider.import(makeInput({ knownPhysicalId: known }));

      vi.clearAllMocks();
      expect(imported?.attributes).toEqual(await createdAttributes());
    });

    it('an AUTO-RESOLVED zone records the identical attribute set too', async () => {
      mockSend.mockResolvedValueOnce(listPage('ZPARITY'));
      mockSend.mockResolvedValueOnce({ DelegationSet: { NameServers: NS } });
      const imported = await provider.import(makeInput({ properties: { Name: 'example.com' } }));

      vi.clearAllMocks();
      expect(imported?.attributes).toEqual(await createdAttributes());
    });
  });

  // ─── the actual user symptom, end to end ───────────────────────────

  describe('end-to-end: Fn::Join over the imported record', () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');

    function contextFor(attributes: Record<string, unknown>): ResolverContext {
      return {
        template: {} as CloudFormationTemplate,
        resources: {
          Zone: {
            physicalId: 'ZE2E',
            resourceType: 'AWS::Route53::HostedZone',
            properties: { Name: 'example.com' },
            attributes,
            dependencies: [],
          },
        },
      };
    }

    const OUTPUT = { 'Fn::Join': [',', { 'Fn::GetAtt': ['Zone', 'NameServers'] }] };

    it('resolves the Output that used to be silently dropped', async () => {
      mockSend.mockResolvedValueOnce({
        HostedZone: { Id: '/hostedzone/ZE2E' },
        DelegationSet: { NameServers: NS },
      });
      const imported = await provider.import(makeInput({ knownPhysicalId: 'ZE2E' }));

      // The state record the import writes is fed to the REAL resolver.
      const resolved = await resolver.resolve(OUTPUT, contextFor(imported!.attributes!));

      expect(resolved).toBe(NS.join(','));
    });

    it('resolves to the empty string for a zone with no delegation set', async () => {
      mockSend.mockResolvedValueOnce({ HostedZone: { Id: '/hostedzone/ZE2E' } });
      const imported = await provider.import(makeInput({ knownPhysicalId: 'ZE2E' }));

      // `[]` joins to `''`; a comma STRING would have joined character-wise or
      // thrown, which is the divergence the `?? []` shape rules out.
      await expect(resolver.resolve(OUTPUT, contextFor(imported!.attributes!))).resolves.toBe('');
    });

    it('NEGATIVE CONTROL: the pre-fix empty attribute set still throws', async () => {
      // Pins the mechanism the fix removes rather than trusting that the
      // assertions above could only pass for the right reason.
      await expect(resolver.resolve(OUTPUT, contextFor({}))).rejects.toThrow(
        /Fn::Join's second argument must be a list/
      );
    });
  });
});
