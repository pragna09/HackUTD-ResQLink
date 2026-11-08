import OpenAI from "openai";
import { XMLParser } from "fast-xml-parser";

// ---------- CONFIG ----------
const PLACE = "Richardson, TX";
const LAT = 32.9483;
const LON = -96.7299;
const env = (globalThis as typeof globalThis & {
  process?: { env?: Record<string, string | undefined> };
}).process?.env ?? {};
// Confirm the exact ID on the model's page (or via GET /v1/models, see below)
const MODEL = env.NEMOTRON_MODEL ?? "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const FORCE = env.FORCE === "1"; // 1 = ask the model even if weather looks fine
const NEWS_RSS =
  `https://news.google.com/rss/search?q=${encodeURIComponent(PLACE + " weather")}&hl=en-US&gl=US&ceid=US:en`;

const apiKey = env.NVIDIA_API_KEY?.trim().replace(/^(['"])(.*)\1$/, "$2");
if (!apiKey) {
  throw new Error("Set NVIDIA_API_KEY to a valid NVIDIA API key.");
}

const client = new OpenAI({
  apiKey,
  baseURL: "https://integrate.api.nvidia.com/v1",
});

// ---------- TYPES ----------
interface Alert {
  event: string;
  severity: string;
  headline: string;
  instruction: string | null;
  ends: string | null;
}
interface NwsResponse {
  features: Array<{ properties: Alert }>;
}
interface Hour {
  time: string;
  tempC: number;
  rainChancePct: number;
  gustKmh: number;
}
interface OpenMeteoResponse {
  hourly: { time: string[]; temperature_2m: number[]; precipitation_probability: number[]; wind_gusts_10m: number[] };
}
interface RssItem {
  title: string;
}

// ---------- 1. DATA SOURCES ----------
async function getAlerts(): Promise<Alert[]> {
  const res = await fetch(`https://api.weather.gov/alerts/active?point=${LAT},${LON}`, {
    headers: { "User-Agent": "weather-alert-test (you@email.com)" },
  });
  const data = (await res.json()) as NwsResponse;
  return data.features.map(f => ({
    event: f.properties.event,
    severity: f.properties.severity,
    headline: f.properties.headline,
    instruction: f.properties.instruction,
    ends: f.properties.ends,
  }));
}

async function getForecast(): Promise<Hour[]> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&hourly=temperature_2m,precipitation_probability,wind_gusts_10m` +
    `&forecast_hours=12&timezone=auto`;
  const h = ((await (await fetch(url)).json()) as OpenMeteoResponse).hourly;
  return h.time.map((t, i) => ({
    time: t,
    tempC: h.temperature_2m[i],
    rainChancePct: h.precipitation_probability[i],
    gustKmh: h.wind_gusts_10m[i],
  }));
}

async function getNews(): Promise<string[]> {
  try {
    const xml = await (await fetch(NEWS_RSS)).text();
    const items: RssItem | RssItem[] = new XMLParser().parse(xml)?.rss?.channel?.item ?? [];
    return (Array.isArray(items) ? items : [items]).slice(0, 5).map(i => i.title);
  } catch {
    return []; // news is optional
  }
}

// ---------- 2. RULES (code decides IF it's bad) ----------
function findRisks(alerts: Alert[], hours: Hour[]) {
  const risks: string[] = [];
  for (const a of alerts) {
    if (["Moderate", "Severe", "Extreme"].includes(a.severity)) risks.push(`NWS alert: ${a.event}`);
  }
  if (hours.some((h) => h.rainChancePct >= 70)) risks.push("High chance of rain (70%+)");
  if (hours.some((h) => h.gustKmh >= 50)) risks.push("Strong wind gusts (50+ km/h)");
  if (hours.some((h) => h.tempC >= 38)) risks.push("Extreme heat (38°C+)");
  if (hours.some((h) => h.tempC <= 0)) risks.push("Freezing temperatures");
  return risks;
}

// ---------- 3. NEMOTRON (model explains it) ----------
async function writeNotification(payload: object) {
  // chat_template_kwargs is an NVIDIA extension the OpenAI types don't know about.
  const body: OpenAI.Chat.ChatCompletionCreateParamsNonStreaming & { chat_template_kwargs?: { enable_thinking: boolean } } = {
    model: MODEL,
    temperature: 0.2,
    max_tokens: 600,
    messages: [
      {
        role: "system",
        content:
          "You write weather push notifications. Use ONLY the data provided; never invent " +
          "times, numbers, or events. Reply with JSON only, no other text: " +
          '{"notify": boolean, "severity": "low"|"medium"|"high", ' +
          '"title": string (max 50 chars), "body": string (max 160 chars, include timing and one practical tip)}. ' +
          "Set notify to false if nothing is actually hazardous.",
      },
      { role: "user", content: JSON.stringify(payload) },
    ],
    // Turn off Nemotron's long "thinking" trace for a faster, cleaner reply
    chat_template_kwargs: { enable_thinking: false },
  };
  const resp = await client.chat.completions.create(body);

  let text = resp.choices[0].message.content ?? "";
  text = text.replace(/<think>[\s\S]*?<\/think>/g, ""); // strip reasoning if it appears anyway
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(json);
}

// ---------- RUN ----------
(async () => {
  const [alerts, hours, news] = await Promise.all([getAlerts(), getForecast(), getNews()]);
  const risks = findRisks(alerts, hours);

  console.log("Active alerts:", alerts.length, "| Risks found:", risks);

  if (risks.length === 0 && !FORCE) {
    console.log("Weather looks fine — no notification needed. (Run with FORCE=1 to test the model anyway.)");
    return;
  }

  const result = await writeNotification({ place: PLACE, risks, alerts, next12Hours: hours, recentNews: news });
  console.log("\n📱 NOTIFICATION:\n", result);
})();