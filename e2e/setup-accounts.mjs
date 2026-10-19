// One-time setup: creates (or signs in) test users A and B and makes them
// friends through the real Buddies UI. Safe to run again.
import { BASE, appears, checker, creds, launch, login, newUser, step } from "./lib.mjs";

const { a, b } = creds();
const { check, finish } = checker();
const browser = await launch();
const A = await newUser(browser, "A");
const B = await newUser(browser, "B");

try {
  step("Sign in (or sign up) both users");
  console.log("  A:", await login(A, a));
  console.log("  B:", await login(B, b));

  step("A sends B a friend request");
  await A.goto(`${BASE}/buddies?tab=add`);
  await A.fill('input[placeholder="Search by username..."]', b.username);
  await appears(A.getByRole("button", { name: /^(Add Friend|Cancel Request|Unfriend)$/ }).first());
  const addButton = A.getByRole("button", { name: "Add Friend", exact: true }).first();
  if (await addButton.isVisible()) {
    await addButton.click();
    await A.waitForTimeout(1500);
  }

  step("B accepts");
  await B.goto(`${BASE}/buddies?tab=requests`);
  const accept = B.getByRole("button", { name: "Accept", exact: true }).first();
  if (await appears(accept)) {
    await accept.click();
    await B.waitForTimeout(2000);
  }

  await A.goto(`${BASE}/buddies?tab=friends`);
  check("A and B are friends", await appears(A.getByText(b.username).first()));
} catch (error) {
  check("setup finished", false, error.message.split("\n")[0]);
} finally {
  finish([A, B]);
  await browser.close();
}
