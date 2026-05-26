/**
 * `S3LocalStateProvider` — implementation of {@link LocalStateProvider}
 * backed by cdkd's S3 state. Wraps the existing
 * `loadStateForStack` + `buildCrossStackResolver` helpers in
 * `src/cli/commands/local-state-loader.ts` so the four `cdkd local *`
 * commands can route both `--from-state` and `--from-cfn-stack`
 * through the same provider-shaped interface (issue #606).
 *
 * Behavior is identical to the pre-issue-#606 code path — this file
 * exists ONLY to give the CLI layer a single interface against which
 * to wire both flags, so adding a third state source (a future
 * `--from-tf-state`? out of scope for now) doesn't require touching
 * the four `local-*.ts` command files again.
 */

import {
  buildCrossStackResolver as buildCrossStackResolverImpl,
  loadStateForStack,
  type BuildCrossStackResolverOptions,
  type LoadStateForStackOptions,
} from '../cli/commands/local-state-loader.js';
import type { CrossStackResolver } from './state-resolver.js';
import type { LocalStateProvider, LocalStateRecord } from './local-state-provider.js';

export interface S3LocalStateProviderOptions {
  /** Falls back to env / cdk.json / default per `resolveStateBucketWithDefault`. */
  stateBucket?: string;
  /** S3 key prefix; the CLI always supplies the `--state-prefix` default. */
  statePrefix: string;
  /** Region for the AWS clients constructed by the underlying helpers. */
  region?: string;
  /** AWS profile name. */
  profile?: string;
  /**
   * Region of the state record to read when the same stack name has
   * state in multiple regions. Surfaced as `--stack-region` on every
   * `cdkd local *` command.
   */
  stackRegion?: string;
}

export class S3LocalStateProvider implements LocalStateProvider {
  // erasableSyntaxOnly forbids parameter-property shorthand; declare
  // fields explicitly + assign in the body.
  public readonly label = '--from-state';
  private readonly opts: S3LocalStateProviderOptions;
  // The cross-stack resolver allocates its own AWS clients (one per
  // build) that must be disposed in the outer `finally`. Tracked so
  // `dispose` can close every resolver this provider handed out.
  private readonly disposers: Array<() => void> = [];

  constructor(opts: S3LocalStateProviderOptions) {
    this.opts = opts;
  }

  public async load(
    stackName: string,
    synthRegion: string | undefined
  ): Promise<LocalStateRecord | undefined> {
    const loadOpts: LoadStateForStackOptions = {
      statePrefix: this.opts.statePrefix,
      ...(this.opts.stackRegion !== undefined && { stackRegion: this.opts.stackRegion }),
      ...(this.opts.stateBucket !== undefined && { stateBucket: this.opts.stateBucket }),
      ...(this.opts.region !== undefined && { region: this.opts.region }),
      ...(this.opts.profile !== undefined && { profile: this.opts.profile }),
    };
    const loaded = await loadStateForStack(stackName, synthRegion, loadOpts);
    if (!loaded) return undefined;
    // Outputs are typed `Record<string, unknown>` on `StackState` but
    // every value cdkd ever writes is a string at the wire level —
    // coerce here so the rest of the local-substitution path can
    // treat it uniformly with the CFn provider's stringly typed map.
    const outputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(loaded.state.outputs ?? {})) {
      if (typeof v === 'string') outputs[k] = v;
      else if (typeof v === 'number' || typeof v === 'boolean') outputs[k] = String(v);
      else outputs[k] = JSON.stringify(v);
    }
    return {
      resources: loaded.state.resources,
      outputs,
      region: loaded.region,
    };
  }

  public async buildCrossStackResolver(
    consumerRegion: string
  ): Promise<CrossStackResolver | undefined> {
    const buildOpts: BuildCrossStackResolverOptions = {
      statePrefix: this.opts.statePrefix,
      ...(this.opts.stateBucket !== undefined && { stateBucket: this.opts.stateBucket }),
      ...(this.opts.region !== undefined && { region: this.opts.region }),
      ...(this.opts.profile !== undefined && { profile: this.opts.profile }),
    };
    const built = await buildCrossStackResolverImpl(consumerRegion, buildOpts);
    if (!built) return undefined;
    this.disposers.push(built.dispose);
    return built.resolver;
  }

  public dispose(): void {
    while (this.disposers.length > 0) {
      const fn = this.disposers.pop();
      if (fn) {
        try {
          fn();
        } catch {
          // Disposal is best-effort; the underlying helper already
          // swallows AWS client errors.
        }
      }
    }
  }
}
