import type { DeployEngine } from '../deploy-engine.js';
import { resolveDynamicReferences } from '../intrinsic-resolver/dynamic-refs.js';
import { persistedTokenResolverContext } from '../masked-baseline-recapture.js';
import {
  dynamicReferenceTokens,
  secretRerenderPairs,
  staticTemplateText,
  type RecordedSecretValues,
} from '../secret-redaction.js';
import { producerRegionEvidence } from './rollback.js';
import { tokensIn, tokenVersionMoved } from './update/legacy-spelling.js';
import type { StackState } from '../../types/state.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import { safeMsg } from '../../utils/display-safe.js';

/** One record leaf an older cdkd may have spelled with a secret's reference. */
interface Candidate {
  container: Record<string, unknown> | unknown[];
  key: string | number;
  stored: string;
  text: string;
}

/**
 * Before the deploy's diff (go-to-k/cdkd#7037): a record an older cdkd wrote
 * can hold a secret's `{{resolve:...}}` reference where the template spells
 * plain text (`Engine: postgres` beside the generated username `postgres`).
 * Compared as written, that is a change the deploy never makes, and every
 * reader of the plan (the stateful and in-use-export refusals, the
 * `--require-approval` prompt, the rollback-deferral check) would act on it.
 *
 * A deploy may read the secret (the update arm resolves it anyway), so the
 * question is settled here instead of guessed: for a leaf holding a reference
 * where the template's node is ALL template text, the record's references are
 * resolved (pinned to the stack's producer regions, as the masked-baseline
 * re-capture does) and, where the record then reads exactly that text, the
 * leaf is rewritten in memory to the text. What it writes is the template's
 * own text; the plaintext is a comparison key only and never stored. The save
 * persists the healed leaf like any other.
 *
 * Refused, leaving the leaf as it was: incomplete region evidence, a failed
 * resolution, a token served at a version the record was not written at (a
 * rotation since: the equality would say nothing about what AWS holds), and
 * anything that does not render to the text exactly. A stack with no such
 * leaf makes no call.
 */
export async function healLegacyLiteralSpellings(
  engine: DeployEngine,
  state: StackState,
  template: CloudFormationTemplate
): Promise<void> {
  const evidence = (() => {
    try {
      return producerRegionEvidence(engine.rollbackDeps(), state);
    } catch {
      return undefined;
    }
  })();
  for (const [logicalId, record] of Object.entries(state.resources ?? {})) {
    const declared = template.Resources?.[logicalId];
    if (declared === undefined || declared.Type !== record?.resourceType) continue;
    const properties = record.properties;
    if (properties === null || typeof properties !== 'object') continue;
    const candidates: Candidate[] = [];
    collect(properties, declared.Properties ?? {}, candidates, 0);
    // The drift baseline beside it took the same spelling (its walk is
    // template-sourced); healed alike, so a no-change deploy leaves none.
    const observed = record.observedProperties;
    if (observed !== null && typeof observed === 'object') {
      collect(observed, declared.Properties ?? {}, candidates, 0);
    }
    if (candidates.length === 0) continue;
    if (evidence?.complete !== true) continue;
    const own: RecordedSecretValues = new Map();
    try {
      for (const token of new Set(candidates.flatMap((c) => tokensIn(c.stored)))) {
        await resolveDynamicReferences(
          engine.resolver,
          token,
          persistedTokenResolverContext(own, evidence.regions)
        );
      }
    } catch {
      engine.logger.debug(
        safeMsg`${logicalId}: a stored secret reference could not be read to compare with the template; compared as written`
      );
      continue;
    }
    const pairs = secretRerenderPairs(own);
    let healed = 0;
    for (const candidate of candidates) {
      if (tokenVersionMoved(record, tokensIn(candidate.stored), own)) continue;
      let rendered = candidate.stored;
      for (const [expression, plaintext] of pairs)
        rendered = rendered.split(expression).join(plaintext);
      if (rendered !== candidate.text) continue;
      (candidate.container as Record<string | number, unknown>)[candidate.key] = candidate.text;
      healed++;
    }
    if (healed > 0) {
      engine.logger.debug(
        safeMsg`${logicalId}: ${String(healed)} stored value(s) an older cdkd spelled as a secret reference read as the template's text; compared as that text`
      );
    }
  }
}

const MAX_DEPTH = 32;

/** Record leaves holding a reference where the template node is all text, paired by key / index. */
function collect(stored: unknown, declared: unknown, out: Candidate[], depth: number): void {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(stored)) {
    if (!Array.isArray(declared) || declared.length !== stored.length) return;
    stored.forEach((item, i) => visit(stored, i, item, declared[i], out, depth));
    return;
  }
  if (stored === null || typeof stored !== 'object') return;
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) return;
  const record = stored as Record<string, unknown>;
  const template = declared as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(template, key)) continue;
    visit(record, key, record[key], template[key], out, depth);
  }
}

function visit(
  container: Record<string, unknown> | unknown[],
  key: string | number,
  stored: unknown,
  declared: unknown,
  out: Candidate[],
  depth: number
): void {
  if (typeof stored === 'string') {
    if (dynamicReferenceTokens(stored).length === 0) return;
    const text = staticTemplateText(declared);
    if (text !== undefined && text !== stored) out.push({ container, key, stored, text });
    return;
  }
  // An intrinsic template node has no keys to pair against a stored object.
  if (declared !== null && typeof declared === 'object' && !Array.isArray(declared)) {
    const keys = Object.keys(declared);
    if (keys.length === 1 && (keys[0] === 'Ref' || keys[0]!.startsWith('Fn::'))) return;
  }
  collect(stored, declared, out, depth + 1);
}
