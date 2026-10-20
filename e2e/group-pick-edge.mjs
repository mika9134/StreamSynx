// Edge cases for Group Pick, each in its own room:
//   1. Solo room in Series mode: "Solo Pick", a series wins, Play loads seasons.
//   2. Race: A and B press Start in the same instant; one session, same deck.
//   3. Host leaves mid-vote: the other member takes over and finishes.
//   4. Nobody votes: the 3-minute timeout decides on taste; Run again restarts.
//   5. Clock skew: B's clock runs 2 minutes fast; B must not steal host.
// Needs `npm run dev` running and the test users (npm run test:e2e:setup).
// Takes about 8 minutes, mostly waiting on the timeout and takeover clocks.
// Run some scenarios only with E2E_ONLY, e.g. E2E_ONLY=5 (scenario 3 runs inside 2).
import { BASE, appears, checker, creds, launch, login, newUser, shot, step } from "./lib.mjs";

const { a, b } = creds();
const { check, finish } = checker();
const browser = await launch();
const pages = [];
const open = async (label, user, { clockOffsetMs = 0 } = {}) => {
  const page = await newUser(browser, label);
  if (clockOffsetMs) {
    // Shift this browser's clock; the server's clock stays correct.
    await page.context().addInitScript((offset) => {
      const RealDate = Date;
      class SkewedDate extends RealDate {
        constructor(...args) {
          super(...(args.length ? args : [RealDate.now() + offset]));
        }
        static now() {
          return RealDate.now() + offset;
        }
      }
      window.Date = SkewedDate;
    }, clockOffsetMs);
  }
  await login(page, user);
  pages.push(page);
  return page;
};

const dialog = (page) => page.getByRole("dialog");
const deckCard = (page) => dialog(page).getByText(/^Card \d+ of \d+$/);
const cardTitle = (page) => dialog(page).locator('[aria-label*="Swipe right for yes"] h3').first().innerText();
const isHostOn = (page) => dialog(page).getByRole("button", { name: "+1 min" }).isVisible().catch(() => false);
const vote = async (page, value) => {
  await dialog(page).getByRole("button", { name: value === "yes" ? "Yes" : "Pass", exact: true }).click();
  await page.waitForTimeout(700);
};
const voteAll = async (page, value = "yes") => {
  const label = await deckCard(page).innerText();
  const [, done, total] = label.match(/Card (\d+) of (\d+)/).map(Number);
  for (let i = done; i <= total; i += 1) await vote(page, value);
};

const createRoom = async (owner, name, guest) => {
  await owner.goto(`${BASE}/rooms`);
  await owner.getByRole("button", { name: /Create Room/ }).first().click();
  await owner.fill("#roomName", name);
  await owner.locator('form button[type="submit"]').click();
  await owner.waitForURL(/\/rooms\/[^/]+$/, { timeout: 20000 });
  await owner.waitForTimeout(2000);
  if (guest) {
    await owner.getByRole("button", { name: /Add Member/ }).click();
    await owner.fill('input[placeholder="Search your friends by username..."]', guest.username);
    const add = owner.locator(`button[title="Add ${guest.username}"]`);
    if (await appears(add)) await add.click();
    await owner.waitForTimeout(2000);
    await owner.keyboard.press("Escape");
  }
  return owner.url();
};

const enter = async (page, url) => {
  await page.goto(url);
  return appears(page.getByText("Room Chat"), 20000);
};

const openPanel = async (page) => {
  await page.getByRole("button", { name: /Group Pick/ }).first().click();
  return appears(dialog(page), 8000);
};

const startFrom = async (page, modeLabel = "Movie") => {
  if (!(await dialog(page).isVisible())) await openPanel(page);
  await dialog(page).getByRole("button", { name: modeLabel, exact: true }).click();
  await dialog(page).getByRole("button", { name: /Start (Group|Solo) Pick/ }).click();
};

const stamp = new Date().toISOString().slice(11, 19);
let A;
let B;

