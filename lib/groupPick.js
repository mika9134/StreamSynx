// lib/groupPick.js — the maths behind Group Pick in watch rooms.
//
// Everything here is plain functions over taste profiles and TMDB results.
// Network calls (TMDB) are injected through `deps`, and nothing touches
// Firestore — lib/groupPickStore.js owns the room document.
//
// The flow
// --------
//  1. mergeGroupTaste — every member's stored taste profile becomes one group
//     profile. Traits several people share weigh more than one person's niche.
//  2. gatherCandidates — TMDB titles that fit the group, enriched into title
//     profiles so they can be scored like people are.
//  3. fitPerMember — how well each title fits each member (0..1).
//  4. selectShortlist — drops what anyone has seen, keeps a varied top 12.
//  5. pickFairWinner — votes plus fit, chosen by "least misery": the title the
//     least happy member minds least.
//
// Keys: titles are identified as "movie_603" / "tv_1399". Underscores (not
// colons) so the keys work in Firestore dotted update paths.
import { buildIdf, scoreMatch, weightedCosine } from "./tasteMatch";
import { buildTasteProfile, genreName, normalizePick } from "./tasteProfile";
import { tmdbGet } from "./tmdb";

export const SHORTLIST_SIZE = 12;
/** Candidates enriched with keywords and credits before the final cut. */
export const ENRICH_POOL_SIZE = 30;
/** Below this, after every relaxation, the session is cancelled. */
export const MIN_SHORTLIST = 4;
export const CHECK_TIMEOUT_MS = 8_000;
export const VOTING_TIMEOUT_MS = 180_000;
export const HOST_HEARTBEAT_MS = 15_000;
export const HOST_STALE_MS = 45_000;

/** Winner score = FAIR_MIN_WEIGHT · least happy + the rest · average. */
export const FAIR_MIN_WEIGHT = 0.6;
/** A member's satisfaction = VOTE_WEIGHT · their vote + the rest · their fit. */
export const VOTE_WEIGHT = 0.7;
/** "Fits the group N%" leans harder on the least happy member. */
const DISPLAY_MIN_WEIGHT = 0.7;

const FACETS = ["genres", "keywords", "people", "decades"];
const MAX_CHIP_GENRES = 4;
const MAX_CHIP_KEYWORDS = 2;
const MAX_CHIP_PEOPLE = 1;
const MAX_SAME_GENRE = 4;
const MIN_PER_TYPE = 3;
const RECS_SLOTS = 2;
const RECS_MIN_FAIR = 0.3;
const MAX_RECS_MEMBERS = 4;
const OVERVIEW_CAP = 300;

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const round = (value, places = 3) => Math.round(value * 10 ** places) / 10 ** places;

// --- Keys --------------------------------------------------------------------

/** @param {{id:number, media_type:'movie'|'tv'}} item @returns {string} "movie_603" */
export const itemKeyOf = (item) => `${item.media_type === "tv" ? "tv" : "movie"}_${Number(item.id)}`;

/** "movie:603" (the seen-key format in lib/assistant.js) → "movie_603" */
export const seenKeyToItemKey = (key) => String(key).replace(":", "_");

/** Taste picks are public, so they can be excluded before any network call. */
const pickItemKeys = (tastePicks) =>
  [...(tastePicks?.movies || []), ...(tastePicks?.shows || [])].map((pick) =>
    itemKeyOf({ id: pick.id, media_type: pick.type })
  );

// --- Genres ------------------------------------------------------------------
//
// TMDB numbers series genres differently ("Sci-Fi & Fantasy" is 10765, film
// "Sci-Fi" is 878). Profiles mix both, so everything is mapped onto film ids
// before comparing, and back to series ids when querying /discover/tv.

