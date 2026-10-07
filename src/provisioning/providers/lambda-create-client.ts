import { LambdaClient } from '@aws-sdk/client-lambda';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';

/**
 * The memoized client a Lambda provider sends its main CREATE through (issue
 * #4639): SDK retries on, except a 5xx (`withoutServerErrorRetries`). Every
 * other call keeps the shared client and its full SDK retry.
 *
 * `CreateFunction`, `CreateFunctionUrlConfig` and `AddPermission` carry no
 * idempotency token, and each is unique by name: the function name, the
 * function + qualifier, and the function + `StatementId` (which
 * `LambdaPermissionProvider` derives from the logical id). The SDK's own
 * replay of a 5xx whose request Lambda completed happens inside one `send`,
 * where neither the provider nor the deploy engine can see it, and fails
 * `ResourceConflictException` against what the first request made; the
 * engine then credits that collision to another holder, and the resource is
 * left in no state record for every re-run to collide with. Refused here, the
 * 5xx reaches the engine's retry, which marks a later collision as possibly
 * this create's own (`withRetry`, #3978).
 *
 * The client is built in the shared client's REGION (read from it, as
 * `config.region()` resolves it), with the ambient identity. The PROMISE is
 * cached, so two creates on a cold provider build one client; a rejected
 * region read is not cached, so the next create retries it. A shared client
 * that is not a `LambdaClient` -- a unit-test double -- is used as is:
 * `AwsClients` always supplies a real one.
 */
export class LambdaCreateClientCache {
  private client: Promise<LambdaClient> | undefined;
  private readonly shared: () => LambdaClient;

  /** @param shared reads the provider's shared Lambda client at each `get()`. */
  constructor(shared: () => LambdaClient) {
    this.shared = shared;
  }

  get(): Promise<LambdaClient> {
    const shared = this.shared();
    if (!(shared instanceof LambdaClient)) return Promise.resolve(shared);
    this.client ??= shared.config.region().then(
      (region) =>
        withoutServerErrorRetries(new LambdaClient({ ...ambientClientDefaults(), region })),
      (error: unknown) => {
        this.client = undefined;
        throw error;
      }
    );
    return this.client;
  }
}
