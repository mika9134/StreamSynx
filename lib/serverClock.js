// lib/serverClock.js — "now" by the server's clock, not this computer's.
//
// Group Pick compares "now" with times the server wrote (hostSeenAt) and
// times another member's browser wrote (votingEndsAt). A computer whose clock
// is a few minutes off would see a live host as gone and take over, or end
// voting early. Firebase measures this device's offset from the server and
// keeps it at .info/serverTimeOffset; adding it gives the server's time.
import { onValue, ref } from "firebase/database";
import { rtdb } from "../firebase";

let offsetMs = 0;
let listening = false;

const listen = () => {
  if (listening || typeof window === "undefined") return;
  listening = true;
  onValue(ref(rtdb, ".info/serverTimeOffset"), (snapshot) => {
    offsetMs = Number(snapshot.val()) || 0;
  });
};

/** Milliseconds since 1970 by the server's clock (best estimate). */
export const serverNow = () => {
  listen();
  return Date.now() + offsetMs;
};
