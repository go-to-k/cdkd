import type { CloudFormationTemplate, TemplateOutput } from '../../types/resource.js';
import { getLogger } from '../../utils/logger.js';
import type { IntrinsicResolveFn } from '../diff-calculator.js';
import {
  collectPublishedOutputNames,
  displayTextOrWithheld,
  exportNameNoEchoParameters,
  exportNameSecretExposure,
  isExportAliasCollision,
  secretSafeKeyDisplay,
} from '../../deployment/outputs-export-alias.js';
import {
  dynamicReferenceTokens,
  hasMaskableValues,
  printingCorpusOf,
  readsNoEchoSource,
  shareLogOnlyValues,
  type NoEchoPositionSources,
  type RecordedSecretValues,
} from '../../deployment/secret-redaction.js';
import { stripForDisplay } from '../../utils/regexp.js';
import { safeMsg } from '../../utils/display-safe.js';
import { safeStringify } from '../../utils/aws-failure-text.js';
import { keepsSecretReferenceToken } from '../../deployment/intrinsic-resolver/context.js';
import type { ResolvedTemplateOutputs } from './types.js';
import { containsSecretDynamicReference, isUnresolvedValue, templateUsesSub } from './values.js';

/**
 * Resolve a template's `Outputs` section into the exact bag shape the deploy
 * engine persists to `StackState.outputs` (issue #1921).
 *
 * This is the preview twin of `resolveOutputs` (`deploy-engine/outputs/resolve.ts`), and the three
 * semantics below are load-bearing for parity — a preview that builds a
 * DIFFERENT bag than the apply persists reports a phantom change on every run,
 * which is this issue's own bug class inverted. `tests/unit/analyzer/
 * outputs-diff.test.ts` fences each one against drift on the deploy side.
 *
 * 1. An output whose `Condition` evaluates false is SKIPPED, not resolved —
 *    CloudFormation simply does not create it (mirrors the resource side's
 *    `filterResourcesByCondition`; an unknown condition name is kept).
 * 2. An `Export.Name` is stored as a SECOND key holding the same value, so
 *    `Fn::ImportValue` can find it by export name. Both keys land in state, so
 *    both must land here.
 * 3. Resolution is best-effort and never throws — a diff must never harden into
 *    an error where the deploy would have succeeded.
 *
 * The parity claim is scoped to the deploy engine's NO-CHANGE branch, which is
 * the one this preview stands in for. Its changed-resources branch resolves
 * outputs with no `resolutionFailed` gate at all — correctly, because by then
 * every resource exists and resolution is expected to succeed, whereas a diff
 * runs BEFORE any of them are created.
 *
 * Deliberately does NOT redact secrets the way the deploy side does: this
 * resolver runs with `skipDynamicReferences`, so a `{{resolve:...}}` reference
 * is never resolved to plaintext in the first place and the bag already holds
 * the expression that state stores post-redaction.
 *
 * `storedOutputs` is the bag currently in state. It is consulted for exactly
 * two decisions — the LITERAL `Export.Name` of a secret-bearing stack, see issue
 * #1942 at that branch, and whether a skipped-output record still applies, see
 * issue #2740 below — and never merged into the result: everything else here
 * previews what the template says, and reading state anywhere else would make
 * the preview agree with the past instead of with the next deploy.
 *
 * `skippedOutputKeys` (issue #2740) are the keys the LAST DEPLOY could not
 * resolve and skipped, already narrowed by the caller on BOTH halves of the
 * binding rule: the recorded digest still matches today's template, AND no
 * resource the output references is changing on this run
 * (`bindingSkippedOutputs`, over a pre-resolution snapshot and this run's
 * resource diff — see `skipped-outputs.ts` for why the snapshot is the
 * caller's and why the change map cannot come from the digest). Such a key,
 * while still absent from `storedOutputs`, is previewed as ABSENT — skipped
 * without resolving, no bag entry, no row — because that is what the next
 * deploy will leave in state: this resolver runs
 * with `skipDynamicReferences`, so a failure that happened inside a secret
 * lookup would otherwise assemble cleanly and preview an `ADD` the deploy will
 * never perform. NOT a resolution failure: the sibling outputs are previewed
 * normally, so a genuine change beside the broken output still renders and
 * `--fail` still exits 1 for it. The key appearing in state (a later deploy
 * resolved it) ends the suppression.
 *
 * `outputsPass` (go-to-k/cdkd#4043) is the twin of the deploy's outputs-pass
 * bag: `resolveInto(bag)` is a resolver recording into `bag`. Every value
 * resolves into `secrets`, and each `Export.Name` into a bag of its own, so the
 * `NoEcho` values the deploy's pass reads as LOG-ONLY needles are known per
 * source, and an alias whose name holds one is refused as the deploy refuses
 * it. Without it no alias is refused for that reason.
 */
