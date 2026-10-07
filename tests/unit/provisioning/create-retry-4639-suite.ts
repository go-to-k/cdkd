/**
 * The go-to-k/cdkd#4639 cases every name-unique, token-less create runs. Kept
 * apart from `create-retry-4639-harness.ts`, which the hoisted SDK mock
 * factories import: this module reaches `src/`, which imports the SDK packages
 * those factories are still building.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { ResourceProvider } from '../../../src/types/resource.js';
import { AwsClients, getAwsClients, setAwsClients } from '../../../src/utils/aws-clients.js';
import { withRetry } from '../../../src/deployment/retry.js';
import {
  hasReplayMayCollide,
  isNameCollisionErrorFrom,
  isReplayedNameCollisionFrom,
} from '../../../src/deployment/retryable-errors.js';
import {
  isAuxiliaryMarkOf,
  RETRY_AUXILIARY_OWNER,
} from '../../../src/provisioning/auxiliary-failure.js';
import {
  FakeNamedCreates,
  advancingSleep,
  configsOf,
  expectFullSdkRetry,
  expectRefusesServerErrorReplay,
  sentVia,
  transient500,
  useService,
  type NamedCreate,
} from './create-retry-4639-harness.js';

export interface CreateSite {
  type: string;
  /** The SDK command class name of the create under test. */
  command: string;
  /** The name the create sends, which the fake collides on. */
  name: string;
  props: Record<string, unknown>;
  provider: () => ResourceProvider;
  /** AWS's collision text says "already exists", so the prose classifier reads it. */
  prose: boolean;
  /** The region every client must resolve; defaults to the stubbed stack region. */
  region?: string;
}

/** The stack region the suite stubs, distinct from every client default. */
const STACK_REGION = 'eu-west-3';

export function describeCreateRetrySafety(
  sites: CreateSite[],
  creates: Record<string, NamedCreate>,
  options: { identitySwitch: boolean } = { identitySwitch: true }
): void {
  describe.each(sites)('$type create retry safety (issue #4639)', (site) => {
    let provider: ResourceProvider;
    let aws: FakeNamedCreates;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-07T00:00:00Z'));
      // Read by `ambientRegion()` when the provider is built below.
      vi.stubEnv('AWS_REGION', STACK_REGION);
      aws = new FakeNamedCreates(creates);
      useService(aws.send);
      provider = site.provider();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    });

    const createWithRetry = () =>
      withRetry(() => provider.create('Res', site.type, site.props), 'Res', {
        sleep: advancingSleep,
      });

    it('a lost create response surfaces the replay collision as one THIS create may have made', async () => {
      aws.loseNextResponse.set(site.command, transient500());

      const error = await createWithRetry().catch((e: unknown) => e);

      // One resource, never two: the name collides rather than duplicating.
      expect([...aws.names.get(site.command)!]).toEqual([site.name]);
      // The 5xx left the SDK unreplayed and reached the engine's retry, which
      // sent the create again in a SECOND send.
      expect(sentVia.filter(([n]) => n === site.command)).toHaveLength(2);
      expect(aws.calls.filter((c) => c === site.command)).toHaveLength(2);
      // The engine stamped the collision as possibly this create's own, the
      // verdict no delete-first path may act on. Nothing is adopted: the
      // collision is the error.
      expect(hasReplayMayCollide(error)).toBe(true);
      expect(isNameCollisionErrorFrom(error, 'Res')).toBe(false);
      if (site.prose) {
        expect(
          isReplayedNameCollisionFrom(error, 'Res', (link) =>
            isAuxiliaryMarkOf(link, RETRY_AUXILIARY_OWNER)
          )
        ).toBe(true);
      }
    });

    it('a name that already existed before any ambiguous attempt is not stamped as replayed', async () => {
      aws.names.get(site.command)!.add(site.name);

      const error = await createWithRetry().catch((e: unknown) => e);

      expect(aws.calls.filter((c) => c === site.command)).toHaveLength(1);
      expect(hasReplayMayCollide(error)).toBe(false);
      if (site.prose) expect(isNameCollisionErrorFrom(error, 'Res')).toBe(true);
    });

    it('sends the create through a client that refuses the SDK retry of a 5xx, and nothing else', async () => {
      aws.names.get(site.command)!.add(site.name);
      await provider.create('Res', site.type, site.props).catch(() => undefined);
      await provider
        .readCurrentState!(site.name, 'Res', site.type, site.props)
        .catch(() => undefined);

      for (const config of configsOf(site.command)) await expectRefusesServerErrorReplay(config);
      const others = sentVia.filter(([n]) => n !== site.command);
      expect(others.length).toBeGreaterThan(0);
      for (const [, config] of others) await expectFullSdkRetry(config);
      // The create lands in the region of the calls around it.
      for (const [, config] of sentVia) {
        expect(await config.region()).toBe(site.region ?? STACK_REGION);
      }
    });

    it.runIf(options.identitySwitch)(
      'builds the create client with the identity of the client every other call uses',
      async () => {
        const previous = getAwsClients();
        try {
          setAwsClients(new AwsClients({ profile: 'first-profile' }));
          await provider
            .readCurrentState!(site.name, 'Res', site.type, site.props)
            .catch(() => undefined);
          // A switch between the provider's first call and its create.
          setAwsClients(new AwsClients({ profile: 'second-profile' }));
          aws.names.get(site.command)!.add(site.name);
          await provider.create('Res', site.type, site.props).catch(() => undefined);
        } finally {
          setAwsClients(previous);
        }

        expect(configsOf(site.command).length).toBeGreaterThan(0);
        expect(sentVia.length).toBeGreaterThan(configsOf(site.command).length);
        for (const [, config] of sentVia) expect(config.profile).toBe('first-profile');
      }
    );
  });
}
