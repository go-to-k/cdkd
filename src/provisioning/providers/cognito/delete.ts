import { type DeleteContext, assertRegionMatch } from '../../region-check.js';
import {
  type ProtectionFlipRecord,
  deleteWithProtectionCompensation,
  protectionFlipKey,
  userPoolProtectionSite,
  observeThenDisableProtection,
} from '../deletion-protection-compensation.js';
import {
  type UserPoolType,
  DescribeUserPoolCommand,
  UpdateUserPoolCommand,
  ResourceNotFoundException,
  DeleteUserPoolCommand,
  type DeletionProtectionType,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  reportKind,
  echoesDeveloperEmail,
  EMAIL_RESET_CLAUSE,
  isRefusedEcho,
  echoesCustomerManagedKey,
  bareFlipResets,
  isTransientCognitoFailure,
  userPoolDeletionProtectionUpdate,
  EMAIL_RESET_BEFORE_DELETE_CLAUSE,
  sentWithoutEmail,
  isAmbiguousWriteFailure,
} from './shared.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  describeAwsFailure,
  safeStringify,
  isAwsAuthoredFailure,
} from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNotGone } from '../../not-gone.js';
import type { CognitoUserPoolProvider } from '../cognito-provider.js';

/**
 * Delete a Cognito User Pool.
 *
 * When `context.removeProtection === true`, `DeletionProtection` is flipped
 * from `ACTIVE` to `INACTIVE` via `UpdateUserPool` before deletion, unless
 * the live pool reads `INACTIVE` already, in which case no `UpdateUserPool`
 * is sent. Without `removeProtection`, AWS rejects the delete on a
 * protected pool with `InvalidParameterException` and the destroy fails;
 * the user is expected to set `--remove-protection` explicitly.
 *
 * Pre-PR behavior was an unconditional flip-off; that silent bypass has
 * been gated on `--remove-protection` to match the rest of the
 * deletion-protection-bearing types and CDK CLI's refuse-on-protected
 * semantics. See PR body for migration notes.
 *
 * The compensation boundary (issue #2204): a flip whose delete then fails
 * terminally is undone here, so a destroy that did not happen does not leave
 * a live pool with its guard stripped.
 */
