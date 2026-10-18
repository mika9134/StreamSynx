// components/SwipeDeck.jsx — the shared Group Pick card stack.
//
// Every member sees the same cards; swiping right (or Yes / →) votes yes,
// left (or Pass / ←) votes no. Votes are optimistic: the card leaves at once
// and comes back only if the write fails. Cards already voted on are skipped,
// so a refresh resumes where you left off.
import { useEffect, useMemo, useState } from "react";
import { animate, motion, useMotionValue, useTransform } from "framer-motion";
import { useSwipeable } from "react-swipeable";
import toast from "react-hot-toast";
import { FaCheck, FaStar, FaTimes } from "react-icons/fa";
import { MatchRing } from "./BuddyMatchCard";
import { genreNames, posterUrl } from "../lib/tmdb";

const COMMIT_DISTANCE = 110;
const COMMIT_VELOCITY = 0.5;
const EASE_OUT_EXPO = [0.16, 1, 0.3, 1];

const CardFace = ({ item }) => {
  const percent = typeof item.groupFit === "number" ? Math.round(item.groupFit * 100) : null;
  return (
    <>
      {item.poster_path ? (
        <img
          src={posterUrl(item.poster_path)}
          alt=""
          draggable={false}
          className="absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <div className="absolute inset-0 bg-secondary" />
      )}
      <div className="absolute inset-0 bg-gradient-to-t from-primary via-primary/60 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 space-y-2 p-4">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-xl font-semibold leading-tight text-textprimary">{item.title}</h3>
            <p className="mt-0.5 flex items-center gap-2 text-xs text-textsecondary">
              {item.year && <span>{item.year}</span>}
              <span className="chip px-2 py-0.5 text-[10px]">{item.media_type === "tv" ? "Series" : "Film"}</span>
              {item.vote_average > 0 && (
                <span className="flex items-center gap-1">
                  <FaStar className="text-accent" /> {item.vote_average.toFixed(1)}
                </span>
              )}
            </p>
          </div>
          {percent !== null && (
            <div className="flex flex-col items-center gap-0.5">
              <MatchRing percent={percent} size={44} />
              <span className="text-[10px] text-textsecondary">Fits the group</span>
            </div>
          )}
        </div>
        <p className="text-xs text-textsecondary">{genreNames(item, 3).join(" · ")}</p>
        {item.overview && <p className="line-clamp-3 text-xs text-textprimary/80">{item.overview}</p>}
      </div>
    </>
  );
};

