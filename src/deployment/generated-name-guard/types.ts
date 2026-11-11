import type { ResourceChange, ResourceState, StackOrphanRecord } from '../../types/state.js';
import type { ProvisionedBy } from '../../provisioning/provider-registry.js';
import type { ResourceProvider } from '../../types/resource.js';
import type { RollbackJournal } from '../../types/rollback-journal.js';
import type { RetainedResource } from '../../state/s3-state-backend.js';

/** What a planned create's generated name was found to be. */
export type GeneratedNameVerdict =
  | { kind: 'free' }
  /** A holder this stack's own evidence names (`via`). */
  | { kind: 'licensed'; holder: string; via: LicenseSource }
  /**
   * A holder nothing of this stack names: refuse. `ownIntent` (review D1):
   * this stack's ledger does name the name, but cannot tell this holder is
   * what its create made -- a run abandoned or a create that came back
   * failed, for a type that reports no creation time -- so it may be this
   * stack's own resource; the refusal says so.
   */
  | { kind: 'held'; holder: string; ownIntent?: 'abandoned' | 'failed' }
  /** The lookup was refused (403): create, warning once. */
  | { kind: 'unchecked'; error: unknown }
  /** The lookup, or reading this stack's evidence, failed otherwise: refuse. */
  | { kind: 'failed'; error: unknown };

/** Which evidence named a holder. */
export type LicenseSource = 'record' | 'orphan' | 'journal' | 'ledger' | 'retained' | 'history';

/** One planned create the guard asks about. */
export interface Candidate {
  logicalId: string;
  resourceType: string;
  name: string;
  property: string | undefined;
  provider: ResourceProvider;
  properties: Record<string, unknown>;
  /**
   * Its lookup needs a value only known once the create's properties resolve
   * (an EventBridge rule's `EventBusName` given as an intrinsic): it runs at
   * the create, never against a guessed default.
   */
  deferred: boolean;
  /**
   * A replacement's name generation, under which `name` was derived (absent
   * for a plain CREATE): `GeneratedNameGuard.admit` re-derives the name
   * under the same one.
   */
  generation?: number;
}

/** A resource this stack's own history shows it created, then kept. */
export interface KeptInHistory {
  logicalId: string;
  resourceType: string;
  physicalId: string;
  /** When it was kept (epoch ms), when the history says. */
  keptAt?: number;
}

/** What the guard needs from the engine. */
export interface GeneratedNameGuardInput {
  stackName: string;
  region: string;
  changes: Iterable<ResourceChange>;
  /** The router a create uses (`ProviderRegistry.getProviderFor`). */
  providerFor(input: { resourceType: string; properties: Record<string, unknown> }): {
    provider: ResourceProvider;
    provisionedBy: ProvisionedBy;
  };
  /** The stack's loaded state record's resources. */
  records: Readonly<Record<string, ResourceState>>;
  /** The stack's loaded rollback orphans. */
  orphans: readonly StackOrphanRecord[] | undefined;
  /** This stack's rollback journal, read on demand. */
  loadJournal(): Promise<RollbackJournal | null>;
  /**
   * What this stack let go of under this prefix (`retained.json`), read on
   * demand; `null` when there is no such record at all (this cdkd never
   * destroyed or orphaned the stack here), the only case in which the history
   * below is read.
   */
  loadRetained(): Promise<readonly RetainedResource[] | null>;
  /**
   * What this prefix's own history shows this stack created and then kept (an
   * older cdkd that wrote no `retained.json`), read only when a held name is
   * licensed by nothing else and there is no `retained.json`.
   */
  loadKeptInHistory?(): Promise<readonly KeptInHistory[]>;
  /** The account the ARNs of SNS / Step Functions names are built in. */
  accountInfo(): Promise<{ partition: string; region: string; accountId: string }>;
  /**
   * When this deploy took over an EXPIRED lock: the abandoned run's lease
   * horizon (its last renewal plus its renewal interval, epoch ms). With the ledger's own record of an abandoned run
   * (`cdkd force-unlock`), it bounds what that run's intents license (G-1).
   */
  abandonedRunAt?: number;
  /** Timing, overridable for tests. */
  timing?: Partial<GuardTiming>;
  /** Where a non-fatal note goes (the deploy's logger). */
  warn?(message: string): void;
  /**
   * go-to-k/cdkd#5064: the stack has a `stackInstanceId`. What left the stack
   * (a rollback's orphans, `retained.json`, what history shows it kept) is
   * then never taken back implicitly, so none of it licenses a holder; only
   * this stack's live records, its journal and its ledger do.
   */
  newScheme?: boolean;
  /**
   * go-to-k/cdkd#5064 phase 2: for a planned UPDATE that replaces its
   * resource on a stack with an instance id, the name generation the new
   * resource is created at (`nextNameGeneration`); `undefined` for any other
   * change. Such a replacement creates under a NEW generated name, so it is
   * checked like a create: looked up now, its intent recorded, and a crash
   * re-run's own resource licensed by the ledger.
   */
  replacementGeneration?(change: ResourceChange): number | undefined;
}

/** The guard's clocks and waits. */
export interface GuardTiming {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** How long a held queue or bucket is re-read while it may be deleting. */
  cooldownMs: number;
  /** The wait between those re-reads. */
  cooldownStepMs: number;
}

/**
 * go-to-k/cdkd#4705 perf: how long the first planned intent write waits for
 * the other types' lookups to answer, so they share one write.
 */
export const GROUP_WINDOW_MS = 15;

/** The defaults (exported so an engine-level test can shorten the waits). */
export const DEFAULT_TIMING: GuardTiming = {
  now: () => Date.now(),
  // Unref'd (review N1): a Ctrl-C that ends the cooldown never waits on it.
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms).unref?.();
    }),
  // SQS keeps a deleted queue's name for 60 seconds; S3 answers for a
  // just-deleted bucket for about as long.
  cooldownMs: 65_000,
  cooldownStepMs: 10_000,
};

/**
 * Types whose exact read can still answer for a resource being deleted (a
 * queue's 60-second cooldown, a bucket's delete propagating): a held name of
 * these is read again across that window before it is refused.
 */
export const STILL_LISTED_WHILE_DELETING: ReadonlySet<string> = new Set([
  'AWS::SQS::Queue',
  'AWS::S3::Bucket',
]);

/** Clock skew tolerated between cdkd's clock (when kept) and AWS's (when created). */
export const KEPT_AT_SKEW_MS = 60_000;