export async function deleteImpl(
  this: CognitoUserPoolProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  // The flip record `run` receives. It is the SAME object the compensation
  // holds for this key (the registry hands one record to both), so the
  // re-enable reads what the flip latched on it.
  let flipRecord: ProtectionFlipRecord | undefined;
  await deleteWithProtectionCompensation({
    registry: this.protectionFlips,
    key: protectionFlipKey(resourceType, physicalId, context?.expectedRegion),
    run: (flip) => {
      flipRecord = flip;
      return this.deleteOnce(logicalId, physicalId, resourceType, context, flip);
    },
    compensation: {
      logicalId,
      physicalId,
      logger: this.logger,
      mask: context?.maskSecrets,
      site: userPoolProtectionSite(physicalId, context?.expectedRegion),
      // A FRESH read, echoed back (#4066). The echo is ALWAYS written, even
      // when the read already says ACTIVE: a read can lag a write that
      // landed, and an echoed ACTIVE is idempotent and resets nothing.
      //
      // A bare `DeletionProtection: 'ACTIVE'` would reset the pool's self
      // sign-up, Lambda triggers and advanced security, so it is used only
      // where those are ALREADY reset -- a bare flip known to have landed --
      // and only when the echo is refused on validation (the same stale
      // member that refused the flip's echo). That case is also reported at
      // ERROR first, with what the pool held, since the pool stays LIVE
      // with its settings reset whatever the re-enable does.
      reEnable: async () => {
        const bareFlip = flipRecord ? this.preFlipPools.get(flipRecord) : undefined;
        let pool: UserPoolType | undefined;
        try {
          pool = (
            await this.getClient().send(new DescribeUserPoolCommand({ UserPoolId: physicalId }))
          ).UserPool;
        } catch (readError) {
          // Cannot tell what landed: report a possible reset as recorded.
          if (bareFlip)
            this.reportSettingsResetByBareFlip(
              physicalId,
              bareFlip.pool,
              reportKind(bareFlip),
              maskerOrIdentity(context?.maskSecrets)
            );
          throw readError;
        }
        if (!pool) {
          if (bareFlip)
            this.reportSettingsResetByBareFlip(
              physicalId,
              bareFlip.pool,
              reportKind(bareFlip),
              maskerOrIdentity(context?.maskSecrets)
            );
          throw new Error(`DescribeUserPool returned no pool for ${physicalId}`);
        }
        // OFF after a bare attempt: the bare write landed (only a
        // definitely-REFUSED echo leads to one), so the settings WERE reset.
        if (bareFlip && pool.DeletionProtection !== 'ACTIVE') bareFlip.ambiguous = false;
        const resetConfirmed = bareFlip !== undefined && !bareFlip.ambiguous;
        // Every bare attempt is reported. An unclear one whose pool reads ON
        // stays "MAY": a read can lag the write it is meant to reflect.
        if (bareFlip)
          this.reportSettingsResetByBareFlip(
            physicalId,
            bareFlip.pool,
            reportKind(bareFlip),
            maskerOrIdentity(context?.maskSecrets)
          );
        // A flip-off sent without the SES EmailConfiguration that the read
        // shows LANDED: the pool is live on Cognito's default sender. A
        // bare flip's own report already names it.
        if (
          flipRecord &&
          this.emailOmittedFlips.has(flipRecord) &&
          !echoesDeveloperEmail(pool) &&
          !(bareFlip && echoesDeveloperEmail(bareFlip.pool))
        ) {
          this.logger.error(
            safeMsg`Cognito User Pool ${physicalId} is LIVE with its SES email configuration reset: ` +
              safeMsg`--remove-protection turned DeletionProtection off with an UpdateUserPool that left ` +
              safeMsg`out its DEVELOPER EmailConfiguration (sending it was refused), and the delete then ` +
              safeMsg`failed. The pool's email configuration was ${EMAIL_RESET_CLAUSE}`
          );
        }
        // A bare re-enable loses nothing only while the reset is the pool's
        // latest state: not after an echo flip has landed since.
        const bareLicensed = resetConfirmed && bareFlip.echoedSince !== true;
        const readOn = pool.DeletionProtection === 'ACTIVE';
        try {
          // A guard that already reads ON is not worth the SES sender: the
          // write without it would reset it (#4149) -- unless this flip's
          // email-less flip-off definitely landed, so the sender is reset
          // already and the read is stale.
          const emailAlreadyReset =
            flipRecord !== undefined && this.emailOmittedFlips.get(flipRecord) === 'definite';
          await this.sendEchoedDeletionProtection(physicalId, pool, 'ACTIVE', {
            emailFallback: !readOn || emailAlreadyReset,
            mask: maskerOrIdentity(context?.maskSecrets),
          });
        } catch (echoError) {
          let failure: unknown = echoError;
          if (bareLicensed && isRefusedEcho(echoError)) {
            try {
              await this.getClient().send(
                new UpdateUserPoolCommand({
                  UserPoolId: physicalId,
                  DeletionProtection: 'ACTIVE',
                })
              );
              return readOn ? 'already-on' : undefined;
            } catch (bareError) {
              failure = bareError;
            }
          }
          // The guard read ON: the write-back failing does not make it off,
          // and the "still off" ERROR (with a bare restore command to paste)
          // would be false and harmful. Say what is known instead.
          if (readOn && !(failure instanceof ResourceNotFoundException)) {
            const mask = maskerOrIdentity(context?.maskSecrets);
            this.logger.debug(
              mask(
                safeMsg`Writing DeletionProtection back on ${mask(physicalId)} failed: ${mask(describeAwsFailure(failure).detail)}`
              )
            );
            return 'read-on-write-failed';
          }
          throw failure;
        }
        return readOn ? 'already-on' : undefined;
      },
    },
  });
}

/**
 * The ERROR for a pool that stays LIVE after a failed delete whose flip went
 * out as the bare write (#4066): its self sign-up, Lambda triggers and
 * advanced security were reset by that write, and nothing cdkd does
 * afterwards can bring them back -- a redeploy will not either, because the
 * recorded properties still match the template, so the diff is empty.
 * Names what the pool held before the flip (a boolean, trigger and key
 * ARNs, a mode) so the user can put it back. An ARN is template-authored, so
 * it can come from a dynamic reference: each value and the line are masked.
 */
