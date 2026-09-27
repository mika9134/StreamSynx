import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { AnimatePresence, motion } from "framer-motion";
import { FiX } from "react-icons/fi";
import { FaStar } from "react-icons/fa";
import { GENRE_MAP, posterUrl, profileUrl, titleOf, tmdbGet, watchHref, yearOf } from "../lib/tmdb";

// Talk shows and news appearances say nothing about someone's body of work.
const NOISE_GENRES = new Set([10763, 10767]);
const SELF_ROLE = /\b(self|himself|herself|themselves|narrator \(voice\))\b/i;
const CREW_JOBS = new Set(["Director", "Creator", "Screenplay", "Writer", "Producer", "Executive Producer"]);

// Person lookups are stable, so one fetch per person per session is plenty.
const personCache = new Map();

const fetchPerson = (id) => {
  if (!personCache.has(id)) {
    const request = tmdbGet(`/person/${id}`, { append_to_response: "combined_credits" })
      .then(({ data }) => data)
      .catch((error) => {
        personCache.delete(id);
        throw error;
      });
    personCache.set(id, request);
  }
  return personCache.get(id);
};

/** First couple of sentences of the TMDB biography, capped so the card never scrolls. */
const shortBio = (text, maxChars = 260) => {
  if (!text) return "";
  const firstParagraph = text.split(/\n+/)[0].trim();
  const sentences = firstParagraph.match(/[^.!?]+[.!?]+(\s|$)/g) || [firstParagraph];
  let bio = "";
  for (const sentence of sentences) {
    if (bio && (bio + sentence).length > maxChars) break;
    bio += sentence;
    if (bio.length >= maxChars * 0.6) break;
  }
  bio = bio.trim();
  return bio.length > maxChars ? `${bio.slice(0, maxChars).replace(/\s+\S*$/, "")}…` : bio;
};

const listJoin = (items) =>
  items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/**
 * Collapses cast + crew credits into one entry per title, dropping self
 * appearances and talk/news shows, ranked by how widely each title was seen.
 */
const buildCredits = (person, excludeKey) => {
  const credits = person?.combined_credits;
  if (!credits) return [];

  const byTitle = new Map();
  const add = (item, role) => {
    if (!["movie", "tv"].includes(item.media_type)) return;
    if ((item.genre_ids || []).some((id) => NOISE_GENRES.has(id))) return;
    const key = `${item.media_type}-${item.id}`;
    if (key === excludeKey) return;
    const existing = byTitle.get(key);
    if (existing) {
      if (role && !existing.roles.includes(role)) existing.roles.push(role);
      return;
    }
    byTitle.set(key, { ...item, roles: role ? [role] : [] });
  };

  (credits.cast || []).forEach((item) => {
    if (SELF_ROLE.test(item.character || "")) return;
    add(item, item.character || "");
  });
  (credits.crew || []).forEach((item) => {
    if (CREW_JOBS.has(item.job)) add(item, item.job);
  });

  return [...byTitle.values()].sort((a, b) => (b.vote_count || 0) - (a.vote_count || 0));
};

/** "Mostly films", top genres, and how long they've been working — a few plain statements. */
const buildKnownFor = (person, credits) => {
  if (!credits.length) return [];
  const lines = [];

  const films = credits.filter((item) => item.media_type === "movie").length;
  const series = credits.length - films;
  const share = films / credits.length;
  const format =
    share >= 0.7 ? "mostly in films" : share <= 0.3 ? "mostly in series" : "across films and series";
  const department = person.known_for_department;
  const craft =
    department === "Acting"
      ? "Acts"
      : department === "Directing"
      ? "Directs"
      : department === "Writing"
      ? "Writes"
      : department === "Production"
      ? "Produces"
      : "Works";
  lines.push(`${craft} ${format} — ${films} film${films === 1 ? "" : "s"}, ${series} series.`);

  const genreCounts = new Map();
  credits.forEach((item) =>
    (item.genre_ids || []).forEach((id) => {
      if (GENRE_MAP[id]) genreCounts.set(id, (genreCounts.get(id) || 0) + 1);
    })
  );
  const topGenres = [...genreCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id]) => GENRE_MAP[id]);
  if (topGenres.length) lines.push(`Gravitates toward ${listJoin(topGenres).toLowerCase()}.`);

  const years = credits.map((item) => Number(yearOf(item))).filter(Boolean);
  if (years.length) {
    const first = Math.min(...years);
    const latest = Math.max(...years);
    if (latest > first) lines.push(`Credits span ${first}–${latest}.`);
  }

  return lines;
};

const lifeLine = (person) => {
  if (!person?.birthday) return person?.place_of_birth || "";
  const born = new Date(person.birthday);
  const end = person.deathday ? new Date(person.deathday) : new Date();
  let age = end.getFullYear() - born.getFullYear();
  if (
    end.getMonth() < born.getMonth() ||
    (end.getMonth() === born.getMonth() && end.getDate() < born.getDate())
  ) {
    age -= 1;
  }
  const bornText = `Born ${born.getFullYear()}${person.place_of_birth ? ` in ${person.place_of_birth}` : ""}`;
  return person.deathday ? `${bornText} · died aged ${age}` : `${bornText} · ${age}`;
};

