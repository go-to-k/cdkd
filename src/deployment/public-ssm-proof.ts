import { IntrinsicFunctionResolver } from './intrinsic-function-resolver.js';
import type { ResolverContext } from './intrinsic-resolver/context.js';
import type { RecordedSecretValues } from './secret-redaction/pairs.js';
import { dynamicReferenceTokens } from './secret-redaction/redact-path.js';
import { isSingleDynamicReferenceToken } from './secret-redaction/rules.js';
import {
  isProvenPublicExpression,
  recordProvenPublicExpression,
  wholeStringLeavesOf,
} from './secret-redaction/mask-only.js';
import { classifyReplaySecretRegion } from './secret-region-classification.js';
import { safeMsg } from '../utils/display-safe.js';

/**
 * Proves, for the two commands that resolve nothing, which plain
 * `{{resolve:ssm:...}}` references in a record's MIXED leaves name a PUBLIC
 * parameter (issue [#2036](https://github.com/go-to-k/cdkd/issues/2036)).
 *
 * `cdkd state refresh-observed` and `cdkd import`'s observed capture redact an
 * AWS readback against the record's own `properties` with an EMPTY secrets
 * map. A mixed leaf there (a reference inside surrounding text) used to be
 * refused whatever its parameter was, so a public one was over-redacted: the
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
 *   regions) is not looked up at all: no proof.
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
 * the proof (`recordProvenPublicExpression`) and nothing else can read it.
 */
export class PublicSsmProver {
  private resolver: IntrinsicFunctionResolver | undefined;
  private readonly verdicts = new Map<string, Promise<boolean>>();
  private readonly region: string;
  private readonly producerRegions: readonly string[];
  private readonly logger: { debug(message: string): void };

  constructor(
    region: string,
    producerRegions: readonly string[],
    logger: { debug(message: string): void }
  ) {
    this.region = region;
    this.producerRegions = producerRegions;
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
      if (await this.isPublic(token)) recordProvenPublicExpression(bag, token);
    }
    return bag;
  }

  private isPublic(token: string): Promise<boolean> {
    let verdict = this.verdicts.get(token);
    if (!verdict) {
      verdict = this.lookUp(token);
      this.verdicts.set(token, verdict);
    }
    return verdict;
  }

  private async lookUp(token: string): Promise<boolean> {
    if (classifyReplaySecretRegion(token, this.region, this.producerRegions).kind !== 'local') {
      return false;
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
      return false;
    }
    return isProvenPublicExpression(probe, token);
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
