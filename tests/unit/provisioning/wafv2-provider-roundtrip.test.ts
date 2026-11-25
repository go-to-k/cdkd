import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateWebACLCommand,
  GetWebACLCommand,
  UpdateWebACLCommand,
} from '@aws-sdk/client-wafv2';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-wafv2', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-wafv2')>(
    '@aws-sdk/client-wafv2'
  );
  return {
    ...actual,
    WAFV2Client: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { WAFv2WebACLProvider } from '../../../src/provisioning/providers/wafv2-provider.js';

const ARN = 'arn:aws:wafv2:us-east-1:123456789012:regional/webacl/my-acl/abc-123';

const RESOURCE_TYPE = 'AWS::WAFv2::WebACL';

describe('WAFv2WebACLProvider read-update round-trip', () => {
  let provider: WAFv2WebACLProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new WAFv2WebACLProvider();
  });

  it('Class 2 — empty Description placeholder is sanitized to undefined on update() round-trip', async () => {
    // Mechanical guard for Class 2 placeholder regression on
    // structurally-incomplete-when-empty fields. See
    // docs/provider-rules.md#readcurrentstate-for-drift-detection.
    //
    // readCurrentState always-emits `Description: ''` on a WebACL with
    // no description (state-keys-only top-level walk requires the
    // placeholder for console-side ADD detection). AWS WAFv2 rejects
    // `Description: ''` on UpdateWebACL with "Member must have length
    // greater than or equal to 1" (min 1, max 256). The Class 2 fix
    // sanitizes empty -> undefined at the wire layer in update().

    // observed = what readCurrentState would have produced on a WebACL
    // without a description.
    const observed: Record<string, unknown> = {
      Name: 'my-acl',
      Scope: 'REGIONAL',
      Description: '',
      DefaultAction: { Allow: {} },
      Rules: [],
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: 'm',
      },
      CustomResponseBodies: {},
      TokenDomains: [],
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    // GetWebACL (LockToken lookup), then UpdateWebACL.
    mockSend
      .mockResolvedValueOnce({
        WebACL: { Id: 'abc-123', Name: 'my-acl' },
        LockToken: 'lt',
      })
      .mockResolvedValueOnce({});

    await provider.update('L', ARN, RESOURCE_TYPE, observed, observed);

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateWebACLCommand);
    expect(updateCall).toBeDefined();
    const input = updateCall![0].input as { Description?: string };
    // Class 2: empty Description placeholder MUST NOT reach AWS as ''
    // (would be rejected with min-length-1 validation).
    expect(input.Description).toBeUndefined();
  });

  it('Class 2 — empty Description placeholder is sanitized to undefined on create() too', async () => {
    // Symmetric guard: create() also takes user properties from state
    // (e.g. CREATE-after-replacement), so the same sanitize must apply.
    const properties: Record<string, unknown> = {
      Name: 'my-acl',
      Scope: 'REGIONAL',
      Description: '',
      DefaultAction: { Allow: {} },
      Rules: [],
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: 'm',
      },
    };

    mockSend.mockResolvedValueOnce({
      Summary: { ARN, Id: 'abc-123' },
    });

    await provider.create('L', RESOURCE_TYPE, properties);

    const createCall = mockSend.mock.calls.find((c) => c[0] instanceof CreateWebACLCommand);
    expect(createCall).toBeDefined();
    const input = createCall![0].input as { Description?: string };
    expect(input.Description).toBeUndefined();
  });

  it('non-empty Description survives the round-trip unchanged', async () => {
    // Negative control: a user-supplied Description must NOT be dropped
    // by the sanitize. Only the empty-string placeholder is filtered.
    const observed: Record<string, unknown> = {
      Name: 'my-acl',
      Scope: 'REGIONAL',
      Description: 'a real description',
      DefaultAction: { Allow: {} },
      Rules: [],
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: 'm',
      },
      CustomResponseBodies: {},
      TokenDomains: [],
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    mockSend
      .mockResolvedValueOnce({
        WebACL: { Id: 'abc-123', Name: 'my-acl' },
        LockToken: 'lt',
      })
      .mockResolvedValueOnce({});

    await provider.update('L', ARN, RESOURCE_TYPE, observed, observed);

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateWebACLCommand);
    const input = updateCall![0].input as { Description?: string };
    expect(input.Description).toBe('a real description');
  });

  it('round-trip: every observed placeholder value reaches UpdateWebACL without AWS-rejection-shaped inputs', async () => {
    // Broad guard: state == AWS-current snapshot, so update() must
    // produce a no-op-equivalent UpdateWebACL call. Verifies no
    // Class 2 placeholder (CustomResponseBodies: {}, TokenDomains: [],
    // Rules: []) translates to an AWS-rejected shape.
    const observed: Record<string, unknown> = {
      Name: 'my-acl',
      Scope: 'REGIONAL',
      Description: '',
      DefaultAction: { Allow: {} },
      Rules: [],
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: 'm',
      },
      CustomResponseBodies: {},
      TokenDomains: [],
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    mockSend
      .mockResolvedValueOnce({
        WebACL: { Id: 'abc-123', Name: 'my-acl' },
        LockToken: 'lt',
      })
      .mockResolvedValueOnce({});

    await provider.update('L', ARN, RESOURCE_TYPE, observed, observed);

    const updateCall = mockSend.mock.calls.find((c) => c[0] instanceof UpdateWebACLCommand);
    const input = updateCall![0].input as Record<string, unknown>;

    // Class 2 — empty Description must be sanitized to undefined.
    expect(input['Description']).toBeUndefined();
    // Empty-array placeholders are accepted by AWS as "no rules / no token
    // domains" and reach the wire as-is.
    expect(input['Rules']).toEqual([]);
    expect(input['TokenDomains']).toEqual([]);
    // go-to-k/cdkd#6986: the empty `CustomResponseBodies` map is NOT accepted
    // (measured: `Value '{}' at 'customResponseBodies' failed to satisfy
    // constraint: Member must have length greater than or equal to 1`), so it
    // is omitted, which the whole-replace UpdateWebACL reads as "none".
    expect(input['CustomResponseBodies']).toBeUndefined();
    // GetWebACL ran for LockToken acquisition.
    expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(GetWebACLCommand);
  });

  describe('CustomResponseBodies on the wire (go-to-k/cdkd#6986)', () => {
    const base: Record<string, unknown> = {
      Name: 'my-acl',
      Scope: 'REGIONAL',
      DefaultAction: { Allow: {} },
      Rules: [],
      VisibilityConfig: {
        SampledRequestsEnabled: true,
        CloudWatchMetricsEnabled: true,
        MetricName: 'm',
      },
    };
    const bodies = {
      blocked: { ContentType: 'TEXT_PLAIN', Content: 'blocked' },
    };

    function primeUpdate(): void {
      mockSend
        .mockResolvedValueOnce({ WebACL: { Id: 'abc-123', Name: 'my-acl' }, LockToken: 'lt' })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ WebACL: { Id: 'abc-123', Name: 'my-acl', Capacity: 2 } });
    }

    function sentUpdate(): Record<string, unknown> {
      const call = mockSend.mock.calls.find((c) => c[0] instanceof UpdateWebACLCommand);
      expect(call).toBeDefined();
      return call![0].input as Record<string, unknown>;
    }

    it('drift --revert: the readback {} is omitted from UpdateWebACL', async () => {
      // The revert's desired bag is the deploy-time readback, which spells a
      // web ACL without custom bodies as `{}`.
      const desired = { ...base, DefaultAction: { Allow: {} }, CustomResponseBodies: {} };
      const previous = { ...base, DefaultAction: { Block: {} }, CustomResponseBodies: {} };
      primeUpdate();

      await provider.update('L', ARN, RESOURCE_TYPE, desired, previous, {
        desiredFromAwsReadback: true,
      });

      const input = sentUpdate();
      expect(input['CustomResponseBodies']).toBeUndefined();
      expect(input['DefaultAction']).toEqual({ Allow: {} });
    });

    it('a declared non-empty map is still sent on update', async () => {
      primeUpdate();

      await provider.update(
        'L',
        ARN,
        RESOURCE_TYPE,
        { ...base, CustomResponseBodies: bodies },
        { ...base, CustomResponseBodies: {} }
      );

      expect(sentUpdate()['CustomResponseBodies']).toEqual(bodies);
    });

    it('create omits an empty map and sends a declared one', async () => {
      mockSend.mockResolvedValueOnce({ Summary: { ARN, Id: 'abc-123' } });
      await provider.create('L', RESOURCE_TYPE, { ...base, CustomResponseBodies: {} });
      mockSend.mockResolvedValueOnce({ Summary: { ARN, Id: 'abc-123' } });
      await provider.create('L2', RESOURCE_TYPE, { ...base, CustomResponseBodies: bodies });

      const creates = mockSend.mock.calls
        .filter((c) => c[0] instanceof CreateWebACLCommand)
        .map((c) => (c[0].input as Record<string, unknown>)['CustomResponseBodies']);
      expect(creates).toEqual([undefined, bodies]);
    });
  });
});
