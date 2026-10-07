/**
 * Shared harness for the go-to-k/cdkd#4639 create-retry tests: a stand-in for
 * an AWS SDK client whose `send` models the SDK retry middleware, and a fake
 * service in which a named create COLLIDES with a resource of the same name.
 *
 * A test file `vi.mock`s its SDK package so the client constructor returns
 * {@link sdkClientStandIn}, reaching this module through a dynamic import from
 * the hoisted factory. Module state is per test file (vitest isolates files).
 */
import { expect, vi } from 'vite-plus/test';

/** The resolved client config a stand-in exposes, as the SDK retry middleware reads it. */
export interface StandInConfig {
  region: () => Promise<string>;
  /** The `profile` the client was constructed with, to tell identities apart. */
  profile?: string;
  retryStrategy: () => Promise<unknown>;
}

interface Command {
  constructor: { name: string };
  input: Record<string, unknown>;
}

/** A stand-in for the SDK's resolved V2 retry strategy: it retries a server fault only. */
export const baseStrategy = {
  acquireInitialRetryToken: async (_scope: string) => 'token',
  refreshRetryTokenForRetry: async (_token: unknown, info: { error?: unknown }) => {
    if ((info.error as { $fault?: string } | undefined)?.$fault !== 'server') {
      throw new Error('not retryable');
    }
    return 'retry-token';
  },
  recordSuccess: (_token: unknown) => undefined,
};

/** How many times the stand-in SDK replays one `send` (the standard mode's 3 attempts). */
const SDK_MAX_ATTEMPTS = 3;

/** `[command name, client config]` per send, so a test can see WHICH client sent it. */
export const sentVia: Array<[string, StandInConfig]> = [];

let service: (command: Command) => Promise<unknown> = async () => ({});

/** Install the fake service every stand-in client sends to. */
export function useService(send: (command: Command) => Promise<unknown>): void {
  service = send;
  sentVia.length = 0;
}

/**
 * A client double: on a failure it asks its RESOLVED strategy whether to
 * retry, and replays the same request when the strategy hands back a token.
 */
export function sdkClientStandIn(
  region = 'us-east-1',
  profile?: string
): {
  config: StandInConfig;
  send: (command: Command) => Promise<unknown>;
} {
  const config: StandInConfig = {
    region: () => Promise.resolve(region),
    ...(profile !== undefined && { profile }),
    retryStrategy: async (): Promise<unknown> => baseStrategy,
  };
  return {
    config,
    send: async (command: Command) => {
      sentVia.push([command.constructor.name, config]);
      const strategy = (await config.retryStrategy()) as typeof baseStrategy;
      let token: unknown = await strategy.acquireInitialRetryToken('svc');
      for (let attempt = 1; ; attempt++) {
        try {
          return await service(command);
        } catch (error) {
          if (attempt >= SDK_MAX_ATTEMPTS) throw error;
          try {
            token = await strategy.refreshRetryTokenForRetry(token, { error });
          } catch {
            throw error;
          }
        }
      }
    },
  };
}

/** The shape `isTransientServerError` / `isAmbiguousOutcomeError` classify (issue #2026). */
export const transient500 = (): Error =>
  Object.assign(new Error('Internal failure'), {
    name: 'InternalFailure',
    $fault: 'server',
    $metadata: { httpStatusCode: 500 },
  });

const throttled = (): Error =>
  Object.assign(new Error('Rate exceeded'), {
    name: 'ThrottlingException',
    $fault: 'server',
    $metadata: { httpStatusCode: 503 },
  });

/** Advance the fake clock on every backoff. */
export const advancingSleep = (ms: number): Promise<void> => {
  vi.setSystemTime(Date.now() + Math.max(ms, 1000));
  return Promise.resolve();
};

/** One name-unique create: the input key carrying the name, and AWS's collision error. */
export interface NamedCreate {
  nameKey: string;
  collision: (name: string) => Error;
}

/**
 * A fake service. Each create in `creates` collides on a name it already
 * made; `names` counts RESOURCES, not calls. Every other command answers `{}`.
 */
export class FakeNamedCreates {
  readonly names = new Map<string, Set<string>>();
  readonly calls: string[] = [];
  /** The named create does its work, THEN throws this (a lost response). */
  readonly loseNextResponse = new Map<string, Error>();

  constructor(private readonly creates: Record<string, NamedCreate>) {
    for (const command of Object.keys(creates)) this.names.set(command, new Set());
  }

  send = async (command: Command): Promise<unknown> => {
    const name = command.constructor.name;
    this.calls.push(name);
    const create = this.creates[name];
    if (!create) return {};
    const resourceName = command.input[create.nameKey] as string;
    const made = this.names.get(name)!;
    if (made.has(resourceName)) throw create.collision(resourceName);
    made.add(resourceName);
    const error = this.loseNextResponse.get(name);
    if (error) {
      this.loseNextResponse.delete(name);
      throw error;
    }
    return {};
  };
}

/** The configs every send of `command` went through; at least one. */
export function configsOf(command: string): StandInConfig[] {
  const configs = sentVia.filter(([n]) => n === command).map(([, c]) => c);
  expect(configs.length).toBeGreaterThan(0);
  return configs;
}

/** Assert `config` refuses the SDK retry of a 5xx and still retries a throttle. */
export async function expectRefusesServerErrorReplay(config: StandInConfig): Promise<void> {
  const strategy = (await config.retryStrategy()) as typeof baseStrategy;
  await expect(
    strategy.refreshRetryTokenForRetry('t', { error: transient500() } as never)
  ).rejects.toThrow();
  await expect(strategy.refreshRetryTokenForRetry('t', { error: throttled() } as never)).resolves.toBe(
    'retry-token'
  );
}

/** Assert `config` keeps the SDK's full retry. */
export async function expectFullSdkRetry(config: StandInConfig): Promise<void> {
  expect(await config.retryStrategy()).toBe(baseStrategy);
}
