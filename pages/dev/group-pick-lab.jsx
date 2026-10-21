// pages/dev/group-pick-lab.jsx — Group Pick practice page (development only).
//
// Runs the whole Group Pick flow in one browser with the real logic, real
// taste profiles and real TMDB results, but keeps the session in memory
// instead of rooms/{id}/groupPick/current. Useful for testing and tuning
// without Firestore rules, and for watching how the winner is chosen.
//
// Limits compared with a real room: you vote for every member yourself, and
// only your own watch history is excluded (other people's is private).
import { useEffect, useMemo, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import toast from "react-hot-toast";
import { db } from "../../firebase";
import NavBar from "../../components/NavBar";
import Footer from "../../components/Footer";
import SwipeDeck from "../../components/SwipeDeck";
import { Results, TasteChips } from "../../components/GroupPickModal";
import { useAuth } from "../../lib/auth";
import { explainGroupPick, loadSeenKeys } from "../../lib/assistant";
import { fetchUserTaste } from "../../lib/tasteProfile";
import {
  explanationPayload,
  fallbackExplanation,
  gatherCandidates,
  mergeGroupTaste,
  pickFairWinner,
  seenKeyToItemKey,
  selectShortlist,
  votingProgress,
} from "../../lib/groupPick";

export const getStaticProps = () =>
  process.env.NODE_ENV === "production" ? { notFound: true } : { props: {} };

const MAX_MEMBERS = 4;
const MODES = [
  { value: "movie", label: "Movie" },
  { value: "tv", label: "Series" },
  { value: "any", label: "Either" },
];

const toMember = (uid, data) => ({
  uid,
  username: data?.username || "Anonymous",
  tasteProfile: data?.tasteProfile || null,
  tastePicks: data?.tastePicks || { movies: [], shows: [] },
});

const percent = (value) => (typeof value === "number" ? `${Math.round(value * 100)}%` : "–");

const GroupPickLab = () => {
  const { user, loading: authLoading } = useAuth();
  const [people, setPeople] = useState([]); // me + friends: [{ uid, username }]
  const [selected, setSelected] = useState([]);
  const [mode, setMode] = useState("movie");
  const [phase, setPhase] = useState("setup"); // setup | building | voting | done
  const [log, setLog] = useState([]);
  const [groupTaste, setGroupTaste] = useState(null);
  const [shortlist, setShortlist] = useState([]);
  const [fits, setFits] = useState({});
  const [votes, setVotes] = useState({});
  const [votingAs, setVotingAs] = useState(null);
  const [result, setResult] = useState(null);

  const say = (line) => setLog((prev) => [...prev, line]);

  // You and your friends are the people you can put in the pretend room.
  useEffect(() => {
    if (!user) return;
    (async () => {
      const friendsSnap = await getDoc(doc(db, "friends", user.uid)).catch(() => null);
      const uids = [user.uid, ...((friendsSnap?.exists() && friendsSnap.data().friends) || [])];
      const docs = await Promise.all(uids.map((uid) => getDoc(doc(db, "users", uid)).catch(() => null)));
      const list = uids.map((uid, index) => ({
        uid,
        username: docs[index]?.exists() ? docs[index].data().username || "Anonymous" : "Unknown",
      }));
      setPeople(list);
      setSelected([user.uid]);
    })();
  }, [user]);

  const usernames = useMemo(() => Object.fromEntries(people.map((p) => [p.uid, p.username])), [people]);
  const online = useMemo(() => new Set(selected), [selected]);

  const toggle = (uid) =>
    setSelected((prev) =>
      prev.includes(uid)
        ? prev.filter((id) => id !== uid || id === user.uid)
        : prev.length >= MAX_MEMBERS
        ? prev
        : [...prev, uid]
    );

  const reset = () => {
    setPhase("setup");
    setLog([]);
    setGroupTaste(null);
    setShortlist([]);
    setFits({});
    setVotes({});
    setResult(null);
  };

  // Same steps the host runs in a real room, minus Firestore.
  const build = async () => {
    reset();
    setPhase("building");
    try {
      const started = performance.now();
      const members = await Promise.all(
        selected.map((uid) => fetchUserTaste(uid).catch(() => null).then((data) => toMember(uid, data)))
      );
      const taste = mergeGroupTaste(members);
      setGroupTaste(taste);
      say(`Loaded ${members.length} taste profiles (${taste.profiled.length} with picks).`);

      const gathered = await gatherCandidates({ groupTaste: taste, members, mode });
      say(
        `TMDB gave ${gathered.candidates.length} enriched candidates` +
          (gathered.relaxed.length ? ` after relaxing: ${gathered.relaxed.join(", ")}.` : ".")
      );

      const candidateKeys = new Set(gathered.candidates.map((item) => item.key));
      const mySeen = (await loadSeenKeys(user.uid)).map(seenKeyToItemKey).filter((key) => candidateKeys.has(key));
      say(`You have already seen ${mySeen.length} of them; removed.`);

      const { items } = selectShortlist({
        candidates: gathered.candidates,
        fits: gathered.fits,
        excludeKeys: new Set(mySeen),
        mode,
      });
      if (!items.length) {
        say("Not enough titles left. Try “Either”.");
        setPhase("setup");
        return;
      }
      const keys = items.map((item) => item.key);
      setFits(
        Object.fromEntries(
          selected.map((uid) => [uid, Object.fromEntries(keys.map((key) => [key, gathered.fits[uid]?.[key] ?? null]))])
        )
      );
      setShortlist(items);
      setVotingAs(selected[0]);
      say(`Shortlist of ${items.length} ready in ${Math.round(performance.now() - started)} ms.`);
      setPhase("voting");
    } catch (error) {
      console.error("Group Pick lab:", error);
      say(`Failed: ${error.message}`);
      setPhase("setup");
    }
  };

  const vote = async (uid, key, value) =>
    setVotes((prev) => ({ ...prev, [uid]: { ...prev[uid], [key]: value } }));

  /** Fills in random votes for everyone except you, to test quickly. */
  const randomOthers = () =>
    setVotes((prev) => {
      const next = { ...prev };
      selected
        .filter((uid) => uid !== user.uid)
        .forEach((uid) => {
          next[uid] = Object.fromEntries(shortlist.map((item) => [item.key, Math.random() < 0.5 ? "yes" : "no"]));
        });
      return next;
    });

  const decide = async () => {
    const pick = pickFairWinner({ items: shortlist, fits, votes, members: selected });
    if (!pick.winner) return;
    const winnerRank = pick.ranking.find((entry) => entry.key === pick.winner.key);
    const base = {
      winnerKey: pick.winner.key,
      runnerUpKeys: pick.runnersUp.map((item) => item.key),
      method: pick.method,
      eligibility: pick.eligibility,
      reason: "host-forced",
      ranking: pick.ranking,
      perMember: winnerRank.perMember,
      explanation: null,
    };
    setResult(base);
    setPhase("done");
    const chips = groupTaste?.chips || [];
    try {
      const explanation = await explainGroupPick({
        user,
        payload: explanationPayload({ item: pick.winner, result: base, usernames, chips }),
      });
      setResult({ ...base, explanation });
    } catch (error) {
      say(`Cue unavailable (${error.message}); using the fallback line.`);
      setResult({ ...base, explanation: fallbackExplanation({ item: pick.winner, result: base, chips }) });
    }
  };

  const progress = votingProgress({ items: shortlist, votes, voters: selected, onlineUids: online, roomMembers: selected });

  if (authLoading) return <div className="min-h-screen bg-primary" />;

  return (
    <div className="min-h-screen bg-primary text-textprimary flex flex-col">
      <NavBar />
      <main className="flex-1 container mx-auto max-w-3xl space-y-6 p-4 pt-24 md:pt-28">
        <header className="space-y-2">
          <p className="section-label text-accent">Dev only</p>
          <h1 className="heading-lg">Group Pick lab</h1>
          <p className="text-sm text-textsecondary">
            The real Group Pick logic in one browser. The session stays in memory, so no Firestore rule is needed.
            You vote for everyone yourself.
          </p>
        </header>

        {!user ? (
          <p className="surface p-4 text-sm">Log in first: the lab reads real taste profiles.</p>
        ) : (
          <>
            {/* 1. Setup */}
            <section className="surface space-y-4 p-4">
              <p className="section-label">1 · Who is in the pretend room? (up to {MAX_MEMBERS})</p>
              <div className="flex flex-wrap gap-2">
                {people.map((person) => (
                  <button
                    key={person.uid}
                    type="button"
                    onClick={() => toggle(person.uid)}
                    className={`chip ${selected.includes(person.uid) ? "chip-active" : ""}`}
                  >
                    {person.username}
                    {person.uid === user.uid ? " (you)" : ""}
                  </button>
                ))}
                {people.length <= 1 && (
                  <span className="text-xs text-textsecondary">Add friends on the Buddies page to test a group.</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {MODES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setMode(option.value)}
                    className={`chip ${mode === option.value ? "chip-active" : ""}`}
                  >
                    {option.label}
                  </button>
                ))}
                <button type="button" onClick={build} disabled={phase === "building"} className="btn-primary ml-auto">
                  {phase === "building" ? "Building…" : phase === "setup" ? "Build shortlist" : "Start over"}
                </button>
              </div>
              {groupTaste && <TasteChips groupTaste={groupTaste} />}
              {log.length > 0 && (
                <ol className="list-decimal space-y-0.5 pl-5 text-xs text-textsecondary">
                  {log.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ol>
              )}
            </section>

            {/* 2. Voting */}
            {phase === "voting" && (
              <section className="surface space-y-4 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="section-label mr-1">2 · Voting as</p>
                  {selected.map((uid) => (
                    <button
                      key={uid}
                      type="button"
                      onClick={() => setVotingAs(uid)}
                      className={`chip ${votingAs === uid ? "chip-active" : ""}`}
                    >
                      {usernames[uid]}
                    </button>
                  ))}
                  {selected.length > 1 && (
                    <button type="button" onClick={randomOthers} className="chip">
                      Random votes for the others
                    </button>
                  )}
                  <button type="button" onClick={decide} className="btn-primary ml-auto">
                    Decide now
                  </button>
                </div>
                <SwipeDeck
                  key={votingAs}
                  items={shortlist}
                  myVotes={votes[votingAs] || {}}
                  onVote={(key, value) => vote(votingAs, key, value)}
                  voterStatus={Object.entries(progress.perVoter).map(([uid, status]) => ({
                    uid,
                    username: usernames[uid],
                    ...status,
                  }))}
                  waitingOnNames={progress.waitingOn.map((uid) => usernames[uid])}
                  solo={selected.length <= 1}
                />
              </section>
            )}

            {/* 3. Results + how it was decided */}
            {phase === "done" && result && (
              <>
                <section className="glass-card-elevated p-5">
                  <Results
                    session={{ result, shortlist }}
                    usernames={usernames}
                    isCreator
                    onPlay={() => toast.success("In a real room this loads the title for everyone.")}
                    onRunAgain={reset}
                    onClose={reset}
                    playing={false}
                  />
                </section>
                <section className="surface space-y-2 p-4">
                  <p className="section-label">How it was decided · top 5</p>
                  <p className="text-xs text-textsecondary">
                    Each person's satisfaction = 0.7 × vote (yes = 1, no = 0) + 0.3 × fit. Score = 0.6 × least happy +
                    0.4 × average. Eligible: {result.eligibility}. Method: {result.method}.
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs tabular-nums">
                      <thead className="text-textsecondary">
                        <tr>
                          <th className="py-1 pr-3">Title</th>
                          <th className="pr-3">Score</th>
                          <th className="pr-3">Least happy</th>
                          <th className="pr-3">Average</th>
                          <th className="pr-3">Yes</th>
                          <th>No</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.ranking.map((row) => (
                          <tr key={row.key} className="border-t border-white/[0.06]">
                            <td className="py-1 pr-3">
                              {shortlist.find((item) => item.key === row.key)?.title}
                              {row.key === result.winnerKey ? " 🏆" : ""}
                            </td>
                            <td className="pr-3">{row.score.toFixed(3)}</td>
                            <td className="pr-3">{percent(row.min)}</td>
                            <td className="pr-3">{percent(row.mean)}</td>
                            <td className="pr-3">{row.yes}</td>
                            <td>{row.no}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </>
            )}
          </>
        )}
      </main>
      <Footer />
    </div>
  );
};

export default GroupPickLab;
