"use client";

export type TabId = "proof" | "terminal" | "feed";

const items = [
  {
    id: "proof",
    label: "Proof of Work",
    // X logo — contributions on X
    filled: true,
    icon: (
      <path d="M17.53 3h3.2l-7 8 8.23 10.75h-6.44l-5.05-6.6-5.78 6.6H1.5l7.49-8.56L1.1 3h6.6l4.56 6.03zm-1.12 16.9h1.77L7.68 4.98H5.78z" />
    ),
  },
  {
    id: "terminal",
    label: "Alpha Terminal",
    // Gem — simple faceted diamond
    icon: (
      <>
        <path d="M6 3h12l4 6-10 13L2 9Z" />
        <path d="M11 3 8 9l4 13 4-13-3-6" />
        <path d="M2 9h20" />
      </>
    ),
  },
  {
    id: "feed",
    label: "Alpha Feed",
    // Signal waves — live stream of posts
    icon: (
      <>
        <circle cx="6" cy="18" r="1.2" />
        <path d="M5 12.5a6.5 6.5 0 0 1 6.5 6.5" />
        <path d="M5 7a12 12 0 0 1 12 12" />
      </>
    ),
  },
];

type Props = {
  active: TabId;
  onChange: (tab: TabId) => void;
};

export default function Sidebar({ active, onChange }: Props) {
  return (
    // bottom bar on mobile, vertical rail from sm up
    <nav
      // bottom-5 on mobile, raised further to clear the home indicator on
      // notched phones (env(safe-area-inset-bottom)); vertical rail from sm up
      className="fixed bottom-[max(1.25rem,env(safe-area-inset-bottom))] left-1/2 z-50 -translate-x-1/2 rounded-2xl bg-white p-1.5
                 sm:bottom-auto sm:left-5 sm:top-1/2 sm:translate-x-0 sm:-translate-y-1/2"
    >
      <ul className="flex flex-row gap-1 sm:flex-col">
        {items.map((item) => {
          const isActive = active === item.id;
          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onChange(item.id as TabId)}
                aria-label={item.label}
                aria-current={isActive ? "page" : undefined}
                className={`flex h-11 w-11 items-center justify-center rounded-xl outline-none transition-colors focus:outline-none sm:h-10 sm:w-10 ${
                  isActive
                    ? "bg-[#1E2AEB] text-white"
                    : "text-[#1E2AEB] hover:bg-[#1E2AEB]/10"
                }`}
              >
                <svg
                  viewBox="0 0 24 24"
                  fill={item.filled ? "currentColor" : "none"}
                  stroke={item.filled ? "none" : "currentColor"}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-[18px] w-[18px]"
                >
                  {item.icon}
                </svg>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