const CreditTile = ({ item, hiddenOnMobile, onOpen }) => {
  const poster = posterUrl(item.poster_path);
  const role = item.roles[0];
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Watch ${titleOf(item)}`}
      className={`group/credit min-w-0 text-left ${hiddenOnMobile ? "hidden sm:block" : ""}`}
    >
      <div className="relative aspect-[2/3] overflow-hidden rounded-lg border border-white/[0.08] bg-secondary">
        {poster ? (
          <img
            src={poster}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-300 group-hover/credit:scale-105"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-1.5 text-center text-[10px] text-textsecondary">
            {titleOf(item)}
          </div>
        )}
        {item.vote_average > 0 && (
          <span className="absolute right-1 top-1 inline-flex items-center gap-0.5 rounded bg-black/70 px-1 py-px text-[9px] text-textprimary">
            <FaStar className="h-2 w-2 text-accent" />
            {item.vote_average.toFixed(1)}
          </span>
        )}
      </div>
      <p className="mt-1.5 truncate text-[11px] font-medium text-textprimary group-hover/credit:text-accent">
        {titleOf(item)}
      </p>
      <p className="truncate text-[10px] text-textsecondary">
        {[item.media_type === "tv" ? "Series" : yearOf(item), role].filter(Boolean).join(" · ")}
      </p>
    </button>
  );
};

/**
 * Compact bio card for a cast or crew member. `person` only needs `id` and
 * `name`; anything else (photo, role) is shown while the full profile loads.
 * `excludeKey` ("movie-123" / "tv-456") hides the title you're already watching.
 */
const PersonModal = ({ person, onClose, excludeKey }) => {
  const router = useRouter();
  const closeRef = useRef(null);
  const [details, setDetails] = useState(null);
  const [error, setError] = useState(false);
  const isOpen = Boolean(person);

  useEffect(() => {
    if (!person?.id) return undefined;
    let active = true;
    setDetails(null);
    setError(false);
    fetchPerson(person.id)
      .then((data) => active && setDetails(data))
      .catch(() => active && setError(true));
    return () => {
      active = false;
    };
  }, [person?.id]);

  useEffect(() => {
    if (!isOpen) return undefined;
    document.body.style.overflow = "hidden";
    const timer = setTimeout(() => closeRef.current?.focus(), 60);
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(timer);
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [isOpen, onClose]);

  const credits = useMemo(() => buildCredits(details, excludeKey), [details, excludeKey]);
  const knownFor = useMemo(() => buildKnownFor(details || {}, credits), [details, credits]);
  const bio = useMemo(() => shortBio(details?.biography), [details]);

  const photo = profileUrl(details?.profile_path || person?.profile_path);
  const name = details?.name || person?.name;
  const loading = !details && !error;

  const openCredit = (item) => {
    onClose();
    router.push(watchHref(item));
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 px-4 backdrop-blur-md"
          onMouseDown={onClose}
          role="dialog"
          aria-modal="true"
          aria-labelledby="person-modal-name"
        >
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.99 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            onMouseDown={(event) => event.stopPropagation()}
            className="relative max-h-[92vh] w-full max-w-xl overflow-hidden rounded-2xl border border-white/[0.08] bg-primary-soft/95 p-5 shadow-lift backdrop-blur-2xl sm:p-6"
          >
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="absolute right-3 top-3 rounded-lg p-1.5 text-textsecondary transition-colors hover:bg-white/[0.06] hover:text-textprimary"
            >
              <FiX size={18} />
            </button>

            {/* Header */}
            <div className="flex items-center gap-4 pr-8">
              <div className="h-20 w-20 shrink-0 overflow-hidden rounded-full border border-white/[0.08] bg-secondary">
                {photo ? (
                  <img src={photo} alt="" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-2xl font-medium text-textsecondary">
                    {name?.charAt(0)}
                  </div>
                )}
              </div>
              <div className="min-w-0">
                <h2 id="person-modal-name" className="truncate text-lg font-semibold text-textprimary">
                  {name}
                </h2>
                {(details?.known_for_department || person?.job) && (
                  <p className="mt-0.5 text-xs uppercase tracking-[0.12em] text-accent">
                    {details?.known_for_department || person.job}
                  </p>
                )}
                {details && lifeLine(details) && (
                  <p className="mt-1 truncate text-xs text-textsecondary">{lifeLine(details)}</p>
                )}
              </div>
            </div>

            {loading && (
              <div className="mt-5 space-y-2">
                <div className="skeleton h-3.5 w-full rounded" />
                <div className="skeleton h-3.5 w-11/12 rounded" />
                <div className="skeleton h-3.5 w-2/3 rounded" />
                <div className="mt-5 grid grid-cols-4 gap-3 sm:grid-cols-5">
                  {Array.from({ length: 5 }).map((_, index) => (
                    <div
                      key={index}
                      className={`skeleton aspect-[2/3] rounded-lg ${index === 4 ? "hidden sm:block" : ""}`}
                    />
                  ))}
                </div>
              </div>
            )}

            {error && (
              <p className="mt-5 text-sm text-textsecondary">
                Couldn&apos;t load this profile right now. Try again in a moment.
              </p>
            )}

            {details && (
              <>
                {bio && (
                  <p className="mt-4 line-clamp-4 text-[13px] leading-relaxed text-textsecondary">{bio}</p>
                )}

                {knownFor.length > 0 && (
                  <ul className="mt-4 space-y-1 border-l-2 border-accent/60 pl-3 text-[13px] text-textprimary">
                    {knownFor.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}

                {credits.length > 0 && (
                  <div className="mt-5">
                    <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-textsecondary">
                      Watch their work
                    </h3>
                    {/* Fixed grid, no scrolling: 8 titles on phones, 10 on larger screens. */}
                    <div className="grid grid-cols-4 gap-3 sm:grid-cols-5">
                      {credits.slice(0, 10).map((item, index) => (
                        <CreditTile
                          key={`${item.media_type}-${item.id}`}
                          item={item}
                          hiddenOnMobile={index >= 8}
                          onOpen={() => openCredit(item)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default PersonModal;