const TV_TO_MOVIE_GENRES = { 10759: [28, 12], 10765: [878, 14], 10768: [10752] };
const MOVIE_TO_TV_GENRE = { 28: 10759, 12: 10759, 878: 10765, 14: 10765, 10752: 10768 };
/** Film genres with no series equivalent; dropped from series queries. */
const MOVIE_ONLY_GENRES = new Set([27, 53, 10749, 36, 10402, 10770]);

/** Film-id genre list for any TMDB item or id list. */
const canonicalGenreIds = (ids = []) => [
  ...new Set(ids.flatMap((id) => TV_TO_MOVIE_GENRES[Number(id)] || [Number(id)])),
];

const normalizeVector = (map) => {
  const norm = Math.sqrt(Object.values(map).reduce((sum, weight) => sum + weight * weight, 0));
  if (!norm) return {};
  return Object.fromEntries(Object.entries(map).map(([key, weight]) => [key, weight / norm]));
};

/** A genre vector re-keyed onto film ids, weight split across expansions. */
const canonicalGenreVector = (vector = {}) => {
  const out = {};
  Object.entries(vector).forEach(([id, weight]) => {
    const targets = TV_TO_MOVIE_GENRES[Number(id)] || [Number(id)];
    targets.forEach((target) => {
      out[target] = (out[target] || 0) + weight / targets.length;
    });
  });
  return normalizeVector(out);
};

const canonicalProfile = (profile) =>
  profile ? { ...profile, genres: canonicalGenreVector(profile.genres) } : null;

const hasProfile = (profile) => Object.keys(profile?.genres || {}).length > 0;

/** Film genre ids → the ids /discover/tv understands. */
const toTvGenreIds = (ids) => [
  ...new Set(
    ids
      .map(Number)
      .filter((id) => !MOVIE_ONLY_GENRES.has(id))
      .map((id) => MOVIE_TO_TV_GENRE[id] || id)
  ),
];

const topKeys = (vector = {}, count) =>
  Object.entries(vector)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([key]) => key);

// --- 1. Group taste ----------------------------------------------------------

/**
 * Merges members' taste profiles into one.
 *
 * Each stored vector is unit length, so every member carries equal weight. A
 * trait's merged weight is its average across profiled members, scaled by the
 * square root of how many of them have it — shared traits beat one person's
 * strong niche.
 *
 * @param {Array<{uid:string, username?:string, tasteProfile?:object|null}>} members
 * @returns {{ profile: object|null, profiled: string[], unprofiled: string[],
 *             support: Record<string, Record<string, number>>,
 *             chips: Array<{facet:string, key:string, label:string, count:number, total:number}> }}
 */
export const mergeGroupTaste = (members) => {
  const profiled = members.filter((member) => hasProfile(member.tasteProfile));
  const unprofiled = members.filter((member) => !hasProfile(member.tasteProfile)).map((m) => m.uid);
  const total = profiled.length;
  const support = { genres: {}, keywords: {}, people: {}, decades: {} };

  if (!total) {
    return { profile: null, profiled: [], unprofiled, support, chips: [] };
  }

  const profiles = profiled.map((member) => canonicalProfile(member.tasteProfile));
  const profile = { labels: { keywords: {}, people: {} } };

  FACETS.forEach((facet) => {
    const sums = {};
    profiles.forEach((member) => {
      Object.entries(member[facet] || {}).forEach(([key, weight]) => {
        sums[key] = (sums[key] || 0) + weight;
        support[facet][key] = (support[facet][key] || 0) + 1;
      });
    });
    const merged = {};
    Object.entries(sums).forEach(([key, sum]) => {
      merged[key] = (sum / total) * Math.sqrt(support[facet][key] / total);
    });
    profile[facet] = normalizeVector(merged);
  });

  profiles.forEach((member) => {
    Object.assign(profile.labels.keywords, member.labels?.keywords);
    Object.assign(profile.labels.people, member.labels?.people);
  });

  // A trait is "shared" when (nearly) everyone has it; with two people, both.
  const threshold = total <= 2 ? total : Math.ceil(total * 0.66);
  const chipsFor = (facet, limit, labelOf) =>
    topKeys(profile[facet], Infinity)
      .filter((key) => support[facet][key] >= threshold && labelOf(key))
      .slice(0, limit)
      .map((key) => ({ facet, key, label: labelOf(key), count: support[facet][key], total }));

  const chips = [
    ...chipsFor("genres", MAX_CHIP_GENRES, genreName),
    ...chipsFor("keywords", MAX_CHIP_KEYWORDS, (key) => profile.labels.keywords[key]),
    ...chipsFor("people", MAX_CHIP_PEOPLE, (key) => profile.labels.people[key]),
  ];

  return { profile, profiled: profiled.map((member) => member.uid), unprofiled, support, chips };
};

