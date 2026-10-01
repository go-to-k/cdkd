/**
 * The orphan report the API Gateway (v1) and API Gateway v2 providers share
 * for their tokenless creates (issue
 * [#2080](https://github.com/go-to-k/cdkd/issues/2080), Plan C: v1
 * `CreateAuthorizer` / `CreateDeployment`, v2 `CreateApi` /
 * `CreateIntegration` / `CreateAuthorizer`). The latch, the 5xx-refusing
 * client and the window come from `ambiguous-create.ts`; this module is only
 * the lookup-and-report step a provider runs at the top of the next attempt.
 *
 * Detection only: it never adopts and never deletes. Nothing a listing
 * returns attributes a resource to THIS create -- names are the template's
 * own and need not be unique, an integration or a deployment has no name at
 * all, names are scoped to the account and region while cdkd's stack lock is
 * scoped to the state bucket and prefix, and the API a child lives in can be
 * shared with another stack (an imported `RestApiId` / `ApiId`). Adopting the
 * wrong resource would point this stack's routes, methods, stages and
 * `cdkd destroy` at one it does not own.
 */

import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import type { MaskedLogSinks } from '../masked-retry-logger.js';
import type { AmbiguousCreateWindow } from './ambiguous-create.js';

/** Page ceiling for an orphan lookup's list call. */
export const MAX_ORPHAN_LIST_PAGES = 20;

/** Most ids one orphan report names. */
const MAX_REPORTED_ORPHANS = 5;

/** One orphan lookup after an ambiguous create. */
export interface OrphanLookup {
  /** The create call, e.g. `CreateApi`. */
  readonly action: string;
  /** The list call the lookup pages through, e.g. `GetApis`. */
  readonly listAction: string;
  /** What the earlier attempt may have made, every value already masked. */
  readonly subject: string;
  /** The report's noun, e.g. `API(s)`. */
  readonly noun: string;
  /** Pages through the list call: the candidate ids, and whether the page ceiling cut it. */
  readonly list: () => Promise<OrphanIds>;
  /** A pasteable read command for one candidate. */
  readonly inspect: (id: string) => string;
  /**
   * A pasteable delete command for one candidate. Present ONLY when `list`
   * filters by the ambiguous attempt's window (the resource carries a
   * creation date): without a window nothing narrows a candidate to this
   * create, so the report offers no delete command.
   */
  readonly remove?: (id: string) => string;
}

/** What a lookup's list step found. */
export interface OrphanIds {
  readonly ids: string[];
  /** `true` when the page ceiling cut the listing short. */
  readonly truncated: boolean;
}

/**
 * Page a list call, keeping the ids `keep` accepts, up to
 * {@link MAX_ORPHAN_LIST_PAGES} pages. `fetchPage` adapts the service's
 * paging shape (v1 `items` / `position`, v2 `Items` / `NextToken`).
 */
export async function collectOrphanIds<T>(
  fetchPage: (token: string | undefined) => Promise<{ items: T[]; next: string | undefined }>,
  keep: (item: T) => string | undefined
): Promise<OrphanIds> {
  const ids: string[] = [];
  let token: string | undefined;
  let pages = 0;
  do {
    const page = await fetchPage(token);
    for (const item of page.items) {
      const id = keep(item);
      if (id !== undefined) ids.push(id);
    }
    token = page.next;
    pages++;
  } while (token && pages < MAX_ORPHAN_LIST_PAGES);
  return { ids, truncated: Boolean(token) };
}

/**
 * After an attempt at a tokenless create ended AMBIGUOUS (in practice a 5xx,
 * the only ambiguous failure the engine retries: API Gateway may have made the
 * resource and lost the answer), name the resources that could be its orphan,
 * before the create is sent again.
 *
 * A dated lookup (`remove` present) lists only resources created inside the
 * window and adds a delete command after the read command, conditional on
 * confirming. An undated one says only which resources match and were not
 * recorded by this process -- which can include this stack's own recorded one,
 * created by an earlier process -- and prints a READ command per id, no delete
 * command.
 *
 * Every failure warns and returns: the lookup must never fail a deploy, and a
 * missing list permission must not break a deploy that works today. List
 * calls are eventually consistent, so an empty result says only what was
 * listed.
 */
export async function reportPossibleOrphans(
  logicalId: string,
  window: AmbiguousCreateWindow,
  log: MaskedLogSinks,
  lookup: OrphanLookup
): Promise<void> {
  const since = new Date(window.floorMs).toISOString();
  const until = new Date(window.ceilingMs).toISOString();
  const remove = lookup.remove;
  const when = remove !== undefined ? `between ${since} and ${until}` : `at ${since}`;
  let found: OrphanIds;
  try {
    found = await lookup.list();
  } catch (error) {
    const failure = describeAwsFailure(error);
    log.debug(`${lookup.listAction} failed with: ${log.value(failure.detail)}`);
    log.warn(
      `An earlier ${lookup.action} attempt for ${logicalId} failed without a definite answer (${when}), so API Gateway may have created ${lookup.subject} that no cdkd state records, and cdkd could not look for it (${lookup.listAction}: ${failure.summary}). Creating it again; check for a duplicate.`
    );
    return;
  }

  const incomplete = found.truncated
    ? ` The search was incomplete: the list was cut at ${MAX_ORPHAN_LIST_PAGES} pages.`
    : '';
  if (found.ids.length === 0) {
    const line = `No listed ${lookup.noun} matching ${lookup.subject} is unrecorded by this deploy, so the listing shows no orphan of the earlier ambiguous ${lookup.action} attempt for ${logicalId} (${when}).${incomplete}`;
    if (found.truncated) {
      log.warn(line);
    } else {
      log.debug(line);
    }
    return;
  }

  const shown = found.ids.slice(0, MAX_REPORTED_ORPHANS);
  const more = found.ids.length > shown.length ? ', ...' : '';
  const inspect = shown.map((id) => lookup.inspect(id)).join(' ; ');
  if (remove !== undefined) {
    const deletion = shown.map((id) => remove(id)).join(' ; ');
    log.warn(
      `An earlier ${lookup.action} attempt for ${logicalId} failed without a definite answer, and API Gateway may have created ${lookup.subject} then that no cdkd state records. ${found.ids.length} ${lookup.noun} were created ${when} that this deploy did not record: ${shown.join(', ')}${more}. cdkd does not adopt or delete them: nothing listed proves which deploy created one. Creating a new one now. First inspect each candidate: ${inspect}. Only after confirming one is this deploy's orphan and not another deploy's, delete it: ${deletion}.${incomplete}`
    );
    return;
  }
  log.warn(
    `An earlier ${lookup.action} attempt for ${logicalId} failed without a definite answer (${when}), and API Gateway may have created ${lookup.subject} then that no cdkd state records. ${found.ids.length} ${lookup.noun} match that this deploy did not record: ${shown.join(', ')}${more}. API Gateway reports no creation time for them, so any of them may instead be this stack's own recorded one, another stack's, or older than this deploy; cdkd does not adopt or delete them. Creating a new one now. Inspect each before deleting anything: ${inspect}.${incomplete}`
  );
}
