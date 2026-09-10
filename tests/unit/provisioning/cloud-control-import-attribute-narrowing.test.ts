/**
 * `CloudControlProvider.import` narrows the Cloud Control resource MODEL to the
 * type's schema-declared attributes, masking everything else (issue
 * [#2847](https://github.com/go-to-k/cdkd/issues/2847)).
 *
 * WHAT EACH CASE MUST DISCRIMINATE, because the obvious phrasings do not.
 *
 * A negative alone ("the secret is not in state") passes perfectly on a bag
 * that was never written at all, and would therefore stay green under a
 * mutation that returned `{}` — or under one that dropped the key instead of
 * masking it, which is the specific alternative this fix REJECTED. So every
 * case below pairs the negative with a POSITIVE on the same key: the key is
 * present AND holds `SECRET_MASK`. `toEqual` over the whole bag is used in
 * preference to per-key probes wherever the whole bag is small, since it pins
 * the certified keys and the masked keys in one assertion and cannot be
 * satisfied by a bag that merely lacks the secret.
 *
 * The fixture type is deliberately NOT one with an SDK provider: `import()`
 * routes to Cloud Control only for types with no dedicated provider, so a
 * fixture naming a registered type would exercise a path this class never
 * takes in production.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockCloudControlSend = vi.fn();
const mockCloudFormationSend = vi.fn();
const mockWarn = vi.fn();
const mockDebug = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: mockCloudControlSend, config: { region: vi.fn() } },
    cloudFormation: { send: mockCloudFormationSend },
    dynamoDB: { send: vi.fn() },
    apiGateway: { send: vi.fn() },
    cloudFront: { send: vi.fn() },
    lambda: { send: vi.fn() },
    eventBridge: { send: vi.fn() },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: mockDebug,
      info: vi.fn(),
      warn: mockWarn,
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return {
      child: () => child,
      debug: mockDebug,
      info: vi.fn(),
      warn: mockWarn,
      error: vi.fn(),
    };
  },
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { clearReadOnlyPropertiesCache } from '../../../src/provisioning/read-only-properties.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import { describeTypeRetryDelays } from '../../../src/provisioning/describe-type.js';

const TYPE = 'AWS::Pinpoint::APNSChannel';

/**
 * The real AWS-published shape for this type, trimmed to what the narrowing
 * reads. `Id` is the only readOnly member; `PrivateKey` / `TokenKey` are
 * ordinary writable properties, which is exactly why the Cloud Control model
 * can carry them and why `readOnlyProperties` alone separates them.
 */
const APNS_SCHEMA = JSON.stringify({ readOnlyProperties: ['/properties/Id'] });

/** The plaintext under test. Chosen so it can never coincide with a key name. */
const APNS_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----zz-lane2847-zz';

function wireGetResource(model: Record<string, unknown>): void {
  mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'GetResourceCommand') {
      return Promise.resolve({
        ResourceDescription: { Identifier: 'chan-1', Properties: JSON.stringify(model) },
      });
    }
    return Promise.reject(new Error(`unexpected command ${cmd.constructor.name}`));
  });
}

