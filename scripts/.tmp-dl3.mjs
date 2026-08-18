import puppeteer from "puppeteer-core";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.setCookie({ name: "valor_onboarding", value: "1", domain: "localhost", path: "/" });

await page.goto("http://localhost:3000/", { waitUntil: "networkidle2", timeout: 60000 });
await page.evaluate(() => { [...document.querySelectorAll("button")][3]?.click(); });
await new Promise((r) => setTimeout(r, 800));
const input = await page.$('input[placeholder*="username"]');
await input.type("liamsky272");
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.body.innerText.includes("Weekly"), { timeout: 30000 });
await new Promise((r) => setTimeout(r, 400));

// Capture PNG generation
await page.evaluate(() => {
  const orig = HTMLCanvasElement.prototype.toDataURL;
  window.__pngs = [];
  HTMLCanvasElement.prototype.toDataURL = function (...a) {
    const url = orig.apply(this, a);
    if (a[0] === "image/png" && this.width >= 1000) window.__pngs.push(url);
    return url;
  };
});

const cardBtn = await page.evaluate(() => {
  const btn = document.querySelector('button[aria-label="Download stats image"]');
  const card = document.querySelector("main > div > div");
  return {
    exists: !!btn,
    text: btn?.textContent?.trim() || "(icon only)",
    hasBlue: (btn?.className || "").includes("bg-[#1E2AEB]"),
    inCard: card?.contains(btn) ?? false,
    title: btn?.getAttribute("title") || "",
  };
});
console.log("CARD BUTTON:", JSON.stringify(cardBtn));

// Click it (weekly active)
await page.evaluate(() => document.querySelector('button[aria-label="Download stats image"]')?.click());
await new Promise((r) => setTimeout(r, 400));
const weeklyCount = await page.evaluate(() => window.__pngs.length);

// Switch card toggle to Monthly, click again
await page.evaluate(() => {
  const btns = [...document.querySelectorAll("main button")];
  btns.find((b) => b.textContent?.trim() === "Monthly")?.click();
});
await new Promise((r) => setTimeout(r, 300));
const monthlyTitle = await page.evaluate(() => document.querySelector('button[aria-label="Download stats image"]')?.getAttribute("title") || "");
await page.evaluate(() => document.querySelector('button[aria-label="Download stats image"]')?.click());
await new Promise((r) => setTimeout(r, 400));
const monthlyCount = await page.evaluate(() => window.__pngs.length);

// Open modal - confirm no download button there
await page.evaluate(() => document.querySelector('button[aria-label="Open analytics stats"]')?.click());
await new Promise((r) => setTimeout(r, 400));
const modalHasDownload = await page.evaluate(() => {
  const overlay = document.querySelector('[class*="z-[80]"]');
  return !!overlay && [...overlay.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Download");
});

console.log("DL COUNTS: weekly->", weeklyCount, "monthly->", monthlyCount - weeklyCount);
console.log("MONTHLY TITLE:", monthlyTitle);
console.log("MODAL HAS DOWNLOAD:", modalHasDownload);
await browser.close();
