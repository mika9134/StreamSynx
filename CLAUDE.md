# StreamSynx

Next.js 16 (pages router) + React 18, Firebase (Auth, Firestore, Realtime Database), TMDB, Tailwind 3. Watch movies/series, watch rooms with friends, buddy matching, and "Cue", an AI recommendation assistant.

## Commands

- `npm run dev`: dev server on http://localhost:3000 (webpack mode; first load of each page compiles slowly)
- `npm run build`: production build; needs the env vars below or Firebase init fails while collecting page data
- `npm test`: unit tests in `tests/` (Node test runner; `tests/loader.mjs` stubs Firebase/axios so `lib/*.js` runs in plain Node, no network)
- `npm run test:e2e`: browser test of rooms + live Group Pick + Leave, two users in Playwright (needs `npm run dev` running). Run `npm run test:e2e:setup` once to create and befriend the test users. Screenshots go to `e2e/shots/`.

## Environment

`.env.local` (git-ignored; see `.env.example` for names): `API_KEY`, `NEXT_PUBLIC_API_KEY` (TMDB), `NEXT_PUBLIC_FIREBASE_*` (7 keys), `OPENROUTER_API_KEY` (Cue). Optional: `AI_BASE_URL`, `AI_MODELS`.

Browser tests read `E2E_A_PASSWORD` / `E2E_B_PASSWORD` (test users `ssx_test_a` / `ssx_test_b`, emails `ssx.test.a@example.com` / `ssx.test.b@example.com`), or `e2e/.creds.json` locally. `E2E_BROWSER=chromium` uses Playwright's own Chromium (`npx playwright-core install chromium`) where Chrome is not installed.

## Layout

- `pages/`: routes. `pages/rooms/[roomId].jsx` is the watch room; `pages/api/assistant/chat.js` is Cue (OpenAI-compatible gateway via `fetch`, also has a `mode: "groupPick"` one-line explanation).
- `lib/`: logic. `groupPick.js` is pure (no Firestore); `groupPickStore.js` is its Firestore I/O; `tasteProfile.js` / `tasteMatch.js` are taste vectors and similarity.
- `components/`: UI. `GroupPickModal.jsx`, `SwipeDeck.jsx`.
- `docs/group-pick-plan.md`: design of Group Pick (schema, state machine, fairness formula).
- `pages/dev/group-pick-lab.jsx`: dev-only page running Group Pick in one browser with an in-memory session.

## Things to know

- Firestore and RTDB security rules live in the Firebase console, not in this repo, and only the project owner (Kidus-M) can change them. A "Missing or insufficient permissions" error usually means a rule is missing; handle `permission-denied` gracefully rather than crashing.
- Room members are in `rooms/{id}.members` (an old bug used `memberIds`). Only the room creator (`createdBy`) changes media; a creator who leaves hands the room to a random member.
- `components/TvRemoteNavigation.jsx` captures arrow keys globally (capture phase + `stopPropagation`). Components that need ← / → must opt out, like `SwipeDeck` does with `data-arrow-keys="swipe"`.
- Lines in `.env.local` may end in CRLF (Windows).
- The repo owner explains changes to a learning developer: describe what changed and why in plain language.
