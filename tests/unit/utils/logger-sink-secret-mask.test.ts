import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { ConsoleLogger, getLogger, setLogger } from '../../../src/utils/logger.js';
import { runStackBuffered } from '../../../src/utils/stack-context.js';
import { withCurrentResourceSecrets } from '../../../src/deployment/resource-secrets-scope.js';
import {
  recordLogOnlyValue,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

/**
 * Issue [#2177](https://github.com/go-to-k/cdkd/issues/2177): a provider's own
 * `this.logger.*` line is masked at the LOGGER SINK whenever the deploy engine
 * or the rollback executor has bound the resource's secret bag through
 * `withCurrentResourceSecrets` — no per-site masker threading needed.
 *
 * The provider shape is reproduced exactly: a `getLogger().child(...)` logger
 * held on the instance, called from inside the bound provider call. Importing
 * `resource-secrets-scope.ts` is what installs the sink's masker source, as it
 * is in production (every binder imports it).
 */
const SECRET = 'hunter2-db-password';
const OTHER = 'other-resource-token';

function bag(...plaintexts: string[]): RecordedSecretValues {
  return new Map(plaintexts.map((p) => [p, `{{resolve:secretsmanager:${p}}}`]));
}

class FakeProvider {
  private logger = getLogger().child('FakeProvider');
  create(properties: { Password: string }): void {
    this.logger.debug(`Creating user with password ${properties.Password}`);
    this.logger.info(`Created user (password ${properties.Password})`);
    this.logger.warn(`Password ${properties.Password} is weak`);
    this.logger.error(`Failed for ${properties.Password}`);
  }
}

describe('ConsoleLogger masks bound resource secrets at the sink (issue #2177)', () => {
  let spies: Record<'debug' | 'info' | 'warn' | 'error', ReturnType<typeof vi.spyOn>>;
  const printed = (): string =>
    Object.values(spies)
      .flatMap((spy) => spy.mock.calls.map((call) => String(call[0])))
      .join('\n');

  beforeEach(() => {
    setLogger(new ConsoleLogger('info', false));
    spies = {
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    for (const spy of Object.values(spies)) spy.mockRestore();
    setLogger(new ConsoleLogger());
  });

  it('masks a provider line at every level while a bag is bound', () => {
    setLogger(new ConsoleLogger('debug', false));
    withCurrentResourceSecrets(bag(SECRET), () => new FakeProvider().create({ Password: SECRET }));

    for (const level of ['debug', 'info', 'warn', 'error'] as const) {
      expect(spies[level]).toHaveBeenCalledTimes(1);
      const line = String(spies[level].mock.calls[0]?.[0]);
      expect(line).toContain('***');
      expect(line).not.toContain(SECRET);
    }
  });

  it('masks at info level too, where the debug line is filtered', () => {
    withCurrentResourceSecrets(bag(SECRET), () => new FakeProvider().create({ Password: SECRET }));

    expect(spies.debug).not.toHaveBeenCalled();
    expect(String(spies.info.mock.calls[0]?.[0])).toBe('Created user (password ***)');
    expect(printed()).not.toContain(SECRET);
  });

  it('masks a line captured into the per-stack output buffer', async () => {
    const result = await runStackBuffered(async () =>
      withCurrentResourceSecrets(bag(SECRET), async () => {
        await Promise.resolve();
        new FakeProvider().create({ Password: SECRET });
      })
    );

    expect(result.lines).toHaveLength(3);
    for (const line of result.lines) {
      expect(line).toContain('***');
      expect(line).not.toContain(SECRET);
    }
    expect(printed()).toBe('');
  });

  it('leaves a line unchanged when no bag is bound', () => {
    new FakeProvider().create({ Password: SECRET });

    expect(String(spies.info.mock.calls[0]?.[0])).toBe(`Created user (password ${SECRET})`);
  });

  it('leaves a line unchanged when the bound bag is empty', () => {
    withCurrentResourceSecrets(new Map(), () => new FakeProvider().create({ Password: SECRET }));

    expect(String(spies.info.mock.calls[0]?.[0])).toBe(`Created user (password ${SECRET})`);
  });

  it('masks a LOG-ONLY needle (a NoEcho parameter value) in a bag with no map entry', () => {
    const secrets: RecordedSecretValues = new Map();
    recordLogOnlyValue(secrets, SECRET);

    withCurrentResourceSecrets(secrets, () => new FakeProvider().create({ Password: SECRET }));

    expect(String(spies.info.mock.calls[0]?.[0])).toBe('Created user (password ***)');
  });

  it('masks a value added to the bag after it was bound', () => {
    const secrets: RecordedSecretValues = new Map();
    withCurrentResourceSecrets(secrets, () => {
      secrets.set(SECRET, '{{resolve:secretsmanager:x}}');
      new FakeProvider().create({ Password: SECRET });
    });

    expect(printed()).not.toContain(SECRET);
  });

  it('masks a secret inside an extra arg, even one JSON.stringify would escape', () => {
    const quoted = 'pa"ss\\word-123';
    withCurrentResourceSecrets(bag(quoted, SECRET), () => {
      getLogger().info('payload', { Password: quoted, [SECRET]: 'v', nested: [SECRET] });
    });

    const line = String(spies.info.mock.calls[0]?.[0]);
    expect(line).not.toContain('pa\\"ss');
    expect(line).not.toContain(SECRET);
    expect(line).toContain('{"Password":"***","***":"v","nested":["***"]}');
  });

  it('masks a secret holding a character the terminal sanitizer rewrites', () => {
    const withC1 = 'abc\u0085defghi';
    withCurrentResourceSecrets(bag(withC1), () => {
      getLogger().info(`value ${withC1}`);
    });

    expect(String(spies.info.mock.calls[0]?.[0])).toBe('value ***');
  });

  it('a nested scope masks with its own bag, and the outer bag resumes after it', () => {
    withCurrentResourceSecrets(bag(OTHER), () => {
      withCurrentResourceSecrets(bag(SECRET), () => {
        getLogger().info(`inner ${SECRET} ${OTHER}`);
      });
      getLogger().info(`outer ${SECRET} ${OTHER}`);
    });

    expect(String(spies.info.mock.calls[0]?.[0])).toBe(`inner *** ${OTHER}`);
    expect(String(spies.info.mock.calls[1]?.[0])).toBe(`outer ${SECRET} ***`);
  });

  it('concurrent resource scopes do not see each other’s needles', async () => {
    const lines: Record<string, string> = {};
    const capture = vi.fn((line: string) => line);
    spies.info.mockImplementation((line: unknown) => capture(String(line)));

    const run = (name: string, secret: string, gate: Promise<void>) =>
      withCurrentResourceSecrets(bag(secret), async () => {
        await gate;
        getLogger().info(`${name} ${SECRET} ${OTHER}`);
      });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const both = Promise.all([run('A', SECRET, gate), run('B', OTHER, gate)]);
    release();
    await both;

    for (const call of capture.mock.calls) lines[call[0].split(' ')[0] ?? ''] = call[0];
    expect(lines['A']).toBe(`A *** ${OTHER}`);
    expect(lines['B']).toBe(`B ${SECRET} ***`);
  });
});
