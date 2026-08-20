import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
}));

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

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { HostedZoneAlreadyExists } from '@aws-sdk/client-route-53';

import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import { resetIdempotencyTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import { withRetry } from '../../../src/deployment/retry.js';

const transient500 = (): Error =>
  Object.assign(new Error('We encountered an internal error. Please try again.'), {
    name: 'InternalError',
    $metadata: { httpStatusCode: 500 },
  });

/**
 * A fake Route 53 modelling the behaviour the fix relies on: a hosted zone is
 * keyed by its CallerReference, a repeat of a known one is REFUSED (rather than
 * silently returning the zone), and a distinct one creates a SECOND zone for the
 * same domain — which is what makes an unstable caller reference a duplicate
 * generator rather than a harmless retry.
 */
class FakeRoute53 {
  /** zoneId -> { name, callerReference } */
  readonly zones = new Map<string, { name: string; callerReference: string }>();
  private nextId = 1;
  loseNextCreateResponse = false;
  /** Drive the post-create rollback arm (UpdateHostedZoneFeatures failing). */
  updateFeaturesFails = false;
  /** Make the rollback's DeleteHostedZone fail, leaving the zone live. */
  deleteHostedZoneFails = false;
  /** DNSName each ListHostedZonesByName page was asked for. */
  readonly listCalls: string[] = [];

  send = (command: { constructor: { name: string }; input: Record<string, unknown> }): unknown => {
    const input = command.input;
    switch (command.constructor.name) {
      case 'CreateHostedZoneCommand': {
        const callerReference = input['CallerReference'] as string;
        for (const zone of this.zones.values()) {
          if (zone.callerReference === callerReference) {
            return Promise.reject(
              new HostedZoneAlreadyExists({
                message: 'A hosted zone has already been created with the specified caller reference.',
                $metadata: {},
              })
            );
          }
        }
        const zoneId = `Z${String(this.nextId++).padStart(4, '0')}`;
        // Route 53 stores zone names fully qualified, and the provider's
        // name-scoped lookup compares against that form. A fake that echoed the
        // template's dot-less spelling back would make the lookup miss.
        const name = String(input['Name']).endsWith('.')
          ? String(input['Name'])
          : `${String(input['Name'])}.`;
        this.zones.set(zoneId, { name, callerReference });
        if (this.loseNextCreateResponse) {
          this.loseNextCreateResponse = false;
          throw transient500();
        }
        return Promise.resolve({
          HostedZone: { Id: `/hostedzone/${zoneId}`, Name: input['Name'], CallerReference: callerReference },
          DelegationSet: { NameServers: ['ns-1.example.', 'ns-2.example.'] },
        });
      }
      case 'ListHostedZonesByNameCommand': {
        // Honours DNSName and paginates ONE zone at a time, so the lookup's
        // name-scoped early return and its truncation branch are both
        // exercised. A fake that returns every zone on one page leaves the
        // part of the adopt path that decides WHICH zones are considered
        // completely untested.
        this.listCalls.push(String(input['DNSName'] ?? ''));
        const ordered = [...this.zones.entries()].sort(([, a], [, b]) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0
        );
        const startAt = input['DNSName']
          ? ordered.findIndex(
              ([id, zone]) =>
                zone.name >= String(input['DNSName']) &&
                (!input['HostedZoneId'] || id === String(input['HostedZoneId']))
            )
          : 0;
        const from = startAt === -1 ? ordered.length : startAt;
        const page = ordered.slice(from, from + 1);
        const next = ordered[from + 1];
        return Promise.resolve({
          HostedZones: page.map(([id, zone]) => ({
            Id: `/hostedzone/${id}`,
            Name: zone.name,
            CallerReference: zone.callerReference,
          })),
          IsTruncated: next !== undefined,
          ...(next ? { NextDNSName: next[1].name, NextHostedZoneId: next[0] } : {}),
        });
      }
      case 'UpdateHostedZoneFeaturesCommand':
        return this.updateFeaturesFails
          ? Promise.reject(transient500())
          : Promise.resolve({});
      case 'ListQueryLoggingConfigsCommand':
        return Promise.resolve({ QueryLoggingConfigs: [] });
      case 'DeleteHostedZoneCommand': {
        if (this.deleteHostedZoneFails) {
          return Promise.reject(new Error('UnauthorizedOperation: route53:DeleteHostedZone'));
        }
        this.zones.delete(String(input['Id']).replace('/hostedzone/', ''));
        return Promise.resolve({});
      }
      case 'GetHostedZoneCommand': {
        const id = String(input['Id']).replace('/hostedzone/', '');
        const zone = this.zones.get(id);
        return Promise.resolve({
          HostedZone: { Id: `/hostedzone/${id}`, Name: zone?.name, CallerReference: zone?.callerReference },
          DelegationSet: { NameServers: ['ns-1.example.', 'ns-2.example.'] },
        });
      }
      default:
        return Promise.resolve({});
    }
  };
}

/**
 * The retry's sleep, with the CLOCK ADVANCED.
 *
 * Load-bearing rather than cosmetic: the defect this file fences is a
 * `Date.now()`-derived caller reference, and two attempts separated by no real
 * time land in the SAME millisecond — so a same-instant fixture reports the
 * broken derivation as idempotent and cannot discriminate at all (measured: the
 * pre-fix code passed the duplicate-zone assertion). The real schedule sleeps at
 * least 250ms between attempts, and advancing a faked clock reproduces that
 * without spending it.
 */
const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

describe('Route53Provider hosted-zone CallerReference (issue #2039)', () => {
  let provider: Route53Provider;
  let aws: FakeRoute53;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    resetIdempotencyTokensForTests();
    aws = new FakeRoute53();
    mockSend.mockReset();
    mockSend.mockImplementation(aws.send);
    warnSpy.mockReset();
    provider = new Route53Provider();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a retried create after a lost response leaves exactly ONE hosted zone', async () => {
    aws.loseNextCreateResponse = true;

    const result = await withRetry(
      () => provider.create('Zone', 'AWS::Route53::HostedZone', { Name: 'example.com' }),
      'Zone',
      { sleep: advancingSleep }
    );

    expect(aws.zones.size).toBe(1);
    expect(result.physicalId).toBe('Z0001');
  });

  it('returns the adopted zone with its name servers, as a first-attempt create would', async () => {
    aws.loseNextCreateResponse = true;

    const result = await withRetry(
      () => provider.create('Zone', 'AWS::Route53::HostedZone', { Name: 'example.com' }),
      'Zone',
      { sleep: advancingSleep }
    );

    // The NameServers assertion alone is NOT a discriminator: a per-attempt
    // caller reference simply creates a second zone and returns ITS name
    // servers, which look identical. What makes this case discriminate is that
    // the servers must come from the FIRST zone -- the one the lost response
    // described -- with no second zone in existence.
    expect(result.physicalId).toBe('Z0001');
    expect(aws.zones.size).toBe(1);
    expect(result.attributes?.['NameServers']).toEqual(['ns-1.example.', 'ns-2.example.']);
  });

  it('releases the caller reference when the post-create rollback DELETED the zone', async () => {
    // UpdateHostedZoneFeatures fails after the zone exists, so create() rolls
    // the zone back. The retry must mint a NEW caller reference: reusing one
    // whose zone is gone would be refused as already-existing and then find
    // nothing to adopt, wedging the create permanently.
    aws.updateFeaturesFails = true;
    let firstAttempt = true;
    mockSend.mockImplementation(
      (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command.constructor.name === 'UpdateHostedZoneFeaturesCommand' && !firstAttempt) {
          return Promise.resolve({});
        }
        if (command.constructor.name === 'UpdateHostedZoneFeaturesCommand') {
          firstAttempt = false;
        }
        return aws.send(command as never);
      }
    );

    const result = await withRetry(
      () =>
        provider.create('Zone', 'AWS::Route53::HostedZone', {
          Name: 'example.com',
          HostedZoneFeatures: { AcceleratedRecoveryStatus: 'ENABLED' },
        }),
      'Zone',
      { sleep: advancingSleep }
    );

    // One zone alive, and it is the SECOND one: the first was rolled back.
    expect(aws.zones.size).toBe(1);
    expect(result.physicalId).toBe('Z0002');
  });

  it('KEEPS the caller reference when the rollback delete itself failed', async () => {
    // The zone is still live, so the retry must be handed THAT zone rather than
    // creating a second one beside an orphan cdkd state never names.
    aws.updateFeaturesFails = true;
    aws.deleteHostedZoneFails = true;
    let firstAttempt = true;
    mockSend.mockImplementation(
      (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command.constructor.name === 'UpdateHostedZoneFeaturesCommand' && !firstAttempt) {
          return Promise.resolve({});
        }
        if (command.constructor.name === 'UpdateHostedZoneFeaturesCommand') {
          firstAttempt = false;
        }
        return aws.send(command as never);
      }
    );

    const result = await withRetry(
      () =>
        provider.create('Zone', 'AWS::Route53::HostedZone', {
          Name: 'example.com',
          HostedZoneFeatures: { AcceleratedRecoveryStatus: 'ENABLED' },
        }),
      'Zone',
      { sleep: advancingSleep }
    );

    expect(aws.zones.size).toBe(1);
    expect(result.physicalId).toBe('Z0001');
  });

  it('mints a FRESH caller reference for a later create of the same logical id', async () => {
    await provider.create('Zone', 'AWS::Route53::HostedZone', { Name: 'example.com' });
    await provider.create('Zone', 'AWS::Route53::HostedZone', { Name: 'example.com' });

    // Two deliberate creates are two zones; only a REPLAY collapses onto one.
    expect(aws.zones.size).toBe(2);
    const references = [...aws.zones.values()].map((zone) => zone.callerReference);
    expect(new Set(references).size).toBe(2);
  });

  it('finds the zone across a TRUNCATED listing', async () => {
    // The fake pages one zone at a time, so an account holding several zones
    // for the same name forces the truncation branch. Before this, the fake
    // returned everything on one page and that branch was never executed.
    aws.zones.set('Z9001', { name: 'example.com.', callerReference: 'someone-else-1' });
    aws.zones.set('Z9002', { name: 'example.com.', callerReference: 'someone-else-2' });
    aws.loseNextCreateResponse = true;

    const result = await withRetry(
      () => provider.create('Zone', 'AWS::Route53::HostedZone', { Name: 'example.com' }),
      'Zone',
      { sleep: advancingSleep }
    );

    expect(result.physicalId).toBe('Z0001');
    expect(aws.listCalls.length).toBeGreaterThan(1);
  });

  it('never adopts a zone for a DIFFERENT name, even on a caller-reference match', async () => {
    // ListHostedZonesByName is name-ordered, so once the name changes no later
    // page can hold ours and the walk stops. Without that stop the lookup would
    // keep paging the account and could adopt a zone for another domain --
    // returning a physical id for a name the template never asked for.
    //
    // The decoy carries the SAME caller reference on purpose: any weaker setup
    // is rejected by the token comparison anyway and so cannot tell whether the
    // name check ran at all.
    mockSend.mockImplementation(
      (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command.constructor.name === 'CreateHostedZoneCommand') {
          // Our own zone is NOT created; a differently-named zone holds the token.
          aws.zones.set('Z9100', {
            name: 'zzz-later.com.',
            callerReference: String(command.input['CallerReference']),
          });
          return Promise.reject(
            new HostedZoneAlreadyExists({ message: 'already exists', $metadata: {} })
          );
        }
        return aws.send(command as never);
      }
    );

    await expect(
      provider.create('Zone', 'AWS::Route53::HostedZone', { Name: 'example.com' })
    ).rejects.toThrow('Failed to create hosted zone');
  });

  it('reports the ORIGINAL error when the adopt lookup is not permitted', async () => {
    // A missing route53:ListHostedZonesByName must not replace the diagnosis
    // with AccessDenied -- that sends the next reader after a permissions
    // problem instead of the caller-reference collision that happened.
    mockSend.mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'CreateHostedZoneCommand') {
        return Promise.reject(
          new HostedZoneAlreadyExists({ message: 'already exists', $metadata: {} })
        );
      }
      if (command.constructor.name === 'ListHostedZonesByNameCommand') {
        return Promise.reject(new Error('AccessDenied: route53:ListHostedZonesByName'));
      }
      return Promise.resolve({});
    });

    await expect(
      provider.create('Zone', 'AWS::Route53::HostedZone', { Name: 'example.com' })
    ).rejects.toThrow('already exists');
  });

  it('matches HostedZoneAlreadyExists by NAME, so a duplicate SDK copy cannot defeat the adopt', async () => {
    // `instanceof` fails when a second @aws-sdk/client-route-53 in the tree
    // gives the error a different class object; the adopt path would then
    // silently never run.
    const structural = Object.assign(new Error('already exists'), {
      name: 'HostedZoneAlreadyExists',
    });
    let created = false;
    mockSend.mockImplementation(
      (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        if (command.constructor.name === 'CreateHostedZoneCommand' && created) {
          return Promise.reject(structural);
        }
        if (command.constructor.name === 'CreateHostedZoneCommand') {
          created = true;
        }
        return aws.send(command as never);
      }
    );
    aws.loseNextCreateResponse = true;

    const result = await withRetry(
      () => provider.create('Zone', 'AWS::Route53::HostedZone', { Name: 'example.com' }),
      'Zone',
      { sleep: advancingSleep }
    );

    expect(result.physicalId).toBe('Z0001');
    expect(aws.zones.size).toBe(1);
  });

  it('rethrows HostedZoneAlreadyExists when no zone carries the caller reference', async () => {
    // Somebody else's zone holds the name; ours is nowhere to be found. Adopting
    // a zone we cannot identify would be worse than failing.
    mockSend.mockImplementation((command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'CreateHostedZoneCommand') {
        return Promise.reject(
          new HostedZoneAlreadyExists({ message: 'already exists', $metadata: {} })
        );
      }
      return Promise.resolve({ HostedZones: [], IsTruncated: false });
    });

    await expect(
      provider.create('Zone', 'AWS::Route53::HostedZone', { Name: 'example.com' })
    ).rejects.toThrow('Failed to create hosted zone');
  });
});
