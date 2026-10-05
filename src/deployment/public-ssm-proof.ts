import { IntrinsicFunctionResolver } from './intrinsic-function-resolver.js';
import type { ResolverContext } from './intrinsic-resolver/context.js';
import type { RecordedSecretValues } from './secret-redaction/pairs.js';
import { dynamicReferenceTokens } from './secret-redaction/redact-path.js';
import { isSingleDynamicReferenceToken } from './secret-redaction/rules.js';
import {
  provenPublicValue,
  recordProvenPublicExpression,
  wholeStringLeavesOf,
} from './secret-redaction/mask-only.js';
import {
  classifyReplaySecretRegion,
  regionLessSecretName,
} from './secret-region-classification.js';
import type { ProducerRegionEvidence } from './producer-regions-scope.js';
import { safeMsg } from '../utils/display-safe.js';

/**
 * Proves, for `cdkd state refresh-observed` (which resolves nothing), which
 * plain `{{resolve:ssm:...}}` references in a record's MIXED leaves name a
 * PUBLIC parameter (issue [#2036](https://github.com/go-to-k/cdkd/issues/2036)).
 *
 * That command redacts an AWS readback against the record's own `properties`
 * with an EMPTY secrets map. Only a LEGACY record carries a public expression
 * there (imported before the #2944 refusal marker, written by an older binary,
 * or hand-edited): a current `cdkd import` refuses the baseline of a record it
 * could not resolve, and a resolved public reference is persisted resolved. A
 * mixed leaf there (a reference inside surrounding text) used to be refused
 * whatever its parameter was, so a public one was over-redacted: the
 * baseline held the expression where AWS holds the value. The only evidence
 * that can lift that is the parameter's TYPE, so this asks AWS for it.
 *
 * THE LOOKUP IS THE RESOLVER'S OWN COMPARISON PATH (`skipDynamicReferences`),
 * so there is one model of what "public" means and one place that asks:
 *
 * - `GetParameter` is sent with `WithDecryption: false`, so a `SecureString`
 *   answers with ciphertext the resolver discards. No secret value is fetched.
 * - It is sent in the record's OWN region, through a resolver pinned to it,
 *   and with the command's credentials — the ones its readback used. A
 *   reference `classifyReplaySecretRegion` does not answer `local` for (an ARN
 *   naming another region, or a region-less name in a stack that reads across
 *   regions) is not looked up at all: no proof. Nor is a region-less one when
 *   the producer-region evidence is INCOMPLETE (a nested child whose ancestors'
 *   reads could not be established, go-to-k/cdkd#4213): a parent may have
 *   resolved it in another region.
 * - Public is `String` / `StringList`, the resolver's own predicate. Every
 *   other answer — `SecureString`, an absent or unknown `Type`, any error
 *   (`AccessDenied`, `ParameterNotFound`, throttling past the retry) — is NO
 *   proof, and the leaf keeps today's over-redaction. A missing
 *   `ssm:GetParameter` permission therefore degrades to the old behaviour and
 *   never fails the command.
 *
 * Only tokens inside MIXED leaves are asked about: a whole-token leaf is
 * decided by position and never reads a proof, so a record with none costs no
 * call. Each token is asked once per prover, shared by every record.
 *
 * The proof lands in a FRESH, EMPTY map per record ({@link proofBagFor}), so
 * the redaction still runs its empty-map pipeline; the map's identity carries
 * the proof (`recordProvenPublicExpression`) and nothing else can read it. It
 * carries the VALUE the lookup returned, and the reader admits a leaf only when
 * the readback equals the source with that value in place of the token — so a
 * type read today never vouches for a value an earlier deploy resolved.
 */
export class PublicSsmProver {
  private resolver: IntrinsicFunctionResolver | undefined;
  private readonly verdicts = new Map<string, Promise<string | undefined>>();
  private readonly region: string;
  private readonly loadEvidence: () => Promise<ProducerRegionEvidence>;
  private evidence: Promise<ProducerRegionEvidence> | undefined;
  private readonly logger: { debug(message: string): void };

  /**
   * `loadEvidence` is called at most ONCE, and only when a REGION-LESS token
   * is about to be looked up: deriving it can read every ancestor's state
   * record (go-to-k/cdkd#4213), which a stack with no such token must not pay
   * for under its lock. A rejection reads as INCOMPLETE evidence.
   */
  constructor(
    region: string,
    loadEvidence: () => Promise<ProducerRegionEvidence>,
    logger: { debug(message: string): void }
  ) {
    this.region = region;
    this.loadEvidence = loadEvidence;
    this.logger = logger;
  }

  /**
   * A fresh, empty secrets map carrying a proof for every plain `ssm` token in
   * `source`'s mixed leaves that this prover proved public. Hand it to
   * `redactSecretsForState` in place of a shared empty constant.
   */
  async proofBagFor(source: unknown): Promise<RecordedSecretValues> {
    const bag: RecordedSecretValues = new Map();
    for (const token of mixedLeafSsmTokens(source)) {
      const value = await this.publicValue(token);
      if (value !== undefined) recordProvenPublicExpression(bag, token, value);
    }
    return bag;
  }

  private publicValue(token: string): Promise<string | undefined> {
    let verdict = this.verdicts.get(token);
    if (!verdict) {
      verdict = this.lookUp(token);
      this.verdicts.set(token, verdict);
    }
    return verdict;
  }

  private async lookUp(token: string): Promise<string | undefined> {
    // An ARN-form token names its own region, so the evidence is not
    // consulted for it (`classifyReplaySecretRegion` reads producer regions
    // only for a region-less name) and is not loaded.
    let regions: readonly string[] = [];
    if (regionLessSecretName(token) !== undefined) {
      this.evidence ??= this.loadEvidence().catch(() => ({ regions: [], complete: false }));
      const evidence = await this.evidence;
      if (!evidence.complete) return undefined;
      regions = evidence.regions;
    }
    if (classifyReplaySecretRegion(token, this.region, regions).kind !== 'local') {
      return undefined;
    }
    this.resolver ??= new IntrinsicFunctionResolver(this.region);
    const probe: RecordedSecretValues = new Map();
    const context: ResolverContext = {
      template: { Resources: {} },
      resources: {},
      recordedSecretValues: probe,
      skipDynamicReferences: true,
    };
    try {
      await this.resolver.resolveDynamicReferences(token, context);
    } catch (err) {
      // The error's NAME only: its message can carry the parameter name, and a
      // reader of this line needs only to know why the proof is missing.
      const name = err instanceof Error ? err.name : typeof err;
      this.logger.debug(
        safeMsg`Could not prove an ssm dynamic reference public (${name}); a leaf embedding it ` +
          `keeps its {{resolve:...}} expression in observedProperties.`
      );
      return undefined;
    }
    return provenPublicValue(probe, token);
  }
}

/** Every plain `{{resolve:ssm:` token inside a string leaf of `source` that is not a whole token. */
function mixedLeafSsmTokens(source: unknown): Set<string> {
  const tokens = new Set<string>();
  for (const leaf of wholeStringLeavesOf(source)) {
    if (isSingleDynamicReferenceToken(leaf)) continue;
    for (const token of dynamicReferenceTokens(leaf)) {
      if (token.startsWith('{{resolve:ssm:')) tokens.add(token);
    }
  }
  return tokens;
}
