/**
 * Two properties of the per-unit recovery that the PR could otherwise only
 * ARGUE (issues go-to-k/cdkd#3181 / go-to-k/cdkd#3218, acceptance 3 on both):
 * a secret resolved AFTER a recovered sibling stays out of the resolver's log
 * lines, and the token/twin PAIRING survives a skipped token.
 *
 * They are separate cases because they are fenced to different depths, and
 * saying so is the point — an earlier cut of this file claimed the first case
 * tested the pairing, and a mutation probe (`twinTokens[index]` ->
 * `twinTokens[index + 1]`) left it GREEN. It passes for a broader reason than
 * pairing: nothing on this path writes a resolved plaintext into a log line at
 * all. That is still worth a regression guard, so the case stays — under an
 * honest description.
 *
 * The SECOND case is the one that fences the pairing, and it reds under that
 * probe. It works because `subject` on a recorded entry is derived from the
 * token's paired twin, so a shifted index correspondence makes the entry
 * describe a different token than the one that failed. That is the only
 * observable of the pairing this PR gives a caller: `twin` itself never leaves
 * `resolveDynamicReferences`.
 *
 * The file mocks `src/utils/logger.js`, which the sibling recovery suite
 * deliberately does not — hence its own file.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const logLines: string[] = [];
vi.mock('../../../src/utils/logger.js', () => {
  const push =
    (level: string) =>
    (...args: unknown[]): void => void logLines.push(`${level} ${args.map(String).join(' ')}`);
  const fake = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    setLevel: (): void => {},
    child: (): unknown => fake,
  };
  return { getLogger: () => fake };
});

const sendMock = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  GetSecretValueCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __type: 'GetSecretValue', input })),
}));
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: vi.fn().mockImplementation(() => ({ send: sendMock })),
  GetParameterCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ __type: 'GetParameter', input })),
}));

const { IntrinsicFunctionResolver } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);

const DEAD = '{{resolve:ssm-secure:/deleted/param}}';
const LIVE = '{{resolve:secretsmanager:prod/db:SecretString:password}}';
/**
 * Three characters, deliberately below `MIN_NEEDLE_LENGTH` (4). A needle this
 * short is NEVER registered as one — that floor exists so a short secret cannot
 * rewrite unrelated text everywhere — so the ONLY thing that can keep it out of
 * a log line is the position mask the log twin carries. That is what makes this
 * case a test of the PAIRING rather than of the needle mask.
 */
const SUB_FLOOR_PLAINTEXT = 'pw1';