export function reportSettingsResetByBareFlip(
  this: CognitoUserPoolProvider,
  physicalId: string,
  before: UserPoolType,
  kind: 'reset' | 'earlier' | 'unclear',
  mask: MaskerFn
): void {
  const held: string[] = [];
  const adminOnly = before.AdminCreateUserConfig?.AllowAdminCreateUserOnly;
  if (adminOnly !== undefined) held.push(`AllowAdminCreateUserOnly=${String(adminOnly)}`);
  const lambdaConfig = (before.LambdaConfig ?? {}) as Record<string, unknown>;
  for (const [trigger, value] of Object.entries(lambdaConfig)) {
    // Not triggers of their own: the KMS key, and the legacy spelling of a
    // trigger whose versioned `*Config` form is also present (one slot).
    // Every OTHER slot is listed, even one sharing a function with another.
    if (trigger === 'KMSKeyID') continue;
    if (lambdaConfig[`${trigger}Config`] !== undefined) continue;
    const arn =
      typeof value === 'string'
        ? value
        : value && typeof value === 'object' && 'LambdaArn' in value
          ? String((value as { LambdaArn?: unknown }).LambdaArn)
          : undefined;
    if (arn) held.push(`LambdaConfig.${trigger}=${arn}`);
  }
  const mode = before.UserPoolAddOns?.AdvancedSecurityMode;
  if (mode) held.push(`AdvancedSecurityMode=${mode}`);
  // The bare write omits it too, which resets it to COGNITO_DEFAULT (#4149).
  // Named by its sending account only: the SourceArn embeds an address.
  if (echoesDeveloperEmail(before))
    held.push('EmailConfiguration.EmailSendingAccount=DEVELOPER (SES)');
  // The bare write omits it too, which resets it to the AWS owned key (#2762).
  if (echoesCustomerManagedKey(before)) {
    held.push(`KeyConfiguration.KmsKeyArn=${String(before.KeyConfiguration?.KmsKeyArn)}`);
  }
  const heldText =
    held.length > 0 ? held.map((entry) => mask(entry)).join(', ') : 'none of these settings';
  const what = bareFlipResets(before);
  const state =
    kind === 'unclear'
      ? safeMsg`is LIVE and its ${what} MAY have been reset: ` +
        safeMsg`--remove-protection sent UpdateUserPool with DeletionProtection alone (the pool's own ` +
        safeMsg`configuration was refused) and got no clear answer, and the delete then failed. Check it ` +
        safeMsg`with aws cognito-idp describe-user-pool.`
      : kind === 'earlier'
        ? safeMsg`is LIVE; its ${what} were reset by an ` +
          safeMsg`earlier UpdateUserPool that --remove-protection sent with DeletionProtection alone (the ` +
          safeMsg`pool's own configuration was refused); they may have been restored since. Check it with ` +
          safeMsg`aws cognito-idp describe-user-pool.`
        : safeMsg`is LIVE with its ${what} reset: ` +
          safeMsg`--remove-protection had to turn DeletionProtection off with UpdateUserPool alone (the ` +
          safeMsg`pool's own configuration was refused), and the delete then failed.`;
  this.logger.error(
    mask(
      safeMsg`Cognito User Pool ${physicalId} ` +
        state +
        safeMsg` Before that write the pool held: ${heldText}. Put them back with ` +
        safeMsg`aws cognito-idp update-user-pool, sending the pool's complete configuration -- a ` +
        safeMsg`cdkd deploy will NOT restore them, because its recorded properties still match the template.`
    )
  );
}

