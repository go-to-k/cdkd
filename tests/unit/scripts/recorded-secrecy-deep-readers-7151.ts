/**
 * go-to-k/cdkd#7151: the record readers ONLY the deep reach of the record-text
 * fence sees (`recorded-secrecy-readers-7061.test.ts`, `deepRecordTextProblems`):
 * a bag reached through two or more local copies, a chain of same-file
 * helpers, or a function another module exports. Each still reads a record
 * bag's TEXT.
 *
 * Each entry was triaged by go-to-k/cdkd#7156 and carries its `why`: the
 * reason its verdict can never be less masked than the record's provenance
 * alone would make it (the value is not a record bag, a text hit masks or
 * refuses MORE, the reader reads the provenance field already, or it needs
 * the marker KIND, which `recordedSecrecyOf` merges). Every writer of
 * `noEchoLeaves` or `noEchoAttributeNames` (the deploy persist, scrub, import,
 * the rollback replay, the drift revert) writes the mask at each position it
 * names in the same step, and `maskedPropertyFingerprints` stamps only keys
 * holding the mask. So a marked position holding a NoEcho plaintext is not a
 * state cdkd writes; a stale-leaf heal may leave a fingerprint over a settled,
 * no-longer-NoEcho value, which `recordedSecrecyOf` reads as MORE masked. A new reader
 * fails the fence until it is pinned here with its `why`, and so does an
 * entry that matches nothing.
 */