export async function resolveTemplateOutputs(
  template: CloudFormationTemplate,
  resolveFn: IntrinsicResolveFn,
  conditions?: Record<string, boolean>,
  storedOutputs?: Record<string, unknown>,
  skippedOutputKeys?: ReadonlySet<string>,
  outputsPass?: {
    resolveInto: (bag: RecordedSecretValues) => IntrinsicResolveFn;
    secrets: RecordedSecretValues;
    /** The deploy's `noEchoParameterValueSeed`, built from this diff's inputs. */
    noEchoParameterValues?: RecordedSecretValues;
    /**
     * The `NoEcho` parameters an intrinsic name may read, under the verdicts
     * this diff KNOWS (go-to-k/cdkd#4657): the deploy's positional refusal.
     */
    noEchoNameSources?: NoEchoPositionSources;
    /**
     * A nested child's parameters the parent fills from a `NoEcho` source
     * under ANY condition verdict (go-to-k/cdkd#4723): read only by the
     * `exportNameReadsNoEcho` gate, whose stored alias was published under a
     * past verdict. Pass 3 keeps `noEchoNameSources`, today's.
     */
    noEchoNameParametersAnyVerdict?: ReadonlySet<string>;
    /**
     * Whether `Fn::GetAtt` of `attribute` on `logicalId` serves a value its
     * producer declared `NoEcho`, per the stored record. Read only by the
     * `exportNameReadsNoEcho` gate (go-to-k/cdkd#4723), never by pass 3.
     */
    noEchoAttributeIsNoEcho?: (logicalId: string, attribute: string) => boolean;
  }
): Promise<ResolvedTemplateOutputs> {
  const resolveValue = outputsPass?.resolveInto(outputsPass.secrets) ?? resolveFn;
  // The outputs whose `Export.Name` pass 2 decides, in declaration order.
  const exporting: Array<{
    outputKey: string;
    output: TemplateOutput & { Export: { Name: unknown } };
    value: unknown;
  }> = [];
  // The deploy's verdict (go-to-k/cdkd#4043) over this name's bag, whose
  // log-only set is the pass's, and the stack's `NoEcho` seed. Skipped while
  // neither holds a needle.
  const refusesNoEchoName = (exportName: string, nameBag: RecordedSecretValues): boolean =>
    outputsPass !== undefined &&
    (hasMaskableValues(outputsPass.secrets) ||
      nameBag.size > 0 ||
      hasMaskableValues(outputsPass.noEchoParameterValues)) &&
    exportNameSecretExposure(
      exportName,
      nameBag,
      outputsPass.secrets,
      outputsPass.noEchoParameterValues
    ) !== undefined;
  // The owner key as a debug line may show it: masked against the pass's
  // printing corpus, as the deploy's refusal warning masks it.
  const ownerDisplay = (outputKey: string): string =>
    outputsPass === undefined
      ? outputKey
      : displayTextOrWithheld(
          secretSafeKeyDisplay(outputKey, printingCorpusOf(outputsPass.secrets))
        );
  const logger = getLogger().child('OutputsDiff');
  // `Object.create(null)`, not `{}` (issue #1943's class). Two writes below
  // key this bag by a template-controlled RESOLVED `Export.Name`, so a stack
  // exporting the name `__proto__` would either mutate the prototype or have
  // its write silently dropped on a normal object — and a dropped write then
  // reads downstream as a phantom REMOVE of a key state actually holds. A
  // null-prototype bag has no `__proto__` setter, so the key lands as data.
  // `JSON.stringify` and `Object.entries` treat it identically, and the value
  // is only ever consumed through those.
  const outputs: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const exportNames = new Set<string>();
  const failedKeys = new Set<string>();
  const failedOutputKeys = new Set<string>();
  // Starts true and only ever turns false: an arm that cannot hand the merge a
  // key clears it. See `ResolvedTemplateOutputs.failuresMirrorDeploy`.
  let failuresMirrorDeploy = true;
  const secretSourceKeys = new Set<string>();
  const declaredKeys = new Set<string>();
  // Walked over the WHOLE template, `Resources` included (issue #1948). The
  // question this answers is "does this stack handle secrets at all?", and the
  // deleted-output case it gates is precisely one where `Outputs` no longer
  // mentions the secret — so an Outputs-only walk would answer `false` for
  // every case the gate exists to catch.
  const templateHasSecretReference = containsSecretDynamicReference(template);
  const secretBearingExportNames: string[] = [];
  const refusedNoEchoExportNames: string[] = [];
  let exportNameReadsNoEcho = false;
  let resolutionFailed = false;
  // Does the deploy's outputs pass RECORD a secret at all (issue #4143)? A
  // spelled output value (`secretSourceKeys`) is one source; a resolved value
  // or intrinsic `Export.Name` that keeps a deploy-resolved token after the
  // skip pass (a plain `ssm` SecureString, or a `secretsmanager` reference
  // spelled only in a name) is the other, invisible to that raw spelling
  // test. Decided after the loop, so LITERAL aliases wait for it. Every alias
  // is written after the loop, in declaration order, as the deploy's alias
  // pass does (values first, then aliases).
  //
  // Only a token the template SPELLS in that output counts: one that arrives
  // through a `Ref` to a parameter (a nested child's secret parameter, which
  // the diff passes on as its token) is not recorded in the deploy's pass map,
  // so counting it suppressed a section main published (#4145 review).
  // This gate reads the whole pass, as the deploy's alias decisions do: they
  // run after every name has resolved (go-to-k/cdkd#4043).
  let passResolvesSecret = false;
  // A leaf walk rather than `JSON.stringify`, which throws on a BigInt or a
  // cycle, and would count a key NAME spelling a token.
  const spellsToken = (raw: unknown): boolean => {
    if (typeof raw === 'string') return raw.includes('{{resolve:');
    if (Array.isArray(raw)) return raw.some(spellsToken);
    if (raw !== null && typeof raw === 'object') {
      return Object.values(raw as Record<string, unknown>).some(spellsToken);
    }
    return false;
  };
  const pendingAliases: Array<{
    outputKey: string;
    exportName: string;
    value: unknown;
    literal: boolean;
  }> = [];
  const keepsTokenInLeaves = (value: unknown): boolean => {
    if (typeof value === 'string') return keepsSecretReferenceToken(value);
    if (Array.isArray(value)) return value.some(keepsTokenInLeaves);
    if (value !== null && typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).some(keepsTokenInLeaves);
    }
    return false;
  };
  // The deploy engine REFUSES an export alias whose name is another published
  // output's name, and refuses one carrying a secret (issue #1919). This module
  // previews the bag that engine persists, so it has to refuse the same two —
  // it is the THIRD writer of that key space. Without this the preview publishes
  // an alias the deploy will not, and `computeOutputsDiff` reports a phantom
  // ADD/MODIFY on EVERY run: `cdkd diff --fail` never goes green again, and the
  // user is told an export exists that deploy declines to publish.
  const publishedOutputNames = collectPublishedOutputNames(template.Outputs ?? {}, conditions);

  if (!template.Outputs) {
    return {
      outputs,
      exportNames,
      failedKeys,
      failedOutputKeys,
      failuresMirrorDeploy,
      secretSourceKeys,
      declaredKeys,
      templateHasSecretReference,
      resolutionFailed,
      secretBearingExportNames,
      refusedNoEchoExportNames,
      exportNameReadsNoEcho,
    };
  }

  /**
   * Record a key the resolver DROPPED — plus the literal `Export.Name` alias the
   * deploy would have written alongside it. Both are absent from the bag, so
   * both would otherwise read as phantom REMOVEs and make the suppression
   * warning fire on the ordinary pending-resource case.
   */
  const recordFailure = (outputKey: string, output: TemplateOutput): void => {
    failedKeys.add(outputKey);
    // Only a LITERAL alias can be named. An INTRINSIC `Export.Name` on a failed
    // output has no resolved string to record, so if state holds that alias it
    // still reads as a phantom REMOVE. Accepted rather than worked around: the
    // name is genuinely unknowable here, and `failedKeys` feeds ONLY the
    // suppression-warning filter — never a rendered row — so the worst outcome
    // is one spurious warning line, not a wrong diff.
    if (typeof output.Export?.Name === 'string') failedKeys.add(output.Export.Name);
  };

  // Pass 1: which keys does the TEMPLATE prove are secret-bearing? Walked over
  // EVERY declared output — including condition-skipped ones, which never reach
  // the resolve loop below yet can still sit on the stored side and print as a
  // REMOVE row. A literal `Export.Name` alias is recorded too, since the deploy
  // writes the same value under both keys.
  // The `NoEcho` sources for the `exportNameReadsNoEcho` gate in the loop
  // below: no condition verdicts; in a nested child, each parameter the parent
  // fills from a `NoEcho` source under ANY verdict; and a `NoEcho` attribute.
  const everyBranch: NoEchoPositionSources = {
    parameters: new Set([
      ...(outputsPass?.noEchoNameSources?.parameters ?? []),
      ...(outputsPass?.noEchoNameParametersAnyVerdict ?? []),
    ]),
    ...(outputsPass?.noEchoAttributeIsNoEcho !== undefined && {
      attributeIsNoEcho: outputsPass.noEchoAttributeIsNoEcho,
    }),
  };
  for (const [outputKey, output] of Object.entries(template.Outputs)) {
    // Every declared key, secret-bearing or not (issue #1948): a stored key
    // this set does NOT hold is one today's template cannot account for, which
    // is the deleted-output signal `secretSourceKeys` structurally cannot give.
    declaredKeys.add(outputKey);
    if (typeof output.Export?.Name === 'string') declaredKeys.add(output.Export.Name);
    // Every declared output, not only those pass 3 decides: a condition-false
    // exporter's stored alias is a REMOVE row too. And NO condition verdicts,
    // unlike pass 3's refusal of today's name: the stored alias was published
    // under a past verdict, so an `Fn::If` branch today drops still counts.
    // A LITERAL name reads nothing, as for pass 3.
    const name: unknown = output.Export?.Name;
    if (
      !exportNameReadsNoEcho &&
      outputsPass?.noEchoNameSources !== undefined &&
      name !== null &&
      typeof name === 'object' &&
      readsNoEchoSource(name, everyBranch)
    ) {
      exportNameReadsNoEcho = true;
    }
    if (!containsSecretDynamicReference(output.Value)) continue;
    secretSourceKeys.add(outputKey);
    if (typeof output.Export?.Name === 'string') secretSourceKeys.add(output.Export.Name);
  }

  /**
   * Record the secret-bearing `Export.Name` of an output the loop below leaves
   * BEFORE its alias block -- condition-false, previewed absent by a #2740
   * record, or FAILED -- for the stored-key span only (issue #4015). A failed
   * one counts too: a RENAMED exporter whose value fails leaves the section
   * rendered (its old output key and alias are REMOVE rows), and its stale
   * alias printed raw without this. The
   * output's alias is not in this bag, so a stored copy of it is a REMOVE or
   * carried row whose NAME a binary from before #1919 filled with the
   * plaintext; without this, a condition-gated exporter printed it. Nothing
   * is published from here, and a name that throws or does not keep its token
   * gives no span.
   */
  /**
   * ANY `{{resolve:...}}` token left after this resolver's
   * `skipDynamicReferences` pass marks a name the deploy substitutes a SECRET
   * into, not only the `secretsmanager` / `ssm-secure` spellings
   * `isSecretDynamicReference` knows: a plain `{{resolve:ssm:...}}` to a
   * `SecureString` parameter stays a token too (measured), while a public
   * `String` one resolves to its value and carries none. So the token scan,
   * not the spelling, decides (issue #4015). Corpus only: which alias this
   * preview publishes is decided below by `keepsSecretReferenceToken`, which
   * reads the same scan narrowed to the services the deploy resolves (#4056).
   */
  const recordTokenBearingExportName = (name: string): void => {
    if (dynamicReferenceTokens(name).length > 0) secretBearingExportNames.push(name);
  };

  const recordSkippedSecretExportName = async (output: TemplateOutput): Promise<void> => {
    const declared: unknown = output.Export?.Name;
    if (declared === undefined || typeof declared === 'string') return;
    try {
      const resolvedName = await resolveFn(structuredClone(declared));
      if (typeof resolvedName === 'string') recordTokenBearingExportName(resolvedName);
    } catch {
      // No span from a name this preview cannot resolve.
    }
  };

  for (const [outputKey, output] of Object.entries(template.Outputs)) {
    if (output.Condition !== undefined && conditions?.[output.Condition] === false) {
      logger.debug(
        `Skipping output ${stripForDisplay(outputKey)} — condition ${stripForDisplay(String(output.Condition))} is false`
      );
      // NOT a resolution failure — CFn genuinely does not create it, so the
      // deploy drops it from the bag too and a REMOVE here is CORRECT.
      await recordSkippedSecretExportName(output);
      continue;
    }
    // Issue #2740: the last deploy could not resolve this output and the
    // template has not changed in any way its resolution reads — so the next
    // deploy will skip it again, and previewing it would be a phantom ADD.
    // Previewed as ABSENT instead, the way the deploy leaves it: no bag entry,
    // and — deliberately — neither `resolutionFailed` nor `failedKeys`, which
    // would suppress the whole section and hide a sibling's genuine change.
    // Only while the key is ABSENT from state: present means a later deploy did
    // resolve it, and the record is stale rather than binding. Checked BEFORE
    // resolving the preview's value. The deploy's value pass still resolves
    // it, recording its `NoEcho` needles for the alias verdict
    // (go-to-k/cdkd#4043), so with an `outputsPass` it is resolved into that
    // bag too, and the result discarded. Bound, stated: this issues the
    // lookups its resolution makes (an attribute heal, a CFn fallback), and
    // it can OVER-refuse, since the deploy's value pass may fail before
    // reaching what this preview's resolution records. Only a DERIVED needle
    // (an `Fn::Base64` encoding, an `Fn::Split` piece) can differ: the
    // `NoEcho` value itself is in both sides' seed either way.
    if (
      skippedOutputKeys?.has(outputKey) &&
      !(
        storedOutputs !== undefined &&
        Object.prototype.hasOwnProperty.call(storedOutputs, outputKey)
      )
    ) {
      logger.debug(
        `Diff previewing output ${stripForDisplay(outputKey)} as absent — the last deploy could not resolve it and its template inputs are unchanged`
      );
      if (outputsPass !== undefined) {
        try {
          await resolveValue(structuredClone(output.Value));
        } catch {
          // Its needles only; a failure records nothing more.
        }
      }
      await recordSkippedSecretExportName(output);
      continue;
    }
    const sourceUsedSub = templateUsesSub(output.Value);

    let value: unknown;
    try {
      // Resolve a CLONE. The reason is the INVARIANT, not a call site: this
      // template is shared with the resource diff that already ran and with
      // the skipped-output digests computed above, so nothing here may leave
      // a resolved value — a decrypted secret among them — reachable by
      // either. Resolving a copy makes that true whatever the resolver does.
      // (It is not true that the resolver mutates its input today: `resolveSub`
      // wrote back until go-to-k/cdkd#2764 retired it, and this comment named
      // that write-back in three places. Kept as history so the clone is not
      // deleted as dead weight, which is exactly what the invariant forbids.)
      value = await resolveValue(structuredClone(output.Value));
    } catch (error) {
      logger.debug(
        `Diff could not resolve output ${stripForDisplay(outputKey)}: ${stripForDisplay(safeStringify(error))}`
      );
      resolutionFailed = true;
      recordFailure(outputKey, output);
      // The deploy records a throw the same way (its catch stores `undefined`):
      // a matching failure signal, not a promise that its resolution throws too.
      failedOutputKeys.add(outputKey);
      await recordSkippedSecretExportName(output);
      continue;
    }
    if (isUnresolvedValue(value, sourceUsedSub)) {
      // The common, EXPECTED case: the output references a resource this deploy
      // has not created yet. Not a warning — the resource section already shows
      // that CREATE.
      logger.debug(
        `Diff left output ${stripForDisplay(outputKey)} unresolved (references a pending resource)`
      );
      resolutionFailed = true;
      recordFailure(outputKey, output);
      // Only a TOP-LEVEL `undefined` is deploy's own signal. Every other arm of
      // `isUnresolvedValue` (a nested `undefined` included) says nothing about
      // what the deploy does with the key, so it cannot be previewed as carried.
      if (value === undefined) failedOutputKeys.add(outputKey);
      else failuresMirrorDeploy = false;
      await recordSkippedSecretExportName(output);
      continue;
    }
    outputs[outputKey] = value;
    if (spellsToken(output.Value) && keepsTokenInLeaves(value)) passResolvesSecret = true;

    if (output.Export?.Name) {
      exporting.push({
        outputKey,
        output: output as TemplateOutput & { Export: { Name: unknown } },
        value,
      });
    }
  }

  // Pass 2, the deploy's name pass: every `Export.Name`, AFTER every value,
  // resolved before any alias is decided (go-to-k/cdkd#4043, Phase B). Each
  // name resolves into a bag of its OWN sharing the pass's log-only set, with
  // its entries forwarded into the pass bag once it resolves -- the deploy's
  // `nameSecrets` (a live recording scope, `openRecordingScope`) -- so an
  // `Fn::Base64` in a name records its encoding exactly as the deploy's does.
  const resolvedNames: Array<{
    outputKey: string;
    exportName: string;
    value: unknown;
    declaredExportIsIntrinsic: boolean;
    nameSource: unknown;
    nameBag: RecordedSecretValues;
  }> = [];
  for (const { outputKey, output, value } of exporting) {
    const nameBag: RecordedSecretValues = new Map();
    if (outputsPass !== undefined) shareLogOnlyValues(nameBag, outputsPass.secrets);
    try {
      let exportName: unknown = output.Export.Name;
      // The `Fn::Sub` scoping is derived from `Export.Name`'s OWN source, not
      // from `output.Value`: an export name can be an `Fn::Sub` while the value
      // is a plain `Fn::GetAtt` (or the reverse), and reusing the value's flag
      // would either miss a laundered placeholder in the NAME — publishing a
      // wrong alias key, which is worse than a phantom because a consumer reads
      // it — or suppress on a name that never used `Fn::Sub` at all.
      const exportSourceUsedSub = templateUsesSub(output.Export.Name);
      const declaredExportIsIntrinsic = typeof output.Export.Name !== 'string';
      if (typeof exportName !== 'string') {
        try {
          exportName = await (outputsPass?.resolveInto(nameBag) ?? resolveFn)(
            structuredClone(exportName)
          );
        } catch (error) {
          logger.debug(
            `Diff could not resolve Export.Name of ${stripForDisplay(outputKey)}: ${stripForDisplay(safeStringify(error))}`
          );
          resolutionFailed = true;
          // The value resolved, so deploy records no failure for this output,
          // and the alias it will write has no name here to merge under.
          failuresMirrorDeploy = false;
          continue;
        }
      }
      if (typeof exportName === 'string') recordTokenBearingExportName(exportName);
      if (
        declaredExportIsIntrinsic &&
        spellsToken(output.Export.Name) &&
        typeof exportName === 'string' &&
        keepsSecretReferenceToken(exportName)
      ) {
        passResolvesSecret = true;
      }
      if (typeof exportName === 'string' && !isUnresolvedValue(exportName, exportSourceUsedSub)) {
        resolvedNames.push({
          outputKey,
          exportName,
          value,
          declaredExportIsIntrinsic,
          nameSource: output.Export.Name,
          nameBag,
        });
      } else {
        // An Export.Name that stayed intrinsic means the alias key the deploy
        // WILL write is unknown, so the bag is incomplete — same suppression as
        // an unresolvable value rather than a diff missing a key.
        resolutionFailed = true;
        failuresMirrorDeploy = false;
      }
    } finally {
      if (outputsPass !== undefined) {
        for (const [plaintext, expression] of nameBag)
          outputsPass.secrets.set(plaintext, expression);
      }
    }
  }

  // Pass 3, the deploy's alias decisions: in declaration order, each against
  // every value's and every name's needles.
  for (const {
    outputKey,
    exportName,
    value,
    declaredExportIsIntrinsic,
    nameSource,
    nameBag,
  } of resolvedNames) {
    // The refusal order MIRRORS the deploy engine's — secret first, then
    // collision — so a name matching both is attributed the same way on
    // both sides. See `outputs-export-alias.ts`'s parity table for the full
    // row-by-row correspondence this block is written against.
    if (exportNameNoEchoParameters(nameSource, outputsPass?.noEchoNameSources).length > 0) {
      // An intrinsic name reading a `NoEcho` parameter (go-to-k/cdkd#4657),
      // refused from the template at any value length, as the deploy does.
      refusedNoEchoExportNames.push(exportName);
      logger.debug(
        safeMsg`Diff skipping export alias of ${ownerDisplay(outputKey)} — the name reads a NoEcho parameter`
      );
    } else if (refusesNoEchoName(exportName, nameBag)) {
      refusedNoEchoExportNames.push(exportName);
      // A `NoEcho` value in the name (go-to-k/cdkd#4043), decided HERE, as
      // the deploy decides it: after every value and every name, against
      // all their needles and the stack's `NoEcho` seed.
      logger.debug(
        safeMsg`Diff skipping export alias of ${ownerDisplay(outputKey)} — the name carries a value this pass recorded as secret`
      );
    } else if (declaredExportIsIntrinsic && keepsSecretReferenceToken(exportName)) {
      // An INTRINSIC name that still carries a `{{resolve:...}}` token
      // after this resolver's `skipDynamicReferences` pass is one the deploy
      // WILL substitute plaintext into, and then refuse (the name would be a
      // state KEY, which no redaction pass walks). The TOKEN decides, not
      // the `secretsmanager` / `ssm-secure` spelling: a plain `ssm` token
      // to a `SecureString` survives the pass too, and the spelling test
      // published its alias as a phantom ADD (issue #4056). Gated on INTRINSIC
      // deliberately: for a LITERAL name the deploy substitutes nothing —
      // it uses the string verbatim as the key — so it publishes, and
      // refusing here would be a phantom REMOVE on every run. That gate is
      // the round-6 regression this replaces, which traded one divergence
      // for two.
      logger.debug(
        `Diff skipping export alias of ${stripForDisplay(outputKey)} — the name carries a secret reference`
      );
    } else if (isExportAliasCollision(exportName, outputKey, publishedOutputNames)) {
      // Deploy skips this alias and keeps the colliding output's own value,
      // so previewing it here would be a permanent phantom row. NOT a
      // resolution failure: the bag matches what deploy writes, which is the
      // point of the suppression flag, so nothing needs withholding.
      logger.debug(
        `Diff skipping export alias ${stripForDisplay(exportName)} of ${stripForDisplay(outputKey)} — collides with an output name`
      );
    } else {
      // Written after the loop (a LITERAL one decided there, once
      // `passResolvesSecret` is known).
      pendingAliases.push({
        outputKey,
        exportName,
        value,
        literal: !declaredExportIsIntrinsic,
      });
    }
  }

  const deployRecordsSecret = secretSourceKeys.size > 0 || passResolvesSecret;
  for (const { outputKey, exportName, value, literal } of pendingAliases) {
    if (!literal || !deployRecordsSecret) {
      outputs[exportName] = value;
      exportNames.add(exportName);
      continue;
    }
    // The deploy refuses a LITERAL name that CONTAINS a resolved secret
    // plaintext — the `prod-<secret>-endpoint` shape — and this preview
    // never substitutes a plaintext, so it cannot evaluate that predicate
    // directly. Narrowed to stacks where the deploy actually records a
    // secret (`passResolvesSecret`, issue #4143): with none there is nothing
    // for a name to contain.
    //
    // STATE decides it (issue #1942). The stored bag holding this exact
    // alias KEY is proof that a PREVIOUS deploy — which did hold the
    // plaintext and did evaluate the predicate — published it, so this
    // preview can publish it too: same literal name, same output, so the
    // next deploy re-evaluates the same predicate over the same name. The
    // preview is not guessing at the predicate; it is reading a verdict
    // the apply already recorded.
    //
    // Publishing regardless of the stored VALUE, deliberately. The
    // refusal deploy makes is about the NAME, which is a template literal
    // and unchanged between the two runs; the value is what the output
    // resolves to today, and previewing a CHANGED one is exactly the #875
    // case this whole section exists for. Requiring value equality would
    // suppress the only row anyone needed.
    //
    // ABSENT key -> suppress, as before. Absence is not evidence: it means
    // either a first deploy of this alias or a first deploy of the stack,
    // and in both the apply's verdict does not exist yet. Guessing there
    // would be guessing at the predicate, which is what this arm refuses
    // to do.
    //
    // Two residuals, stated rather than papered over. (1) A secret that
    // ROTATES to a value which is a substring of the literal export name
    // flips deploy's verdict, so the preview would publish a row deploy
    // now refuses — a phantom, and the row's KEY would carry that
    // plaintext; the name is a fixed template literal and the value is
    // high-entropy, so this needs a coincidence rather than a mistake.
    // (2) A key stored by a PRE-#1919 binary records no verdict at all
    // (the refusal did not exist then) — that is the same key
    // `cdkd scrub` reports through `secretBearingStateKeyWarning`, and
    // it prints as a row on any stack whose section is not suppressed,
    // so publishing does not widen it. Its NAME goes through
    // `computeOutputsDiff`'s key verdict (issue #4015). While the name is
    // still declared it is template text -- the plaintext it would carry
    // is in the template itself -- and is masked only when the corpus
    // holds it; once removed, its stored key is a REMOVE row the
    // alias-name refusal there withholds.
    const storedProvesPublished =
      storedOutputs !== undefined &&
      Object.prototype.hasOwnProperty.call(storedOutputs, exportName);
    if (storedProvesPublished) {
      outputs[exportName] = value;
      exportNames.add(exportName);
    } else {
      // Suppressing is this module's existing answer to "cannot reproduce
      // what deploy will do", and it also avoids printing a row whose KEY
      // may hold that plaintext into CI logs.
      //
      // Recording the ALIAS key is what keeps the suppression honest: it
      // is absent from this bag but may well be PRESENT in state, and
      // without recording it the warning downstream reads it as a REMOVE
      // and blames "an output referencing a resource this deploy has yet
      // to create" — the wrong cause, on every run, forever.
      // `failedKeys.add` directly, NOT `recordFailure`: that helper also
      // records `outputKey`, whose value resolved fine and belongs in the
      // diff.
      logger.debug(
        `Diff cannot decide the export alias of ${stripForDisplay(outputKey)} — a literal name may contain a resolved secret and state does not hold that key`
      );
      failedKeys.add(exportName);
      resolutionFailed = true;
      // Deploy DOES decide this alias, holding the plaintext, and the
      // merge has no verdict to carry or drop it by.
      failuresMirrorDeploy = false;
    }
  }

  return {
    outputs,
    exportNames,
    failedKeys,
    failedOutputKeys,
    failuresMirrorDeploy,
    secretSourceKeys,
    declaredKeys,
    templateHasSecretReference,
    resolutionFailed,
    secretBearingExportNames,
    refusedNoEchoExportNames,
    exportNameReadsNoEcho,
  };
}
