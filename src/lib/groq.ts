/** Minimal Groq chat-completions client, used solely to classify whether an
 *  X handle represents a crypto NFT project. Kept deliberately narrow - one
 *  function, one job - rather than a general-purpose wrapper.
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.1-8b-instant";

export type ClassificationInput = {
  handle: string;
  bio: string;
  recentTweet: string;
};

const SYSTEM_PROMPT =
  "You classify X (Twitter) accounts for PRE-MINT NFT discovery. Return true " +
  "only when the HANDLE'S OWN ACCOUNT is a crypto NFT project whose mint has " +
  "definitely NOT started yet and is clearly upcoming, pre-mint, or launching " +
  "soon. Return false if minting is live, open, started, completed, minted out, " +
  "sold out, trading, or already available on OpenSea. Return false if timing " +
  "is unclear. A person promoting or mentioning a project is also false. Judge " +
  "the account, not isolated NFT keywords. Reply with exactly one word: true " +
  "or false. No punctuation, explanation, or other text.";

function buildUserPrompt({ handle, bio, recentTweet }: ClassificationInput): string {
  return [
    `Handle: @${handle}`,
    `Bio: ${bio || "(empty)"}`,
    `Most recent tweet: ${recentTweet || "(none)"}`,
    "",
    "Is this the project's own account AND is its mint clearly still upcoming and not started? Answer true or false only.",
  ].join("\n");
}

/** Returns true/false, or throws if Groq is unreachable, misconfigured, or
 *  answers with anything other than a clean true/false - callers should
 *  treat a thrown error as "skip this candidate", not as a false verdict. */
export async function classifyNftProject(
  input: ClassificationInput,
): Promise<boolean> {
  const apiKey = (process.env.GROQ_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error("No Groq session configured - set GROQ_API_KEY");
  }

  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      temperature: 0,
      max_tokens: 5,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(input) },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Groq returned ${response.status}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = (data.choices?.[0]?.message?.content ?? "").trim().toLowerCase();

  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`Groq returned an unexpected answer: "${raw}"`);
}
