import { describe, it, expect, afterEach } from 'vite-plus/test';
import { SQSClient } from '@aws-sdk/client-sqs';
import {
  AwsClients,
  getAwsClients,
  resetAwsClients,
  runWithStackAwsClients,
  setAwsClients,
} from '../../../src/utils/aws-clients.js';
import { awsClientDefaults } from '../../../src/utils/aws-client-defaults.js';
import {
  ambientRegion,
  currentStackAwsScope,
  runInStackAwsScope,
} from '../../../src/utils/stack-aws-scope.js';
import { ECRProvider } from '../../../src/provisioning/providers/ecr-provider.js';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import { registerAllProviders } from '../../../src/provisioning/register-providers.js';
import {
  acquireIdempotencyToken,
  resetIdempotencyTokensForTests,
} from '../../../src/provisioning/providers/idempotency-token.js';

/**
 * Issue go-to-k/cdkd#1981: the per-stack AWS scope that replaced `deploy.ts`'s
 * process-global `setAwsClients` + `process.env.AWS_REGION` switch. The
 * command-level concurrency case is
 * `tests/unit/cli/deploy-cross-region-stack-scope.test.ts`; this pins each door
 * a consumer reads through, inside and outside a scope.
 *
 * No client built here ever sends: `config.region()` resolves locally.
 */

const savedRegion = process.env['AWS_REGION'];

afterEach(() => {
  if (savedRegion === undefined) delete process.env['AWS_REGION'];
  else process.env['AWS_REGION'] = savedRegion;
  resetAwsClients();
});

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1));

describe('outside a stack scope nothing changes', () => {
  it('reads the environment, injects no region, and serves the global clients', () => {
    process.env['AWS_REGION'] = 'sa-east-1';
    const global = new AwsClients({ region: 'ca-central-1' });
    setAwsClients(global);

    expect(currentStackAwsScope()).toBeUndefined();
    expect(ambientRegion()).toBe('sa-east-1');
    expect('region' in awsClientDefaults()).toBe(false);
    expect(getAwsClients()).toBe(global);
  });
});

describe('inside a stack scope', () => {
  it('serves the scope clients and region through every door', async () => {
    process.env['AWS_REGION'] = 'sa-east-1';
    const global = new AwsClients({ region: 'ca-central-1' });
    setAwsClients(global);
    const stack = new AwsClients({ region: 'eu-west-1' });

    await runWithStackAwsClients(stack, async () => {
      await tick();
      expect(getAwsClients()).toBe(stack);
      expect(ambientRegion()).toBe('eu-west-1');
      expect(awsClientDefaults().region).toBe('eu-west-1');
      // A client a provider builds for itself with no region of its own.
      const client = new SQSClient({ ...awsClientDefaults() });
      expect(await client.config.region()).toBe('eu-west-1');
      client.destroy();
    });

    // ...and the global door is untouched once the scope unwinds.
    expect(getAwsClients()).toBe(global);
    expect(ambientRegion()).toBe('sa-east-1');
  });

  it("lets a site's own explicit region override the scope's", async () => {
    await runWithStackAwsClients(new AwsClients({ region: 'eu-west-1' }), async () => {
      const client = new SQSClient({ ...awsClientDefaults(), region: 'us-west-2' });
      expect(await client.config.region()).toBe('us-west-2');
      client.destroy();
    });
  });

  it('keeps setAwsClients from reaching into a scope', () => {
    const stack = new AwsClients({ region: 'eu-west-1' });
    runWithStackAwsClients(stack, () => {
      setAwsClients(new AwsClients({ region: 'us-west-2' }));
      expect(getAwsClients()).toBe(stack);
    });
  });

  it('isolates two interleaved scopes across awaits', async () => {
    // The #1981 shape in miniature: both scopes are entered before either
    // reads, and each reads only after yielding to the other.
    const east = new AwsClients({ region: 'us-east-1' });
    const west = new AwsClients({ region: 'eu-west-1' });
    let entered = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const probe = async (): Promise<[AwsClients, string | undefined, string | undefined]> => {
      entered++;
      if (entered === 2) release();
      await gate;
      await tick();
      const client = new SQSClient({ ...awsClientDefaults() });
      const sdkRegion = await client.config.region();
      client.destroy();
      return [getAwsClients(), ambientRegion(), sdkRegion];
    };

    const [a, b] = await Promise.all([
      runWithStackAwsClients(east, probe),
      runWithStackAwsClients(west, probe),
    ]);

    expect(a).toEqual([east, 'us-east-1', 'us-east-1']);
    expect(b).toEqual([west, 'eu-west-1', 'eu-west-1']);
  });

  it('lets the innermost of two nested scopes win, and restores the outer', () => {
    const outer = new AwsClients({ region: 'us-east-1' });
    const inner = new AwsClients({ region: 'eu-west-1' });
    runWithStackAwsClients(outer, () => {
      runWithStackAwsClients(inner, () => {
        expect(getAwsClients()).toBe(inner);
        expect(ambientRegion()).toBe('eu-west-1');
      });
      expect(getAwsClients()).toBe(outer);
      expect(ambientRegion()).toBe('us-east-1');
    });
  });

  it('carries the folded region of the clients, not a raw spelling', () => {
    runWithStackAwsClients(new AwsClients({ region: 'EU-WEST-1' }), () => {
      expect(ambientRegion()).toBe('eu-west-1');
    });
  });

  it('reaches a provider that captures its region at construction', async () => {
    // `ECRProvider` is one of the providers whose `providerRegion` field
    // initializer used to read `process.env['AWS_REGION']` directly.
    process.env['AWS_REGION'] = 'sa-east-1';
    const provider = await runWithStackAwsClients(
      new AwsClients({ region: 'eu-west-1' }),
      () => new ECRProvider()
    );
    // Built OUTSIDE the scope on purpose: the region must already be captured.
    const client = (
      provider as unknown as {
        getClient(): { config: { region(): Promise<string> }; destroy(): void };
      }
    ).getClient();
    expect(await client.config.region()).toBe('eu-west-1');
    client.destroy();
  });
});

