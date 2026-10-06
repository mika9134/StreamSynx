# Group Pick: Implementation Plan

> Target repo: StreamSynx (Next.js pages router, Firebase Auth + Firestore + RTDB, TMDB, Tailwind 3, framer-motion 12, react-swipeable 7).
> Status: design agreed, not yet built. All file, function and field names below come from the current code (checked 2026-10-06).

---

## 1. Overview

Group Pick helps everyone in a watch-party room agree on something to watch.

1. Any member presses the gold **Group Pick** button in the room header, or the **"Can't decide? Start a Group Pick"** link in the empty player.
2. This creates `rooms/{roomId}/groupPick/current`. Every member's room page listens to that doc and opens the modal live.
3. The **host** (the person who started it) loads each member's stored `tasteProfile`, merges them with `mergeGroupTaste()`, and shows the shared traits as chips ("Sci-Fi · all 3").
4. The host builds a pool of TMDB candidates. Each member privately reports which of those they have already seen. The host then publishes a shortlist of about 12 titles that nobody has seen (`buildShortlist()`).
5. Everyone swipes the same cards in `SwipeDeck`. Votes are stored per user. Each card shows "Fits the group N%", calculated by `fitPerMember()` on top of `scoreMatch`/`weightedCosine`/`buildIdf` from `lib/tasteMatch.js`.
6. The host finalises with `pickFairWinner()`. This uses least misery plus yes votes, with deterministic tie-breaks. The results screen shows per-member fit bars, runners-up and a one-line explanation from Cue (a new short mode in `pages/api/assistant/chat.js`).
7. **Play in this room** reuses the room's existing `handleSelectMedia` → `updateDoc(roomDocRef, { currentMediaId, currentMediaType, currentMediaTitle, currentMediaPoster, currentSeason: null, currentEpisode: null })` and pushes a "Group Pick" system message into the RTDB room chat.

### Files

