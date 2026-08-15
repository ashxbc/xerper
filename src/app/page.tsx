import Image from "next/image";
import App from "@/components/App";

export default function Home() {
  return (
    <div
      // h-dvh (dynamic viewport height) rather than h-screen: 100vh includes
      // the mobile browser's URL-bar area, which crops content behind it and
      // makes the layout jump when the bar collapses.
      className="relative h-dvh w-screen overflow-hidden"
      style={{
        backgroundColor: "#1E2AEB",
        backgroundImage:
          "linear-gradient(rgba(255,255,255,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.08) 1px, transparent 1px)",
        backgroundSize: "50px 50px",
      }}
    >
      {/* Logo bleeds off the top-left edge */}
      <Image
        src="/xerper.png"
        alt="Xerper"
        width={280}
        height={280}
        priority
        className="pointer-events-none absolute -left-2 -top-2 w-[60px] select-none sm:w-[80px]"
      />

      <a
        href="https://x.com/valor0x"
        target="_blank"
        rel="noopener noreferrer"
        style={{ fontFamily: "var(--font-cursive)" }}
        className="absolute right-4 top-4 z-50 text-lg text-white transition-opacity hover:opacity-70 sm:right-6 sm:top-5 sm:text-xl"
      >
        powered by valor
      </a>

      <App />
    </div>
  );
}