/** The draggable top card plus its buttons and keyboard shortcuts. */
const TopCard = ({ item, onCommit, disabled }) => {
  const x = useMotionValue(0);
  const rotate = useTransform(x, [-200, 200], [-12, 12]);
  const yesOpacity = useTransform(x, [20, COMMIT_DISTANCE], [0, 1]);
  const noOpacity = useTransform(x, [-COMMIT_DISTANCE, -20], [1, 0]);
  const [leaving, setLeaving] = useState(false);

  const commit = async (value) => {
    if (leaving || disabled) return;
    setLeaving(true);
    await animate(x, value === "yes" ? 600 : -600, { duration: 0.35, ease: EASE_OUT_EXPO });
    onCommit(value);
  };

  const snapBack = () => animate(x, 0, { type: "spring", stiffness: 300, damping: 25 });

  const handlers = useSwipeable({
    onSwiping: ({ deltaX }) => !leaving && !disabled && x.set(deltaX),
    onSwiped: ({ deltaX, velocity }) => {
      const far = Math.abs(deltaX) > COMMIT_DISTANCE;
      const flicked = velocity > COMMIT_VELOCITY && Math.abs(deltaX) > 30;
      if (far || flicked) commit(deltaX > 0 ? "yes" : "no");
      else snapBack();
    },
    trackMouse: true,
    preventScrollOnSwipe: true,
    delta: 5,
  });

  useEffect(() => {
    const onKey = (event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      if (event.key === "ArrowRight") commit("yes");
      if (event.key === "ArrowLeft") commit("no");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <>
      <motion.div
        {...handlers}
        style={{ x, rotate }}
        className="surface shadow-lift absolute inset-0 cursor-grab touch-pan-y select-none overflow-hidden active:cursor-grabbing"
        aria-label={`${item.title}. Swipe right for yes, left to pass.`}
      >
        <CardFace item={item} />
        <motion.span
          style={{ opacity: yesOpacity }}
          className="absolute left-4 top-4 -rotate-12 rounded-lg border-2 border-accent px-3 py-1 text-lg font-bold text-accent"
        >
          YES
        </motion.span>
        <motion.span
          style={{ opacity: noOpacity }}
          className="absolute right-4 top-4 rotate-12 rounded-lg border-2 border-red-400 px-3 py-1 text-lg font-bold text-red-400"
        >
          PASS
        </motion.span>
      </motion.div>
      <div className="absolute -bottom-16 left-0 right-0 flex justify-center gap-6">
        <button
          type="button"
          onClick={() => commit("no")}
          disabled={disabled || leaving}
          className="btn-icon h-12 w-12 text-lg text-red-400"
          aria-label="Pass"
        >
          <FaTimes />
        </button>
        <button
          type="button"
          onClick={() => commit("yes")}
          disabled={disabled || leaving}
          className="btn-primary h-12 w-12 rounded-full p-0 text-lg"
          aria-label="Yes"
        >
          <FaCheck />
        </button>
      </div>
    </>
  );
};

const VoterStrip = ({ voterStatus }) => (
  <div className="flex flex-wrap justify-center gap-1.5">
    {voterStatus.map((voter) => (
      <span
        key={voter.uid}
        className={`chip text-[11px] ${voter.done ? "chip-active" : ""} ${voter.online ? "" : "opacity-40"}`}
        title={voter.online ? undefined : "Offline"}
      >
        {voter.username}
        <span className="tabular-nums">
          {voter.done ? "done" : `${voter.count}/${voter.total}`}
        </span>
      </span>
    ))}
  </div>
);

/**
 * @param {{ items: Array<object>, myVotes: Record<string,'yes'|'no'>,
 *           onVote: (key:string, value:'yes'|'no') => Promise<void>,
 *           voterStatus: Array<{uid, username, count, total, done, online}>,
 *           waitingOnNames?: string[], solo?: boolean, disabled?: boolean }} props
 */
const SwipeDeck = ({ items, myVotes = {}, onVote, voterStatus = [], waitingOnNames = [], solo = false, disabled = false }) => {
  const [pending, setPending] = useState({});

  const remaining = useMemo(
    () => items.filter((item) => !myVotes[item.key] && !pending[item.key]),
    [items, myVotes, pending]
  );
  const votedCount = items.length - remaining.length;

  const handleCommit = (item) => async (value) => {
    setPending((prev) => ({ ...prev, [item.key]: value }));
    try {
      await onVote(item.key, value);
    } catch (error) {
      console.error("Group Pick vote failed:", error);
      toast.error("Your vote didn't save. Try that card again.");
    } finally {
      // Either the live doc now has the vote, or the card should come back.
      setPending(({ [item.key]: _, ...rest }) => rest);
    }
  };

  const [top, ...behind] = remaining;

  return (
    <div className="flex flex-col items-center gap-4">
      {!solo && voterStatus.length > 0 && <VoterStrip voterStatus={voterStatus} />}
      <p className="text-xs tabular-nums text-textsecondary">
        {top ? `Card ${votedCount + 1} of ${items.length}` : `${items.length} of ${items.length} voted`}
      </p>

      {top ? (
        // data-arrow-keys tells TvRemoteNavigation to leave ← / → to the deck.
        <div className="relative mb-16 aspect-[2/3] w-full max-w-[280px]" data-arrow-keys="swipe">
          {behind.slice(0, 2).reverse().map((item, index, list) => {
            const depth = list.length - index;
            return (
              <div
                key={item.key}
                className="surface absolute inset-0 overflow-hidden"
                style={{ transform: `translateY(${depth * 8}px) scale(${1 - depth * 0.04})`, opacity: 1 - depth * 0.25 }}
                aria-hidden="true"
              >
                <CardFace item={item} />
              </div>
            );
          })}
          <TopCard key={top.key} item={top} onCommit={handleCommit(top)} disabled={disabled} />
        </div>
      ) : (
        <div className="surface w-full max-w-[280px] p-6 text-center">
          <p className="font-semibold text-textprimary">You're done.</p>
          <p className="mt-1 text-sm text-textsecondary">
            {solo || !waitingOnNames.length
              ? "Picking the winner…"
              : `Waiting on ${waitingOnNames.join(", ")}…`}
          </p>
        </div>
      )}
    </div>
  );
};

export default SwipeDeck;
