// The real thing: two browsers in one room run a live Group Pick, the
// creator presses Play, then the Leave rules are exercised.
// Needs: `npm run dev` running and test users who are friends
// (run `node e2e/setup-accounts.mjs` once).
import { BASE, appears, checker, creds, launch, login, newUser, shot, step } from "./lib.mjs";

const { a, b } = creds();
const { check, finish } = checker();
const browser = await launch();
const A = await newUser(browser, "A");
const B = await newUser(browser, "B");

const createRoomWithB = async (name) => {
  await A.goto(`${BASE}/rooms`);
  await A.getByRole("button", { name: /Create Room/ }).first().click();
  await A.fill("#roomName", name);
  await A.locator('form button[type="submit"]').click();
  await A.waitForURL(/\/rooms\/[^/]+$/, { timeout: 20000 });
  await A.waitForTimeout(2000);
  await A.getByRole("button", { name: /Add Member/ }).click();
  await A.fill('input[placeholder="Search your friends by username..."]', b.username);
  const addB = A.locator(`button[title="Add ${b.username}"]`);
  if (await appears(addB)) await addB.click();
  await A.waitForTimeout(2000);
  return A.url();
};

const dialog = (page) => page.getByRole("dialog");
const cardTitle = (page) => dialog(page).locator('[aria-label*="Swipe right for yes"] h3').innerText();
const vote = async (page, value) => {
  await dialog(page).getByRole("button", { name: value === "yes" ? "Yes" : "Pass", exact: true }).click();
  await page.waitForTimeout(700);
};

try {
  await login(A, a);
  await login(B, b);
  const stamp = new Date().toISOString().slice(11, 19);

  step("Room with A (creator) and B");
  const roomUrl = await createRoomWithB(`Live Group Pick ${stamp}`);
  await B.goto(roomUrl);
  check("both in the room", await appears(B.getByText("Room Chat"), 20000));

  step("A starts Group Pick");
  await A.getByRole("button", { name: /Group Pick/ }).first().click();
  const intro = await appears(dialog(A).getByText("Can't decide? Swipe on it."), 8000);
  const blocked = await A.getByText(/needs a Firestore rule/).isVisible().catch(() => false);
  check("Group Pick opens (rules allow it)", intro && !blocked, blocked ? "still blocked by rules" : "");
  await dialog(A).getByRole("button", { name: /Start (Group|Solo) Pick/ }).click();

  step("B's panel opens by itself, both reach the deck");
  const bAuto = await appears(dialog(B), 15000);
  check("B's panel opened automatically", bAuto);
  const aDeck = await appears(dialog(A).getByText(/^Card 1 of \d+$/), 90000);
  const bDeck = await appears(dialog(B).getByText(/^Card 1 of \d+$/), 30000);
  check("both see the same deck", aDeck && bDeck);
  await shot(A, "deck");
  await shot(B, "deck");

  if (aDeck && bDeck) {
    const total = Number((await dialog(A).getByText(/^Card 1 of \d+$/).innerText()).match(/of (\d+)/)[1]);
    step(`Voting: A yes to all ${total}; B no to all but the last 3`);
    const bYes = [];
    for (let i = 0; i < total; i += 1) {
      const title = await cardTitle(B);
      const yes = i >= total - 3;
      if (yes) bYes.push(title);
      await vote(B, yes ? "yes" : "no");
    }
    console.log("  B said yes to:", bYes.join(" | "));
    check("live voter chips update on A's screen", await appears(dialog(A).getByText(new RegExp(`${b.username}\\s*done`)), 10000));
    for (let i = 0; i < total; i += 1) await vote(A, "yes");

    step("Host decides automatically once both are done");
    const aResult = await appears(dialog(A).getByText(/Tonight's pick/), 30000);
    const bResult = await appears(dialog(B).getByText(/Tonight's pick/), 15000);
    check("both see results", aResult && bResult);
    const winnerA = await dialog(A).locator("h3.font-dm-display").innerText().catch(() => "?");
    const winnerB = await dialog(B).locator("h3.font-dm-display").innerText().catch(() => "?");
    check("same winner on both screens", winnerA === winnerB, winnerA);
    check("winner is one B said yes to (least misery)", bYes.includes(winnerA));
    const cue = await appears(dialog(A).locator("p.italic"), 45000);
    check("Cue line arrives", cue, cue ? await dialog(A).locator("p.italic").innerText() : "");
    check("B sees 'Waiting for … to hit play'", await dialog(B).getByText(/Waiting for .* to hit play/).isVisible());
    await shot(A, "results");
    await shot(B, "results");

    step("A presses Play in this room");
    await dialog(A).getByRole("button", { name: "Play in this room" }).click();
    const aPlayer = await appears(A.locator("iframe[src*='embed']"), 15000);
    const bPlayer = await appears(B.locator("iframe[src*='embed']"), 15000);
    check("player loads for both", aPlayer && bPlayer);
    const nowA = await A.getByText("Currently Watching:").locator("..").innerText().catch(() => "");
    check("room shows the winner as Currently Watching", nowA.includes(winnerA), nowA.replace(/\s+/g, " "));
    check("Group Pick line in chat", await appears(B.getByText(new RegExp(`Group Pick: ${winnerA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)), 10000));
    check("B's panel closed after Play", await dialog(B).waitFor({ state: "hidden", timeout: 10000 }).then(() => true).catch(() => false));
    await shot(B, "after-play");
  }

  step("Creator A leaves → B becomes creator");
  A.once("dialog", (d) => d.accept());
  await A.getByRole("button", { name: /^Leave$/ }).click();
  const aLeft = await A.waitForURL(/\/rooms$/, { timeout: 15000 }).then(() => true).catch(() => false);
  await B.reload();
  await appears(B.getByText("Room Chat"), 20000);
  const createdBy = await B.getByText(/^Created by /).innerText().catch(() => "");
  check("A left; B is the new creator", aLeft && createdBy.includes(b.username), createdBy);
  check("B now sees creator tools (Select Media)", await B.getByText("Select Media").isVisible().catch(() => false));
  await shot(B, "b-is-creator");

  step("B, now alone, tries to leave → told to delete instead");
  await B.getByRole("button", { name: /^Leave$/ }).click();
  check("'only member' message", await appears(B.getByText(/only member/), 5000));

  step("Normal member leave (second room)");
  const room2 = await createRoomWithB(`Leave test ${stamp}`);
  await B.goto(room2);
  await appears(B.getByText("Room Chat"), 20000);
  B.once("dialog", (d) => d.accept());
  await B.getByRole("button", { name: /^Leave$/ }).click();
  const bLeft = await B.waitForURL(/\/rooms$/, { timeout: 15000 }).then(() => true).catch(() => false);
  await A.goto(room2);
  await A.waitForTimeout(2500);
  const stillListed = (await A.locator("main").innerText()).includes(b.username);
  check("B left and is gone from A's member list", bLeft && !stillListed, `redirected=${bLeft}, stillListed=${stillListed}`);
} catch (error) {
  check("test ran to the end", false, error.message.split("\n")[0]);
  await shot(A, "failure").catch(() => {});
  await shot(B, "failure").catch(() => {});
} finally {
  finish([A, B]);
  await browser.close();
}