describe('every registered provider takes its region from the scope', () => {
  it('captures the scope region in each providerRegion field, not the environment', () => {
    // The deploy no longer sets AWS_REGION per stack, so a provider still
    // reading the environment would get the BASE region even in a serial
    // deploy. Registering inside a scope is exactly what deploy.ts does.
    process.env['AWS_REGION'] = 'sa-east-1';
    const registry = runWithStackAwsClients(new AwsClients({ region: 'eu-west-1' }), () => {
      const r = new ProviderRegistry();
      registerAllProviders(r);
      return r;
    });
    const seen = new Set<object>();
    const wrong: string[] = [];
    for (const type of registry.getRegisteredTypes()) {
      const provider = registry.getProvider(type) as unknown as Record<string, unknown>;
      if (seen.has(provider) || !Object.hasOwn(provider, 'providerRegion')) continue;
      seen.add(provider);
      if (provider['providerRegion'] !== 'eu-west-1') {
        wrong.push(`${type}: ${String(provider['providerRegion'])}`);
      }
    }
    expect(wrong).toEqual([]);
    // Floor, so an empty population cannot pass the check above vacuously.
    expect(seen.size).toBeGreaterThanOrEqual(30);
  });
});

describe('idempotency tokens are keyed by the scope region', () => {
  afterEach(() => resetIdempotencyTokensForTests());

  it('mints different tokens for the same resource in two stack regions', () => {
    // One process-wide AWS_REGION for both: only the scope can tell them apart.
    process.env['AWS_REGION'] = 'sa-east-1';
    const mint = (region: string): string =>
      runWithStackAwsClients(
        new AwsClients({ region }),
        () => acquireIdempotencyToken({ scope: 'RunInstances', logicalId: 'Same' }).value
      );
    expect(mint('us-east-1')).not.toBe(mint('eu-west-1'));
  });
});

describe('a scope must name a region', () => {
  it('refuses clients configured without one', () => {
    expect(() => runWithStackAwsClients(new AwsClients(), () => undefined)).toThrow(
      /configured with a region/
    );
  });

  it('refuses an empty region at the scope itself', () => {
    expect(() =>
      runInStackAwsScope({ region: '', clients: new AwsClients() }, () => undefined)
    ).toThrow(/non-empty region/);
  });
});
