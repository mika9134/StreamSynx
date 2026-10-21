// Cue's one-line Group Pick explanation is checked before users see it
// (groupPickReplyProblem in pages/api/assistant/chat.js). The rejected lines
// below are real replies seen on 21 Oct 2026.
import test from "node:test";
import assert from "node:assert/strict";

const { groupPickReplyProblem } = await import("../pages/api/assistant/chat.js");

const noTaste = { title: "You Can See Everything", sharedTraits: [] };
const withTaste = { title: "A.I. Artificial Intelligence", sharedTraits: ["Drama", "Sci-Fi", "Mystery"] };

test("rejects a shared interest nobody has", () => {
  const reply =
    "You Can See Everything is the fair pick because both members voted yes, and it's the documentary that fits their shared interest in real stories about controversial figures.";
  assert.equal(groupPickReplyProblem(reply, noTaste), "invented shared taste");
});

test("rejects field names leaking into the sentence", () => {
  const reply =
    "A.I. Artificial Intelligence is the fair pick because its Drama and Sci-Fi genres match two of the three sharedTraits, and both members voted yes.";
  assert.equal(groupPickReplyProblem(reply, withTaste), "field name");
});

test("accepts plain, honest lines", () => {
  assert.equal(
    groupPickReplyProblem("You Can See Everything is the fair pick: everyone said yes and nobody is left unhappy.", noTaste),
    null
  );
  assert.equal(
    groupPickReplyProblem("A.I. Artificial Intelligence suits the room: you all share a love of Sci-Fi, and both of you said yes.", withTaste),
    null
  );
});

test("rejects empty and overlong replies", () => {
  assert.equal(groupPickReplyProblem("", withTaste), "empty");
  assert.equal(groupPickReplyProblem("word ".repeat(40), withTaste), "too long");
});

test("a camelCase title is not mistaken for a field name", () => {
  assert.equal(groupPickReplyProblem("WandaVision is the fair pick: both of you said yes.", { title: "WandaVision", sharedTraits: [] }), null);
});
