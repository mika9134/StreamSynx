import React, { useCallback, useState } from "react";
import { profileUrl } from "../lib/tmdb";
import PersonModal from "./PersonModal";

/**
 * Horizontal row of people. `crew` entries (directors, creators) lead the row
 * and show their job instead of a character. Tapping anyone opens their bio.
 * `excludeKey` ("movie-123" / "tv-456") keeps the current title out of their credits.
 */
const CastRow = ({ cast = [], crew = [], title = "Cast", excludeKey }) => {
  const [selected, setSelected] = useState(null);
  const close = useCallback(() => setSelected(null), []);

  const people = [
    ...crew.map((person) => ({ ...person, role: person.job })),
    ...cast.map((person) => ({ ...person, role: person.character })),
  ];
  if (!people.length) return null;

  return (
    <div>
      <h3 className="mb-3 text-[13px] font-semibold uppercase tracking-[0.14em] text-textsecondary">
        {title}
      </h3>
      <div className="rail flex gap-4 overflow-x-auto pb-1">
        {people.map((person, index) => {
          const photo = profileUrl(person.profile_path);
          return (
            <button
              key={`${person.id ?? person.cast_id}-${person.role || index}`}
              type="button"
              onClick={() => setSelected(person)}
              aria-label={`About ${person.name}`}
              className="group/person w-[84px] shrink-0 rounded-lg text-center"
            >
              <div className="mx-auto h-[84px] w-[84px] overflow-hidden rounded-full border border-white/[0.08] bg-secondary transition-colors group-hover/person:border-accent/70">
                {photo ? (
                  <img
                    src={photo}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover transition-transform duration-300 group-hover/person:scale-105"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-lg font-medium text-textsecondary">
                    {person.name?.charAt(0)}
                  </div>
                )}
              </div>
              <p className="mt-2 truncate text-[12px] font-medium text-textprimary group-hover/person:text-accent">
                {person.name}
              </p>
              <p className={`truncate text-[11px] ${person.job ? "text-accent/80" : "text-textsecondary"}`}>
                {person.role}
              </p>
            </button>
          );
        })}
      </div>

      <PersonModal person={selected} onClose={close} excludeKey={excludeKey} />
    </div>
  );
};

export default CastRow;
