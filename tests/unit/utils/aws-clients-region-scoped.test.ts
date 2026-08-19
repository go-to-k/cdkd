import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { AwsClients } from '../../../src/utils/aws-clients.js';

/**
 * The region + credential plumbing behind issue
 * [#1957](https://github.com/go-to-k/cdkd/issues/1957).
 *
 * Deliberately NO mocks. The subject is what the REAL SDK client ends up
 * configured with, and what it reports back about itself, so these cases build
 * real clients and read their resolved config.
 *
 * What these cases can and cannot prove about credentials, stated because the
 * distinction is easy to overclaim: they prove the `profile` KEY and an
 * explicit `credentials` object reach the constructed client and survive a
 * region override. They do NOT prove credentials actually resolve FROM that
 * profile — that needs a real `~/.aws/credentials`, which is an integ concern,
 * not a unit one.
 */
describe('AwsClients — region-scoped siblings (issue #1957)', () => {
  let savedRegion: string | undefined;
  let savedDefaultRegion: string | undefined;

  beforeEach(() => {
    savedRegion = process.env['AWS_REGION'];
    savedDefaultRegion = process.env['AWS_DEFAULT_REGION'];
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
  });

  afterEach(() => {
    if (savedRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = savedRegion;
    if (savedDefaultRegion === undefined) delete process.env['AWS_DEFAULT_REGION'];
    else process.env['AWS_DEFAULT_REGION'] = savedDefaultRegion;
  });

  describe('configuredRegion', () => {
    it('reports the explicitly configured region', () => {
      expect(new AwsClients({ region: 'ap-northeast-1' }).configuredRegion).toBe('ap-northeast-1');
    });

    it('does NOT consult the environment', () => {
      // Note there is deliberately no `resolveRegion()` beside this getter
      // either. An earlier revision had one — it asked `ssm.config.region()` —
      // and it was unsound: `clientOptions` omits `region` for an unconfigured
      // instance, so every service client resolves and memoizes its OWN region
      // at its OWN first construction, and one member cannot answer for the
      // bag. A caller needing a region it can rely on must build a CONFIGURED
      // bag via `withRegion`, whose members agree by construction.
      // The load-bearing property, not an omission. An env read here is
      // unstable in the dangerous direction: the SDK memoizes a region-less
      // client's region at first resolution while `deploy.ts`'s `switchRegion`
      // keeps mutating AWS_REGION per stack, so an env-derived answer can
      // describe a client that pinned itself to a different region long ago —
      // and a caller comparing against it would conclude "already correct" and
      // use the wrong clients.
      process.env['AWS_REGION'] = 'eu-west-1';
      expect(new AwsClients({}).configuredRegion).toBeUndefined();
      expect(new AwsClients({ region: 'ap-northeast-1' }).configuredRegion).toBe('ap-northeast-1');
    });

    it('treats an empty configured region as unset', () => {
      expect(new AwsClients({ region: '' }).configuredRegion).toBeUndefined();
    });
  });

  describe('credentialConfig', () => {
    it('carries profile and explicit credentials but NEVER the region', () => {
      const credentials = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' };
      const config = new AwsClients({ region: 'us-east-1', profile: 'p', credentials })
        .credentialConfig;
      expect(config).toEqual({ profile: 'p', credentials });
      expect(config).not.toHaveProperty('region');
    });

    it('omits absent halves rather than emitting undefined values', () => {
      expect(new AwsClients({ region: 'us-east-1' }).credentialConfig).toEqual({});
    });

    it('CLONES the credentials so a caller cannot mutate the source instance', () => {
      // The bag is handed to every derived sibling; aliasing one mutable object
      // would let a caller reach through it and rewrite the ambient
      // credentials.
      const credentials = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' };
      const ambient = new AwsClients({ region: 'us-east-1', credentials });
      const taken = ambient.credentialConfig.credentials;
      expect(taken).not.toBe(credentials);
      taken!.accessKeyId = 'AKIAMUTATED';
      expect(ambient.credentialConfig.credentials?.accessKeyId).toBe('AKIAEXAMPLE');
    });
  });

  describe('withRegion', () => {
    it('overrides ONLY the region and hands the credential config to the real SDK client', async () => {
      const credentials = { accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' };
      const ambient = new AwsClients({ region: 'us-east-1', credentials });

      const scoped = ambient.withRegion('ap-northeast-1');

      expect(scoped).not.toBe(ambient);
      expect(scoped.configuredRegion).toBe('ap-northeast-1');
      // Read back off the REAL client the SDK resolved, not off our own config
      // object — that is the only thing that proves the override reached it.
      await expect(scoped.ssm.config.region()).resolves.toBe('ap-northeast-1');
      await expect(scoped.secretsManager.config.region()).resolves.toBe('ap-northeast-1');
      // Explicit credentials have NO environment path, so this is the half that
      // genuinely would be lost by a bare `new SSMClient({ region })`.
      await expect(scoped.ssm.config.credentials()).resolves.toMatchObject(credentials);
      // The source instance is untouched.
      expect(ambient.configuredRegion).toBe('us-east-1');
      await expect(ambient.ssm.config.region()).resolves.toBe('us-east-1');

      ambient.destroy();
      scoped.destroy();
    });

    it('passes the --profile key through to the derived client', async () => {
      // Scope note: this pins that `profile` is CARRIED, which is the right
      // behaviour and worth a regression net. It is NOT a live `--profile` fix:
      // `src/cli/program.ts` sets `process.env.AWS_PROFILE` in a preAction hook
      // for every command, so a bare client would pick the profile up from the
      // environment anyway. The carry matters for a library caller that never
      // runs that hook, and alongside the explicit-`credentials` case above,
      // which has no environment path at all.
      const ambient = new AwsClients({ region: 'us-east-1', profile: 'cdkd-lane-1957' });
      const scoped = ambient.withRegion('ap-northeast-1');

      expect(scoped.credentialConfig).toEqual({ profile: 'cdkd-lane-1957' });
      await expect(scoped.ssm.config.region()).resolves.toBe('ap-northeast-1');
      expect(scoped.ssm.config.profile).toBe('cdkd-lane-1957');

      ambient.destroy();
      scoped.destroy();
    });

    it('overrides a region the ambient resolved from the environment', async () => {
      process.env['AWS_REGION'] = 'us-east-1';
      const ambient = new AwsClients({ profile: 'cdkd-lane-1957' });
      const scoped = ambient.withRegion('ap-northeast-1');

      await expect(scoped.ssm.config.region()).resolves.toBe('ap-northeast-1');
      expect(scoped.credentialConfig).toEqual({ profile: 'cdkd-lane-1957' });

      ambient.destroy();
      scoped.destroy();
    });
  });
});
