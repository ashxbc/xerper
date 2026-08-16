import Image from "next/image";
import { cookies } from "next/headers";
import App from "@/components/App";
import FirstVisitGate from "@/components/FirstVisitGate";

export default async function Home() {
  // Read by the server so returning visitors (cookie set on completion) get
  // the full UI in the initial HTML - the gate never renders for them, so
  // there is no flash of the modal before hydration.
  const cookieStore = await cookies();
  const onboardingPassed = cookieStore.get("valor_onboarding")?.value === "1";

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
      {/* First-visit gate: hides everything but the logo and shows the
          follow-Valor modal until the visitor completes it. The gate renders
          its own copy of the logo while active, and restores these children
          (logo + powered by valor + app) once completed. */}
      <FirstVisitGate serverCompleted={onboardingPassed}>
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
      </FirstVisitGate>
    </div>
  );
}