export async function deleteOnce(
  this: CognitoUserPoolProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  context: DeleteContext | undefined,
  flip: ProtectionFlipRecord
): Promise<void> {
  this.logger.debug(`Deleting Cognito User Pool ${logicalId}: ${physicalId}`);

  try {
    if (context?.removeProtection === true) {
      // ALWAYS read the live flag, never the recorded one: state can be
      // stale (the user could have flipped it via console), and the
      // compensation may only restore a guard this run OBSERVED on and
      // turned off (issue #2204). A pool observed INACTIVE skips the
      // `UpdateUserPool`. An UNREADABLE one is not flipped at all (#4066):
      // the only write possible without the read is the bare one, which
      // resets self sign-up, Lambda triggers and advanced security.
      let observed: string | undefined;
      let observedPool: UserPoolType | undefined;
      let observeError: unknown;
      // A TRANSIENT read failure is re-thrown after the flip block, before
      // any DeleteUserPool: the outer destroy loop re-enters on it, and the
      // retry can read the pool and flip it properly.
      let transientReadError: unknown;
      try {
        await observeThenDisableProtection({
          flip,
          logger: this.logger,
          physicalId,
          mask: context?.maskSecrets,
          guardName: 'DeletionProtection',
          observe: async () => {
            const describeResponse = await this.getClient()
              .send(new DescribeUserPoolCommand({ UserPoolId: physicalId }))
              .catch((error: unknown) => {
                observeError = error;
                throw error;
              });
            observedPool = describeResponse.UserPool;
            observed = observedPool?.DeletionProtection;
            return observed === 'ACTIVE';
          },
          disable: async () => {
            if (observed !== undefined && observed !== 'ACTIVE') {
              // Already off: an earlier attempt's bare write that got no
              // clear answer DID land (its echo was definitely refused, so
              // only the bare write can have turned the guard off).
              const earlier = this.preFlipPools.get(flip);
              if (earlier?.ambiguous) earlier.ambiguous = false;
              return;
            }
            if (!observedPool) {
              // A missing pool needs no flip: the delete's own not-found
              // arm reports it gone, after the region check.
              if (observeError instanceof ResourceNotFoundException) return;
              if (observeError !== undefined && isTransientCognitoFailure(observeError)) {
                transientReadError = observeError;
                return;
              }
              const reason =
                observeError === undefined
                  ? 'DescribeUserPool returned no pool'
                  : maskerOrIdentity(context?.maskSecrets)(
                      describeAwsFailure(observeError).summary
                    );
              this.logger.warn(
                safeMsg`Cognito User Pool ${physicalId}: DeletionProtection was left on, because ` +
                  safeMsg`the pool could not be read first (${reason}) and turning it off without ` +
                  safeMsg`that read resets the pool's self sign-up, Lambda triggers and advanced ` +
                  safeMsg`security. The delete will be refused while it is on; re-run once the pool ` +
                  safeMsg`can be read (cognito-idp:DescribeUserPool is the permission it needs).`
              );
              return;
            }
            this.logger.debug(
              `Disabling DeletionProtection on Cognito User Pool ${physicalId} before deletion (--remove-protection)`
            );
            await this.disableUserPoolDeletionProtection(
              physicalId,
              observedPool,
              flip,
              maskerOrIdentity(context?.maskSecrets)
            );
          },
        });
      } catch (flipError) {
        // A transient flip failure retries the whole delete, like a
        // transient read: re-thrown here, before any DeleteUserPool.
        if (isTransientCognitoFailure(flipError)) throw flipError;
        // Non-fatal — log and proceed. The actual delete below will
        // surface any real authorization / state error, a missing pool
        // included (its NotFound arm below runs the region check).
        // Masked (#5180): AWS's validation text can quote an echoed,
        // template-authored member (USER_POOL_ECHO_MEMBERS).
        this.logger.debug(
          maskerOrIdentity(context?.maskSecrets)(
            `Could not disable DeletionProtection for ${physicalId}: ${describeAwsFailure(flipError).detail}`
          )
        );
      }
      if (transientReadError !== undefined) throw transientReadError;
    }

    await this.getClient().send(new DeleteUserPoolCommand({ UserPoolId: physicalId }));
    // AWS took the delete: nothing after it may put the guard back.
    flip.deleteAccepted = true;
    this.logger.debug(`Successfully deleted Cognito User Pool ${logicalId}`);
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Cognito User Pool ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete Cognito User Pool ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFoundException` in a message as "already deleted": only the
    // typed not-found above means this pool is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}

/**
 * Send the echoed `DeletionProtection` write. When the echo carried a
 * `DEVELOPER` (SES) `EmailConfiguration` and AWS refuses it on validation,
 * it is re-sent ONCE without that member before anything falls back to the
 * bare write: a stale SES identity must not cost the pool its self sign-up,
 * Lambda triggers and advanced security. That second write resets the
 * email configuration to `COGNITO_DEFAULT` (measured, #4149), so a re-send
 * that lands -- or may have landed -- says so at warn.
 */
export async function sendEchoedDeletionProtection(
  this: CognitoUserPoolProvider,
  physicalId: string,
  pool: UserPoolType,
  value: DeletionProtectionType,
  opts: { readonly emailFallback?: boolean; readonly mask?: MaskerFn } = {}
): Promise<'echoed' | 'without-email'> {
  // The class is AWS-authored text too, so the warns below mask it.
  const mask = maskerOrIdentity(opts.mask);
  try {
    await this.getClient().send(
      new UpdateUserPoolCommand(userPoolDeletionProtectionUpdate(physicalId, pool, value))
    );
    return 'echoed';
  } catch (echoError) {
    if (!echoesDeveloperEmail(pool) || !isRefusedEcho(echoError)) throw echoError;
    if (opts.emailFallback === false) throw echoError;
    const resetClause = value === 'ACTIVE' ? EMAIL_RESET_CLAUSE : EMAIL_RESET_BEFORE_DELETE_CLAUSE;
    // Kept at debug: if the re-send fails too, the caller's warn names only
    // that second failure.
    this.logger.debug(
      safeMsg`UpdateUserPool refused the SES EmailConfiguration of ${physicalId}: ${mask(describeAwsFailure(echoError).summary)}`
    );
    try {
      await this.getClient().send(
        new UpdateUserPoolCommand(
          userPoolDeletionProtectionUpdate(physicalId, pool, value, {
            withoutDeveloperEmail: true,
          })
        )
      );
    } catch (resendError) {
      // The write that failed OMITTED the SES EmailConfiguration: if it
      // landed after all, that member was reset.
      if (typeof resendError === 'object' && resendError !== null) {
        sentWithoutEmail.add(resendError);
      }
      // `warnGuardLeftOn` names that for a no-answer flip-off that is not
      // transient. Every other no-answer failure -- a transient flip-off
      // (retried silently) or any re-enable -- would never say it.
      if (
        isAmbiguousWriteFailure(resendError) &&
        (value === 'ACTIVE' || isTransientCognitoFailure(resendError))
      ) {
        this.logger.warn(
          safeMsg`Cognito User Pool ${physicalId}: UpdateUserPool refused the write carrying the ` +
            safeMsg`pool's SES EmailConfiguration (${mask(describeAwsFailure(echoError).summary)}), and the ` +
            safeMsg`write re-sent without it answered ${mask(describeAwsFailure(resendError).summary)}. If ` +
            safeMsg`that write landed, the pool's email configuration was ${resetClause}`
        );
      }
      throw resendError;
    }
    this.logger.warn(
      safeMsg`Cognito User Pool ${physicalId}: UpdateUserPool refused the write (possibly the ` +
        safeMsg`pool's SES EmailConfiguration, ${mask(describeAwsFailure(echoError).summary)}), so ` +
        safeMsg`DeletionProtection was set to ${value} with the pool's other settings but without ` +
        safeMsg`that EmailConfiguration. The pool's email configuration was ${resetClause}`
    );
    return 'without-email';
  }
}

