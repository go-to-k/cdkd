/**
 * Shim: re-exports cdk-local's in-process Cloud Map service registry for
 * `cdkd local start-service` — peers reach each other by IP / network alias
 * on the shared service network without docker `network connect`
 * choreography. The implementation lives in cdk-local and cdkd consumes it
 * verbatim instead of carrying a byte-identical copy. `RegistrationHandle`
 * is re-exported as a type because the still-local sibling
 * `ecs-service-runner.ts` imports it alongside the class. See cdk-local's
 * `src/local/cloud-map-registry.ts`.
 */
export { CloudMapRegistry, type RegistrationHandle } from 'cdk-local/internal';
