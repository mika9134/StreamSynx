// lib/friends.js — the buddy-request actions, shared by the Buddies page and
// the notifications menu so both paths write exactly the same documents.
import { arrayUnion, doc, setDoc, updateDoc } from "firebase/firestore";
import { db } from "../firebase";

/** Request ids are `${from}_${to}`, so either side can address one directly. */
export const requestId = (fromUid, toUid) => `${fromUid}_${toUid}`;

export const acceptFriendRequest = async (myUid, fromUid) => {
  await updateDoc(doc(db, "friendRequests", requestId(fromUid, myUid)), { status: "accepted" });
  await setDoc(doc(db, "friends", myUid), { friends: arrayUnion(fromUid) }, { merge: true });
  await setDoc(doc(db, "friends", fromUid), { friends: arrayUnion(myUid) }, { merge: true });
};

export const rejectFriendRequest = (myUid, fromUid) =>
  updateDoc(doc(db, "friendRequests", requestId(fromUid, myUid)), { status: "rejected" });