/** "Sci-Fi · all 3" / "Mystery · 2 of 3"; a solo member's chips are just labels. */
export const chipText = (chip) => {
  if (chip.total <= 1) return chip.label;
  return chip.count === chip.total
    ? `${chip.label} · all ${chip.total}`
    : `${chip.label} · ${chip.count} of ${chip.total}`;
};

// --- 3. Fit per member -------------------------------------------------------

/**
 * How well each title fits each member, 0..1.
 *
 * Raw fit is the facet-weighted cosine from tasteMatch.js. It is then divided
 * by the member's best raw fit across the whole pool, so a member with rich
 * keyword vectors and one with only genres sit on the same scale and neither
 * dominates the least-misery minimum.
 *
 * IDF is built over the title profiles, not the members: rarity should say
 * what makes one candidate different from the others.
 *
 * @param {Record<string, object|null>} memberProfiles uid → tasteProfile (null = unprofiled)
 * @param {Map<string, object>} titleProfiles itemKey → title taste profile
 * @param {{ idf?: object }} [options]
 * @returns {Record<string, Record<string, number|null>>} uid → itemKey → fit
 */
export const fitPerMember = (memberProfiles, titleProfiles, { idf } = {}) => {
  const titles = [...titleProfiles.entries()].map(([key, profile]) => [key, canonicalProfile(profile)]);
  const rarity = idf || buildIdf(titles.map(([, profile]) => profile));
  const fits = {};

  Object.entries(memberProfiles).forEach(([uid, rawProfile]) => {
    const profile = hasProfile(rawProfile) ? canonicalProfile(rawProfile) : null;
    const raw = titles.map(([key, title]) => [
      key,
      profile ? scoreMatch(profile, title, { idf: rarity }).affinity : 0,
    ]);
    const best = Math.max(0, ...raw.map(([, value]) => value));
    fits[uid] = Object.fromEntries(
      raw.map(([key, value]) => [key, profile && best >= 0.05 ? round(clamp01(value / best)) : null])
    );
  });

  return fits;
};

/**
 * Summary of one title's fits across members.
 * @param {Array<number|null|undefined>} fits
 * @returns {{min:number|null, mean:number|null, fair:number|null, percent:number|null}}
 */
export const fairFitOf = (fits) => {
  const known = fits.filter((fit) => typeof fit === "number");
  if (!known.length) return { min: null, mean: null, fair: null, percent: null };
  const min = Math.min(...known);
  const mean = known.reduce((sum, fit) => sum + fit, 0) / known.length;
  const fair = DISPLAY_MIN_WEIGHT * min + (1 - DISPLAY_MIN_WEIGHT) * mean;
  return { min, mean, fair, percent: Math.round(fair * 100) };
};

const itemFits = (fits, key) => Object.values(fits || {}).map((byKey) => byKey?.[key]);

// --- 2. Candidates -----------------------------------------------------------

const today = () => new Date().toISOString().slice(0, 10);

