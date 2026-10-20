// lib/groupPickStore.js — Firestore I/O for Group Pick.
//
// One live session per room at rooms/{roomId}/groupPick/current. The host (the
// member who started it, or whoever takes over if they drop) writes the
// shortlist and the result; every member writes only their own entry under
// `participants` and `votes`. Status changes that could race go through
// transactions so two clients can never both publish or both decide.
//
// The maths lives in lib/groupPick.js; this file only moves data.
import {
  Timestamp,
  arrayUnion,
  doc,
  runTransaction,
  serverTimestamp,
  updateDoc,
} from "firebase/firestore";
import { db } from "../firebase";
import { HOST_STALE_MS, VOTING_TIMEOUT_MS } from "./groupPick";
import { serverNow } from "./serverClock";

export const ACTIVE_STATUSES = ["building", "voting"];

export const groupPickRef = (roomId) => doc(db, "rooms", roomId, "groupPick", "current");

export const isActive = (session) => ACTIVE_STATUSES.includes(session?.status);

const millisOf = (value) => (typeof value?.toMillis === "function" ? value.toMillis() : 0);

/** True when the host has not sent a heartbeat for HOST_STALE_MS. */
export const isHostStale = (session, now = serverNow()) =>
  isActive(session) && now - millisOf(session.hostSeenAt) > HOST_STALE_MS;

const newSessionId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * Starts a session, overwriting any finished one (which wipes old votes).
 * If one is already running with a live host, nothing is written and the
 * caller just joins it.
 *
 * @returns {Promise<{ started: boolean, sessionId: string }>}
 */
export const startGroupPick = ({ roomId, uid, username, mode }) =>
  runTransaction(db, async (tx) => {
    const ref = groupPickRef(roomId);
    const snap = await tx.get(ref);
    const current = snap.exists() ? snap.data() : null;
    if (isActive(current) && !isHostStale(current)) {
      return { started: false, sessionId: current.sessionId };
    }

    const sessionId = newSessionId();
    tx.set(ref, {
      sessionId,
      status: "building",
      stage: "gathering",
      mode: ["movie", "tv", "any"].includes(mode) ? mode : "movie",
      startedBy: uid,
      hostUid: uid,
      hostSeenAt: serverTimestamp(),
      startedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      error: null,
      groupTaste: null,
      candidateKeys: [],
      participants: {
        [uid]: { username: username || "Anonymous", joinedAt: serverTimestamp(), seenAmong: [], checkedAt: null },
      },
      votes: {},
      shortlist: [],
      fits: {},
      voters: [],
      votingEndsAt: null,
      result: null,
      playedAt: null,
      playedBy: null,
    });
    return { started: true, sessionId };
  });

// --- Member self-writes ------------------------------------------------------

export const registerParticipant = (roomId, uid, username) =>
  updateDoc(groupPickRef(roomId), {
    [`participants.${uid}`]: {
      username: username || "Anonymous",
      joinedAt: serverTimestamp(),
      seenAmong: [],
      checkedAt: null,
    },
    updatedAt: serverTimestamp(),
  });

/** Which of the candidates this member has already seen; nothing more. */
export const submitSeenAmong = (roomId, uid, keys) =>
  updateDoc(groupPickRef(roomId), {
    [`participants.${uid}.seenAmong`]: keys,
    [`participants.${uid}.checkedAt`]: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

/** One write per swipe. */
export const castVote = (roomId, uid, key, value) =>
  updateDoc(groupPickRef(roomId), {
    [`votes.${uid}.${key}`]: value === "yes" ? "yes" : "no",
    updatedAt: serverTimestamp(),
  });

// --- Host writes -------------------------------------------------------------

export const heartbeat = (roomId) =>
  updateDoc(groupPickRef(roomId), { hostSeenAt: serverTimestamp() });

export const publishGroupTaste = (roomId, groupTaste) =>
  updateDoc(groupPickRef(roomId), {
    groupTaste: {
      chips: groupTaste.chips,
      profiled: groupTaste.profiled,
      unprofiled: groupTaste.unprofiled,
    },
    updatedAt: serverTimestamp(),
  });

/** Moves to the seen-check: members answer which of these they have seen. */
export const publishCandidates = (roomId, candidateKeys) =>
  updateDoc(groupPickRef(roomId), {
    stage: "checking",
    candidateKeys,
    updatedAt: serverTimestamp(),
  });

/** building → voting, only for the session it was computed for. */
export const publishShortlist = (roomId, sessionId, { shortlist, fits, voters }) =>
  runTransaction(db, async (tx) => {
    const ref = groupPickRef(roomId);
    const snap = await tx.get(ref);
    const current = snap.data();
    if (current?.sessionId !== sessionId || current.status !== "building") return false;
    tx.update(ref, {
      status: "voting",
      stage: null,
      shortlist,
      fits,
      voters,
      votingEndsAt: Timestamp.fromMillis(serverNow() + VOTING_TIMEOUT_MS),
      updatedAt: serverTimestamp(),
    });
    return true;
  });

/** Someone joined after the shortlist went out: let them vote too. */
export const addLateVoter = (roomId, uid, fitsForUid) =>
  updateDoc(groupPickRef(roomId), {
    voters: arrayUnion(uid),
    ...(fitsForUid ? { [`fits.${uid}`]: fitsForUid } : {}),
    updatedAt: serverTimestamp(),
  });

export const extendVoting = (roomId, session, extraMs = 60_000) =>
  updateDoc(groupPickRef(roomId), {
    votingEndsAt: Timestamp.fromMillis(Math.max(serverNow(), millisOf(session.votingEndsAt)) + extraMs),
    updatedAt: serverTimestamp(),
  });

/** voting → done. Only one writer can win. */
export const finalizeGroupPick = (roomId, sessionId, result) =>
  runTransaction(db, async (tx) => {
    const ref = groupPickRef(roomId);
    const snap = await tx.get(ref);
    const current = snap.data();
    if (current?.sessionId !== sessionId || current.status !== "voting") return false;
    tx.update(ref, {
      status: "done",
      result: { ...result, explanation: null, explanationSource: null, decidedAt: serverTimestamp() },
      updatedAt: serverTimestamp(),
    });
    return true;
  });

export const patchExplanation = (roomId, explanation, source) =>
  updateDoc(groupPickRef(roomId), {
    "result.explanation": explanation,
    "result.explanationSource": source,
    updatedAt: serverTimestamp(),
  });

export const cancelGroupPick = (roomId, error = null) =>
  updateDoc(groupPickRef(roomId), {
    status: "cancelled",
    error,
    updatedAt: serverTimestamp(),
  });

/** Set by the room creator once the winner is loaded into the player. */
export const markPlayed = (roomId, uid) =>
  updateDoc(groupPickRef(roomId), {
    playedAt: serverTimestamp(),
    playedBy: uid,
    updatedAt: serverTimestamp(),
  });

/** Takes over as host if the current one has gone quiet. */
export const claimHost = (roomId, uid) =>
  runTransaction(db, async (tx) => {
    const ref = groupPickRef(roomId);
    const snap = await tx.get(ref);
    const current = snap.data();
    if (!isHostStale(current) || current.hostUid === uid) return false;
    tx.update(ref, { hostUid: uid, hostSeenAt: serverTimestamp(), updatedAt: serverTimestamp() });
    return true;
  });
