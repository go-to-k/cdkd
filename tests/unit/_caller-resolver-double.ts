import { vi } from 'vite-plus/test';

/**
 * A test double for `src/local/dynamic-reference.ts` (issue #2056).
 *
 * `createCallerDynamicReferenceResolver` is replaced by one that builds cdk-local's
 * REAL resolver with fake Secrets Manager / SSM clients, recording each `send`
 * (with the client's region), each client `destroy`, and the `profile` the site
 * asked for. Because only the helper is doubled, a site that bypasses it (back to
 * `new DynamicReferenceResolver({ profile })`) builds real SDK clients and goes red.
 *
 * Use from a `vi.mock` factory:
 *
 *     const dr = vi.hoisted(() => ({
 *       smSend: vi.fn(), ssmSend: vi.fn(), destroy: vi.fn(),
 *       profiles: [] as Array<string | undefined>,
 *     }));
 *     vi.mock('../../../src/local/dynamic-reference.js', async () =>
 *       (await import('../_caller-resolver-double.js')).callerResolverModule(dr));
 */
type Recorded = (...args: unknown[]) => unknown;

export interface CallerResolverRecorder {
  smSend: Recorded;
  ssmSend: Recorded;
  destroy: Recorded;
  profiles: Array<string | undefined>;
}

export async function callerResolverModule(
  dr: CallerResolverRecorder
): Promise<typeof import('../../src/local/dynamic-reference.js')> {
  const { DynamicReferenceResolver } =
    await vi.importActual<typeof import('cdk-local/internal')>('cdk-local/internal');
  return {
    createCallerDynamicReferenceResolver: (profile: string | undefined) => {
      dr.profiles.push(profile);
      return new DynamicReferenceResolver({
        secretsManagerClientFactory: (region) => ({
          send: ((cmd: { input: unknown }) => dr.smSend(region, cmd.input)) as never,
          destroy: () => dr.destroy('secretsmanager', region),
        }),
        ssmClientFactory: (region) => ({
          send: ((cmd: { input: unknown }) => dr.ssmSend(region, cmd.input)) as never,
          destroy: () => dr.destroy('ssm', region),
        }),
      });
    },
  };
}