/** The fields a shortlist card needs, nothing else (the doc is shared). */
const toShortlistItem = (item, type, source) => ({
  key: itemKeyOf({ id: item.id, media_type: type }),
  id: Number(item.id),
  media_type: type,
  title: item.title || item.name || "Untitled",
  year: String(item.release_date || item.first_air_date || "").slice(0, 4),
  poster_path: item.poster_path || null,
  backdrop_path: item.backdrop_path || null,
  overview: String(item.overview || "").slice(0, OVERVIEW_CAP),
  genre_ids: (item.genre_ids || []).map(Number),
  vote_average: round(Number(item.vote_average) || 0, 1),
  popularity: Number(item.popularity) || 0,
  source,
});

const discoverRequest = (type, source, params, page) => ({
  type,
  source,
  path: `/discover/${type}`,
  params: { sort_by: "popularity.desc", include_adult: false, page, ...params },
});

/**
 * The TMDB requests for one gathering round. `relaxed` lowers the bars and
 * widens the net when a strict round came back short.
 */
const candidateRequests = ({ groupTaste, members, types, pageOffset, relaxed }) => {
  const profile = groupTaste?.profile;
  const requests = [];
  const pages = relaxed ? [1, 2, 3] : [1, 2];

  if (profile) {
    const genreIds = topKeys(profile.genres, relaxed ? 2 : 3).map(Number);
    const keywordIds = topKeys(profile.keywords, Infinity)
      .filter((key) => (groupTaste.support.keywords[key] || 0) >= Math.min(2, groupTaste.profiled.length))
      .slice(0, 3);

    types.forEach((type) => {
      const ids = type === "tv" ? toTvGenreIds(genreIds) : genreIds;
      const voteFloor = type === "tv" ? (relaxed ? 50 : 150) : relaxed ? 100 : 400;
      if (ids.length) {
        pages.forEach((page) =>
          requests.push(
            discoverRequest(type, "genres", {
              with_genres: ids.join("|"),
              "vote_count.gte": voteFloor,
              "vote_average.gte": 6.3,
            }, page + pageOffset)
          )
        );
      }
      if (keywordIds.length && !relaxed) {
        requests.push(
          discoverRequest(type, "keywords", {
            with_keywords: keywordIds.join("|"),
            "vote_count.gte": voteFloor,
          }, 1 + pageOffset)
        );
      }
    });

    // Each member's first pick of the right type adds personal variety, so the
    // list is not only the average taste.
    members
      .filter((member) => groupTaste.profiled.includes(member.uid))
      .slice(0, MAX_RECS_MEMBERS)
      .forEach((member) => {
        types.forEach((type) => {
          const pick = (type === "tv" ? member.tastePicks?.shows : member.tastePicks?.movies)?.[0];
          if (pick) {
            requests.push({
              type,
              source: "recs",
              path: `/${type}/${pick.id}/recommendations`,
              params: { page: 1 + pageOffset },
            });
          }
        });
      });
  }

  if (!profile || relaxed) {
    types.forEach((type) =>
      requests.push({ type, source: "trending", path: `/trending/${type}/week`, params: { page: 1 + pageOffset } })
    );
  }

  return requests;
};

/** Profile of one title, built the same way a member's picks are. */
const defaultEnrich = (pick) =>
  buildTasteProfile({
    movies: pick.type === "movie" ? [pick] : [],
    shows: pick.type === "tv" ? [pick] : [],
  });

/**
 * Stage 1 (network): builds and enriches the candidate pool.
 *
 * @param {{ groupTaste: ReturnType<typeof mergeGroupTaste>,
 *           members: Array<{uid:string, tasteProfile?:object, tastePicks?:object}>,
 *           mode: 'movie'|'tv'|'any',
 *           knownExclusions?: Set<string>,
 *           pageOffset?: number }} opts
 * @param {{ get?: Function, enrich?: Function }} [deps]
 * @returns {Promise<{ candidates: Array<object>, titleProfiles: Map<string, object>,
 *                     fits: Record<string, Record<string, number|null>>, relaxed: string[] }>}
 */
