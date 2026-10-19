// Shared helpers for the browser tests (Playwright).
//
// Settings, all optional except the two passwords:
//   E2E_BASE_URL          app under test (default http://localhost:3000)
//   E2E_A_EMAIL / E2E_A_PASSWORD / E2E_A_USERNAME   test user A
//   E2E_B_EMAIL / E2E_B_PASSWORD / E2E_B_USERNAME   test user B
//   E2E_BROWSER           "chrome" (installed Chrome) or "chromium" (Playwright's own)
// Locally the passwords can live in e2e/.creds.json instead (git-ignored).
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const BASE = process.env.E2E_BASE_URL || "http://localhost:3000";
export const SHOTS = path.join(DIR, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

export const creds = () => {
  const file = path.join(DIR, ".creds.json");
  const local = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const user = (key, fallbackName) => ({
    username: process.env[`E2E_${key}_USERNAME`] || local[key.toLowerCase()]?.username || fallbackName,
    email:
      process.env[`E2E_${key}_EMAIL`] ||
      local[key.toLowerCase()]?.email ||
      `${fallbackName.replace(/_/g, ".")}@example.com`,
    password: process.env[`E2E_${key}_PASSWORD`] || local[key.toLowerCase()]?.password,
  });
  const a = user("A", "ssx_test_a");
  const b = user("B", "ssx_test_b");
  if (!a.password || !b.password) {
    throw new Error("Set E2E_A_PASSWORD and E2E_B_PASSWORD (or create e2e/.creds.json).");
  }
  return { a, b };
};

/** Installed Chrome when available, otherwise Playwright's own Chromium. */
export const launch = async () => {
  const preferred = process.env.E2E_BROWSER || "chrome";
  if (preferred === "chrome") {
    try {
      return await chromium.launch({ channel: "chrome", headless: true });
    } catch {
      console.log("Installed Chrome not found; using Playwright Chromium (npx playwright-core install chromium).");
    }
  }
  return chromium.launch({ headless: true });
};

/** A fresh browser profile (its own login) that records console errors. */
export const newUser = async (browser, label) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.label = label;
  page.errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") page.errors.push(`[${label}] ${msg.text().slice(0, 300)}`);
  });
  page.on("pageerror", (err) => page.errors.push(`[${label}] PAGEERROR ${err.message.slice(0, 300)}`));
  page.setDefaultNavigationTimeout(90000);
  page.setDefaultTimeout(30000);

  // Wait for the HTML, then give React time to attach handlers (hydration),
  // so clicks are not lost on a page that only looks ready. A cold dev server
  // sometimes drops the first connection, so retry once on network errors.
  const goto = page.goto.bind(page);
  page.goto = async (url, options = {}) => {
    let response;
    try {
      response = await goto(url, { waitUntil: "domcontentloaded", ...options });
    } catch (error) {
      if (!/ERR_|net::/.test(error.message)) throw error;
      await page.waitForTimeout(2000);
      response = await goto(url, { waitUntil: "domcontentloaded", ...options });
    }
    await page.waitForLoadState("load", { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    return response;
  };
  return page;
};

let shotCount = 0;
export const shot = async (page, name) => {
  shotCount += 1;
  const file = path.join(SHOTS, `${String(shotCount).padStart(2, "0")}-${page.label}-${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  📸 ${path.relative(process.cwd(), file)}`);
  return file;
};

export const step = (text) => console.log(`\n▶ ${text}`);

/** Waits for the locator to appear. (locator.isVisible() never waits.) */
export const appears = (locator, timeout = 10000) =>
  locator.waitFor({ state: "visible", timeout }).then(() => true).catch(() => false);

/** Signs in; signs up first if the account does not exist yet. */
export const login = async (page, user) => {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', user.email);
  await page.fill('input[name="password"]', user.password);
  await page.click('button[type="submit"]');
  const signedIn = await page
    .waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (signedIn) return "signed-in";

  await page.goto(`${BASE}/signup`);
  await page.fill('input[name="username"]', user.username);
  await page.fill('input[name="email"]', user.email);
  await page.fill('input[name="password"]', user.password);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.startsWith("/signup"), { timeout: 20000 });
  return "signed-up";
};

/** Pass/fail bookkeeping shared by every test file. */
export const checker = () => {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok });
    console.log(`  ${ok ? "✅" : "❌"} ${name}${detail ? ` — ${detail}` : ""}`);
  };
  const finish = (pages) => {
    const errors = pages.flatMap((page) => page.errors);
    console.log(`\nConsole errors: ${errors.length}`);
    errors.forEach((line) => console.log(`  ${line}`));
    const passed = results.filter((r) => r.ok).length;
    console.log(`\nRESULT: ${passed}/${results.length} checks passed`);
    if (passed !== results.length) process.exitCode = 1;
  };
  return { check, finish };
};
