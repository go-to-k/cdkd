import { IAMClient } from '@aws-sdk/client-iam';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';

/**
 * The memoized client an IAM provider sends its main CREATE through (issue
 * #4639): SDK retries on, except a 5xx
 * (`withoutServerErrorRetries`). Every other call keeps the shared client and
 * its full SDK retry.
 *
 * None of `CreateRole`, `CreateUser`, `CreateGroup`, `CreateInstanceProfile`,
 * `CreatePolicy` or `CreateAccessKey` carries an idempotency token. The SDK's
 * own replay of a 5xx whose request IAM completed happens inside one `send`,
 * where neither the provider nor the deploy engine can see it:
 *
 *  - a name-unique create's replay fails `EntityAlreadyExists` against the
 *    entity the first request made, and the engine credits that collision to
 *    another holder, leaving an entity no state records that every re-run
 *    collides with;
 *  - `CreateAccessKey`'s replay mints a SECOND key and returns it, so the first
 *    is a live, unrecorded credential holding one of the user's two key slots.
 *
 * Refused here, the 5xx reaches the provider -- `IAMAccessKeyProvider`'s
 * failed-attempt reconcile then deletes the key that attempt minted -- and the
 * engine's retry, which marks the create as possibly replayed, so a later name
 * collision is never credited to another holder (`withRetry`, #3978).
 *
 * The client is built in the shared client's REGION (read from it, as
 * `config.region()` resolves it -- IAM is global, but the region still picks
 * the partition's endpoint), with the ambient identity. The PROMISE is cached,
 * so two creates on a cold provider build one client; a rejected region read
 * is not cached, so the next create retries it. A shared client that is not an
 * `IAMClient` -- a unit-test double -- is used as is: `AwsClients` always
 * supplies a real one.
 */
export class IamCreateClientCache {
  private client: Promise<IAMClient> | undefined;
  private readonly shared: () => IAMClient;

  /** @param shared reads the provider's shared IAM client at each `get()`. */
  constructor(shared: () => IAMClient) {
    this.shared = shared;
  }

  get(): Promise<IAMClient> {
    const shared = this.shared();
    if (!(shared instanceof IAMClient)) return Promise.resolve(shared);
    this.client ??= shared.config.region().then(
      (region) => withoutServerErrorRetries(new IAMClient({ ...ambientClientDefaults(), region })),
      (error: unknown) => {
        this.client = undefined;
        throw error;
      }
    );
    return this.client;
  }
}