export async function gatherCandidates(opts, deps = {}) {
  const get = deps.get || tmdbGet;
  const enrich = deps.enrich || defaultEnrich;
  const { groupTaste, members, mode = "movie", pageOffset = 0 } = opts;
  const types = mode === "any" ? ["movie", "tv"] : [mode === "tv" ? "tv" : "movie"];

  const exclude = new Set(opts.knownExclusions || []);
  members.forEach((member) => pickItemKeys(member.tastePicks).forEach((key) => exclude.add(key)));

  const groupGenres = groupTaste?.profile?.genres || {};
  const pool = new Map();
  const relaxed = [];
  const now = today();

  const runRound = async (isRelaxed) => {
    const requests = candidateRequests({ groupTaste, members, types, pageOffset, relaxed: isRelaxed });
    const settled = await Promise.allSettled(requests.map((request) => get(request.path, request.params)));
    settled.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      const { type, source } = requests[index];
      (result.value?.data?.results || []).forEach((raw) => {
        if (raw.adult || !raw.poster_path) return;
        const date = raw.release_date || raw.first_air_date;
        if (!date || date > now) return;
        const item = toShortlistItem(raw, type, source);
        if (exclude.has(item.key) || pool.has(item.key)) return;
        const genreVector = Object.fromEntries(canonicalGenreIds(item.genre_ids).map((id) => [id, 1]));
        item.coarse = round(
          weightedCosine(groupGenres, normalizeVector(genreVector)) + (0.1 * Math.min(item.popularity, 500)) / 500
        );
        pool.set(item.key, item);
      });
    });
  };

  await runRound(false);
  if (pool.size < ENRICH_POOL_SIZE) {
    relaxed.push("lower-vote-floor", "fewer-genres", "page-3", "trending");
    await runRound(true);
  }

  // Best coarse matches first; with both types, keep both in the pool.
  const ranked = [...pool.values()].sort((a, b) => b.coarse - a.coarse || b.popularity - a.popularity);
  let chosen = ranked.slice(0, ENRICH_POOL_SIZE);
  if (types.length > 1) {
    const perType = Math.floor(ENRICH_POOL_SIZE / 2);
    const firsts = types.flatMap((type) => ranked.filter((item) => item.media_type === type).slice(0, perType));
    const firstKeys = new Set(firsts.map((item) => item.key));
    chosen = [...firsts, ...ranked.filter((item) => !firstKeys.has(item.key))].slice(0, ENRICH_POOL_SIZE);
  }

  const enriched = await Promise.allSettled(
    chosen.map((item) => enrich(normalizePick(item, item.media_type)))
  );
  const titleProfiles = new Map();
  const candidates = [];
  enriched.forEach((result, index) => {
    if (result.status !== "fulfilled" || !result.value) return;
    titleProfiles.set(chosen[index].key, result.value);
    candidates.push(chosen[index]);
  });

  const memberProfiles = Object.fromEntries(
    members.map((member) => [member.uid, member.tasteProfile || null])
  );
  const fits = fitPerMember(memberProfiles, titleProfiles);

  return { candidates, titleProfiles, fits, relaxed };
}

// --- 4. Shortlist ------------------------------------------------------------

/**
 * Stage 2 (pure): removes seen titles and picks a varied top N.
 *
 * Limits: at most 4 titles share a lead genre; with both types, at least 3 of
 * each when available; up to 2 slots go to members' personal recommendations
 * that still fit everyone reasonably.
 *
 * @param {{ candidates: Array<object>, fits: object, excludeKeys?: Set<string>,
 *           mode?: 'movie'|'tv'|'any', size?: number }} input
 * @returns {{ items: Array<object>, shortBy: number }}
 */
