// components/NotificationsList.jsx — the notifications section at the top of
// the account menu. Buddy requests can be answered in place; everything else
// links to where it happened.
import React, { useState } from "react";
import Link from "next/link";
import { formatDistanceToNowStrict } from "date-fns";
import toast from "react-hot-toast";
import { FiBell, FiCheck, FiX } from "react-icons/fi";
import { acceptFriendRequest, rejectFriendRequest } from "../lib/friends";

const DEFAULT_AVATAR = "https://www.gravatar.com/avatar/00000000000000000000000000000000?d=mp&f=y";

const hrefFor = (item) =>
  item.type === "room"
    ? `/rooms/${item.roomId}`
    : item.type === "request"
    ? "/buddies?tab=requests"
    : "/buddies";

const Message = ({ item }) => {
  const name = <span className="font-medium text-textprimary">{item.from?.username || "Someone"}</span>;
  if (item.type === "request") return <>{name} wants to be your buddy</>;
  if (item.type === "accepted") return <>{name} accepted your buddy request</>;
  return (
    <>
      {name} added you to <span className="font-medium text-textprimary">{item.roomName}</span>
    </>
  );
};

const NotificationsList = ({ uid, items, highlightKeys, max = 8 }) => {
  const [busy, setBusy] = useState({});

  const respond = async (item, accept) => {
    setBusy((previous) => ({ ...previous, [item.key]: true }));
    try {
      if (accept) {
        await acceptFriendRequest(uid, item.otherUid);
        toast.success(`You and ${item.from?.username || "they"} are now buddies`);
      } else {
        await rejectFriendRequest(uid, item.otherUid);
        toast("Request declined");
      }
    } catch (error) {
      console.error("Could not answer buddy request:", error);
      toast.error("Could not update that request.");
    } finally {
      setBusy((previous) => ({ ...previous, [item.key]: false }));
    }
  };

  return (
    <div>
      <p className="section-label flex items-center gap-1.5 px-3 pb-1.5 pt-2">
        <FiBell size={12} /> Notifications
      </p>

      {!items.length ? (
        <p className="px-3 pb-3 pt-1 text-[13px] text-textsecondary">You&apos;re all caught up.</p>
      ) : (
        <ul className="custom-scrollbar max-h-[300px] overflow-y-auto">
          {items.slice(0, max).map((item) => {
            const unread = highlightKeys.has(item.key);
            return (
              <li key={item.key} className="relative">
                <Link
                  href={hrefFor(item)}
                  className={`flex gap-2.5 rounded-lg px-3 py-2.5 transition-colors hover:bg-white/[0.06] ${
                    unread ? "bg-accent/[0.06]" : ""
                  }`}
                >
                  <img
                    src={item.from?.avatar || DEFAULT_AVATAR}
                    alt=""
                    className="mt-0.5 h-8 w-8 shrink-0 rounded-full border border-white/10 object-cover"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] leading-snug text-textsecondary">
                      <Message item={item} />
                    </span>
                    {item.at > 0 && (
                      <span className="mt-0.5 block text-[11px] text-textsecondary/70">
                        {formatDistanceToNowStrict(item.at, { addSuffix: true })}
                      </span>
                    )}
                    {/* Space for the buttons, which sit outside the link. */}
                    {item.type === "request" && <span className="block h-8" />}
                  </span>
                  {unread && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-accent" aria-label="New" />}
                </Link>

                {item.type === "request" && (
                  <div className="absolute bottom-2.5 left-[54px] flex gap-1.5">
                    <button
                      type="button"
                      disabled={busy[item.key]}
                      onClick={() => respond(item, true)}
                      className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[12px] font-medium text-primary transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      <FiCheck size={12} /> Accept
                    </button>
                    <button
                      type="button"
                      disabled={busy[item.key]}
                      onClick={() => respond(item, false)}
                      className="flex items-center gap-1 rounded-md border border-white/10 px-2.5 py-1 text-[12px] text-textsecondary transition-colors hover:text-textprimary disabled:opacity-50"
                    >
                      <FiX size={12} /> Decline
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default NotificationsList;
