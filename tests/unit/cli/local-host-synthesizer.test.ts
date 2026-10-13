import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const synthesize = vi.hoisted(() => vi.fn(async () => ({ stacks: [] })));
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: class {
    synthesize = synthesize;
  },
}));

const { cdkdHostSynthesizer } = await import('../../../src/cli/commands/local-host-synthesizer.js');

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
});
