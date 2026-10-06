// components/GroupPickModal.jsx — the Group Pick panel in a watch room.
//
// Every member renders the same live session document (the page owns the
// listener and passes it in as `session`). Screens follow its status:
// intro → building → voting → results.
//
// Exactly one member, the host, does the work: merging tastes, asking TMDB,
// publishing the shortlist and deciding the winner. That logic lives in
// useGroupPickHost below; everyone else only votes and renders. If the host
// disappears, another member takes over (claimHost).
import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { onValue, ref } from "firebase/database";
import toast from "react-hot-toast";
import { FaCheck, FaLayerGroup, FaTimes } from "react-icons/fa";
import { rtdb } from "../firebase";
import SwipeDeck from "./SwipeDeck";
import { explainGroupPick, loadSeenKeys } from "../lib/assistant";
import { fetchUserTaste } from "../lib/tasteProfile";
import { posterUrl } from "../lib/tmdb";
import {
  CHECK_TIMEOUT_MS,
  HOST_HEARTBEAT_MS,
  MIN_SHORTLIST,
  canForceDecide,
  chipText,
  explanationPayload,
  fallbackExplanation,
  fitPerMember,
  gatherCandidates,
  mergeGroupTaste,
  pickFairWinner,
  seenKeyToItemKey,
  selectShortlist,
  shouldFinalize,
  votingProgress,
} from "../lib/groupPick";
import {
  addLateVoter,
  cancelGroupPick,
  castVote,
  claimHost,
  extendVoting,
  finalizeGroupPick,
  heartbeat,
  isActive,
  isHostStale,
  patchExplanation,
  publishCandidates,
  publishGroupTaste,
  publishShortlist,
  registerParticipant,
  startGroupPick,
  submitSeenAmong,
} from "../lib/groupPickStore";

const MODES = [
  { value: "movie", label: "Movie" },
  { value: "tv", label: "Series" },
  { value: "any", label: "Either" },
];

const millisOf = (value) => (typeof value?.toMillis === "function" ? value.toMillis() : null);

const formatCountdown = (ms) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** Online uids in this room, from the presence nodes the page already writes. */
const useOnlineUids = (roomId) => {
  const [online, setOnline] = useState(() => new Set());
  useEffect(() => {
    if (!roomId) return undefined;
    return onValue(ref(rtdb, `roomPresence/${roomId}`), (snapshot) => {
      const next = new Set();
      snapshot.forEach((child) => {
        if (child.val()?.online) next.add(child.key);
      });
      setOnline(next);
    });
  }, [roomId]);
  return online;
};

/** A clock that ticks while `active`, for countdowns and timeout checks. */
const useNow = (active, interval = 1000) => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [active, interval]);
  return now;
};

const toMember = (uid, data) => ({
  uid,
  username: data?.username || "Anonymous",
  tasteProfile: data?.tasteProfile || null,
  tastePicks: data?.tastePicks || { movies: [], shows: [] },
});

const loadMembers = (uids) =>
  Promise.all(uids.map((uid) => fetchUserTaste(uid).catch(() => null).then((data) => toMember(uid, data))));

/**
 * Every client: join the session, answer the seen-check, and take over as
 * host if the current one has gone quiet.
 */
const useGroupPickMember = ({ roomId, session, me, username, now }) => {
  const registered = useRef(null);
  const checked = useRef(null);

  useEffect(() => {
    if (!isActive(session) || session.participants?.[me]) return;
    if (registered.current === session.sessionId) return;
    registered.current = session.sessionId;
    registerParticipant(roomId, me, username).catch((error) =>
      console.error("Group Pick: could not join:", error)
    );
  }, [roomId, session, me, username]);

  useEffect(() => {
    if (session?.status !== "building" || session.stage !== "checking") return;
    const mine = session.participants?.[me];
    if (!mine || mine.checkedAt || checked.current === session.sessionId) return;
    checked.current = session.sessionId;
    (async () => {
      const candidates = new Set(session.candidateKeys || []);
      const seen = (await loadSeenKeys(me)).map(seenKeyToItemKey).filter((key) => candidates.has(key));
      await submitSeenAmong(roomId, me, seen);
    })().catch((error) => console.error("Group Pick: seen-check failed:", error));
  }, [roomId, session, me]);

  useEffect(() => {
    if (!session || session.hostUid === me || !session.participants?.[me]) return;
    if (isHostStale(session, now)) {
      claimHost(roomId, me).catch((error) => console.error("Group Pick: takeover failed:", error));
    }
  }, [roomId, session, me, now]);
};

/**
 * Host only: drives the session from building to done.
 */
