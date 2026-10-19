// Unit tests for lib/groupPick.js. Run with `npm test`.
import test from "node:test";
import assert from "node:assert/strict";

const gp = await import("../lib/groupPick.js");

const unit = (m) => {
  const n = Math.sqrt(Object.values(m).reduce((s, v) => s + v * v, 0));
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v / n]));
};
const prof = (genres, extra = {}) => ({
  genres: unit(genres),
  keywords: {},
  people: {},
  decades: {},
  labels: { keywords: {}, people: {} },
  pickCount: 8,
  ...extra,
});

const dystopia = { keywords: unit({ 4565: 1 }), labels: { keywords: { 4565: "dystopia" }, people: {} } };
const mika = { uid: "m", tasteProfile: prof({ 878: 3, 9648: 2, 18: 1 }, dystopia), tastePicks: { movies: [{ id: 1, type: "movie" }], shows: [] } };
const alex = { uid: "a", tasteProfile: prof({ 53: 3, 878: 2 }, dystopia), tastePicks: { movies: [{ id: 2, type: "movie" }], shows: [] } };
const sam = { uid: "s", tasteProfile: prof({ 9648: 2, 18: 2, 10765: 2 }), tastePicks: { movies: [], shows: [{ id: 3, type: "tv" }] } };
const nobody = { uid: "n", tasteProfile: null, tastePicks: { movies: [], shows: [] } };

test("mergeGroupTaste: shared traits, TV genre ids mapped, unprofiled kept apart", () => {
  const g = gp.mergeGroupTaste([mika, alex, sam, nobody]);
  assert.deepEqual(g.profiled, ["m", "a", "s"]);
  assert.deepEqual(g.unprofiled, ["n"]);
  const scifi = g.chips.find((c) => c.key === "878");
  assert.equal(scifi.count, 3, "sam's 10765 counts as Sci-Fi");
  assert.equal(gp.chipText(scifi), "Sci-Fi · all 3");
  assert.ok(g.profile.genres["878"] > g.profile.genres["53"], "shared sci-fi beats alex's solo thriller");
  const keyword = g.chips.find((c) => c.facet === "keywords");
  assert.equal(gp.chipText(keyword), "dystopia · 2 of 3", "2 of 3 counts as shared");
});

test("mergeGroupTaste: nobody profiled / solo", () => {
  assert.equal(gp.mergeGroupTaste([nobody]).profile, null);
  const solo = gp.mergeGroupTaste([mika]);
  assert.equal(gp.chipText(solo.chips[0]), "Sci-Fi");
});

test("fitPerMember: calibrated 0..1, best title is 1, unprofiled null", () => {
  const titles = new Map([
    ["movie_10", prof({ 878: 1, 9648: 1 })],
    ["movie_11", prof({ 53: 1 })],
    ["tv_12", prof({ 10765: 1, 18: 1 })],
  ]);
  const fits = gp.fitPerMember({ m: mika.tasteProfile, a: alex.tasteProfile, n: null }, titles);
  assert.equal(Math.max(...Object.values(fits.m)), 1);
  assert.equal(fits.a.movie_11, 1);
  assert.ok(fits.m.tv_12 > 0, "TV sci-fi fits a film sci-fi fan");
  assert.deepEqual(Object.values(fits.n), [null, null, null]);
});

const item = (key, extra = {}) => ({
  key,
  id: Number(key.split("_")[1]),
  media_type: key.split("_")[0],
  title: key,
  vote_average: 7,
  genre_ids: [18],
  ...extra,
});

test("pickFairWinner: least misery beats most votes", () => {
  const items = [item("movie_1", { title: "Knives Out" }), item("movie_2", { title: "Arrival" })];
  const fits = {
    m: { movie_1: 0.92, movie_2: 0.88 },
    a: { movie_1: 0.9, movie_2: 0.81 },
    s: { movie_1: 0.31, movie_2: 0.74 },
  };
  const votes = {
    m: { movie_1: "yes", movie_2: "yes" },
    a: { movie_1: "yes", movie_2: "yes" },
    s: { movie_1: "no", movie_2: "yes" },
  };
  const r = gp.pickFairWinner({ items, fits, votes, members: ["m", "a", "s"] });
  assert.equal(r.winner.title, "Arrival");
  assert.equal(r.eligibility, "majority");
  assert.equal(r.method, "votes+fit");
  assert.equal(r.runnersUp[0].title, "Knives Out");
});

test("pickFairWinner: leavers' votes ignored, no votes means fit-only, empty gives null", () => {
  const items = [item("movie_1"), item("movie_2")];
  const fits = { m: { movie_1: 0.2, movie_2: 0.9 } };
  const r = gp.pickFairWinner({ items, fits, votes: { gone: { movie_1: "yes" } }, members: ["m"] });
  assert.equal(r.method, "fit-only");
  assert.equal(r.winner.key, "movie_2");
  assert.equal(gp.pickFairWinner({ items: [], members: [] }).winner, null);
});

test("pickFairWinner: ties are deterministic (rating, then shortlist order)", () => {
  const items = [item("movie_1", { vote_average: 7 }), item("movie_2", { vote_average: 8 }), item("movie_3", { vote_average: 8 })];
  const r = gp.pickFairWinner({ items, fits: {}, votes: {}, members: ["x", "y"] });
  assert.equal(r.winner.key, "movie_2");
  const r2 = gp.pickFairWinner({ items, fits: {}, votes: {}, members: ["x", "y"] });
  assert.deepEqual(r2.ranking, r.ranking);
});