describe('CloudControlProvider.import attribute narrowing (issue #2847)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearReadOnlyPropertiesCache();
    describeTypeRetryDelays.sleep = async () => {};
  });

  it('masks a writable model key carrying a credential while keeping the declared attribute', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: APNS_SCHEMA });
    wireGetResource({
      Id: 'chan-1',
      PrivateKey: APNS_PRIVATE_KEY,
      BundleId: 'com.example.app',
    });

    const result = await new CloudControlProvider().import({
      logicalId: 'Chan',
      resourceType: TYPE,
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'chan-1',
    });

    // POSITIVE + NEGATIVE in one assertion: `Id` survives as a real value,
    // `PrivateKey` is PRESENT and masked (not dropped — dropping it would make
    // `Fn::GetAtt` fall through to `constructAttribute`'s physical-id
    // fallback), and `BundleId` is masked for the same structural reason even
    // though it is not a secret.
    expect(result?.attributes).toEqual({
      Id: 'chan-1',
      PrivateKey: SECRET_MASK,
      BundleId: SECRET_MASK,
    });
    // The plaintext must not survive ANYWHERE in the returned record.
    expect(JSON.stringify(result)).not.toContain(APNS_PRIVATE_KEY);
  });

  it('FAILS CLOSED when the schema cannot be resolved: every key masked, and a warning naming the grant', async () => {
    mockCloudFormationSend.mockRejectedValue(new Error('AccessDenied'));
    wireGetResource({ Id: 'chan-1', PrivateKey: APNS_PRIVATE_KEY });

    const result = await new CloudControlProvider().import({
      logicalId: 'Chan',
      resourceType: TYPE,
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'chan-1',
    });

    // Not even `Id` is certified here — with no schema, cdkd cannot tell an
    // attribute from a property, and failing OPEN would let a missing IAM
    // permission silently restore the whole disclosure.
    expect(result?.attributes).toEqual({ Id: SECRET_MASK, PrivateKey: SECRET_MASK });
    expect(JSON.stringify(result)).not.toContain(APNS_PRIVATE_KEY);

    // The refusal must be VISIBLE and actionable, not a debug line.
    const warned = mockWarn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('cloudformation:DescribeType');
    expect(warned).toContain(TYPE);
  });

  it('does not warn about a missing grant when the schema resolved fine', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: APNS_SCHEMA });
    wireGetResource({ Id: 'chan-1', BundleId: 'com.example.app' });

    await new CloudControlProvider().import({
      logicalId: 'Chan',
      resourceType: TYPE,
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'chan-1',
    });

    // The OTHER direction (issue #2027's rule): a fence that only ever refuses
    // is indistinguishable from one that refuses everything.
    const warned = mockWarn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).not.toContain('cloudformation:DescribeType');
  });

  it('masks an UNCERTIFIED container LEAF-WISE, keeping the shape the resolver dot-path walk needs', async () => {
    // THE CASE THE FIRST CUT GOT WRONG (issue #2847 security review). Replacing
    // the whole VALUE made `Endpoint` the string `'***'`; `resolveGetAtt`'s
    // dotted walk tests `typeof cursor === 'object'`, so it broke with
    // `cursor === undefined`, never called `noteAttributeSecrecy`, and fell
    // through to `constructAttribute`'s physical-id fallback — the silently
    // wrong value the mask exists to prevent. Masking leaves keeps the walk
    // alive so it lands on a masked LEAF and the refusal fires.
    mockCloudFormationSend.mockResolvedValue({
      Schema: JSON.stringify({ readOnlyProperties: ['/properties/Id'] }),
    });
    wireGetResource({
      Id: 'chan-1',
      Endpoint: { Address: 'db.example.com', Port: 5432 },
      Hosts: [{ Name: 'a' }, { Name: 'b' }],
    });

    const result = await new CloudControlProvider().import({
      logicalId: 'Chan',
      resourceType: TYPE,
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'chan-1',
    });

    // Shape preserved, every LEAF masked — asserted as the whole bag, so a
    // regression back to whole-value masking (`Endpoint: '***'`) reds here.
    expect(result?.attributes).toEqual({
      Id: 'chan-1',
      Endpoint: { Address: SECRET_MASK, Port: SECRET_MASK },
      Hosts: [{ Name: SECRET_MASK }, { Name: SECRET_MASK }],
    });
    // The container must still BE a container for the resolver's walk.
    expect(typeof result?.attributes?.['Endpoint']).toBe('object');
    // Array length and element positions survive too.
    expect(Array.isArray(result?.attributes?.['Hosts'])).toBe(true);
    expect((result?.attributes?.['Hosts'] as unknown[]).length).toBe(2);
  });

  it('masks null / nested arrays / deep nesting, and leaves an EMPTY container empty', async () => {
    // The leaf-walk's own branches, none of which the container case reaches.
    // The empty-container row is a KNOWN gap rather than a desired outcome:
    // there is no leaf to mask, so no `***` lands under that key and the
    // refusal cannot fire for a dotted read through it. Pinned so the method's
    // doc claim about it stays honest.
    mockCloudFormationSend.mockResolvedValue({
      Schema: JSON.stringify({ readOnlyProperties: ['/properties/Id'] }),
    });
    wireGetResource({
      Id: 'chan-1',
      Nulled: null,
      EmptyObj: {},
      EmptyArr: [],
      Matrix: [
        ['a', 'b'],
        ['c', 'd'],
      ],
      Deep: { a: { b: { c: 'zz-lane2847-deep' } } },
    });

    const result = await new CloudControlProvider().import({
      logicalId: 'Chan',
      resourceType: TYPE,
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'chan-1',
    });

    expect(result?.attributes).toEqual({
      Id: 'chan-1',
      Nulled: SECRET_MASK,
      EmptyObj: {},
      EmptyArr: [],
      Matrix: [
        [SECRET_MASK, SECRET_MASK],
        [SECRET_MASK, SECRET_MASK],
      ],
      Deep: { a: { b: { c: SECRET_MASK } } },
    });
    expect(JSON.stringify(result)).not.toContain('zz-lane2847-deep');
  });

  it('records no attributes, with a diagnosable line, when the model parses to a non-object', async () => {
    mockCloudFormationSend.mockResolvedValue({
      Schema: JSON.stringify({ readOnlyProperties: ['/properties/Id'] }),
    });
    mockCloudControlSend.mockImplementation(() =>
      Promise.resolve({
        ResourceDescription: { Identifier: 'chan-1', Properties: '["not","an","object"]' },
      })
    );

    const result = await new CloudControlProvider().import({
      logicalId: 'Chan',
      resourceType: TYPE,
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'chan-1',
    });

    // The physical id still registers the resource; the point is that this
    // path no longer passes SILENTLY, which it did until the `try` narrowing
    // walked past it.
    expect(result?.physicalId).toBe('chan-1');
    expect(result?.attributes).toEqual({});
    const debugged = mockDebug.mock.calls.map((c) => String(c[0])).join('\n');
    expect(debugged).toContain('parsed to an array');
  });

  it('keeps a model key literally named __proto__ as an OWN property rather than dropping it', async () => {
    // `JSON.parse` yields `__proto__` as a legal own key. Assigning it on an
    // ordinary object literal writes the PROTOTYPE and the key vanishes — a
    // DROP, the one outcome this method must never produce.
    mockCloudFormationSend.mockResolvedValue({
      Schema: JSON.stringify({ readOnlyProperties: ['/properties/Id'] }),
    });
    mockCloudControlSend.mockImplementation(() =>
      Promise.resolve({
        ResourceDescription: {
          Identifier: 'chan-1',
          // Built as raw JSON text so the key really arrives via JSON.parse.
          Properties: '{"Id":"chan-1","__proto__":"zz-lane2847-proto"}',
        },
      })
    );

    const result = await new CloudControlProvider().import({
      logicalId: 'Chan',
      resourceType: TYPE,
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'chan-1',
    });

    const attrs = result?.attributes as Record<string, unknown>;
    expect(Object.hasOwn(attrs, '__proto__')).toBe(true);
    expect(attrs['__proto__']).toBe(SECRET_MASK);
    expect(JSON.stringify(result)).not.toContain('zz-lane2847-proto');
  });

  it('warns ONCE PER TYPE, not once per resource, when the schema is unresolvable', async () => {
    mockCloudFormationSend.mockRejectedValue(new Error('AccessDenied'));
    wireGetResource({ Id: 'chan-1' });
    const provider = new CloudControlProvider();

    for (const id of ['chan-1', 'chan-2', 'chan-3']) {
      await provider.import({
        logicalId: 'Chan',
        resourceType: TYPE,
        stackName: 'S',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: id,
      });
    }

    const grantWarnings = mockWarn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes('cloudformation:DescribeType'));
    expect(grantWarnings).toHaveLength(1);
  });

  it('masks every key with NO warning when the schema resolves but declares no attributes', async () => {
    // Distinct from the fail-closed arm and easy to conflate with it: here cdkd
    // KNOWS the type has no attributes, so the outcome is the same bag but the
    // missing-permission warning must NOT fire.
    mockCloudFormationSend.mockResolvedValue({ Schema: JSON.stringify({}) });
    wireGetResource({ Id: 'chan-1', BundleId: 'com.example.app' });

    const result = await new CloudControlProvider().import({
      logicalId: 'Chan',
      resourceType: 'AWS::Example::NoAttrs',
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'chan-1',
    });

    expect(result?.attributes).toEqual({ Id: SECRET_MASK, BundleId: SECRET_MASK });
    const warned = mockWarn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).not.toContain('cloudformation:DescribeType');
  });

  it('keeps a nested attribute CONTAINER intact, so the resolver dot-path walk still resolves', async () => {
    mockCloudFormationSend.mockResolvedValue({
      Schema: JSON.stringify({ readOnlyProperties: ['/properties/Endpoint/Address'] }),
    });
    wireGetResource({
      Endpoint: { Address: 'db.example.com', Port: 5432 },
      MasterUserPassword: 'zz-lane2847-pw',
    });

    const result = await new CloudControlProvider().import({
      logicalId: 'Db',
      resourceType: 'AWS::Example::Db',
      stackName: 'S',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'db-1',
    });

    // The whole `Endpoint` OBJECT survives (not just `Address`) — reducing the
    // pointer to its leaf would leave nothing for `Fn::GetAtt Endpoint.Port`
    // to descend into, which is issue #381's walk.
    expect(result?.attributes).toEqual({
      Endpoint: { Address: 'db.example.com', Port: 5432 },
      MasterUserPassword: SECRET_MASK,
    });
  });
});