const useGroupPickHost = ({ roomId, session, me, currentUser, roomMembers, onlineUids, usernames, now }) => {
  const isHost = session?.hostUid === me && isActive(session);
  // What the host computed for this session; a takeover host starts empty.
  const cache = useRef({ sessionId: null });
  const steps = useRef(new Set());
  const checkStartedAt = useRef(null);

  const once = (step) => {
    const key = `${session.sessionId}:${step}`;
    if (steps.current.has(key)) return false;
    steps.current.add(key);
    return true;
  };

  const fail = (error, code = "error") => {
    console.error("Group Pick:", error);
    cancelGroupPick(roomId, code).catch(() => {});
  };

  const gather = async () => {
    // Online members may not have registered yet; include them so they get fits.
    const roster = [
      ...new Set([me, ...Object.keys(session.participants || {}), ...roomMembers.filter((uid) => onlineUids.has(uid))]),
    ].filter((uid) => roomMembers.includes(uid));
    const members = await loadMembers(roster);
    const groupTaste = mergeGroupTaste(members);
    const gathered = await gatherCandidates({ groupTaste, members, mode: session.mode });
    cache.current = { sessionId: session.sessionId, members, groupTaste, ...gathered };
    return cache.current;
  };

  // Heartbeat, so others can tell the host is still here.
  useEffect(() => {
    if (!isHost) return undefined;
    const timer = setInterval(() => heartbeat(roomId).catch(() => {}), HOST_HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [isHost, roomId]);

  // building / gathering → checking
  useEffect(() => {
    if (!isHost || session.status !== "building" || session.stage !== "gathering") return;
    if (!once("gather")) return;
    (async () => {
      const { groupTaste, candidates } = await gather();
      await publishGroupTaste(roomId, groupTaste);
      if (candidates.length < MIN_SHORTLIST) {
        await cancelGroupPick(roomId, "not-enough-titles");
        return;
      }
      await publishCandidates(roomId, candidates.map((item) => item.key));
    })().catch((error) => fail(error));
  });

  // building / checking → voting, once everyone online has answered (or time's up)
  useEffect(() => {
    if (!isHost || session.status !== "building" || session.stage !== "checking") return;
    if (checkStartedAt.current?.sessionId !== session.sessionId) {
      checkStartedAt.current = { sessionId: session.sessionId, at: Date.now() };
    }
    const participants = session.participants || {};
    const waiting = Object.entries(participants).filter(
      ([uid, entry]) => onlineUids.has(uid) && roomMembers.includes(uid) && !entry.checkedAt
    );
    const timedOut = now - checkStartedAt.current.at > CHECK_TIMEOUT_MS;
    if (waiting.length && !timedOut) return;
    if (!once("publish")) return;

    (async () => {
      const gathered = cache.current.sessionId === session.sessionId ? cache.current : await gather();
      const excludeKeys = new Set(Object.values(participants).flatMap((entry) => entry.seenAmong || []));
      const { items } = selectShortlist({
        candidates: gathered.candidates,
        fits: gathered.fits,
        excludeKeys,
        mode: session.mode,
      });
      if (items.length < MIN_SHORTLIST) {
        await cancelGroupPick(roomId, "not-enough-titles");
        return;
      }
      const voters = Object.keys(participants).filter((uid) => roomMembers.includes(uid));
      const keys = items.map((item) => item.key);
      // Only the shortlist's fits go into the shared doc.
      const fits = Object.fromEntries(
        voters.map((uid) => [
          uid,
          Object.fromEntries(keys.map((key) => [key, gathered.fits[uid]?.[key] ?? null])),
        ])
      );
      await publishShortlist(roomId, session.sessionId, { shortlist: items, fits, voters });
    })().catch((error) => fail(error));
  });

  // voting: let late joiners in, and decide when it's time
  const decide = (forced = false) => {
    const verdict = shouldFinalize({ session, now: Date.now(), onlineUids, roomMembers, forced });
    if (!verdict.finalize || !once("finalize")) return;
    (async () => {
      const members = (session.voters || []).filter((uid) => roomMembers.includes(uid));
      const pick = pickFairWinner({ items: session.shortlist, fits: session.fits, votes: session.votes, members });
      if (!pick.winner) {
        await cancelGroupPick(roomId, "not-enough-titles");
        return;
      }
      const winnerRank = pick.ranking.find((entry) => entry.key === pick.winner.key);
      const result = {
        winnerKey: pick.winner.key,
        runnerUpKeys: pick.runnersUp.map((item) => item.key),
        method: pick.method,
        eligibility: pick.eligibility,
        reason: verdict.reason,
        ranking: pick.ranking,
        perMember: winnerRank.perMember,
      };
      const decided = await finalizeGroupPick(roomId, session.sessionId, result);
      if (!decided) return;

      const chips = session.groupTaste?.chips || [];
      let explanation;
      let source = "cue";
      try {
        explanation = await explainGroupPick({
          user: currentUser,
          payload: explanationPayload({ item: pick.winner, result, usernames, chips, runnersUp: pick.runnersUp }),
        });
      } catch (error) {
        console.warn("Group Pick: Cue unavailable, using fallback line:", error.message);
        explanation = fallbackExplanation({ item: pick.winner, result, chips });
        source = "fallback";
      }
      await patchExplanation(roomId, explanation, source);
    })().catch((error) => fail(error));
  };

  useEffect(() => {
    if (!isHost || session.status !== "voting") return;

    Object.keys(session.participants || {})
      .filter((uid) => roomMembers.includes(uid) && !(session.voters || []).includes(uid))
      .forEach((uid) => {
        if (!once(`late:${uid}`)) return;
        (async () => {
          let fitsForUid = null;
          if (cache.current.sessionId === session.sessionId && cache.current.titleProfiles) {
            const [member] = await loadMembers([uid]);
            const all = fitPerMember({ [uid]: member.tasteProfile }, cache.current.titleProfiles)[uid];
            fitsForUid = Object.fromEntries(session.shortlist.map((item) => [item.key, all[item.key] ?? null]));
          }
          await addLateVoter(roomId, uid, fitsForUid);
        })().catch((error) => console.error("Group Pick: could not add late voter:", error));
      });

    decide(false);
  });

  return { isHost, decideNow: () => decide(true) };
};

// --- Screens -----------------------------------------------------------------

const Intro = ({ mode, setMode, onStart, starting, solo, error }) => (
  <div className="space-y-5">
    <p className="text-sm text-textsecondary">
      {solo
        ? "Swipe through 12 titles picked for your taste. We'll pick the best one."
        : "Everyone swipes the same 12 titles. We'll pick the one nobody minds, and quietly skip anything you've already watched."}
    </p>
    {error === "not-enough-titles" && (
      <p className="text-sm text-red-400">
        Not enough unwatched titles came back last time. Try "Either" for films and series together.
      </p>
    )}
    <div>
      <p className="section-label mb-2">What are we watching?</p>
      <div className="flex gap-2">
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
      </div>
    </div>
    <button type="button" onClick={onStart} disabled={starting} className="btn-primary w-full">
      {starting ? "Starting…" : solo ? "Start Solo Pick" : "Start Group Pick"}
    </button>
  </div>
);

const TasteChips = ({ groupTaste }) => {
  if (!groupTaste) return null;
  if (!groupTaste.chips?.length) {
    return (
      <p className="text-sm text-textsecondary">
        {groupTaste.profiled?.length
          ? "Your tastes don't overlap much, so we'll look wide."
          : "No one has taste picks yet, so we'll pick from what's popular. Add yours on your profile."}
      </p>
    );
  }
  return (
    <div>
      <p className="section-label mb-2">What you share</p>
      <div className="flex flex-wrap gap-1.5">
        {groupTaste.chips.map((chip) => (
          <span
            key={`${chip.facet}:${chip.key}`}
            className={`chip text-xs ${chip.count === chip.total && chip.total > 1 ? "chip-active" : ""}`}
          >
            {chipText(chip)}
          </span>
        ))}
      </div>
    </div>
  );
};

const Building = ({ session, canCancel, onCancel }) => (
  <div className="space-y-5">
    <TasteChips groupTaste={session.groupTaste} />
    <p className="text-sm text-textsecondary">
      {session.stage === "checking" ? "Checking what you've already seen…" : "Reading everyone's taste and finding titles…"}
    </p>
    <div className="grid grid-cols-3 gap-3">
      {[0, 1, 2].map((index) => (
        <div key={index} className="skeleton aspect-[2/3]" />
      ))}
    </div>
    {canCancel && (
      <button type="button" onClick={onCancel} className="btn-ghost w-full text-sm">
        Cancel
      </button>
    )}
  </div>
);

const fitBarClass = (fit) =>
  fit >= 0.6 ? "bg-accent" : fit >= 0.35 ? "bg-accent-secondary" : "bg-textsecondary/50";

const Results = ({ session, usernames, isCreator, creatorName, onPlay, onRunAgain, onClose, playing }) => {
  const { result, shortlist = [] } = session;
  const winner = shortlist.find((item) => item.key === result?.winnerKey);
  if (!winner) return null;
  const runnersUp = (result.runnerUpKeys || [])
    .map((key) => shortlist.find((item) => item.key === key))
    .filter(Boolean);
  const perMember = Object.entries(result.perMember || {});
  const yes = perMember.filter(([, entry]) => entry.vote === "yes").length;
  const rankingOf = (key) => (result.ranking || []).find((entry) => entry.key === key);

  return (
    <div className="space-y-5">
      <p className="section-label text-accent">
        {result.method === "fit-only"
          ? "Nobody voted, so this was picked on taste"
          : `Tonight's pick · ${yes} of ${perMember.length} said yes`}
      </p>
      <div className="flex gap-4">
        {winner.poster_path && (
          <img
            src={posterUrl(winner.poster_path)}
            alt=""
            className="aspect-[2/3] w-24 shrink-0 rounded-xl object-cover shadow-lift"
          />
        )}
        <div className="min-w-0 flex-1 space-y-2">
          <h3 className="font-dm-display text-2xl leading-tight text-textprimary">{winner.title}</h3>
          <p className="text-xs text-textsecondary">
            {[winner.year, winner.media_type === "tv" ? "Series" : "Film"].filter(Boolean).join(" · ")}
          </p>
          <ul className="space-y-1.5">
            {perMember.map(([uid, entry], index) => (
              <li
                key={uid}
                className="grid animate-fade-up grid-cols-[72px_1fr_36px_14px] items-center gap-2 text-xs"
                style={{ animationDelay: `${index * 60}ms` }}
              >
                <span className="truncate text-textsecondary">{usernames[uid] || "Someone"}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                  {typeof entry.fit === "number" && (
                    <span
                      className={`block h-full rounded-full ${fitBarClass(entry.fit)}`}
                      style={{ width: `${Math.round(entry.fit * 100)}%` }}
                    />
                  )}
                </span>
                <span className="text-right tabular-nums text-textsecondary">
                  {typeof entry.fit === "number" ? `${Math.round(entry.fit * 100)}%` : "–"}
                </span>
                <span aria-label={entry.vote || "no vote"}>
                  {entry.vote === "yes" && <FaCheck className="text-accent" />}
                  {entry.vote === "no" && <FaTimes className="text-red-400" />}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="rounded-r-lg border-l-2 border-accent bg-accent/10 px-3 py-2">
        <p className="section-label text-accent">Cue</p>
        {result.explanation ? (
          <p className="text-sm italic text-textprimary">{result.explanation}</p>
        ) : (
          <div className="skeleton mt-1 h-4 w-4/5" />
        )}
      </div>

      {runnersUp.length > 0 && (
        <div>
          <p className="section-label mb-1">Runners-up</p>
          <ul className="divide-y divide-white/[0.06] text-sm">
            {runnersUp.map((item) => {
              const rank = rankingOf(item.key);
              return (
                <li key={item.key} className="flex justify-between gap-3 py-1.5">
                  <span className="truncate text-textprimary">{item.title}</span>
                  {rank && (
                    <span className="shrink-0 tabular-nums text-textsecondary">
                      {rank.yes} yes{rank.min !== null ? ` · lowest ${Math.round(rank.min * 100)}%` : ""}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {isCreator ? (
          <button type="button" onClick={() => onPlay(winner, result)} disabled={playing} className="btn-primary flex-1">
            {playing ? "Loading…" : "Play in this room"}
          </button>
        ) : (
          <p className="flex-1 self-center text-sm text-textsecondary">
            Waiting for {creatorName || "the room creator"} to hit play.
          </p>
        )}
        <button type="button" onClick={onRunAgain} className="btn-ghost">
          Run again
        </button>
        <button type="button" onClick={onClose} className="btn-ghost">
          Close
        </button>
      </div>
    </div>
  );
};

// --- Modal -------------------------------------------------------------------

/**
 * @param {{ roomId: string, room: object, members: Array<{uid, username}>,
 *           session: object|null, currentUser: object, open: boolean,
 *           onClose: () => void, onPlay: (item, result) => Promise<boolean> }} props
 */
const GroupPickModal = ({ roomId, room, members, session, currentUser, open, onClose, onPlay }) => {
  const me = currentUser.uid;
  const roomMembers = useMemo(
    () => [...new Set([...(room?.members || []), room?.createdBy].filter(Boolean))],
    [room?.members, room?.createdBy]
  );
  const usernames = useMemo(() => {
    const names = Object.fromEntries(members.map((member) => [member.uid, member.username]));
    Object.entries(session?.participants || {}).forEach(([uid, entry]) => {
      if (!names[uid]) names[uid] = entry.username;
    });
    return names;
  }, [members, session?.participants]);
  const myName = usernames[me] || currentUser.displayName || "Anonymous";

  const [mode, setMode] = useState("movie");
  const [starting, setStarting] = useState(false);
  const [playing, setPlaying] = useState(false);
  // "Run again" shows the intro over a finished session until a new one starts.
  const [introOver, setIntroOver] = useState(null);

  const onlineUids = useOnlineUids(roomId);
  const now = useNow(isActive(session));

  useGroupPickMember({ roomId, session, me, username: myName, now });
  const { isHost, decideNow } = useGroupPickHost({
    roomId,
    session,
    me,
    currentUser,
    roomMembers,
    onlineUids,
    usernames,
    now,
  });

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const isCreator = room?.createdBy === me;
  const solo = roomMembers.length <= 1;

  const showIntro =
    !session ||
    session.status === "cancelled" ||
    (session.status === "done" && (session.playedAt || introOver === session.sessionId));

  const start = async () => {
    setStarting(true);
    try {
      const { started } = await startGroupPick({ roomId, uid: me, username: myName, mode });
      if (!started) toast("A Group Pick is already running. Joining it.");
      setIntroOver(null);
    } catch (error) {
      console.error("Group Pick: could not start:", error);
      toast.error("Couldn't start Group Pick. Check your connection and try again.");
    } finally {
      setStarting(false);
    }
  };

  const play = async (item, result) => {
    setPlaying(true);
    try {
      await onPlay(item, result);
    } finally {
      setPlaying(false);
    }
  };

  const progress =
    session?.status === "voting"
      ? votingProgress({
          items: session.shortlist,
          votes: session.votes,
          voters: session.voters,
          onlineUids,
          roomMembers,
        })
      : null;
  const endsAt = millisOf(session?.votingEndsAt);

  let body;
  if (showIntro) {
    body = (
      <Intro
        mode={mode}
        setMode={setMode}
        onStart={start}
        starting={starting}
        solo={solo}
        error={session?.status === "cancelled" ? session.error : null}
      />
    );
  } else if (session.status === "building") {
    body = (
      <Building
        session={session}
        canCancel={isHost || isCreator}
        onCancel={() => cancelGroupPick(roomId).catch(() => {})}
      />
    );
  } else if (session.status === "voting") {
    body = (
      <div className="space-y-4">
        <div className="flex items-center justify-between text-xs text-textsecondary">
          <span>{endsAt ? `${formatCountdown(endsAt - now)} left` : ""}</span>
          {isHost && (
            <span className="flex gap-2">
              <button type="button" onClick={() => extendVoting(roomId, session).catch(() => {})} className="chip">
                +1 min
              </button>
              {!solo && canForceDecide(progress) && (
                <button type="button" onClick={decideNow} className="chip chip-active">
                  Decide now
                </button>
              )}
            </span>
          )}
        </div>
        <SwipeDeck
          items={session.shortlist || []}
          myVotes={session.votes?.[me] || {}}
          onVote={(key, value) => castVote(roomId, me, key, value)}
          voterStatus={Object.entries(progress.perVoter).map(([uid, status]) => ({
            uid,
            username: usernames[uid] || "Someone",
            ...status,
          }))}
          waitingOnNames={progress.waitingOn.filter((uid) => uid !== me).map((uid) => usernames[uid] || "someone")}
          solo={solo}
        />
      </div>
    );
  } else {
    body = (
      <Results
        session={session}
        usernames={usernames}
        isCreator={isCreator}
        creatorName={usernames[room?.createdBy] || room?.createdByUsername}
        onPlay={play}
        onRunAgain={() => setIntroOver(session.sessionId)}
        onClose={onClose}
        playing={playing}
      />
    );
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
          onClick={onClose}
        >
          <motion.div
            initial={{ scale: 0.95, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.95, y: 20 }}
            transition={{ type: "spring", damping: 15, stiffness: 200 }}
            className="glass-card-elevated custom-scrollbar max-h-[90vh] w-full max-w-lg overflow-y-auto p-5 md:p-6"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="group-pick-title"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <p className="section-label flex items-center gap-1.5 text-accent">
                  <FaLayerGroup /> {solo ? "Solo Pick" : "Group Pick"}
                </p>
                <h2 id="group-pick-title" className="heading-lg mt-1">
                  {showIntro
                    ? "Can't decide? Swipe on it."
                    : session.status === "building"
                    ? "Reading your group's taste"
                    : session.status === "voting"
                    ? "Yes or pass?"
                    : "We have a winner"}
                </h2>
              </div>
              <button type="button" onClick={onClose} className="btn-icon shrink-0" aria-label="Close">
                <FaTimes />
              </button>
            </div>
            {body}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default GroupPickModal;