export function selectShortlist({ candidates, fits, excludeKeys = new Set(), mode = "movie", size = SHORTLIST_SIZE }) {
  const ranked = candidates
    .filter((item) => !excludeKeys.has(item.key))
    .map((item) => ({ item, fair: fairFitOf(itemFits(fits, item.key)).fair }))
    .sort(
      (a, b) =>
        (b.fair ?? -1) - (a.fair ?? -1) ||
        (b.item.coarse || 0) - (a.item.coarse || 0) ||
        b.item.vote_average - a.item.vote_average
    );

  const picked = new Set();
  const genreCount = {};
  const leadGenre = (item) => canonicalGenreIds(item.genre_ids)[0] ?? "none";
  const take = (entry, { ignoreGenreCap = false } = {}) => {
    if (picked.size >= size || picked.has(entry)) return;
    const genre = leadGenre(entry.item);
    if (!ignoreGenreCap && (genreCount[genre] || 0) >= MAX_SAME_GENRE) return;
    picked.add(entry);
    genreCount[genre] = (genreCount[genre] || 0) + 1;
  };

  ranked
    .filter((entry) => entry.item.source === "recs" && (entry.fair ?? 0) >= RECS_MIN_FAIR)
    .slice(0, RECS_SLOTS)
    .forEach((entry) => take(entry));
  if (mode === "any") {
    ["movie", "tv"].forEach((type) =>
      ranked
        .filter((entry) => entry.item.media_type === type)
        .slice(0, MIN_PER_TYPE)
        .forEach((entry) => take(entry))
    );
  }
  ranked.forEach((entry) => take(entry));
  ranked.forEach((entry) => take(entry, { ignoreGenreCap: true }));

  // Keep the overall ranking order: it is the final tie-break for the winner.
  const items = ranked
    .filter((entry) => picked.has(entry))
    .map(({ item, fair }) => {
      const { coarse, popularity, ...rest } = item;
      return { ...rest, groupFit: fair === null ? null : round(fair) };
    });

  return { items, shortBy: Math.max(0, size - items.length) };
}

/** gather → select, for when the seen titles are already known (solo, lab page). */
export async function buildShortlist(opts, deps) {
  const gathered = await gatherCandidates(opts, deps);
  const { items, shortBy } = selectShortlist({
    candidates: gathered.candidates,
    fits: gathered.fits,
    excludeKeys: opts.excludeKeys,
    mode: opts.mode,
  });
  return { ...gathered, items, shortBy };
}

// --- 5. Fair winner ----------------------------------------------------------

/**
 * Picks the winner by least misery.
 *
 * A member's satisfaction with a title is 0.7·vote + 0.3·fit (yes = 1, no = 0),
 * or whichever of the two exists. A title scores 0.6·(least satisfied member)
 * + 0.4·(average), so one "no" caps that member at 0.3 and pulls the title
 * down — votes override taste guesses, and nobody gets stuck with something
 * they rejected while a fairer option exists.
 *
 * Only titles a majority said yes to compete; failing that, any title with a
 * yes; failing that, everything. Ties go to more yes votes, fewer no votes,
 * higher minimum, higher TMDB rating, then shortlist order — fully
 * deterministic, so any client recomputing it gets the same answer.
 *
 * @param {{ items: Array<object>, fits: object, votes: object, members: string[] }} input
 *   `members` = participants still in the room; votes from anyone else are ignored.
 * @returns {{ winner: object|null, runnersUp: Array<object>, ranking: Array<object>,
 *             method: 'votes+fit'|'fit-only', eligibility: 'majority'|'any-yes'|'all' }}
 */
