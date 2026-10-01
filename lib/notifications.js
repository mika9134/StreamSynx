// lib/notifications.js — the bell in the account menu.
//
// Nothing new is written when someone sends a request or adds you to a watch
// party: notifications are derived live from documents the app already keeps
// (`friendRequests`, `rooms`). The only extra state is which of those you have
// already seen, stored as `notificationsSeen` on your own user document so the
// badge clears on every device at once.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { collection, doc, getDoc, onSnapshot, query, setDoc, where } from "firebase/firestore";
import { db } from "../firebase";

const toMillis = (value) => {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
};

// Who sent / accepted / invited. Usernames rarely change, so one read per
// person per session.
const profileCache = new Map();
const fetchProfile = (uid) => {
  if (!profileCache.has(uid)) {
    profileCache.set(
      uid,
      getDoc(doc(db, "users", uid))
        .then((snap) => {
          const data = snap.exists() ? snap.data() : {};
          return { uid, username: data.username || null, avatar: data.avatar || null };
        })
        .catch(() => ({ uid, username: null, avatar: null }))
    );
  }
  return profileCache.get(uid);
};

// A re-sent request gets a fresh createdAt, so it reads as new even if the
// previous one with the same document id was already seen.
const requestItems = (snapshot, type, otherField) =>
  snapshot.docs.map((docSnap) => {
    const data = docSnap.data();
    const at = toMillis(data.createdAt);
    return { key: `${type}:${docSnap.id}:${at}`, type, otherUid: data[otherField], at };
  });

/**
 * Live notifications for `uid`:
 *  - `request`  — someone wants to be your buddy (pending, actionable)
 *  - `accepted` — someone accepted a request you sent
 *  - `room`     — someone added you to their watch party
 */
export const useNotifications = (uid) => {
  const [incoming, setIncoming] = useState(null);
  const [accepted, setAccepted] = useState(null);
  const [rooms, setRooms] = useState(null);
  // undefined = still loading, null = this account has never stored a seen list.
  const [seen, setSeen] = useState(undefined);
  const [profiles, setProfiles] = useState({});
  const seededRef = useRef(false);

  useEffect(() => {
    setIncoming(null);
    setAccepted(null);
    setRooms(null);
    setSeen(undefined);
    seededRef.current = false;
    if (!uid) return undefined;

    const fail = (setter, empty) => (error) => {
      console.error("Notifications listener failed:", error);
      setter(empty);
    };

    const unsubscribers = [
      onSnapshot(
        query(
          collection(db, "friendRequests"),
          where("toUserId", "==", uid),
          where("status", "==", "pending")
        ),
        (snapshot) => setIncoming(requestItems(snapshot, "request", "fromUserId")),
        fail(setIncoming, [])
      ),
      onSnapshot(
        query(
          collection(db, "friendRequests"),
          where("fromUserId", "==", uid),
          where("status", "==", "accepted")
        ),
        (snapshot) => setAccepted(requestItems(snapshot, "accepted", "toUserId")),
        fail(setAccepted, [])
      ),
      onSnapshot(
        query(collection(db, "rooms"), where("members", "array-contains", uid)),
        (snapshot) =>
          setRooms(
            snapshot.docs
              .map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }))
              .filter((room) => room.createdBy && room.createdBy !== uid)
              .map((room) => ({
                key: `room:${room.id}`,
                type: "room",
                otherUid: room.createdBy,
                roomId: room.id,
                roomName: room.name || "a watch party",
                at: toMillis(room.createdAt),
              }))
          ),
        fail(setRooms, [])
      ),
      onSnapshot(
        doc(db, "users", uid),
        (snapshot) => {
          const list = snapshot.exists() ? snapshot.data().notificationsSeen : undefined;
          setSeen(Array.isArray(list) ? new Set(list) : null);
        },
        fail(setSeen, new Set())
      ),
    ];

    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [uid]);

  const ready = incoming !== null && accepted !== null && rooms !== null && seen !== undefined;

  const rawItems = useMemo(
    () =>
      ready ? [...incoming, ...accepted, ...rooms].sort((a, b) => b.at - a.at) : [],
    [ready, incoming, accepted, rooms]
  );

  // First run on an account: everything that already happened is history, not
  // news. Only pending requests stay unread, because they still need an answer.
  useEffect(() => {
    if (!ready || seen !== null || seededRef.current) return;
    seededRef.current = true;
    const history = rawItems.filter((item) => item.type !== "request").map((item) => item.key);
    setDoc(doc(db, "users", uid), { notificationsSeen: history }, { merge: true }).catch((error) =>
      console.error("Could not initialise notifications:", error)
    );
  }, [ready, seen, rawItems, uid]);

  useEffect(() => {
    const missing = [...new Set(rawItems.map((item) => item.otherUid))].filter(
      (other) => other && !profiles[other]
    );
    if (!missing.length) return undefined;
    let active = true;
    Promise.all(missing.map(fetchProfile)).then((loaded) => {
      if (!active) return;
      setProfiles((previous) => {
        const next = { ...previous };
        loaded.forEach((profile) => {
          next[profile.uid] = profile;
        });
        return next;
      });
    });
    return () => {
      active = false;
    };
  }, [rawItems, profiles]);

  const items = useMemo(
    () => rawItems.map((item) => ({ ...item, from: profiles[item.otherUid] || null })),
    [rawItems, profiles]
  );

  const unreadKeys = useMemo(() => {
    if (!ready) return new Set();
    if (seen === null) {
      return new Set(rawItems.filter((item) => item.type === "request").map((item) => item.key));
    }
    return new Set(rawItems.filter((item) => !seen.has(item.key)).map((item) => item.key));
  }, [ready, seen, rawItems]);

  /** Marks everything currently listed as seen. Replacing (not appending) prunes stale keys. */
  const markAllSeen = useCallback(() => {
    if (!uid || !ready) return;
    const keys = rawItems.map((item) => item.key);
    setSeen(new Set(keys));
    setDoc(doc(db, "users", uid), { notificationsSeen: keys }, { merge: true }).catch((error) =>
      console.error("Could not mark notifications as seen:", error)
    );
  }, [uid, ready, rawItems]);

  return { items, unreadKeys, unreadCount: unreadKeys.size, markAllSeen, ready };
};