| File | Change |
|---|---|
| `lib/groupPick.js` | **New.** Pure logic: merge, fit, shortlist selection, winner, progress, copy helpers. TMDB access is injected so the core can be tested. |
| `lib/groupPickStore.js` | **New (recommended split).** All Firestore/RTDB I/O for the session doc: start, register, vote, publish, finalise, cancel, heartbeat, takeover. This keeps `lib/groupPick.js` pure. If you'd rather not add a file, these functions can live at the bottom of `GroupPickModal.jsx`. |
| `components/SwipeDeck.jsx` | **New.** The card stack: react-swipeable gestures driving framer-motion. |
| `components/GroupPickModal.jsx` | **New.** The modal with its screens (intro → building → voting → results), the host loop, and participant duties. |
| `pages/rooms/[roomId].jsx` | Header button, empty-player CTA, session listener, play handler, modal mount. |
| `components/ChatInterface.jsx` | Renders `type: "system"` messages. The room chat is `ChatInterface`, not `components/Chat.jsx`, which is an unused mock. |
| `lib/assistant.js` | Export `loadSeenKeys(uid)` (taken out of `buildViewerContext`) and add `explainGroupPick()`. |
| `pages/api/assistant/chat.js` | Add `mode: "groupPick"`. Add `maxTokens` and `requirePicks` options to `callModel`/`complete`. |
| Firestore rules | **There is no `firestore.rules` in the repo** (searched the whole tree; there's no `firebase.json` either). Rules currently live only in the Firebase console. See §7. |

---

## 2. What the existing code gives us, and where it gets in the way

- **Taste profiles are stored, not rebuilt.** `users/{uid}.tasteProfile` is written by `saveTastePicks` (`lib/tasteProfile.js:224`). It holds L2-normalised sparse vectors `genres`, `keywords`, `people`, `decades`, plus `labels.{keywords,people}`, `titles` (`"movie:603"` keys), `topGenres` and `pickCount`. The buddy pages read it straight off the user doc (`pages/buddies/index.jsx:362-367`, `:405-415`). `fetchUserTaste(uid)` (`lib/tasteProfile.js:257`) returns `{ uid, ...data, tastePicks }`. **Group Pick must never call `buildTasteProfile` for a member's picks.** It is only used to enrich *candidate titles* (see §5).
- **Member user docs are readable by other users.** The buddy pages already do this, so the host can call `fetchUserTaste` on every member.
- **Watch history is private.** `history/{uid}`, `favorites/{uid}` and `watchlists/{uid}` can only be read by their owner. The comment at `lib/tasteProfile.js:244-248` and the use of `savePublicStats` confirm this. So the host **cannot** read other members' watch history to exclude titles. Each member has to check the candidates against their own data. This is why the "building" phase has two stages (§4).
- **The seen set already exists.** `buildViewerContext` (`lib/assistant.js:116-126`) builds `seen` as `"movie:{id}"` / `"tv:{tvShowId}"` keys from history, favourites, taste picks and `getContinueWatching()`. Move that into an exported `loadSeenKeys(uid)` and reuse it.
- **IDF on a small pool is a known trap.** `profileMatch` (`lib/buddyDiscovery.js:132-137`) passes `idf: {}` because, as the comment there says, IDF over a pool of two marks everything shared as "common". For Group Pick, build IDF **over the candidate title profiles** (about 30), not over the 2–6 members. Rarity then measures what makes one candidate different from the others, which is what we want.
- **Room chat is RTDB.** `ChatInterface` pushes `{ text, userId, username, timestamp: serverTimestamp() }` to `roomChats/${roomId}/messages` (`components/ChatInterface.jsx:96-103`).
- **Presence is RTDB.** The room page writes `/roomPresence/${roomId}/${uid}` = `{ online, lastChanged, username }`, and `onDisconnect` sets it to `online: false` (`[roomId].jsx:343-363`). Nothing reads it yet. Group Pick will read it so it doesn't wait for people who are offline.
- **There's a name clash.** `[roomId].jsx:23` imports `serverTimestamp` from `firebase/database`. Any Firestore server timestamp in the page needs an alias. Better still, keep all Firestore writes in `lib/groupPickStore.js`.
- **The TMDB rate limiter is global.** `installTmdbRateLimiter()` (`pages/_app.js:12`) wraps axios and `window.fetch` for `api.themoviedb.org`. The default is 40 requests per second, configurable with `NEXT_PUBLIC_TMDB_RATE_LIMIT_PER_SECOND`. Requests with `append_to_response` get priority 5, which is higher and runs first; everything else gets 0. A request can override this with `config.streamSynxPriority`.

### Existing bugs that affect this feature (fix in Phase 0)
1. **Leaving doesn't remove the member.** `handleLeaveRoom` removes `memberIds` (`[roomId].jsx:761-763`), but the field is `members`. Group Pick depends on `room.members` to know who is still in the room, so this has to be fixed.
2. `performUserSearch` filters on `roomData?.memberIds` (`:630`, `:645`). Same wrong field.
3. The `catch` blocks in `handleAddMember` (`:700`) and `handleRemoveMember` (`:743`) show `toast.success` when the call fails.
4. The room `onSnapshot` handler compares against a stale `membersList` closure (`:179-185`). Every room-doc update (including the Play write) therefore refetches all member user docs. This is harmless but wasteful. A `useRef` mirror of `membersList` fixes it.

---

## 3. Firestore document schema

Path: `rooms/{roomId}/groupPick/current` (one live session per room; each new run overwrites the doc).

```js
{
  // --- identity / control (host-owned) ---
  sessionId: "lq3k9x-a81fz",            // random per run; clients key local state on it
  status: "building",                    // "building" | "voting" | "done" | "cancelled"
  stage: "gathering",                    // only while building: "gathering" | "checking"
  mode: "movie",                         // "movie" | "tv" | "any"   (chosen on the intro screen)
  startedBy: "uidA",
  hostUid: "uidA",                       // initially == startedBy; can change via takeover
  hostSeenAt: Timestamp,                 // host heartbeat (serverTimestamp) every 15 s
  startedAt: Timestamp,
  updatedAt: Timestamp,
  error: null,                           // e.g. "not-enough-titles" when cancelled by host

  // --- group taste (host, written during "gathering") ---
  groupTaste: {
    chips: [ { facet: "genres", key: "878", label: "Sci-Fi", count: 3, total: 3 } ],
    profiled: ["uidA", "uidB"],          // members with a tasteProfile
    unprofiled: ["uidC"]                 // votes-only members
  },

  // --- seen-check handshake (host writes keys, members answer) ---
  candidateKeys: ["movie_329865", "tv_1399", ...],   // ≤ 40, written at stage "checking"

  // --- per-member self-writes (each uid writes ONLY its own entry) ---
  participants: {
    uidB: {
      username: "bea",
      joinedAt: Timestamp,
      seenAmong: ["movie_329865"],       // ∩ of candidateKeys and own loadSeenKeys()
      checkedAt: Timestamp | null        // set when seenAmong has been written
    }
  },
  votes: {
    uidB: { "movie_329865": "yes", "tv_1399": "no" }
  },

  // --- voting payload (host, written on building → voting) ---
  shortlist: [ShortlistItem],            // ≤ 12, order = host's ranking (used for tie-break)
  fits: { uidA: { "movie_329865": 0.82, ... }, uidC: { "movie_329865": null } },
  voters: ["uidA", "uidB", "uidC"],      // participants at publish time; host appends late joiners
  votingEndsAt: Timestamp,               // startedVoting + VOTING_TIMEOUT_MS

  // --- outcome (host, on voting → done) ---
  result: {
    winnerKey: "movie_329865",
    runnerUpKeys: ["movie_157336", "tv_66732"],
    method: "votes+fit",                 // "votes+fit" | "fit-only" (nobody voted)
    eligibility: "majority",             // "majority" | "any-yes" | "all"
    reason: "all-voted",                 // "all-voted" | "timeout" | "host-forced"
    ranking: [ { key, score, min, mean, yes, no } ],          // top 5
    perMember: { uidA: { fit: 0.82, vote: "yes" }, uidC: { fit: null, vote: null } },
    explanation: null,                   // Cue's sentence, patched in afterwards
    explanationSource: null,             // "cue" | "fallback"
    decidedAt: Timestamp
  },
  playedAt: null,                        // set by room creator on "Play in this room"
  playedBy: null
}
```

`ShortlistItem`:
```js
{
  key: "movie_329865",        // itemKeyOf(): `${media_type}_${id}` (movie & tv ids collide on TMDB)
  id: 329865, media_type: "movie",
  title: "Arrival", year: "2016",
  poster_path: "/x2F...jpg", backdrop_path: "/yI...jpg",
  overview: "≤ 300 chars",
  genre_ids: [18, 878, 9648],
  vote_average: 7.6,
  groupFit: 0.74,             // fairFit at publish time (0..1) → "Fits the group 74%"
  source: "genres"            // "genres" | "keywords" | "recs" | "trending"
}
```

**Key format.** Firestore map keys use `movie_123` / `tv_456`. Underscores are safe in dotted `updateDoc` paths and in rules map access. The `seen` keys from `assistant.js` use `movie:123`, so convert them with `seenKeyToItemKey()`.

**Size budget.** About 12 shortlist items × ~600 B, plus fits (N×12 numbers), votes, and ~40 candidate keys. That's well under 50 KB for a 10-member room, against Firestore's 1 MiB doc limit.

---

## 4. State machine and who may change it

```
 (no doc) ─┐
 done ─────┼─► building/gathering ─► building/checking ─► voting ─► done ─► (done + playedAt)
 cancelled ┘          │                    │               │
                      └──────► cancelled ◄─┴───────────────┘
```

| Transition | Who | How |
|---|---|---|
| none / `done` / `cancelled` → `building` | Any room member | `runTransaction`: read the doc. If it exists with status `building` or `voting`, abort and just open the modal ("already running"). Otherwise `tx.set(ref, freshSession)` as a **full overwrite**, which wipes old votes. The caller becomes `startedBy` and `hostUid`. The transaction stops two people pressing the button at once from producing two sessions. |
| `gathering` → `checking` | Host only | `updateDoc` with `groupTaste`, `candidateKeys`, `stage: "checking"` |
| `building` → `voting` | Host only | `runTransaction` that checks `status === "building"` and `sessionId` matches, then writes `shortlist`, `fits`, `voters`, `votingEndsAt` |
| `voting` → `done` | Host only | `runTransaction` that checks `status === "voting"` and `sessionId` matches, then writes `result`. Only one writer can win, and the result is deterministic anyway. |
| `done` → `done` (explanation patch) | Host only | `updateDoc({ "result.explanation", "result.explanationSource" })` |
| `done` → `done` (played) | Room creator (`rooms/{id}.createdBy`) | `updateDoc({ playedAt, playedBy })` after `handleSelectMedia` succeeds |
| `building` / `voting` → `cancelled` | Host or room creator | `updateDoc({ status: "cancelled", error? })` |
| Host takeover | Any participant | `runTransaction`: if `status ∈ {building, voting}` and `hostSeenAt` is older than `HOST_STALE_MS` (45 s), set `hostUid = me`, `hostSeenAt = serverTimestamp()` |
| `participants.{me}`, `votes.{me}` | Each member, own key only | `updateDoc` with dotted paths (`participants.${uid}`, `votes.${uid}.${key}`) |

**Why one host computes and nobody else does.** The shortlist depends on TMDB results, which differ between calls, and on calibration. If every client computed it, they would get different lists. Only the host writes `shortlist`, `fits` and `result`. Everyone else just renders the doc. `pickFairWinner` is still deterministic, so any client can recompute it to check (useful in dev), and a takeover host gets the same answer.

**Why the "checking" handshake.** Members can't read each other's history, so the host publishes `candidateKeys` (about 30–40). Each member intersects them with their own `loadSeenKeys()` and writes only the matches. Nobody's history leaves their own device except "I've seen these specific candidates", and the exclusion itself reveals that anyway.

---

## 5. `lib/groupPick.js`: function contracts

Imports: `{ weightedCosine, buildIdf, scoreMatch, FACET_WEIGHTS }` from `./tasteMatch`; `{ genreName, normalizePick, buildTasteProfile }` from `./tasteProfile`; `{ tmdbGet, GENRE_MAP }` from `./tmdb`. Network calls are passed in through `deps`, so the core stays testable.

```js
export const SHORTLIST_SIZE = 12;
export const ENRICH_POOL_SIZE = 30;       // candidates enriched with keywords/credits
export const MIN_SHORTLIST = 4;           // below this after relaxations → cancel
export const CHECK_TIMEOUT_MS = 8_000;    // wait for seenAmong answers
export const VOTING_TIMEOUT_MS = 180_000; // 3 min; host can "+1 min"
export const HOST_HEARTBEAT_MS = 15_000;
export const HOST_STALE_MS = 45_000;
export const FAIR_MIN_WEIGHT = 0.6;       // score = 0.6·min + 0.4·mean
export const VOTE_WEIGHT = 0.7;           // satisfaction = 0.7·vote + 0.3·fit
```

### 5.1 Keys
```js
/** @param {{id:number, media_type:'movie'|'tv'}} item @returns {string} "movie_603" */
export const itemKeyOf = (item) => `${item.media_type === "tv" ? "tv" : "movie"}_${Number(item.id)}`;
/** "movie:603" (assistant.js seen format) → "movie_603" */
export const seenKeyToItemKey = (key) => String(key).replace(":", "_");
```

### 5.2 `mergeGroupTaste(members)`
```js
/**
 * @param {Array<{uid:string, username:string, tasteProfile: object|null}>} members
 *        – from fetchUserTaste(uid); tasteProfile may be missing or have empty vectors.
 * @returns {{
 *   profile: {genres, keywords, people, decades, labels:{keywords,people}} | null,
 *   profiled: string[], unprofiled: string[],
 *   support: { genres: Record<string,number>, keywords: Record<string,number>, people: Record<string,number> },
 *   chips: Array<{facet:'genres'|'keywords'|'people', key:string, label:string, count:number, total:number}>
 * }}
 */
```
- A member counts as "profiled" if `Object.keys(tasteProfile?.genres || {}).length > 0`.
- For each facet: `merged[k] = (Σ_m v_m[k] / P) · (support[k] / P) ** 0.5`, then L2-normalise. `tasteProfile.js`'s `finalize` isn't exported, so add a small local `normalizeVector`. Each stored vector is already unit length, so every member carries equal weight. The `support` term favours traits people share over one person's strong niche.
- Chips: genres with `support ≥ (P <= 2 ? P : Math.ceil(P * 0.66))`, at most 4, labelled with `genreName(key)`. Then up to 2 keywords (`labels.keywords` from any member) and 1 person (`labels.people`), at the same threshold. UI text: `count === total ? \`${label} · all ${total}\` : \`${label} · ${count} of ${total}\``.
- **Edge cases**
  - `P === 0` (nobody has picks): `profile: null`, `chips: []`. `buildShortlist` falls back to trending/popular and the modal shows "No one has taste picks yet. Picking from what's popular." with a link to `/profile`.
  - `P === 1` (one profiled member, or a 1-member room): `profile` is that person's vectors, and chips show without counts ("Your taste").
  - Unprofiled members appear as "votes only" in the UI.

### 5.3 `fitPerMember(memberProfiles, titleProfiles, { idf })`
```js
/**
 * @param {Record<string, object|null>} memberProfiles  uid → tasteProfile (null = unprofiled)
 * @param {Map<string, object>} titleProfiles  itemKey → buildTasteProfile({movies:[pick]}) output
 * @param {{ idf?: ReturnType<typeof buildIdf> }} opts  – default buildIdf([...titleProfiles.values()])
 * @returns {Record<string, Record<string, number|null>>}  uid → itemKey → calibrated fit 0..1
 */
```
- Raw fit: `raw = scoreMatch(memberProfile, titleProfile, { idf }).affinity`. This is the facet-weighted `weightedCosine` with missing-facet redistribution (`tasteMatch.js:175-189`). It skips overlap, confidence and the social nudge, which don't apply to a single title. Calling `scoreMatch` means `tasteMatch.js` doesn't need changes. The extra fields it computes cost microseconds.
- **Calibration per member:** `q_m = max_t raw_m(t)` over the **whole enriched pool** (about 30, not only the final 12, so the numbers don't change when the shortlist is cut). `fit = clamp01(raw / q_m)`. A member with rich keyword vectors and one with only genres then sit on the same scale, so neither dominates the least-misery minimum. If `q_m < 0.05` (no signal at all), fit is `null` for every title.
- IDF is computed over the title profiles, not the members (see §2).
- Unprofiled member: `null` for every title.

### 5.4 `fairFitOf(fitsForItem)`
```js
/** @param {Array<number|null>} fits @returns {{min:number|null, mean:number|null, fair:number|null, percent:number|null}} */
// fair = 0.7·min + 0.3·mean over non-null fits; percent = Math.round(fair*100). All null → nulls.
```
This drives the "Fits the group N%" label (shown with the existing `MatchRing` from `components/BuddyMatchCard.jsx`).

### 5.5 `buildShortlist(opts, deps)`, split into `gatherCandidates` and `selectShortlist`
The host runs this in two steps because of the seen-check handshake. `buildShortlist` is a convenience wrapper for when `excludeKeys` are already known (solo room, or the lab page).

```js
/**
 * Stage 1 – network. Builds and enriches the candidate pool.
 * @param {{ groupTaste: ReturnType<typeof mergeGroupTaste>,
 *           members: Array<{uid, tasteProfile, tastePicks}>,
 *           mode: 'movie'|'tv'|'any',
 *           knownExclusions: Set<string>,   // itemKeys of every member's tastePicks (public) – removed up front
 *           pageOffset?: number }} opts
 * @param {{ get?: typeof tmdbGet, enrich?: (pick)=>Promise<object> }} deps
 *        enrich default: (pick) => buildTasteProfile({ movies: pick.type==='movie'?[pick]:[], shows: pick.type==='tv'?[pick]:[] })
 * @returns {Promise<{ candidates: Array<ShortlistItem & {coarse:number}>, titleProfiles: Map<string,object>,
 *                     fits: Record<uid,Record<key,number|null>>, relaxed: string[] }>}
 */
export async function gatherCandidates(opts, deps) {}

/**
 * Stage 2 – pure. Removes seen titles and picks a diverse top-N.
 * @param {{ candidates, fits, excludeKeys:Set<string>, mode, size?:number }} input
 * @returns {{ items: ShortlistItem[], shortBy: number }}   shortBy = size - items.length
 */
export function selectShortlist(input) {}

export async function buildShortlist(opts, deps) {}  // gather → select with opts.excludeKeys
```

**Candidate sources** (all through `tmdbGet`, so they're rate-limited; `include_adult: false` on everything):
1. Genres: `/discover/{movie|tv}` with `with_genres` = top 3 consensus genre ids joined by `|` (OR), `sort_by: "popularity.desc"`, `vote_count.gte` 400 for movies / 150 for TV, `vote_average.gte: 6.3`, pages 1–2.
2. Keywords: `/discover/{type}` with `with_keywords` = top 3 shared keyword ids joined by `|` (skipped when there are none).
3. Recs: `/{type}/{id}/recommendations` for the highest-weighted taste pick of up to 4 profiled members. This adds personal variety so the list isn't just the average taste.
4. Trending fallback: `/trending/{type}/week`. Only used when `profile` is null or the pool has fewer than `ENRICH_POOL_SIZE` items.

**TV vs movie genre ids.** TMDB uses different genre ids for TV. Add `MOVIE_TO_TV_GENRE = { 28: 10759, 12: 10759, 878: 10765, 14: 10765, 10752: 10768 }` and the reverse `{ 10759: [28, 12], 10765: [878, 14], 10768: [10752] }`. Shared ids (16, 35, 80, 99, 18, 10751, 9648, 37) pass through unchanged. Movie-only ids (27 Horror, 53 Thriller, 10749 Romance, 36, 10402) are dropped from TV queries. Profiles mix ids from both types because `fetchFacets` stores whatever TMDB returns, so translate before every discover call.

**Pipeline.** Merge and dedupe by `itemKeyOf`. Drop anything without `poster_path`, any unreleased title (`release_date` / `first_air_date` after today), and anything in `knownExclusions`. Coarse score: `weightedCosine(groupProfile.genres, oneHot(genre_ids))` plus `0.1 · min(popularity, 500) / 500`. Take the top `ENRICH_POOL_SIZE`. Enrich each via `deps.enrich(normalizePick(item, type))` with `Promise.allSettled`, and drop failures. Then `fits = fitPerMember(...)`.

**`selectShortlist`.** Remove `excludeKeys`. Sort by `fairFitOf(...).fair` descending, then by `vote_average`. Pick greedily with these limits: at most 4 titles sharing the same first `genre_id`; in `mode: "any"`, at least 3 of each type if available; and up to 2 slots reserved for `source: "recs"` items with `fair ≥ 0.3` (variety).

**Not enough results (relaxation ladder).** Each step is logged in `relaxed`:
1. lower `vote_count.gte` to 100 / 50;
2. drop the keyword source and use only the top 2 genres;
3. add page 3;
4. add trending;
5. if `selectShortlist` still returns fewer than 8 items after the seen-check, the host runs **one** more `gatherCandidates({ pageOffset: 2 })`, publishes the new `candidateKeys` and repeats the check (at most 2 check rounds);
6. if there are still fewer than `MIN_SHORTLIST` (4), set status `cancelled` with `error: "not-enough-titles"`. The modal says so and offers "Try Either (movies + series)".

### 5.6 `pickFairWinner(input)`
```js
/**
 * @param {{ items: ShortlistItem[],
 *           fits: Record<uid, Record<key, number|null>>,
 *           votes: Record<uid, Record<key, 'yes'|'no'>>,
 *           members: string[] }}   // participants ∩ current room.members (leavers removed)
 * @returns {{ winner: ShortlistItem|null, runnersUp: ShortlistItem[],
 *             ranking: Array<{key, score, min, mean, yes, no, perMember: Record<uid,{fit,vote,s}>}>,
 *             method: 'votes+fit'|'fit-only', eligibility: 'majority'|'any-yes'|'all' }}
 */
```
**Formula**
- Active voters `V` = members who cast at least one vote on a shortlist key. Votes on keys outside the shortlist, and votes from people who have left, are ignored.
- Satisfaction of member m with title t:
  - `v = 1` for yes, `0` for no, `undefined` if no vote. `f = fits[m][t]` (may be null).
  - `s = v !== undefined ? (f != null ? 0.7·v + 0.3·f : v) : f` (null if both are missing).
- For each title t, over the non-null `s` values: `min_t`, `mean_t`, and `score_t = 0.6·min_t + 0.4·mean_t`. If every `s` is null, `score_t = 0.5`.
- So one "no" from anyone pulls that title's minimum down to at most 0.3. This is the least-misery rule: the winner is the title the least happy person minds least, and votes override taste guesses.
- **Eligibility gate:**
  - if any title has `yes ≥ ceil(|V| / 2)`, only those compete (`"majority"`);
  - otherwise any title with `yes ≥ 1` (`"any-yes"`);
  - otherwise all titles (`"all"`).
  - A title with `no === |V|` and `|V| ≥ 2` is always excluded unless that leaves nothing.
- `method = V.length ? "votes+fit" : "fit-only"`. If nobody voted, the pick is made on taste alone and the results screen says so.

**Tie-breaks.** Compare scores rounded to 4 decimal places, then in order:
1. more yes votes;
2. fewer no votes;
3. higher `min_t`;
4. higher `vote_average`;
5. lower index in `shortlist` (the host's order, which is stable).

This makes the result fully deterministic.

**Edge cases**
- **1 member:** the same formula reduces to "your yes plus your fit". The modal renames itself **Solo Pick**.
- **Empty `items`:** returns `{ winner: null }`, and the host cancels.
- **All members unprofiled and no votes:** every score is 0.5, so tie-breaks 4–5 decide (TMDB rating, then host order).

### 5.7 Progress and finalising
```js
/**
 * @param {{ items, votes, voters:string[], onlineUids:Set<string>, roomMembers:string[] }} s
 * @returns {{ perVoter: Record<uid,{count:number,total:number,done:boolean,online:boolean}>,
 *             waitingOn: string[],   // online, still-member voters not done
 *             allDone: boolean }}
 */
export function votingProgress(s) {}

/**
 * @param {{ session, now:number, onlineUids:Set<string>, roomMembers:string[], forced?:boolean }} s
 * @returns {{ finalize:boolean, reason:'all-voted'|'timeout'|'host-forced'|null }}
 * all-voted: progress.allDone (offline voters are NOT waited for);
 * timeout:   now >= votingEndsAt.toMillis();
 * forced:    host pressed "Decide now" (enabled when ≥ ceil(|voters|/2) are done).
 */
export function shouldFinalize(s) {}
```
Finalising never waits for someone who never votes. Once the deadline passes, or everyone who is online and still a member has finished, the host decides. People who didn't vote still count through their taste fit.

### 5.8 Copy and payload helpers
```js
/** Mirrors the rules for button enablement. */
export function canTransition(from, to, { actorUid, session, room }) {}   // → boolean
/** Shape handleSelectMedia already accepts. */
export const toRoomMedia = (item) => ({ id: item.id, media_type: item.media_type, title: item.title, poster_path: item.poster_path });
/** "Group Pick: Arrival (2016) — 3/3 said yes, everyone ≥ 68% fit" */
export function chatSystemText(item, result, usernames) {}
/** Compact, sanitised input for Cue (§9). */
export function explanationPayload({ item, result, usernames, chips, runnersUp }) {}
/** Template used when Cue fails: "Arrival is the fairest pick — Sci-Fi you all share, and nobody's below 68%." */
export function fallbackExplanation({ item, result, chips }) {}
```

### `lib/groupPickStore.js` (I/O, all thin)
`groupPickRef(roomId)`, `startGroupPick({ roomId, user, username, mode })` (transaction), `registerParticipant(roomId, uid, username)`, `submitSeenAmong(roomId, uid, keys)`, `castVote(roomId, uid, key, value)` (one `updateDoc` per swipe on `votes.${uid}.${key}`), `publishGroupTaste`, `publishCandidates`, `publishShortlist` (transaction), `finalizeGroupPick` (transaction), `patchExplanation`, `markPlayed`, `cancelGroupPick`, `heartbeat`, `claimHost` (transaction). These use Firestore's `serverTimestamp`, so the RTDB name clash in the page never comes up.

---

## 6. Components

### 6.1 `components/SwipeDeck.jsx`
```js
/**
 * props:
 *  items: ShortlistItem[]
 *  myVotes: Record<key,'yes'|'no'>        // from session.votes[me]; deck skips voted cards (resume after refresh)
 *  onVote: (key, value) => Promise<void>   // castVote; optimistic
 *  voterStatus: Array<{uid, username, count, total, done, online}>   // votingProgress().perVoter
 *  solo?: boolean
 *  disabled?: boolean                      // status !== 'voting'
 * state:
 *  index (first unvoted), pending Set<key> (optimistic), dragX via useMotionValue(0)
 */
```
- **Gestures.** Use `useSwipeable({ onSwiping: ({ deltaX }) => x.set(deltaX), onSwiped: commitOrSnap, trackMouse: true, preventScrollOnSwipe: true })`, following the pattern in `components/Hero.jsx:58`. framer-motion handles the visuals: `rotate = useTransform(x, [-200, 200], [-12, 12])`, and stamp opacity follows `x`. Commit when `|deltaX| > 110` or `velocity > 0.5`. Then `animate(x, ±600, { ease: [0.16, 1, 0.3, 1] })` (matches `ease-out-expo`), then call `onVote`.
- **Buttons and keys.** "Pass" (`btn-icon`, red) and "Yes" (`btn-primary`) buttons, plus the ← and → keys, for accessibility and desktop.
- **Card face.** `posterUrl(poster_path)` (`lib/tmdb.js`), title + year, a type badge (`chip`), `genreNames(item, 3)`, ★ `vote_average`, overview with `line-clamp-3`, and `<MatchRing percent={Math.round(groupFit*100)} />` labelled "Fits the group".
- **Live voters strip** above the deck: avatars or initials with a `count/total` mini-bar. Done = `chip-active`. Offline voters are dimmed (`opacity-40`).
- **When finished:** "You're done. Waiting on Bea, Cal…" (`waitingOn`).

### 6.2 `components/GroupPickModal.jsx`
```js
/**
 * props:
 *  roomId: string
 *  room: roomData                       // createdBy, members, currentMediaId…
 *  members: Array<{uid, username}>      // membersList from the page
 *  session: object|null                 // live groupPick/current doc (page owns the listener)
 *  currentUser: FirebaseUser
 *  open: boolean, onClose: () => void
 *  onPlay: (item, result) => Promise<boolean>   // page's handlePlayGroupPick
 * local state:
 *  mode ('movie'|'tv'|'any'), startingm busy flags, onlineUids (RTDB onValue roomPresence/${roomId}),
 *  hostCache useRef({ titleProfiles: Map, memberProfiles: {} , candidates: [] })
 */
```
**Screens**, chosen from `session?.status` and `stage`:
1. **Intro** (no active session): mode toggle as `chip`/`chip-active` (Movie · Series · Either) and a `btn-primary` "Start Group Pick". Copy: "Everyone swipes the same 12 titles. We'll pick the one nobody minds."
2. **Building:** skeleton cards (`skeleton`), the group-taste chips as soon as `groupTaste` appears, and status lines ("Reading everyone's taste…", "Checking what you've already seen…").
3. **Voting:** `SwipeDeck`, and a countdown to `votingEndsAt`. The host also sees "Decide now" and "+1 min".
4. **Results** (`done`):
   - winner poster with title, year and type;
   - per-member fit bars (track `h-1.5 rounded-full bg-white/[0.06]`, fill `bg-accent`, `bg-accent-secondary` or `bg-textsecondary/50` by band ≥ 0.6, 0.35–0.6, < 0.35) with a vote icon per member;
   - a Cue line (`section-label` "Cue" plus an italic sentence) with a skeleton line until `result.explanation` arrives;
   - 2 runner-up mini cards;
   - `btn-primary` "Play in this room" (room creator only; others see "Waiting for {creator} to hit play");
   - `btn-ghost` "Run again" and "Close".
5. **Cancelled:** toast plus close. If `error === "not-enough-titles"`, show a message and offer "Either".

**Effects (in order)**
- **All clients:** when `session` is `building`/`voting` and `!session.participants?.[me]`, call `registerParticipant`.
- **All clients:** when `stage === "checking"` and `!participants[me]?.checkedAt`:
  - `keys = (await loadSeenKeys(me)).map(seenKeyToItemKey)`
  - `submitSeenAmong(roomId, me, candidateKeys ∩ keys)`
- **Host only** (`session.hostUid === me`):
  - heartbeat every `HOST_HEARTBEAT_MS` while building or voting.
  - **Gathering:**
    - `Promise.all(roster.map(fetchUserTaste))`, where roster is `room.members ∩ onlineUids` plus the host;
    - `mergeGroupTaste`, then `publishGroupTaste`;
    - `gatherCandidates`, then `publishCandidates` (stage → checking).
  - **Checking:** wait until every registered, online participant has `checkedAt`, or `CHECK_TIMEOUT_MS` passes. Then:
    - `excludeKeys` = the union of `seenAmong`;
    - `selectShortlist`, then `publishShortlist` with `voters` = current participants and `votingEndsAt`.
    - Late joiners after the timeout are not excluded from seen titles. They can swipe "no".
  - **Voting:** on every snapshot plus a 5 s interval, run `shouldFinalize`. When it returns true:
    - `pickFairWinner`, then `finalizeGroupPick`;
    - then `explainGroupPick(...)`, then `patchExplanation`, falling back to `fallbackExplanation`.
    - Late participant (not in `voters`): append them to `voters`. If `hostCache` has `titleProfiles`, compute their fits and write `fits.{uid}`. Otherwise (takeover host) they vote without fits.
- **Non-host:** if status is `building`/`voting` and `Date.now() - hostSeenAt.toMillis() > HOST_STALE_MS`, call `claimHost`. A takeover host that has no cache during **checking** reruns `gatherCandidates`. During **voting** it only needs `session.fits` and the votes, which are already in the doc.

---

## 7. Firestore security rules

**First** copy the current rules from Firebase console → Firestore → Rules into a new `firestore.rules` and add a `firebase.json` (`{ "firestore": { "rules": "firestore.rules" } }`). Deploying a file that contains only this block would **replace** the existing console rules for `users`, `history`, `friends` and the rest. Then add the following inside `match /databases/{database}/documents`:

```
match /rooms/{roomId}/groupPick/{docId} {
  function roomData()  { return get(/databases/$(database)/documents/rooms/$(roomId)).data; }
  function uid()       { return request.auth.uid; }
  function isMember()  { return request.auth != null &&
                           (uid() in roomData().members || uid() == roomData().createdBy); }
  function isCreator() { return uid() == roomData().createdBy; }
  function isHost()    { return uid() == resource.data.hostUid; }
  function before()    { return resource.data; }
  function after()     { return request.resource.data; }
  function touches(keys) { return after().diff(before()).affectedKeys().hasOnly(keys); }
  function active()    { return before().status in ['building', 'voting']; }
  function freshStart() {
    return after().status == 'building' && after().hostUid == uid() && after().startedBy == uid()
        && after().mode in ['movie', 'tv', 'any'];
  }
  function identityKept() {
    return after().sessionId == before().sessionId && after().startedBy == before().startedBy
        && after().hostUid == before().hostUid;
  }
  function hostStep() {
    return identityKept() && (
         (before().status == 'building' && after().status in ['building', 'voting', 'cancelled'])
      || (before().status == 'voting'   && after().status in ['voting', 'done', 'cancelled'])
      || (before().status == 'done'     && after().status == 'done'
            && after().result.winnerKey == before().result.winnerKey
            && touches(['result', 'updatedAt', 'hostSeenAt'])));
  }
  function ownMapEntry(field) {
    return after().get(field, {}).diff(before().get(field, {})).affectedKeys().hasOnly([uid()]);
  }
  function selfWrite() {
    return active() && touches(['participants', 'votes', 'updatedAt'])
        && ownMapEntry('participants') && ownMapEntry('votes')
        && (!(uid() in after().get('votes', {})) ||
            (before().status == 'voting'
             && after().votes[uid()].size() <= 40
             && after().votes[uid()].values().hasOnly(['yes', 'no'])));
  }
  function takeover() {
    return active() && touches(['hostUid', 'hostSeenAt', 'updatedAt'])
        && after().hostUid == uid()
        && request.time > before().hostSeenAt + duration.value(45, 's');
  }

  allow read:   if isMember();
  allow create: if isMember() && docId == 'current' && freshStart();
  allow update: if isMember() && docId == 'current' && (
                   (before().status in ['done', 'cancelled'] && freshStart())        // restart
                || (isHost() && hostStep())
                || (isCreator() && active() && after().status == 'cancelled'
                      && touches(['status', 'error', 'updatedAt']))
                || (isCreator() && before().status == 'done'
                      && touches(['playedAt', 'playedBy', 'updatedAt']))
                || selfWrite()
                || takeover());
  allow delete: if false;
}
```
Notes:
- `get()` costs one read per rule evaluation. That's fine at swipe rates.
- A `participants`/`votes` write from someone who isn't a voter is allowed while the session is active. That's deliberate: late joiners may vote.
- **RTDB rules** (also console-only): the `type: "system"` chat message is pushed by the creator's client to `roomChats/{roomId}/messages`. The existing rules must already allow member pushes there, because ordinary chat works. Check that they don't validate an exact child set (`text`, `userId`, `username`, `timestamp`). If they do, add `type` and `kind`.

---

## 8. Exact edits to `pages/rooms/[roomId].jsx`

1. **Imports**
   - `:18-26`: add `push` and `onValue` to the `firebase/database` import. `onValue` is only needed if presence is read in the page; otherwise the modal handles it.
   - `:34-43`: add `FaLayerGroup` to the react-icons import.
   - Add `import GroupPickModal from "../../components/GroupPickModal";`
   - Add `import { groupPickRef, markPlayed } from "../../lib/groupPickStore";`
   - Add `import { toRoomMedia, chatSystemText } from "../../lib/groupPick";`
2. **State** (after `:86`): `const [groupPick, setGroupPick] = useState(null); const [groupPickOpen, setGroupPickOpen] = useState(false); const dismissedSessionRef = useRef(null);`
3. **Session listener** (new `useEffect` after the room listener ending `:223`). Run it when `roomId && isMember`: `onSnapshot(groupPickRef(roomId), snap => {...})`.
   - Set `groupPick` to `snap.exists() ? snap.data() : null`.
   - Auto-open when the status is `building` or `voting`, or when it is `done && !playedAt`, as long as `sessionId !== dismissedSessionRef.current`.
   - On `cancelled`, close and `toast("Group Pick cancelled")`.
   - Return the unsubscribe function.
4. **`handleSelectMedia`** (`:444-489`): return `true` after the success toast (`:470-481`) and `false` in the guard (`:451`) and in the `catch` (`:482-488`). Behaviour doesn't otherwise change.
5. **New `handlePlayGroupPick(item, result)`** (after `:489`):
   ```js
   const ok = await handleSelectMedia(toRoomMedia(item));   // same updateDoc path, creator-guarded
   if (!ok) return false;
   await push(ref(rtdb, `roomChats/${roomId}/messages`), {
     type: "system", kind: "groupPick",
     text: chatSystemText(item, result, Object.fromEntries(membersList.map(m => [m.uid, m.username]))),
     userId: currentUser.uid, username: currentUser.displayName || "Room",
     timestamp: serverTimestamp(),           // RTDB serverTimestamp already imported at :23 — correct here
   });
   await markPlayed(roomId, currentUser.uid);
   setGroupPickOpen(false);
   return true;
   ```
   **TV:** `handleSelectMedia` sets `currentMediaType: "tv"` with `currentSeason`/`currentEpisode` `null`. The existing effect at `:226-280` then picks the first season ≥ 1, and `calculateVideoSrc` (`:793-795`) defaults to episode 1. No extra TV code is needed.
6. **Phase 0 fix** `:761-763`: change `memberIds` to `members`. Also fix `:630`/`:645` to `roomData?.members`.
7. **Header button** (`:922`, inside the `flex flex-wrap` div, right after the Add Member `motion.button` that ends at `:932`). Every member sees it, not only the creator:
   ```jsx
   <motion.button whileTap={{ scale: 0.95 }} onClick={() => setGroupPickOpen(true)}
     className="bg-accent hover:bg-accent-hover text-primary font-semibold py-1.5 px-3 rounded-lg transition-colors text-sm flex items-center gap-1.5 shadow-glow">
     <FaLayerGroup /> {groupPick?.status === "voting" || groupPick?.status === "building" ? "Join Group Pick" : "Group Pick"}
     {/* live dot */}{["building","voting"].includes(groupPick?.status) && <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />}
   </motion.button>
   ```
8. **Empty player** (`:1036-1045`): after the existing `<p>`s, add `<button onClick={() => setGroupPickOpen(true)} className="btn-primary mt-2 text-sm">Can't decide? Start a Group Pick</button>`. Show it to every member.
9. **Mount** (before `<Footer />` at `:1308`):
   ```jsx
   <GroupPickModal roomId={roomId} room={roomData} members={membersList} session={groupPick}
     currentUser={currentUser} open={groupPickOpen}
     onClose={() => { dismissedSessionRef.current = groupPick?.sessionId || null; setGroupPickOpen(false); }}
     onPlay={handlePlayGroupPick} />
   ```

### `components/ChatInterface.jsx`
In `messages.map` (`:122-140`), return early for `msg.type === "system"`:
```jsx
<div key={msg.id} className="flex justify-center"><span className="chip chip-active max-w-[90%] text-center">{msg.text}</span></div>
```

---

## 9. Cue explanation: `pages/api/assistant/chat.js`

1. **`callModel`** (`:201`): change the signature to `{ strict = true, maxTokens = MAX_OUTPUT_TOKENS } = {}` and use `max_tokens: maxTokens` at `:219`.
2. **`complete`** (`:259`): change it to `complete(messages, origin, { requirePicks = true, maxTokens } = {})` and pass `{ strict, maxTokens }` at `:274` and `:277`. Change the picks guard at `:290` to `if (requirePicks && (!Array.isArray(parsed.picks) || !parsed.picks.length))`. Without this, a reply-only answer is treated as retryable and burns 3 attempts per model.
3. **New constants and helpers** (after `:174`):
   ```js
   const GROUP_PICK_MAX_TOKENS = 300;
   const clip = (v, n) => String(v ?? "").slice(0, n);
   const sanitizeGroupPick = (raw = {}) => ({
     winner: { title: clip(raw.winner?.title, 120), year: clip(raw.winner?.year, 4),
               type: raw.winner?.type === "tv" ? "series" : "film", genres: (raw.winner?.genres || []).slice(0, 4).map(g => clip(g, 30)) },
     members: (raw.members || []).slice(0, 12).map(m => ({ name: clip(m.name, 30),
               fit: Number.isFinite(m.fit) ? Math.round(m.fit * 100) : null, vote: ["yes","no"].includes(m.vote) ? m.vote : null })),
     shared: (raw.shared || []).slice(0, 6).map(s => clip(s, 40)),
     runnersUp: (raw.runnersUp || []).slice(0, 2).map(t => clip(t, 120)),
     method: raw.method === "fit-only" ? "fit-only" : "votes+fit",
   });
   const groupPickPrompt = (name, gp) => `You are ${name}, the assistant inside StreamSynx. A group in a watch-party room just picked a ${gp.winner.type} together using a fairness rule (the title the least-happy person minds least, combined with yes/no swipes).
   Write ONE sentence (max 28 words) telling the room why "${gp.winner.title}" (${gp.winner.year}) is the fair pick. Mention a shared trait if any, and be honest if someone voted no. Use only the facts below; no other titles, no lists, no emojis.
   Facts: ${JSON.stringify(gp)}
   Reply with ONLY {"reply": "..."} — the first character must be "{".`;
   ```
4. **Handler branch.** Insert after the throttle check (`:416-419`), before `const body = req.body || {}` (`:421`). The normal path rejects requests without a final user message (`:431`), so this branch must come first:
   ```js
   if (req.body?.mode === "groupPick") {
     const name = String(req.body.name || "Cue").slice(0, 40);
     const gp = sanitizeGroupPick(req.body.groupPick);
     if (!gp.winner.title) { res.status(400).json({ error: "Missing winner." }); return; }
     const origin = req.headers.origin || `https://${req.headers.host || "streamsynx.app"}`;
     try {
       const { parsed, model } = await complete(
         [{ role: "system", content: groupPickPrompt(name, gp) }, { role: "user", content: "Explain the pick." }],
         origin, { requirePicks: false, maxTokens: GROUP_PICK_MAX_TOKENS });
       res.status(200).json({ reply: String(parsed.reply || "").trim().slice(0, 240), model });
     } catch (error) {
       res.status(error.status === 429 ? 429 : 502).json({ error: "No explanation right now." });
     }
     return;
   }
   ```
   Auth (`verifyUser`) and `throttled(uid)` apply unchanged. Only the host calls this, once per session, and the client falls back to `fallbackExplanation`.
5. **`lib/assistant.js`**:
   - Take `:116-126` out into `export const collectSeenKeys = ({ history, favorites, picks, continueWatching }) => [...]` and `export const loadSeenKeys = async (uid) => {...}`. `loadSeenKeys` uses `safeGet("history")`, `safeGet("favorites")`, `safeGet("users")` → `readTastePicks`, and `getContinueWatching()`. `buildViewerContext` then calls `collectSeenKeys`, so its behaviour doesn't change.
   - Add after `askAssistant` (`:206-225`):
     ```js
     export const explainGroupPick = async ({ user, payload }) => { /* same fetch, body: { name: ASSISTANT_NAME, mode: "groupPick", groupPick: payload } → returns payload.reply */ };
     ```

---

## 10. TMDB rate-limit budget

| Step | Calls (host only) | Priority |
|---|---|---|
| Discover (genres p1–2, keywords) × type | 3–6 (×2 in "any") | 0 |
| Recommendations seeds | ≤ 4 | 0 |
| Trending (fallback only) | 0–2 | 0 |
| Enrich (`append_to_response=keywords,credits` via `buildTasteProfile`) | ≤ 30 | 5 (auto) |
| Second round (rare) | ≤ 6 + 30 | — |

That's roughly 40–45 calls, about 1–2 s at the default 40/s, and they all go through the shared limiter (`tmdbGet` is axios, so the interceptor applies). Other clients make **no** TMDB calls for Group Pick (cards render from the doc). Member profiles come from Firestore. Cache `titleProfiles` in `hostCache` for the session so late-joiner fits and "Run again" with the same mode don't re-enrich (key the cache by `itemKey`). Don't add a parallel `fetch` path. The page's own `fetchTMDB` (`:52`) also goes through the limiter, but stick to `tmdbGet` for consistency.

---

## 11. Styling (real tokens and utilities only)

- **Overlay:** `fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4`. This matches `CreateRoomModal` (`z-50`, `bg-black/70`), with framer `AnimatePresence` and the same spring (`damping: 15, stiffness: 200`).
- **Panel:** `glass-card-elevated w-full max-w-lg md:max-w-xl p-5 md:p-6 max-h-[90vh] overflow-y-auto custom-scrollbar`.
- **Headings:** `section-label` for eyebrow text ("GROUP PICK"), `heading-lg` for the title, `font-dm-display` optional for the winner title.
- **Chips:** `chip`; shared-by-all chips use `chip chip-active`.
- **Buttons:** `btn-primary`, `btn-ghost`, `btn-icon`. The room header button stays in the page's existing `py-1.5 px-3 rounded-lg text-sm` scale, plus `bg-accent text-primary shadow-glow`.
- **Cards:** `surface shadow-lift rounded-2xl overflow-hidden aspect-[2/3]` poster with a `bg-gradient-to-t from-primary via-primary/60 to-transparent` scrim. YES stamp `border-2 border-accent text-accent`; PASS stamp `border-2 border-red-400 text-red-400` (the page already uses `red-400`/`green-500`).
- **Fit display:** reuse `MatchRing` from `components/BuddyMatchCard.jsx` (already exported; it uses `stroke-accent` and `ease-out-expo`).
- **Motion:** `animate-fade-up` for result rows (staggered with an inline `style={{ animationDelay }}`), and `skeleton` while building.
- **Colours:** never hard-code hex except `#DAA520` for the `Mosaic` spinner, which the page already uses.

---

## 12. Phased build order

**Phase 0: prep (½ day)**
- Fix `members`/`memberIds` (`:630`, `:645`, `:761-763`) and the success-on-error toasts.
- Take `collectSeenKeys`/`loadSeenKeys` out of `assistant.js`.
- Make `handleSelectMedia` return a boolean.
- ✅ *Check:* a non-creator presses Leave and actually disappears from `rooms/{id}.members`. Cue still works and still excludes seen titles.
- Copy the console rules into `firestore.rules` (not deployed yet).

**Phase 1: `lib/groupPick.js` (1 day)**
- Write the pure functions and the TMDB-injected `gatherCandidates`.
- Add a temporary, dev-only lab page `pages/dev/group-pick-lab.jsx` (guard with `if (process.env.NODE_ENV === "production") return notFound` and delete before merge). A Node script won't work here because `tasteMatch → tasteProfile → firebase` initialises at import.
- The lab page loads 2–3 real uids via `fetchUserTaste` and prints the merge chips, a shortlist and fits.
- ✅ *Check:*
  - chips read sensibly;
  - no title in any member's `tastePicks.titles` appears;
  - `pickFairWinner` on hand-written vote fixtures gives the expected winner, including a tie decided by each rule in order;
  - a 1-member list and an all-unprofiled list both return a winner.

**Phase 2: `SwipeDeck.jsx` (1 day)**
- Render it in the lab page with fixture items and local `onVote`.
- ✅ *Check:* touch swipe (DevTools device mode), mouse drag, buttons and ←/→ all commit. A cancelled drag snaps back. Already-voted cards are skipped on remount.

**Phase 3: `GroupPickModal.jsx` + `lib/groupPickStore.js` (1.5 days)**
- First run a 1-member room end to end (intro → building → voting → results), then 2 browsers.
- If writes fail with `permission-denied`, the console rules block the new subcollection. Deploy the §7 block early to a dev project rather than loosening production rules.
- ✅ *Check:* the doc moves through each status in the Firestore console. Votes appear under `votes.{uid}`. Only the host writes `shortlist` and `result`.

**Phase 4: room wiring (½ day)**
- Header button, empty-player CTA, listener, mount, `handlePlayGroupPick`, `ChatInterface` system messages.
- ✅ *Check:* B and C's modals open automatically when A starts. Play sets the player for everyone, and a chat chip appears.

**Phase 5: Cue (½ day)**
- `chat.js` options and branch, `explainGroupPick`, fallback.
- ✅ *Check:* `curl` without a token returns 401. With `AI_MODELS` pointed at an invalid model, the fallback sentence appears. With a real model, the reply has at most 28 words and no other titles.

**Phase 6: rules (½ day)**
- Merge §7 into the copied rules and deploy with `firebase deploy --only firestore:rules`.
- Run every case in the checklist below, especially the negative ones.

---

## 13. Manual test checklist (A = creator, B and C = members; use 3 browsers or profiles, at least one in incognito)

**Happy path**
- [ ] A, B and C are in the room. A presses **Group Pick**, chooses Movie, starts. B and C's modals open within about 1 s without a click.
- [ ] Chips show shared genres with correct counts ("Sci-Fi · all 3", "Thriller · 2 of 3").
- [ ] No shortlist card is a title that any of A/B/C has in history, favourites, taste picks or continue-watching. Before the run, watch a candidate as C to plant a known seen title.
- [ ] Every client shows the same 12 cards in the same order with the same "Fits the group N%".
- [ ] Swiping updates the voters strip on the other screens live.
- [ ] When everyone finishes, results appear automatically. The fit bars and votes match.
- [ ] Cue's sentence appears within a few seconds and is the same on all three screens.
- [ ] A presses **Play in this room**. The player loads for B and C, and the chat shows the Group Pick chip.

**Edge cases**
- [ ] **Race:** A and B press Start within the same second. Only one session exists, and the other client simply joins it.
- [ ] **No profile:** C has no taste picks. C shows as "votes only", the session still completes, and C's fit bar shows "—".
- [ ] **Solo:** a 1-member room shows "Solo Pick" and completes after A's swipes.
- [ ] **Series:** the Series mode winner is TV, Play sets S1 and the episode list renders. Either mode gives a mixed deck.
- [ ] **Never votes:** C closes the tab mid-vote. Presence goes offline and A and B finishing triggers `all-voted` without waiting for C.
- [ ] **Stays online, idle:** C keeps the tab open but doesn't swipe. The timeout (3 min) decides with `reason: "timeout"`.
- [ ] **Nobody votes:** after the timeout, method is `fit-only` and the results banner explains it.
- [ ] **Host leaves:** A (host) closes the tab during voting. After about 45 s, B takes over (`hostUid` changes) and finalises.
- [ ] **Removed mid-vote:** A removes C during voting. C's votes are excluded from the result, and C's page shows the "not a member" error.
- [ ] **Late joiner:** A adds D mid-vote. D's page opens the modal, D votes, and D's votes count.
- [ ] **Unanimous no:** A, B and C all swipe "no" on everything. A winner is still produced (eligibility `all`, least-bad fit).
- [ ] **Few results:** a very niche group, or a temporarily forced tiny pool, ends in the relaxation ladder or a `not-enough-titles` cancel with the "Try Either" message.
- [ ] **Run again:** after done, a new `sessionId` starts, old votes are gone, and dismissing the modal for the old session doesn't block the new one.
- [ ] **Non-creator play:** B (not the creator) sees "Waiting for A to hit play". A can play a runner-up instead.

**Rules (negative tests)**

Run these in the browser console as the stated user, using `updateDoc` from the Firebase SDK. Each should fail with permission-denied:
- [ ] B writes `votes.uidC.movie_1`.
- [ ] B (not host) sets `status: "done"`.
- [ ] B sets `hostUid` while the heartbeat is fresh.
- [ ] B writes `shortlist`.
- [ ] A non-member reads the doc.
- [ ] B writes a vote value of `"maybe"`.
- [ ] Anyone writes a vote after status is `done`.

---

## 14. Open questions and risks

1. **Who can press Play?** *Decided:* only the room creator. If the creator leaves, a random remaining member becomes the creator (`handleLeaveRoom` does this in a transaction and updates `createdBy` and `createdByUsername`). Firestore rules are pending: the owner will upload the current console rules.
2. **Fit calibration.** Per-member max-normalisation makes each member's best candidate 100%. That's fair for least misery but makes "Fits the group N%" relative to the pool, not absolute. Alternative: blend in `min(1, raw / 0.35)`. Tune in the Phase 1 lab.
3. **Weights** (`0.6·min + 0.4·mean`, `0.7·vote + 0.3·fit`, majority gate) are first guesses. Log `result.ranking` in dev and adjust after a few real sessions.
4. **Third vote option?** A "Seen it" button would fix the gap for late joiners (whose seen titles weren't excluded). The agreed schema has only `yes`/`no`. Proposal: treat "Seen it" as `no` for now.
5. **Privacy.** `seenAmong` reveals to other members which of about 40 candidates you've seen. That's minimal, but worth a line in the intro ("We'll quietly skip anything you've already watched").
6. **Clock skew.** The takeover rule uses server `request.time` against `hostSeenAt`, which is safe. The client-side countdown uses local time against `votingEndsAt`, which is cosmetic only.
7. **Rules aren't in the repo.** This is the biggest deployment risk. Deploying a partial file would wipe production rules. Commit the full copied rules first.
8. **Rooms list reads every room.** `pages/rooms/index.jsx:43` queries every room, not only the user's. That's unrelated to this feature, but it shows the room rules are probably permissive. Confirm before relying on them.
9. **Cost.** About 12 vote writes per member per session, plus around 10 host writes. Negligible.
10. **Model quota.** The explanation shares the 30/hour per-user `throttled` budget with the Cue chat. It's one call per session, from the host only.

### Critical Files for Implementation
- pages/rooms/[roomId].jsx
- lib/tasteMatch.js
- lib/tasteProfile.js
- pages/api/assistant/chat.js
- lib/assistant.js
- components/ChatInterface.jsx