/**
 * The `--remove-protection` flip-off as a read-modify-write (issue #4066):
 * `DeletionProtection: 'INACTIVE'` plus the {@link USER_POOL_ECHO_MEMBERS}
 * `pool` (the pre-flip `DescribeUserPool`) carries, so a delete that then
 * fails leaves a live pool with its self sign-up, Lambda triggers and
 * advanced security intact.
 *
 * FALLS BACK to the bare flip only when AWS REFUSED the echo on validation
 * ({@link isRefusedEcho}), so the delete can still run. The bare flip resets
 * the members it omits, so that arm says so at warn AFTER the write lands
 * and keeps the pre-flip read, as definite, for the compensation's report.
 * Any other failure -- of the echo, or of the bare write -- leaves
 * the guard ON and says so at warn (the delete is then refused, and the pool
 * stays whole). A not-found answer is re-thrown silently for the delete's
 * own not-found arm.
 */
export async function disableUserPoolDeletionProtection(
  this: CognitoUserPoolProvider,
  physicalId: string,
  pool: UserPoolType,
  flip: ProtectionFlipRecord,
  mask: MaskerFn
): Promise<void> {
  // The guard reads ACTIVE again, so an earlier attempt's bare write that
  // got no clear answer did NOT land: forget it, or a later INACTIVE read
  // would be taken as proof it did (a false "reset" report, and a bare
  // re-enable against a pool whose settings are intact).
  if (this.preFlipPools.get(flip)?.ambiguous) this.preFlipPools.delete(flip);
  // Only a guard OBSERVED on may be latched as turned off by this run
  // (#2204): on a read with no `DeletionProtection` the flip still goes out,
  // but nothing is owed back.
  const observedOn = pool.DeletionProtection === 'ACTIVE';
  try {
    const sent = await this.sendEchoedDeletionProtection(physicalId, pool, 'INACTIVE', { mask });
    if (sent === 'without-email') this.emailOmittedFlips.set(flip, 'definite');
    // An echo that CARRIED the DEVELOPER sender landed: it holds it again.
    else if (echoesDeveloperEmail(pool)) this.emailOmittedFlips.delete(flip);
    // The echo landed and reset nothing beyond, on the re-send arm, the SES
    // EmailConfiguration (recorded above). A DEFINITE reset an earlier
    // attempt or run recorded on this (retained) record still happened and
    // is still reported, but no longer licenses a bare re-enable: the pool
    // may hold settings again since.
    const earlier = this.preFlipPools.get(flip);
    if (earlier) earlier.echoedSince = true;
    return;
  } catch (echoError) {
    if (echoError instanceof ResourceNotFoundException) throw echoError;
    // A write without the SES EmailConfiguration that may have landed.
    if (
      typeof echoError === 'object' &&
      echoError !== null &&
      sentWithoutEmail.has(echoError) &&
      isAmbiguousWriteFailure(echoError) &&
      !this.emailOmittedFlips.has(flip)
    ) {
      this.emailOmittedFlips.set(flip, 'ambiguous');
    }
    // An answer that does not prove the write was REFUSED (a timeout, a
    // 5xx) may have landed server-side: the guard may be off. Latch it, so
    // a terminal delete failure still turns it back on (the re-enable
    // echoes a fresh read, harmless if the write never landed). The echo
    // resets nothing else either way.
    if (observedOn && isAmbiguousWriteFailure(echoError)) flip.flippedOffByThisRun = true;
    // Retried by the caller before any DeleteUserPool; no warn here.
    if (isTransientCognitoFailure(echoError)) throw echoError;
    if (!isRefusedEcho(echoError)) {
      this.warnGuardLeftOn(physicalId, pool, mask, echoError);
      throw echoError;
    }
    try {
      await this.getClient().send(
        new UpdateUserPoolCommand({ UserPoolId: physicalId, DeletionProtection: 'INACTIVE' })
      );
    } catch (bareError) {
      if (bareError instanceof ResourceNotFoundException) throw bareError;
      if (isAmbiguousWriteFailure(bareError)) {
        // The bare write may have LANDED, resetting the pool's settings.
        // Keep the pre-flip read, marked ambiguous (which licenses no bare
        // re-enable), and latch the flip so a terminal delete failure still
        // reaches the re-enable, whose fresh read settles it. An existing
        // DEFINITE record is never downgraded.
        if (observedOn) flip.flippedOffByThisRun = true;
        if (!this.preFlipPools.has(flip)) this.preFlipPools.set(flip, { pool, ambiguous: true });
      }
      if (isTransientCognitoFailure(bareError)) {
        if (isAmbiguousWriteFailure(bareError)) {
          this.logger.warn(
            safeMsg`Cognito User Pool ${physicalId}: UpdateUserPool with DeletionProtection alone ` +
              safeMsg`(the pool's own configuration was refused) answered ${mask(describeAwsFailure(bareError).summary)}; ` +
              safeMsg`if that write landed, the pool's ${bareFlipResets(pool)} were reset. Retrying the delete.`
          );
        }
        throw bareError;
      }
      this.warnGuardLeftOn(physicalId, pool, mask, bareError, echoError);
      throw bareError;
    }
    const kept = this.preFlipPools.get(flip);
    if (!kept) this.preFlipPools.set(flip, { pool, ambiguous: false });
    else {
      kept.ambiguous = false;
      // A bare write landed again: the pool's settings are reset NOW, so a
      // bare re-enable loses nothing whatever echo landed in between.
      kept.echoedSince = false;
    }
    this.logger.debug(
      mask(
        safeMsg`UpdateUserPool refused the echoed configuration of ${mask(physicalId)}: ${mask(describeAwsFailure(echoError).detail)}`
      )
    );
    this.logger.warn(
      safeMsg`Cognito User Pool ${physicalId}: UpdateUserPool refused the pool's own configuration ` +
        safeMsg`echoed back (${mask(describeAwsFailure(echoError).summary)}), so DeletionProtection was ` +
        safeMsg`turned off alone. That write resets the settings it omits -- ${bareFlipResets(pool)} ` +
        safeMsg`among them -- which stays that way if the delete fails.`
    );
  }
}