describe('recovery keeps secrets out of logs and keeps the twin pairing (go-to-k/cdkd#3181)', () => {
  beforeEach(() => {
    logLines.length = 0;
    sendMock.mockReset();
    sendMock.mockImplementation((cmd: { __type: string }) =>
      cmd.__type === 'GetParameter'
        ? Promise.reject(
            Object.assign(new Error('Parameter /deleted/param not found.'), {
              name: 'ParameterNotFound',
            })
          )
        : Promise.resolve({ SecretString: JSON.stringify({ password: SUB_FLOOR_PLAINTEXT }) })
    );
  });

  it('writes no resolved plaintext into a log line after a recovered sibling', async () => {
    // NOT a test of the token/twin pairing — measured: the shift probe leaves
    // this green. It fences the weaker but real property that the resolved
    // value of a reference fetched AFTER a recovery does not reach a log line.
    // The plaintext is deliberately SUB-FLOOR so the needle mask is not what
    // would be keeping it out.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const recordedSecretValues = new Map<string, string>();
    const abandonedResolutions: unknown[] = [];

    const out = await resolver.resolveDynamicReferences(`${DEAD}/${LIVE}`, {
      recordedSecretValues,
      abandonedResolutions,
    } as never);

    // Premise checks first: without these the masking assertion below is
    // vacuous, because it also passes when nothing was resolved at all.
    expect(abandonedResolutions, 'the first token was not recorded').toHaveLength(1);
    expect(
      out,
      'the second token was not substituted, so no log line could have carried its plaintext ' +
        'and the assertion below would pass for the wrong reason.'
    ).toContain(SUB_FLOOR_PLAINTEXT);
    expect(logLines.length, 'the resolver emitted no log lines at all').toBeGreaterThan(0);

    const leaked = logLines.filter((line) => line.includes(SUB_FLOOR_PLAINTEXT));
    expect(
      leaked,
      `${leaked.length} resolver log line(s) carry the plaintext of the reference resolved AFTER ` +
        `a recovered one: ${JSON.stringify(leaked)}. It is below MIN_NEEDLE_LENGTH, so the needle ` +
        `mask cannot see it — only the log twin's position mask can, and a recovery that shifted ` +
        `the token/twin pairing by one would mask the wrong span (go-to-k/cdkd#3100).`
    ).toEqual([]);
  });

  it("pairs the skipped token with its OWN twin, not a neighbour's", async () => {
    // THE PAIRING ITSELF, and the only observable of it this PR gives a
    // caller. `subject` is derived from the token's paired twin
    // (`straddleSafeTwin(fullMatch, twinTokens[index])`), so if recovery — or
    // anything else — shifted the token/twin index correspondence, the
    // recorded entry would describe a DIFFERENT token than the one that
    // failed.
    //
    // Three tokens with the failure in the MIDDLE, because a shift of one is
    // invisible at the edges of a two-token leaf: with `[FIRST, DEAD, LIVE]`
    // the off-by-one reads `twinTokens[2]`, which is LIVE's.
    const FIRST = '{{resolve:secretsmanager:prod/first:SecretString:password}}';
    sendMock.mockImplementation((cmd: { __type: string; input: Record<string, unknown> }) =>
      cmd.__type === 'GetParameter'
        ? Promise.reject(
            Object.assign(new Error('Parameter /deleted/param not found.'), {
              name: 'ParameterNotFound',
            })
          )
        : Promise.resolve({
            SecretString: JSON.stringify({
              password: String(cmd.input['SecretId']).includes('first')
                ? 'ab2'
                : SUB_FLOOR_PLAINTEXT,
            }),
          })
    );
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const abandonedResolutions: Array<{ subject: string }> = [];

    const out = await resolver.resolveDynamicReferences(`${FIRST}/${DEAD}/${LIVE}`, {
      recordedSecretValues: new Map<string, string>(),
      abandonedResolutions,
    } as never);

    // Premises: the walk really did resume past the middle failure.
    expect(out).toContain(SUB_FLOOR_PLAINTEXT);
    expect(out).toContain('ab2');
    expect(abandonedResolutions).toHaveLength(1);

    const subject = abandonedResolutions[0]!.subject;
    expect(
      subject,
      `the recorded entry describes a token other than the one that failed: got ` +
        `'${subject}'. It is derived from the token's PAIRED twin, so this is what a shifted ` +
        `token/twin index correspondence looks like from outside (go-to-k/cdkd#3100).`
    ).toContain('/deleted/param');
    expect(
      subject,
      "the recorded entry was built from a NEIGHBOUR token's twin - the pairing is off by one."
    ).not.toContain('prod/db');
  });

  it('masks a secret resolved after a failed sibling KEY, not only after a failed token', async () => {
    // go-to-k/cdkd#3218's acceptance 3 specifically, which the two cases above
    // do NOT cover: both fail on a TOKEN, and a key failure is a different
    // mechanism — it never enters the token loop at all.
    //
    // The twin argument for the key ordering is its own claim and is recorded
    // at `resolveKeyUnit`: each string LEAF builds its own `matches` /
    // `twinTokens` inside `resolveDynamicReferencesWithLogTwin`, so the
    // pairing is leaf-local and a key abandoned beside it cannot shift it.
    // This case is the empirical half of that.
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const abandonedResolutions: Array<{ unit: string; subject: string }> = [];

    const out = (await resolver.resolve(
      { Environment: { Variables: { A: { Ref: 'NoSuchThing' }, B: LIVE } } },
      { recordedSecretValues: new Map<string, string>(), abandonedResolutions } as never
    )) as { Environment: { Variables: Record<string, unknown> } };

    // Premises: the key really was abandoned and the sibling really resolved,
    // or the masking assertion below passes for the wrong reason.
    expect(abandonedResolutions.map((e) => [e.unit, e.subject])).toEqual([['key', 'A']]);
    expect(String(out.Environment.Variables['B'])).toContain(SUB_FLOOR_PLAINTEXT);

    const leaked = logLines.filter((line) => line.includes(SUB_FLOOR_PLAINTEXT));
    expect(
      leaked,
      `${leaked.length} resolver log line(s) carry the plaintext of the reference resolved after ` +
        `a failed sibling KEY: ${JSON.stringify(leaked)}.`
    ).toEqual([]);
  });
});