export function pickFairWinner({ items, fits = {}, votes = {}, members }) {
  if (!items?.length) {
    return { winner: null, runnersUp: [], ranking: [], method: "fit-only", eligibility: "all" };
  }

  const keys = new Set(items.map((item) => item.key));
  const voters = members.filter((uid) => Object.keys(votes[uid] || {}).some((key) => keys.has(key)));
  const majority = Math.ceil(voters.length / 2);

  const scored = items.map((item, index) => {
    let yes = 0;
    let no = 0;
    const perMember = {};
    const satisfactions = [];

    members.forEach((uid) => {
      const vote = votes[uid]?.[item.key];
      const fit = fits[uid]?.[item.key];
      const v = vote === "yes" ? 1 : vote === "no" ? 0 : undefined;
      if (vote === "yes") yes += 1;
      if (vote === "no") no += 1;
      const hasFit = typeof fit === "number";
      const s = v !== undefined ? (hasFit ? VOTE_WEIGHT * v + (1 - VOTE_WEIGHT) * fit : v) : hasFit ? fit : null;
      perMember[uid] = { fit: hasFit ? fit : null, vote: vote || null, s: s === null ? null : round(s) };
      if (s !== null) satisfactions.push(s);
    });

    const min = satisfactions.length ? Math.min(...satisfactions) : null;
    const mean = satisfactions.length ? satisfactions.reduce((a, b) => a + b, 0) / satisfactions.length : null;
    const score = min === null ? 0.5 : FAIR_MIN_WEIGHT * min + (1 - FAIR_MIN_WEIGHT) * mean;
    return { item, index, key: item.key, score: round(score, 4), min, mean, yes, no, perMember };
  });

  let eligibility = "all";
  let pool = scored;
  if (voters.length) {
    const majorityPool = scored.filter((entry) => entry.yes >= majority);
    const anyYesPool = scored.filter((entry) => entry.yes >= 1);
    if (majorityPool.length) {
      eligibility = "majority";
      pool = majorityPool;
    } else if (anyYesPool.length) {
      eligibility = "any-yes";
      pool = anyYesPool;
    }
  }
  // Something every voter rejected never wins while anything else is left.
  if (voters.length >= 2) {
    const notUnanimousNo = pool.filter((entry) => entry.no < voters.length);
    if (notUnanimousNo.length) pool = notUnanimousNo;
  }

  const ordered = [...pool].sort(
    (a, b) =>
      b.score - a.score ||
      b.yes - a.yes ||
      a.no - b.no ||
      (b.min ?? -1) - (a.min ?? -1) ||
      b.item.vote_average - a.item.vote_average ||
      a.index - b.index
  );
  // Runners-up can come from outside the eligible pool if it is tiny.
  const rest = scored
    .filter((entry) => !pool.includes(entry))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const full = [...ordered, ...rest];

  return {
    winner: ordered[0].item,
    runnersUp: full.slice(1, 3).map((entry) => entry.item),
    ranking: full.slice(0, 5).map(({ key, score, min, mean, yes, no, perMember }) => ({
      key,
      score,
      min: min === null ? null : round(min),
      mean: mean === null ? null : round(mean),
      yes,
      no,
      perMember,
    })),
    method: voters.length ? "votes+fit" : "fit-only",
    eligibility,
  };
}

// --- Voting progress ---------------------------------------------------------

/**
 * Who has finished swiping. People who left the room are dropped; people who
 * are offline are reported but never waited for.
 *
 * @param {{ items: Array<object>, votes: object, voters: string[],
 *           onlineUids: Set<string>, roomMembers: string[] }} state
 * @returns {{ perVoter: Record<string, {count:number,total:number,done:boolean,online:boolean}>,
 *             waitingOn: string[], allDone: boolean }}
 */
export function votingProgress({ items = [], votes = {}, voters = [], onlineUids = new Set(), roomMembers = [] }) {
  const members = new Set(roomMembers);
  const total = items.length;
  const perVoter = {};
  voters
    .filter((uid) => members.has(uid))
    .forEach((uid) => {
      const count = items.filter((item) => votes[uid]?.[item.key]).length;
      perVoter[uid] = { count, total, done: total > 0 && count >= total, online: onlineUids.has(uid) };
    });
  const waitingOn = Object.entries(perVoter)
    .filter(([, status]) => status.online && !status.done)
    .map(([uid]) => uid);
  const anyDone = Object.values(perVoter).some((status) => status.done);
  return { perVoter, waitingOn, allDone: anyDone && waitingOn.length === 0 };
}