/**
 * The flip did not happen, so the guard is still ON and the delete will be
 * refused: say why at warn, since the flip's own catch logs only at debug.
 * `echoError` is the refused echo that led to a bare write that failed too.
 *
 * Only an AWS-AUTHORED failure proves the write was refused. A client-side
 * one (a timeout, a dropped connection) may have landed server-side, so the
 * guard may be OFF with the pool's settings intact; the line says so rather
 * than claiming the guard is on.
 */
export function warnGuardLeftOn(
  this: CognitoUserPoolProvider,
  physicalId: string,
  pool: UserPoolType,
  mask: MaskerFn,
  error: unknown,
  echoError?: unknown
): void {
  const name =
    typeof error === 'object' && error !== null
      ? safeStringify((error as { name?: unknown }).name)
      : '';
  const accessHint = /AccessDenied|NotAuthorized|Unauthorized/.test(name)
    ? ' The caller needs cognito-idp:UpdateUserPool.'
    : '';
  const echoClause =
    echoError === undefined
      ? ''
      : safeMsg`; the pool's own settings sent back were refused first (${mask(describeAwsFailure(echoError).summary)})`;
  // Masked (#5180): AWS's text can quote an echoed template-authored member.
  this.logger.debug(
    mask(
      safeMsg`UpdateUserPool did not turn DeletionProtection off on ${mask(physicalId)}: ${mask(describeAwsFailure(error).detail)}`
    )
  );
  const refused = error instanceof Error && isAwsAuthoredFailure(error);
  this.logger.warn(
    refused
      ? safeMsg`Cognito User Pool ${physicalId}: DeletionProtection was left on, because UpdateUserPool ` +
          safeMsg`refused to turn it off (${mask(describeAwsFailure(error).summary)})` +
          echoClause +
          safeMsg`. The delete will be refused while it is on.${accessHint}`
      : safeMsg`Cognito User Pool ${physicalId}: UpdateUserPool failed without an answer from AWS ` +
          // Masked: for a failure AWS did not author, the summary IS its raw
          // message, which can quote a resolved value.
          safeMsg`(${mask(describeAwsFailure(error).summary)})` +
          echoClause +
          (echoError === undefined
            ? typeof error === 'object' && error !== null && sentWithoutEmail.has(error)
              ? safeMsg`, so whether DeletionProtection was turned off is unknown. Its other settings were ` +
                safeMsg`not reset, except the SES EmailConfiguration, which that write omitted: if it ` +
                safeMsg`landed, the pool's email configuration was ${EMAIL_RESET_BEFORE_DELETE_CLAUSE}`
              : safeMsg`, so whether DeletionProtection was turned off is unknown. Its other settings were ` +
                safeMsg`not reset.`
            : safeMsg`, so whether DeletionProtection was turned off ALONE is unknown; if it was, the ` +
              safeMsg`pool's ${bareFlipResets(pool)} were reset.`) +
          safeMsg` If the delete then fails, cdkd turns the guard back on. Check the pool with ` +
          safeMsg`aws cognito-idp describe-user-pool.`
  );
}