test("pickFairWinner: everyone said no to everything still yields a winner", () => {
  const items = [item("movie_1"), item("movie_2")];
  const votes = { x: { movie_1: "no", movie_2: "no" }, y: { movie_1: "no", movie_2: "no" } };
  const r = gp.pickFairWinner({ items, fits: {}, votes, members: ["x", "y"] });
  assert.ok(r.winner);
  assert.equal(r.eligibility, "all");
});

test("votingProgress / shouldFinalize: offline and departed voters not waited for", () => {
  const items = [item("movie_1"), item("movie_2")];
  const session = {
    status: "voting",
    shortlist: items,
    voters: ["a", "b", "c"],
    votes: { a: { movie_1: "yes", movie_2: "no" }, b: { movie_1: "yes" } },
    votingEndsAt: 10_000,
  };
  const online = new Set(["a", "b"]);
  const all = ["a", "b", "c"];
  const p = gp.votingProgress({ items, votes: session.votes, voters: session.voters, onlineUids: online, roomMembers: all });
  assert.deepEqual(p.waitingOn, ["b"]);
  assert.equal(gp.shouldFinalize({ session, now: 0, onlineUids: online, roomMembers: all }).finalize, false);
  assert.equal(gp.shouldFinalize({ session, now: 10_000, onlineUids: online, roomMembers: all }).reason, "timeout");
  assert.equal(gp.shouldFinalize({ session, now: 0, onlineUids: online, roomMembers: ["a", "c"] }).reason, "all-voted");
  assert.equal(gp.canForceDecide(p), false);
});

/** A fake TMDB: 20 titles per request, plus one already-picked and one unreleased. */
const fakeTmdb = () => {
  const calls = [];
  let n = 100;
  const make = (type, genres) =>
    Array.from({ length: 20 }, () => {
      n += 1;
      const tv = type === "tv";
      return {
        id: n,
        poster_path: "/p.jpg",
        genre_ids: genres,
        popularity: 100 - (n % 50),
        vote_average: 7,
        [tv ? "first_air_date" : "release_date"]: "2015-01-01",
        [tv ? "name" : "title"]: `T${n}`,
      };
    });
  return {
    calls,
    get: async (path, params) => {
      calls.push({ path, params });
      const type = path.includes("/tv") ? "tv" : "movie";
      const results = make(type, type === "tv" ? [10765, 9648] : [878, 9648]);
      results.push({ id: 1, poster_path: "/p", genre_ids: [878], release_date: "2000-01-01", title: "own pick" });
      results.push({ id: 99999, poster_path: "/p", genre_ids: [878], release_date: "2999-01-01", title: "unreleased" });
      return { data: { results } };
    },
    enrich: async (pick) => prof({ [pick.id % 2 ? 878 : 53]: 1, 9648: 1 }),
  };
};

test("buildShortlist: movie mode, excludes picks/seen/unreleased, 12 items with groupFit", async () => {
  const t = fakeTmdb();
  const members = [mika, alex, sam];
  const groupTaste = gp.mergeGroupTaste(members);
  const r = await gp.buildShortlist({ groupTaste, members, mode: "movie", excludeKeys: new Set(["movie_101"]) }, t);
  assert.equal(r.items.length, 12);
  assert.ok(r.items.every((i) => i.media_type === "movie"));
  assert.ok(!r.items.some((i) => ["movie_1", "movie_99999", "movie_101"].includes(i.key)));
  assert.ok(r.items.every((i) => typeof i.groupFit === "number" && !("coarse" in i)));
  assert.ok(t.calls.every((c) => !c.path.includes("/tv")));
  assert.ok(t.calls.some((c) => c.path === "/movie/1/recommendations"));
});

test("buildShortlist: series discover uses TV genre ids, 'any' mixes types", async () => {
  const t = fakeTmdb();
  const members = [mika, alex];
  const r = await gp.buildShortlist({ groupTaste: gp.mergeGroupTaste(members), members, mode: "any" }, t);
  const tvDiscover = t.calls.find((c) => c.path === "/discover/tv");
  assert.ok(!tvDiscover.params.with_genres.split("|").includes("53"), "thriller has no TV genre");
  assert.ok(tvDiscover.params.with_genres.split("|").includes("10765"));
  assert.ok(r.items.filter((i) => i.media_type === "tv").length >= 3);
  assert.ok(r.items.filter((i) => i.media_type === "movie").length >= 3);
});

test("buildShortlist: nobody profiled falls back to trending", async () => {
  const t = fakeTmdb();
  const r = await gp.buildShortlist({ groupTaste: gp.mergeGroupTaste([nobody]), members: [nobody], mode: "movie" }, t);
  assert.ok(t.calls.every((c) => c.path.startsWith("/trending")));
  assert.ok(r.items.length > 0 && r.items.every((i) => i.groupFit === null));
});

test("copy helpers", () => {
  const it = item("movie_2", { title: "Arrival", year: "2016", genre_ids: [878] });
  const result = { method: "votes+fit", perMember: { m: { fit: 0.88, vote: "yes" }, s: { fit: 0.74, vote: "yes" } } };
  assert.equal(gp.chatSystemText(it, result), "Group Pick: Arrival (2016), 2 of 2 said yes");
  assert.match(
    gp.fallbackExplanation({ item: it, result, chips: [{ facet: "genres", label: "Sci-Fi" }] }),
    /Sci-Fi you all share, and nobody's below 74%/
  );
  assert.deepEqual(gp.toRoomMedia(it), { id: 2, media_type: "movie", title: "Arrival", poster_path: undefined });
});
