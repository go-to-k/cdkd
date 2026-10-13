import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const synthesize = vi.hoisted(() => vi.fn(async () => ({ stacks: [] })));
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: class {
    synthesize = synthesize;
  },
}));

const { cdkdHostSynthesizer } = await import('../../../src/cli/commands/local-host-synthesizer.js');
const { getLogger } = await import('../../../src/utils/logger.js');
const { getAssumedRoleCredentials, resetAwsClientDefaults } = await import(
  '../../../src/utils/aws-client-defaults.js'
);

describe('cdkdHostSynthesizer', () => {
  beforeEach(() => {
    synthesize.mockClear();
  });

  it("synthesizes with cdkd's synthesizer, passing cdk-local's options through", async () => {
    await cdkdHostSynthesizer(() => ({})).synthesize({
      app: 'node app.js',
      output: 'out',
      region: 'us-west-2',
      context: { k: 'v' },
    });
    expect(synthesize).toHaveBeenCalledWith({
      app: 'node app.js',
      output: 'out',
      region: 'us-west-2',
      context: { k: 'v' },
    });
  });

  it("adds the command's --state-bucket, read when it synthesizes", async () => {
    let bucket: string | undefined;
    const synthesizer = cdkdHostSynthesizer(() => ({ stateBucket: bucket }));
    bucket = 'my-bucket';
    await synthesizer.synthesize({ app: 'a' });
    expect(synthesize).toHaveBeenCalledWith({ app: 'a', stateBucket: 'my-bucket' });
  });

  it('passes the profile to the macro-expansion upload', async () => {
    await cdkdHostSynthesizer(() => ({})).synthesize({ app: 'a', profile: 'dev' });
    expect(synthesize).toHaveBeenCalledWith({
      app: 'a',
      profile: 'dev',
      macroExpandS3ClientOpts: { profile: 'dev' },
    });
  });

  it("raises cdkd's logger to debug under --verbose, and only then", async () => {
    const setLevel = vi.spyOn(getLogger(), 'setLevel').mockImplementation(() => undefined);
    try {
      await cdkdHostSynthesizer(() => ({})).synthesize({ app: 'a' });
      await cdkdHostSynthesizer(() => ({ verbose: false })).synthesize({ app: 'a' });
      expect(setLevel).not.toHaveBeenCalled();
      await cdkdHostSynthesizer(() => ({ verbose: true })).synthesize({ app: 'a' });
      expect(setLevel).toHaveBeenCalledWith('debug');
    } finally {
      setLevel.mockRestore();
    }
  });

  describe('--role-arn', () => {
    const TRIPLE = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'CDKD_ROLE_ARN'];
    let saved: Record<string, string | undefined>;
    beforeEach(() => {
      saved = Object.fromEntries(TRIPLE.map((k) => [k, process.env[k]]));
      for (const k of TRIPLE) delete process.env[k];
      resetAwsClientDefaults();
    });
    afterEach(() => {
      for (const k of TRIPLE) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      resetAwsClientDefaults();
    });
    const roleTriple = () => {
      process.env['AWS_ACCESS_KEY_ID'] = 'ASIAROLE';
      process.env['AWS_SECRET_ACCESS_KEY'] = 'role-secret';
      process.env['AWS_SESSION_TOKEN'] = 'role-token';
    };

    it("publishes the role cdk-local assumed to cdkd's clients, once across reloads", async () => {
      roleTriple();
      const synthesizer = cdkdHostSynthesizer(() => ({ roleArn: 'arn:aws:iam::111111111111:role/r' }));
      await synthesizer.synthesize({ app: 'a', profile: 'dev' });
      expect(getAssumedRoleCredentials()).toEqual({
        accessKeyId: 'ASIAROLE',
        secretAccessKey: 'role-secret',
        sessionToken: 'role-token',
      });
      await synthesizer.synthesize({ app: 'a', profile: 'dev' });
      expect(synthesize).toHaveBeenCalledTimes(2);
    });

    it('takes the role from CDKD_ROLE_ARN, as cdk-local does', async () => {
      roleTriple();
      process.env['CDKD_ROLE_ARN'] = 'arn:aws:iam::111111111111:role/r';
      await cdkdHostSynthesizer(() => ({})).synthesize({ app: 'a' });
      expect(getAssumedRoleCredentials()?.accessKeyId).toBe('ASIAROLE');
    });

    it('publishes nothing without a role', async () => {
      roleTriple();
      await cdkdHostSynthesizer(() => ({})).synthesize({ app: 'a' });
      expect(getAssumedRoleCredentials()).toBeUndefined();
    });

    it('refuses to synthesize when the role left no session credentials', async () => {
      await expect(
        cdkdHostSynthesizer(() => ({ roleArn: 'arn:aws:iam::111111111111:role/r' })).synthesize({
          app: 'a',
        })
      ).rejects.toThrow(/assumed role left no session credentials/);
      expect(synthesize).not.toHaveBeenCalled();
    });
  });
});