const solo = async () => {
  step("1. Solo room, Series mode");
  await createRoom(A, `Solo series ${stamp}`);
  await openPanel(A);
  check("panel says Solo Pick", await appears(dialog(A).getByText("Solo Pick", { exact: true }), 5000));
  await startFrom(A, "Series");
  const soloDeck = await appears(deckCard(A), 90000);
  check("solo deck appears", soloDeck);
  if (!soloDeck) return;
  await voteAll(A, "yes");
  const done = await appears(dialog(A).getByText(/Tonight's pick/), 30000);
  const kind = await dialog(A).locator("h3.font-dm-display + p").innerText().catch(() => "");
  check("solo result arrives after my swipes", done);
  check("Series mode picks a series", kind.includes("Series"), kind);
  await shot(A, "solo-series-result");
  await dialog(A).getByRole("button", { name: "Play in this room" }).click();
  check("player loads", await appears(A.locator("iframe[src*='embed']"), 15000));
  check("season list renders for the series", await appears(A.getByText(/Season 1\b/).first(), 15000));
  await shot(A, "solo-series-playing");
};

const raceThenHostLeaves = async () => {
  step("2. Race: A and B press Start together");
  const raceUrl = await createRoom(A, `Race ${stamp}`, b);
  await enter(B, raceUrl);
  await openPanel(A);
  await openPanel(B);
  const startA = dialog(A).getByRole("button", { name: /Start Group Pick/ });
  const startB = dialog(B).getByRole("button", { name: /Start Group Pick/ });
  await Promise.all([startA.click(), startB.click()]);
  const aDeck = await appears(deckCard(A), 90000);
  const bDeck = await appears(deckCard(B), 30000);
  check("both reach a deck", aDeck && bDeck);
  if (!aDeck || !bDeck) return;
  const [titleA, titleB] = [await cardTitle(A), await cardTitle(B)];
  check("same first card on both screens (one session)", titleA === titleB, `${titleA} / ${titleB}`);
  const hosts = [await isHostOn(A), await isHostOn(B)];
  check("exactly one host", hosts.filter(Boolean).length === 1, `A host=${hosts[0]}, B host=${hosts[1]}`);

  step("3. The host closes their tab mid-vote");
  const [host, guest] = hosts[0] ? [A, B] : [B, A];
  await vote(host, "yes");
  await vote(guest, "yes");
  await host.context().close();
  pages.splice(pages.indexOf(host), 1);
  console.log(`  host ${host.label} closed; waiting for ${guest.label} to take over (~45 s)`);
  const tookOver = await appears(dialog(guest).getByRole("button", { name: "+1 min" }), 75000);
  check(`${guest.label} takes over as host`, tookOver);
  await voteAll(guest, "yes");
  const decided = await appears(dialog(guest).getByText(/Tonight's pick/), 40000);
  check("new host decides without waiting for the one who left", decided);
  await shot(guest, "after-takeover");

  // Reopen whoever closed, for the next scenarios.
  if (host === A) A = await open("A2", a);
  else B = await open("B2", b);
};

const nobodyVotes = async () => {
  step("4. Nobody votes: the timeout decides");
  const idleUrl = await createRoom(A, `Idle ${stamp}`, b);
  await enter(B, idleUrl);
  await startFrom(A);
  check("B's panel opens by itself", await appears(dialog(B), 20000));
  check("deck appears", await appears(deckCard(A), 90000));
  console.log("  waiting for the 3-minute timeout…");
  const timedOut = await appears(dialog(A).getByText("Nobody voted, so this was picked on taste"), 220000);
  check("timeout decides on taste alone", timedOut);
  check("B sees the same banner", await appears(dialog(B).getByText("Nobody voted, so this was picked on taste"), 15000));
  await shot(B, "fit-only-result");

  step("4b. B (not the creator) presses Run again");
  const oldWinner = await dialog(A).locator("h3.font-dm-display").innerText().catch(() => "");
  await dialog(B).getByRole("button", { name: "Run again" }).click();
  await dialog(B).getByRole("button", { name: /Start Group Pick/ }).click();
  const fresh = await appears(dialog(A).getByText(/Reading your group's taste|Yes or pass\?/), 20000);
  check("A's panel follows the new session", fresh);
  const freshDeck = await appears(deckCard(A), 90000);
  const restarted = freshDeck && (await deckCard(A).innerText()).startsWith("Card 1 of");
  check("new session starts from card 1 (old votes gone)", restarted, `previous winner: ${oldWinner}`);
};

const clockSkew = async () => {
  step("5. B's clock is 2 minutes fast");
  await B.context().close();
  pages.splice(pages.indexOf(B), 1);
  B = await open("B-skew", b, { clockOffsetMs: 120000 });
  const skewUrl = await createRoom(A, `Skew ${stamp}`, b);
  await enter(B, skewUrl);
  await startFrom(A);
  const skewDeck = (await appears(deckCard(A), 90000)) && (await appears(deckCard(B), 30000));
  check("both reach the deck", skewDeck);
  if (!skewDeck) return;
  await A.waitForTimeout(20000);
  const stolen = await isHostOn(B);
  const aStillHost = await isHostOn(A);
  check("A is still host after 20 s", aStillHost && !stolen, `A host=${aStillHost}, B host=${stolen}`);
  const left = await dialog(B).getByText(/\d+:\d\d left/).innerText().catch(() => "");
  const [minutes, seconds] = (left.match(/(\d+):(\d\d)/) || [0, 0, 0]).slice(1).map(Number);
  check("B's countdown matches the server, not B's clock", minutes * 60 + seconds > 120, left);
  await shot(B, "skew-deck");
};

const scenarios = { 1: solo, 2: raceThenHostLeaves, 4: nobodyVotes, 5: clockSkew };
const only = (process.env.E2E_ONLY || "1,2,4,5").split(",").map((n) => n.trim());

try {
  A = await open("A", a);
  B = await open("B", b);
  for (const [n, run] of Object.entries(scenarios)) {
    if (only.includes(n)) await run();
  }
} catch (error) {
  check("test ran to the end", false, error.message.split("\n")[0]);
  for (const page of pages) await shot(page, "failure").catch(() => {});
} finally {
  finish(pages);
  await browser.close();
}
