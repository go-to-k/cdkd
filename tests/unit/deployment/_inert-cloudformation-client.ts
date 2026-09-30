/**
 * A `src/utils/aws-clients.js` whose CloudFormation client is inert, for unit
 * tests that drive `DeployEngine.deploy()` or the recursive diff without
 * mocking the client factory.
 *
 * Both start a background create-only prefetch
 * (`prefetchCreateOnlyPropertyPaths` -> `scheduleDescribeType`), which reads
 * `getAwsClients().cloudFormation` from the process-global factory. Unmocked,
 * that is a REAL client: with no credentials (CI) its credential chain calls
 * IMDS, and the unit-test AWS fence in `tests/setup.ts` fails whichever test is
 * running when the request goes out.
 *
 * Here reading `cloudFormation` throws instead. `scheduleDescribeType` turns
 * that into a failed lookup, the outcome a credential-less real client reaches,
 * minus the network. Everything else stays real, because some of these suites
 * run the real resolver over SDK-package mocks that read other clients (and
 * `credentialConfig`) through the same factory.
 *
 * Usage (the dynamic import is required: a `vi.mock` factory is hoisted above
 * the file's static imports):
 *
 *   vi.mock('<rel>/src/utils/aws-clients.js', async (importOriginal) =>
 *     (await import('<rel>/tests/unit/deployment/_inert-cloudformation-client.js')).withInertCloudFormationClient(
 *       importOriginal
 *     )
 *   );
 */

type AwsClientsModule = typeof import('../../../src/utils/aws-clients.js');

export async function withInertCloudFormationClient(
  importOriginal: <T = AwsClientsModule>() => Promise<T>
): Promise<AwsClientsModule> {
  const actual = await importOriginal<AwsClientsModule>();
  return {
    ...actual,
    getAwsClients: (...args) =>
      new Proxy(actual.getAwsClients(...args), {
        get: (target, key) => {
          if (key === 'cloudFormation') {
            throw new Error('test stub: no real AWS client (cloudFormation)');
          }
          return Reflect.get(target, key) as unknown;
        },
      }),
  };
}