export const READS_RECORD_TEXT_DEEP: Readonly<Record<string, { count: number; why: string }>> = {
  "src/analyzer/diff-calculator/redaction-masks.ts#maskUnmovedRedactionMasks#holdsMaskLeaf(current[key])": {
    count: 1,
    why: "copies the record's literal mask positions onto the desired side to hide a non-change: a wider `masked` would hide real changes on plaintext keys, and masks no output",
  },
  "src/analyzer/diff-calculator/redaction-masks.ts#maskUnmovedRedactionMasks#holdsMaskLeaf(desired[key])": {
    count: 1,
    why: "the plan side after the NoEcho comparison, not a record: a hit skips a key that comparison already masked",
  },
  "src/analyzer/diff-calculator/redaction-masks.ts#maskUnmovedRedactionMasks#isMaskLeaf(current[key])": {
    count: 1,
    why: "needs the marker SHAPE (a whole-key mask, not a partial one); a hit only lets the masking proceed",
  },
  "src/analyzer/diff-calculator/redaction-masks.ts#maskUnmovedRedactionMasks#mentionsMask(desired[key])": {
    count: 1,
    why: "the plan side, not a record: a hit keeps the key on the masking path instead of comparing it as is",
  },
  "src/analyzer/diff-calculator/redaction-masks.ts#maskedWhere#isMaskLeaf(recorded)": {
    count: 1,
    why: "copies the record's mask leaves into desired at their exact sub-positions: a wider `masked` would mask desired positions and hide real changes",
  },
  "src/analyzer/drift-calculator.ts#diffAt#mentionsDynamicReference(stateValue)": {
    count: 1,
    why: "the baseline re-resolved by drift before the compare; a hit skips the compare, so a wider `masked` would hide drift, and the shown values are redacted downstream",
  },
  "src/analyzer/orphan-rewriter/recorded-attributes.ts#servableRecordedAttribute#carriesSecretMask(value)": {
    count: 1,
    why: "BOTH: getAtt refuses a `noEchoAttributeNames` attribute (secretDerivedLiveAttribute) before it uses this answer; the text hit only adds a refusal",
  },
  "src/analyzer/orphan-rewriter/recorded-attributes.ts#unsplicableCachedAttribute#carriesSecretMask(cached)": {
    count: 1,
    why: "BOTH: reached only from getAtt after secretDerivedLiveAttribute refused the provenance-marked attributes; the text hit only adds a refusal",
  },
  "src/cli/commands/diff-recursive/passed-secret-display.ts#holdsDynamicReference#mentionsDynamicReference(next)": {
    count: 1,
    why: "not a record: its callers pass raw template values (taint of a reference); a hit taints, which masks more",
  },
  "src/cli/commands/diff-recursive/passed-secret-display.ts#maskParameterKeys#isMaskLeaf(value)": {
    count: 1,
    why: "a hit skips re-masking a value that already IS the mask, so the output is the same; which keys are masked comes from the template taint",
  },
  "src/cli/commands/diff-recursive/passed-secret-display.ts#mixesDynamicReference#mentionsDynamicReference(value)": {
    count: 1,
    why: "needs the marker KIND (a reference mixed with other text); a hit only adds display masking, and a plaintext old side is masked by the template taint",
  },
  "src/cli/commands/diff-recursive/passed-secret-display.ts#recordedValuesOf#isMaskLeaf(next)": {
    count: 1,
    why: "collects a tainted record's strings as log-mask needles, skipping only the mask itself: a wider `masked` would add fewer needles and mask LESS",
  },
  "src/cli/commands/drift/redaction.ts#partitionMarkedMaskChanges#holdsMaskLeaf(change.stateValue)": {
    count: 1,
    why: "BOTH: reads the record's `noEchoLeaves` and `observedMaskedLeaves` coordinates already; the text narrows the split to changes whose state side is the mask, and the rest are still redacted",
  },
  "src/cli/commands/drift/redaction.ts#partitionUncertifiedBaselineChanges#holdsMaskLeaf(change.stateValue)": {
    count: 1,
    why: "a change against the resolved comparison baseline, not a record: a hit moves the change to not-compared and prints nothing; a wider `masked` would hide real drift",
  },
  "src/cli/commands/drift/redaction.ts#redactDriftChanges#holdsMaskLeaf(change.stateValue)": {
    count: 1,
    why: "a hit marks the change secret and masks both sides; no record is in hand, and the mask paths are seeded from the record's mask leaves",
  },
  "src/cli/commands/drift/redaction.ts#redactDriftChanges#isMaskLeaf(awsValue)": {
    count: 1,
    why: "the redacted live readback, not a record: a hit only adds the path to the `--accept` refusal set",
  },
  "src/cli/commands/drift/revert-live-values.ts#collect#isMaskLeaf(b)": {
    count: 1,
    why: "the revert's desired bag at uncertified paths: a hit registers the live value as a mask-only needle, which masks more",
  },
  "src/cli/commands/drift/revert-live-values.ts#isTokenOrMaskLeaf#isMaskLeaf(leaf)": {
    count: 1,
    why: "the pairing wildcard of the send bag, not a secrecy verdict: a wider `masked` would make more leaves abstain and weaken the order corroboration",
  },
  "src/cli/commands/drift/revert-live-values.ts#isTokenOrMaskLeaf#mentionsDynamicReference(leaf)": {
    count: 1,
    why: "the token-walk wildcard: it needs the marker KIND (a whole reference token), which `recordedSecrecyOf` merges with the mask",
  },
  "src/cli/commands/drift/revert-live-values.ts#preserveLiveValuesAtMaskedLeaves#holdsMaskLeaf(send)": {
    count: 1,
    why: "asks whether a literal mask would ship to AWS: a wider `masked` would replace a recorded plaintext the revert sends with the live value, which changes what is written",
  },
  "src/cli/commands/drift/revert-live-values.ts#walk#holdsMaskLeaf(value)": {
    count: 1,
    why: "a mask inside a non-plain object of the send bag refuses the whole resource; no value is output",
  },
  "src/cli/commands/drift/revert-live-values.ts#walk#isMaskLeaf(value)": {
    count: 1,
    why: "swaps a literal mask leaf of the send bag for the live value, registered as a needle: a wider `masked` would overwrite a recorded plaintext the revert sends, which changes what is written",
  },
  "src/cli/commands/drift/revert-merge.ts#walk#mentionsDynamicReference(value)": {
    count: 1,
    why: "the send bag, not a record: only an unresolved token's span takes the live value, so it needs the marker KIND",
  },
  "src/cli/commands/drift/revert-payload.ts#keepRecordedAttributesOverMask#holdsMaskLeaf(recorded[key])": {
    count: 1,
    why: "BOTH: the caller re-masks every `noEchoAttributeNames` entry right after; the text only narrows which scan-masked keys take back the value state already holds",
  },
  "src/cli/commands/drift/revert-payload.ts#keepRecordedAttributesOverMask#holdsMaskLeaf(redacted[key])": {
    count: 1,
    why: "the provider's new attributes after the value scan, not a record: a hit only makes the key a restore candidate, and `noEchoAttributeNames` are re-masked after",
  },
  "src/cli/commands/drift/secret-resolution.ts#collectDynamicReferencePaths#mentionsDynamicReference(value)": {
    count: 1,
    why: "seeds the reference set: it needs the marker KIND, and mask positions have their own set (`collectSecretMaskPaths`)",
  },
  "src/cli/commands/drift/secret-resolution.ts#collectSecretMaskPaths#isMaskLeaf(value)": {
    count: 1,
    why: "a hit adds a masking-only position; a provenance-named position holds the mask by construction (`noEchoLeaves` are persisted as the mask), so the text already finds it",
  },
  "src/cli/commands/drift/secret-resolution.ts#containsDynamicReference#mentionsDynamicReference(value)": {
    count: 1,
    why: "asks whether anything is resolvable: it needs the marker KIND, and decides no secrecy",
  },
  "src/cli/commands/drift/secret-resolution.ts#walk#mentionsDynamicReference(v)": {
    count: 1,
    why: "picks the leaves to resolve: it needs the marker KIND, and a resolved plaintext is what marks the path secret",
  },
  "src/cli/commands/import/discarded-subtree.ts#isInertDiscardedSubtree#mentionsDynamicReference(node)": {
    count: 1,
    why: "the template's unresolved Properties and Mappings, not a record: a hit marks the subtree live and refuses the observed baseline",
  },
  "src/cli/commands/import/stack-state.ts#reimportedAttributes#holdsMaskLeaf(prior[key])": {
    count: 2,
    why: "keeps the prior value over a masked row value, and `withDeclaredNoEchoMasked` then masks every `noEchoAttributeNames` key; the other site only names still-masked keys, never values",
  },
  "src/cli/commands/import/stack-state.ts#reimportedAttributes#holdsMaskLeaf(value)": {
    count: 2,
    why: "the import row (a live read), not the record: a masked prior key the row omits is carried, and a wider `masked` would carry prior plaintext into state",
  },
  "src/cli/commands/scrub/cross-region.ts#countSecretReferenceOpenings#countDynamicReferenceOpenings(leaf, service)": {
    count: 1,
    why: "counts reference openers against whole tokens to defer an assembled reference: it needs the marker KIND, and decides no secrecy",
  },
  "src/cli/commands/scrub/cross-region.ts#walk#mentionsDynamicReference(v)": {
    count: 1,
    why: "finds the reference tokens to resolve into needles: it needs the marker KIND, a hit adds needles, and a plaintext leaf has no token to resolve",
  },
  "src/deployment/custom-resource-service-token.ts#uncomparableToken#mentionsMask(value)": {
    count: 1,
    why: "an identity check: a hit makes the token unjudgeable (refused where the diff saw a token change); the recorded token is never printed, only the desired one through the caller's mask",
  },
  "src/deployment/deploy-engine/noecho/echo-fidelity.ts#reportedLeafAt#carriesSecretMask(leaf)": {
    count: 1,
    why: "the leaf comes from a fresh readback (`read.live`), not a record: a hit means no proof of an echo",
  },
  "src/deployment/deploy-engine/update-in-place/write-only-secret-skip.ts#sameAttestedVersion#holdsMaskLeaf(before)": {
    count: 1,
    why: "a hit re-sends the key instead of skipping it; a skip also needs reference tokens in the value (the marker KIND), which `recordedSecrecyOf` merges",
  },
  "src/deployment/deploy-engine/update/compare-record.ts#compareWithRecord#isMaskLeaf(desiredAt)": {
    count: 1,
    why: "the desired side as written, not a record: it only marks a moved shape, which picks the stored leaves that become log-only needles",
  },
  "src/deployment/deploy-engine/update/compare-record.ts#witnessConfirms#holdsMaskLeaf(stored)": {
    count: 1,
    why: "an equality check of the stored value against today's, never output; a confirm writes the mask and its marker (go-to-k/cdkd#4831), which a key-wide `masked` would block",
  },
  "src/deployment/deploy-engine/update/helpers.ts#recordPreviousNoEchoLeaves#isMaskLeaf(leaf)": {
    count: 1,
    why: "skips registering the mask itself as a log-only needle: a wider `masked` would register fewer needles and mask LESS",
  },
  "src/deployment/deploy-engine/update/helpers.ts#recordPreviousNoEchoLeaves#isMaskLeaf(partlyMasked)": {
    count: 1,
    why: "the output of `maskSecretsInText`, not a record: a hit skips a needle that is only the mask",
  },
  "src/deployment/intrinsic-resolver/getatt.ts#resolveGetAtt#carriesSecretMask(flatValue)": {
    count: 1,
    why: "a nested output already holding a reference: the mask only picks the route, so it needs the marker KIND, which `recordedSecrecyOf` merges (go-to-k/cdkd#4847)",
  },
  "src/deployment/intrinsic-resolver/getatt/reresolve.ts#reresolveRecordedReferencesUnstamped#carriesSecretMask(value)": {
    count: 1,
    why: "a value already holding a reference: the mask only SKIPS its re-resolution for the refusal; it needs the marker KIND (go-to-k/cdkd#4800)",
  },
  "src/deployment/intrinsic-resolver/getatt/secrecy.ts#noteAttributeSecrecy#carriesSecretMask(value)": {
    count: 2,
    why: "a hit swaps in the held live read or reports a redacted read, which refuses; a NoEcho-named attribute is still masked by `noEchoAttributeNames`, so a wider `masked` only refuses more",
  },
  "src/deployment/intrinsic-resolver/ref-values.ts#glueTableRefFromPhysicalId#carriesSecretMask(anchor)": {
    count: 1,
    why: "a masked anchor serves the mask; a clear anchor only slices the physical id, so the output is an id segment, never the anchor's text",
  },
  "src/deployment/intrinsic-resolver/ref-values.ts#glueTableRefFromPhysicalId#carriesSecretMask(catalogId)": {
    count: 1,
    why: "only locates the table segment in the physical id and never reaches output; a masked one falls back to the id",
  },
  "src/deployment/intrinsic-resolver/ref-values.ts#recordSetRefFromPhysicalId#carriesSecretMask(recordedName)": {
    count: 1,
    why: "a masked Name serves the mask; a clear Name is only compared with the id's segment, and the value served is that segment of the id",
  },
  "src/deployment/intrinsic-resolver/ref-values.ts#recordSetRefFromPhysicalId#carriesSecretMask(recordedType)": {
    count: 1,
    why: "a masked Type serves the mask; a clear Type is only compared with the id's last segment and never served",
  },
  "src/deployment/intrinsic-resolver/ref-values.ts#refStateLookupFromResource#carriesSecretMask(value)": {
    count: 1,
    why: "a hit refuses or serves the mask; the persist writes the mask at every provenance-marked position, so the clear arm serves a real value, and a wider `masked` would refuse a working Ref",
  },
  "src/deployment/intrinsic-resolver/ref-values/type-refs.ts#recorded#carriesSecretMask(value)": {
    count: 1,
    why: "the mask only counts as recorded and skips the AWS re-read heal: a wider `masked` would skip more heals and mask nothing more",
  },
  "src/deployment/intrinsic-resolver/ref-values/type-refs.ts#s3TablesTableRefFromPhysicalId#carriesSecretMask(tableArn)": {
    count: 1,
    why: "a masked TableARN serves the mask; a clear one is used only when it is a plain public ARN",
  },
  "src/deployment/legacy-row-output-mask.ts#plainParameterValues#holdsMaskLeaf(value)": {
    count: 1,
    why: "a plain recorded parameter only decides a child `Fn::If` branch as the engine did, and is never written or printed: a wider `masked` would only leave the condition undecided",
  },
  "src/deployment/legacy-row-output-mask.ts#plainParameterValues#mentionsDynamicReference(value)": {
    count: 1,
    why: "a reference has no written value to decide a condition with; a plain one decides the branch the deploy took and reaches no output",
  },
  "src/deployment/legacy-row-output-mask.ts#recordedSecretKeys#holdsMaskLeaf(value)": {
    count: 1,
    why: "a NoEcho-served parameter is persisted as the mask, which this sees; key-level provenance names only `Parameters` whole and would taint every output; a legacy row has no provenance",
  },
  "src/deployment/masked-baseline-recapture.ts#overlay#isMaskLeaf(fresh)": {
    count: 1,
    why: "the live readback redacted for this pass, not a record: the check only keeps the mask out of the admissible-reference replacement",
  },
  "src/deployment/masked-baseline-recapture.ts#overlay#isMaskLeaf(old)": {
    count: 1,
    why: "a mask leaf of the baseline is the only position the recapture may change: a wider `masked` would overwrite a non-mask leaf, which changes what is written",
  },
  "src/deployment/masked-baseline-recapture.ts#walk#isMaskLeaf(fresh)": {
    count: 1,
    why: "the redacted live readback, not a record: a mask there relaxes the reproduce check only to the mask or an admissible reference",
  },
  "src/deployment/masked-baseline-recapture.ts#walk#isMaskLeaf(old)": {
    count: 1,
    why: "a mask placeholder of the baseline: a wider `masked` would accept a baseline that does not reproduce, so the recapture would refuse less",
  },
  "src/deployment/masked-property-fingerprints/input-walk.ts#carriesSecretValue#holdsMaskLeaf(value)": {
    count: 1,
    why: "resolved parameter values, template mappings and resolver output, not a record: a hit keeps the input as written (secret)",
  },
  "src/deployment/masked-property-fingerprints/input-walk.ts#carriesSecretValue#mentionsDynamicReference(text)": {
    count: 1,
    why: "parameter values, template text and resolver output, not a record: a reference hit classes the input secret",
  },
  "src/deployment/masked-property-fingerprints/public-references.ts#scanText#dynamicReferenceOpeners(text)": {
    count: 1,
    why: "collects the plain `ssm` tokens of template text to hash: it needs the token text and the marker KIND, not a record verdict",
  },
  "src/deployment/masked-property-fingerprints/stale-noecho-cover.ts#everyMaskedLeafIsStale#holdsMaskLeaf(node)": {
    count: 1,
    why: "BOTH: the key already matched its `maskedPropertyFingerprints` entry; the leaf check narrows within it, which key-level provenance cannot",
  },
  "src/deployment/no-change-outputs-merge.ts#isSecretBearingReferenceString#mentionsDynamicReferenceTo(value, 'secretsmanager')": {
    count: 1,
    why: "the stack Outputs bag, which has no record provenance: it needs the marker KIND (a secret service, not a public `ssm` one), and a hit keeps the outputs whole",
  },
  "src/deployment/no-change-outputs-merge.ts#isSecretBearingReferenceString#mentionsDynamicReferenceTo(value, 'ssm-secure')": {
    count: 1,
    why: "the stack Outputs bag, which has no record provenance: it needs the marker KIND (a secret service, not a public `ssm` one), and a hit keeps the outputs whole",
  },
  "src/deployment/noecho-delete-reresolution.ts#forNestedChild#holdsMaskLeaf(raw)": {
    count: 1,
    why: "BOTH: provenance is read through `noEchoLeaves` (masked as needles); the text marks only the parameters still unresolved, which key-level provenance would widen to all of `Parameters`",
  },
  "src/deployment/noecho-delete-reresolution.ts#forNestedChild#holdsMaskLeaf(value)": {
    count: 1,
    why: "the joined value of the in-memory re-resolved row: a hit refuses the parameter to the child, and plaintext is masked through the inherited secrets",
  },
  "src/deployment/noecho-delete-reresolution.ts#noEchoDeleteValuesFromResolved#holdsMaskLeaf(value)": {
    count: 1,
    why: "today's resolved properties, not the record: a mask means nothing to send, so the delete skip is kept",
  },
  "src/deployment/noecho-delete-reresolution.ts#walk#mentionsDynamicReference(text)": {
    count: 1,
    why: "walks TEMPLATE nodes (`Fn::Sub` text), not a record: a reference refuses the re-resolution",
  },
  "src/deployment/noecho-delete-reresolution.ts#walk#mentionsDynamicReference(value)": {
    count: 1,
    why: "walks TEMPLATE string leaves, not a record: a hit leaves the coordinate un-re-resolved",
  },
  "src/deployment/recorded-identity-attributes.ts#isUsableIdentityValue#mentionsMask(value)": {
    count: 1,
    why: "an AWS-minted id compared with a live token, never output: a wider `masked` would DROP the identity guard",
  },
  "src/deployment/rollback-executor/plan/classify.ts#holdsRedactedLeaf#mentionsMask(value)": {
    count: 1,
    why: "a hit on the journaled previous bag makes the reversal undecidable, which the arm refuses; nothing is printed or written",
  },
  "src/deployment/rollback-executor/replay-noecho.ts#holdsPlaceholder#isMaskRun(value)": {
    count: 1,
    why: "the live readback (`readCurrentState`), not a record: a hit refuses the replay",
  },
  "src/deployment/rollback-executor/replay-noecho.ts#substituteMarkedNoEchoLeaves#holdsMaskLeaf(valueAtCoordinate(desired, coordinate))": {
    count: 1,
    why: "BOTH: the coordinates are the baseline's `noEchoLeaves`; a marked plaintext leaf is the real value to send, and a wider match would overwrite it with a live read",
  },
  "src/deployment/rollback-executor/replay-props.ts#refuseMaskedReplayBaseline#holdsMaskLeaf(props)": {
    count: 1,
    why: "a hit refuses the replay so the mask is never written to AWS; a wider `masked` would refuse rollbacks that restore a real value",
  },
  "src/deployment/rollback-executor/replay-props.ts#walk#mentionsDynamicReference(v)": {
    count: 1,
    why: "finds the reference tokens the replay resolves: it needs the marker KIND, and a plaintext leaf has nothing to resolve",
  },
  "src/deployment/secret-redaction/off-template-echo.ts#maskOffTemplateEchoes#mentionsMask(leaf)": {
    count: 1,
    why: 'a leaf the redaction left as its reference (no mask in it) keeps the reference, drift resolves it; one holding the mask is masked and named (go-to-k/cdkd#7158): a wider `masked` masks MORE, never less',
  },
  "src/deployment/secret-redaction/off-template-echo.ts#corroborates#mentionsMask(recorded)": {
    count: 1,
    why: "a recorded leaf holding the mask is a secret position, so it corroborates any readback leaf there; reached through `storedReferenceLeavesPutBack` (go-to-k/cdkd#7167), whose candidates it widens: a wider `masked` pairs or masks MORE, never less",
  },
  "src/deployment/secret-redaction/stored-reference-positions.ts#walk#mentionsMask(live)": {
    count: 2,
    why: "a stored readback leaf already holding the mask is left as it is (go-to-k/cdkd#7167); any other leaf at a recorded reference position is put back on the reference or masked: a wider `masked` keeps a leaf already masked, never a plaintext",
  },
  "src/deployment/secret-redaction/redact-path/definition.ts#definitionSourceCarriesSecret#carriesSecretMask(source[k])": {
    count: 1,
    why: "every caller masks MORE on a hit (the fail-closed definition mask, the named definition secrets)",
  },
  "src/deployment/type-change-guard.ts#equalIdNamesDifferentResources#holdsMaskLeaf(newDb)": {
    count: 1,
    why: "an identity comparison: a mask answers false, which keeps the refusals; only a boolean leaves, the name is never shown",
  },
  "src/deployment/type-change-guard.ts#equalIdNamesDifferentResources#holdsMaskLeaf(oldDb)": {
    count: 1,
    why: "an identity comparison: a mask answers false, which keeps the refusals; only a boolean leaves, the name is never shown",
  },
  "src/deployment/type-change-guard.ts#permissionsOnDifferentFunctions#holdsMaskLeaf(newFn)": {
    count: 1,
    why: "an identity comparison: a mask answers false, which keeps the refusals; only a boolean leaves, the name is never shown",
  },
  "src/deployment/type-change-guard.ts#permissionsOnDifferentFunctions#holdsMaskLeaf(oldFn)": {
    count: 1,
    why: "an identity comparison: a mask answers false, which keeps the refusals; only a boolean leaves, the name is never shown",
  },
  "src/provisioning/cloud-control/unapplied-update.ts#holdsStandIn#mentionsMaskedIdSegment(value)": {
    count: 1,
    why: "a hit skips the silent no-op check for the key; the warning and the error name keys only",
  },
  "src/provisioning/cloud-control/unapplied-update.ts#holdsStandIn#valueMentionsDynamicReference(value)": {
    count: 1,
    why: "needs the marker KIND (a stand-in the read model never shows); the warning and the error name keys only",
  },
  "src/provisioning/drift-declared-projection.ts#holdsUnsentValue#isMaskLeaf(value)": {
    count: 1,
    why: "asks whether the declared value is what was sent: the mask was not, so the readback fills the baseline; the drift display is redacted later",
  },
  "src/provisioning/drift-declared-projection.ts#holdsUnsentValue#mentionsDynamicReference(value)": {
    count: 1,
    why: "needs the marker KIND: an unresolved token is not the sent value, while a marked plaintext was sent; the drift display is redacted later",
  },
  "src/provisioning/redacted-delete-address.ts#isRedactedRecordedValue#holdsMaskLeaf(value)": {
    count: 1,
    why: "a hit fails safe at every caller (skips the delete naming fields only, leaves an SG rule's identity unknown, skips a scale-to-0); a wider `masked` would skip work on a real address",
  },
};
