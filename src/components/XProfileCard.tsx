import Image from "next/image";

export type XProfile = {
  handle: string;
  name: string;
  avatar: string;
  banner: string;
  bio: string;
  followers: number;
  following: number;
  verified: boolean;
  joined: string;
};

function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** X ships joined dates as either the classic Twitter timestamp format
 *  ("Wed Oct 10 20:19:24 +0000 2018") or an ISO string, depending on the
 *  schema path the profile came from - `Date` parses both. */
function formatJoined(raw: string): string | null {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return `Joined ${date.toLocaleString("en-US", { month: "long", year: "numeric" })}`;
}

export default function XProfileCard({ profile }: { profile: XProfile }) {
  const joined = formatJoined(profile.joined);

  return (
    <a
      href={`https://x.com/${profile.handle}`}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open @${profile.handle} on X`}
      // Fixed height so every card in the list lines up regardless of how
      // much bio/joined-date content a given account happens to have -
      // the bio and joined blocks below reserve constant space instead.
      className="block h-57.5 w-full shrink-0 overflow-hidden border border-[#eff3f4] bg-white text-[#0f1419] shadow-lg transition-opacity hover:opacity-90"
      style={{ fontFamily: "Arial, Helvetica, sans-serif" }}
    >
      <div className="relative h-9 bg-white sm:h-10">
        {profile.banner && (
          <Image
            src={profile.banner}
            alt=""
            fill
            sizes="400px"
            className="object-cover"
          />
        )}
      </div>

      <div className="relative px-3 pb-3 sm:px-3.5 sm:pb-3.5">
        <div className="flex h-5 items-start justify-end sm:h-6">
          <div className="absolute left-3 top-0 h-11 w-11 -translate-y-1/2 overflow-hidden rounded-full border-2 border-white bg-[#eff3f4] sm:left-3.5 sm:h-12 sm:w-12">
            {profile.avatar ? (
              <Image
                src={profile.avatar}
                alt={`${profile.handle} avatar`}
                width={48}
                height={48}
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="h-full w-full bg-[#eff3f4]" />
            )}
          </div>

          <button
            type="button"
            // Decorative for now - stop the click from also triggering the
            // card's own navigation to the post.
            onClick={(event) => event.stopPropagation()}
            className="mt-1 min-h-6 rounded-full border border-[#cfd9de] px-2.5 text-[11px] font-bold leading-4 text-[#0f1419] transition-colors hover:bg-[#0f1419]/10 sm:min-h-7 sm:px-3 sm:text-[12px]"
          >
            Follow
          </button>
        </div>

        <div className="mt-1">
          <div className="flex items-center gap-1">
            <h2 className="min-w-0 truncate text-[13px] font-extrabold leading-4 sm:text-[14px]">
              {profile.name || profile.handle}
            </h2>
            {/* Simulated badge - same shape as X's real verified mark (svg > g > path),
            shown on every card regardless of the real verified flag - these
            projects are almost never genuinely verified. */}
            {true && (
              <svg
                viewBox="0 0 22 22"
                aria-label="Verified account"
                width={16}
                height={16}
                className="h-4 w-4 shrink-0 text-[#1d9bf0]"
                fill="currentColor"
              >
                <g>
                <path d="M20.396 11c0 1.153-1.42 1.897-1.838 2.905-.435 1.045.025 2.574-.765 3.364-.79.79-2.319.33-3.364.765C13.42 18.452 12.677 19.872 11.523 19.872s-1.897-1.42-2.905-1.838c-1.045-.435-2.574.025-3.364-.765-.79-.79-.33-2.319-.765-3.364C4.071 12.897 2.65 12.153 2.65 11s1.42-1.897 1.838-2.905c.435-1.045-.025-2.574.765-3.364.79-.79 2.319-.33 3.364-.765C9.626 5.548 10.37 4.128 11.523 4.128s1.897 1.42 2.905 1.838c1.045.435 2.574-.025 3.364.765.79.79.33 2.319.765 3.364.418 1.008 1.839 1.752 1.839 2.905Z" />
                <path
                    d="m9.57 14.51-2.49-2.49 1.06-1.06 1.43 1.43 4.77-4.77 1.06 1.06-5.83 5.83Z"
                    fill="white"
                />
                </g>
              </svg>
            )}
          </div>
          <p className="text-[12px] leading-4 text-[#536471]">@{profile.handle}</p>
        </div>

        {/* Always rendered (empty when there's no bio) and clamped to two
            lines, so every card reserves the same vertical space here. */}
        <p className="mt-1.5 line-clamp-2 min-h-8 text-[12px] leading-4 sm:text-[13px]">
          {profile.bio}
        </p>

        {/* Fixed-height regardless of whether a joined date resolved. */}
        <div className="mt-1.5 flex h-4 items-center gap-1 text-[12px] leading-4 text-[#536471]">
          {joined && (
            <>
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-3 w-3 shrink-0 fill-current">
                <path d="M7 4V2h2v2h6V2h2v2h1.5A2.5 2.5 0 0 1 21 6.5v12a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 18.5v-12A2.5 2.5 0 0 1 5.5 4H7Zm11.5 2h-13a.5.5 0 0 0-.5.5V9h14V6.5a.5.5 0 0 0-.5-.5ZM19 11H5v7.5a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V11Z" />
              </svg>
              {joined}
            </>
          )}
        </div>

        <div className="mt-1.5 flex gap-3 text-[12px] leading-4">
          <span>
            <strong className="font-bold text-[#0f1419]">{formatCount(profile.following)}</strong>{" "}
            <span className="text-[#536471]">Following</span>
          </span>
          <span>
            <strong className="font-bold text-[#0f1419]">{formatCount(profile.followers)}</strong>{" "}
            <span className="text-[#536471]">Followers</span>
          </span>
        </div>
      </div>
    </a>
  );
}
