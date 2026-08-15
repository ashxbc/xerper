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
    // Filled coin with a dollar sign (svgrepo) - scaled from its native 512
    // viewBox onto the 24x24 icon canvas, so it renders like the X logo.
    filled: true,
    icon: (
      <g transform="scale(0.046875)">
        <path d="m256,11c-135.1,0-245,109.9-245,245s109.9,245 245,245c135.1,0 245-109.9 245-245s-109.9-245-245-245zm0,449.2c-112.6,0-204.2-91.6-204.2-204.2 0-112.6 91.6-204.2 204.2-204.2 112.6,0 204.2,91.6 204.2,204.2 0,112.6-91.6,204.2-204.2,204.2z" />
        <path d="m268.8,224.8v-66.5c11,4.8 17.8,13.8 20.4,27.2l43-5.6c-2.9-17-9.8-30.6-20.4-40.7-10.7-10.2-25-16.3-43-18.5v-16.8h-24.7v16.8c-19.5,1.9-35.1,9.2-46.9,21.9-11.7,12.6-17.6,28.3-17.6,46.9 0,18.4 5.2,34 15.6,46.9 10.4,12.9 26.7,22.5 48.9,28.8v71.3c-6.1-2.9-11.7-7.7-16.7-14.3-5-6.6-8.4-14.4-10.2-23.5l-44.4,4.8c3.4,22.3 11.2,39.6 23.5,51.9s28.2,19.6 47.8,21.9v31h24.7v-31.8c22.1-3.2 39.4-11.8 51.8-25.9 12.4-14.1 18.6-31.4 18.6-51.9 0-18.4-4.9-33.4-14.8-45.2-9.9-11.8-28.4-21.3-55.6-28.7zm-24.7-8.2c-36.1-11.8-24.2-58.9 0-58.9v58.9zm24.7,122.2v-66.4c36.2,7 33.1,59.5 0,66.4z" />
      </g>
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