const toMillis = (value) =>
  typeof value?.toMillis === "function" ? value.toMillis() : typeof value === "number" ? value : null;

/**
 * Whether the host should decide now.
 *
 * @param {{ session: object, now: number, onlineUids: Set<string>, roomMembers: string[], forced?: boolean }} state
 * @returns {{ finalize: boolean, reason: 'all-voted'|'timeout'|'host-forced'|null }}
 */
export function shouldFinalize({ session, now, onlineUids, roomMembers, forced = false }) {
  if (session?.status !== "voting") return { finalize: false, reason: null };
  if (forced) return { finalize: true, reason: "host-forced" };
  const progress = votingProgress({
    items: session.shortlist,
    votes: session.votes,
    voters: session.voters,
    onlineUids,
    roomMembers,
  });
  if (progress.allDone) return { finalize: true, reason: "all-voted" };
  const endsAt = toMillis(session.votingEndsAt);
  if (endsAt !== null && now >= endsAt) return { finalize: true, reason: "timeout" };
  return { finalize: false, reason: null };
}

/** "Decide now" is offered once at least half the voters have finished. */
export const canForceDecide = (progress) => {
  const statuses = Object.values(progress.perVoter);
  return statuses.length > 0 && statuses.filter((status) => status.done).length >= Math.ceil(statuses.length / 2);
};

// --- Copy and payloads -------------------------------------------------------

/** The shape the room page's handleSelectMedia already accepts. */
export const toRoomMedia = (item) => ({
  id: item.id,
  media_type: item.media_type,
  title: item.title,
  poster_path: item.poster_path,
});

const lowestFitPercent = (result) => {
  const fits = Object.values(result?.perMember || {})
    .map((entry) => entry.fit)
    .filter((fit) => typeof fit === "number");
  return fits.length ? Math.round(Math.min(...fits) * 100) : null;
};

const yesCount = (result) =>
  Object.values(result?.perMember || {}).filter((entry) => entry.vote === "yes").length;

/** "Group Pick: Arrival (2016), 3 of 3 said yes" */
export function chatSystemText(item, result) {
  const total = Object.keys(result?.perMember || {}).length;
  const year = item.year ? ` (${item.year})` : "";
  const votes = result?.method === "votes+fit" ? `, ${yesCount(result)} of ${total} said yes` : ", picked on taste";
  return `Group Pick: ${item.title}${year}${votes}`;
}

/**
 * Compact input for Cue's one-line explanation. Only titles, genres and
 * numbers — no histories, no profiles.
 */
export function explanationPayload({ item, result, usernames = {}, chips = [] }) {
  // No overview or runner-up titles: Cue built "shared interests" out of plot
  // summaries, and the line should only explain why this pick is fair.
  return {
    title: item.title,
    year: item.year || null,
    mediaType: item.media_type,
    genres: (item.genre_ids || []).map(genreName).filter(Boolean).slice(0, 3),
    sharedTraits: chips.slice(0, 5).map((chip) => chip.label),
    members: Object.entries(result?.perMember || {}).map(([uid, entry]) => ({
      name: usernames[uid] || "someone",
      fit: typeof entry.fit === "number" ? Math.round(entry.fit * 100) : null,
      vote: entry.vote,
    })),
    method: result?.method || "votes+fit",
  };
}

/** Used whenever Cue is unavailable. */
export function fallbackExplanation({ item, result, chips = [] }) {
  const shared = chips.find((chip) => chip.facet === "genres")?.label;
  const lowest = lowestFitPercent(result);
  const reasons = [
    shared ? `${shared} you all share` : null,
    lowest !== null ? `nobody's below ${lowest}%` : null,
  ].filter(Boolean);
  return reasons.length
    ? `${item.title} is the fairest pick: ${reasons.join(", and ")}.`
    : `${item.title} is the pick the whole room minds least.`;
}
