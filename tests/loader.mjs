// Node ESM loader for unit tests: lets lib/*.js (written for Next.js) run in
// plain Node. It resolves extensionless imports, treats lib/ as ES modules,
// and swaps Firebase, axios and localStorage helpers for inert stubs so no
// test ever touches the network.
const LIB_URL = new URL("../lib/", import.meta.url).href;
// API routes are ES modules too; chat.js has no imports, so it loads as-is.
const API_URL = new URL("../pages/api/", import.meta.url).href;

const STUB =
  "data:text/javascript," +
  [
    "export const db={};",
    "export const doc=()=>{};",
    "export const getDoc=async()=>({exists:()=>false});",
    "export const setDoc=async()=>{};",
    "export default {get:async()=>{throw new Error('no network in tests')}};",
    "export const getLastEpisode=()=>null;",
    "export const getContinueWatching=()=>[];",
    "export const getRecentSearches=()=>[];",
  ].join("");

const isStubbed = (spec) =>
  spec === "firebase/firestore" || spec === "axios" || /\/firebase$/.test(spec) || /\/localStore$/.test(spec);

export async function resolve(spec, ctx, next) {
  if (isStubbed(spec)) return { url: STUB, shortCircuit: true };
  if (spec.startsWith(".") && !/\.[mc]?js$/.test(spec) && ctx.parentURL?.startsWith(LIB_URL)) {
    return next(`${spec}.js`, ctx);
  }
  return next(spec, ctx);
}

export async function load(url, ctx, next) {
  if (url.startsWith(LIB_URL) || url.startsWith(API_URL)) {
    return { ...(await next(url, { ...ctx, format: "module" })), format: "module" };
  }
  return next(url, ctx);
}
