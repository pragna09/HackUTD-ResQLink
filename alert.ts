import OpenAI from "openai";
import { XMLParser } from "fast-xml-parser";

// ---------- CONFIG ----------
const PLACE = "Richardson, TX";
const LAT = 32.9483;
const LON = -96.7299;
// Confirm the exact ID on the model's page (or via GET /v1/models, see below)
const MODEL = process.env.NEMOTRON_MODEL ?? "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";
const FORCE = process.env.FORCE === "1"; // 1 = ask the model even if weather looks fine
const NEWS_RSS =
  `https://news.google.com/rss/search?q=${encodeURIComponent(PLACE + " weather")}&hl=en-US&gl=US&ceid=US:en`;

const client = new OpenAI({
  apiKey: process.env.NVIDIA_API_KEY,
  baseURL: "https://integrate.api.nvidia.com/v1",
});

// ---------- 1. DATA SOURCES ----------
async function getAlerts() {
  const res = await fetch(`https://api.weather.gov/alerts/active?point=${LAT},${LON}`, {
    headers: { "User-Agent": "weather-alert-test (you@email.com)" },
  });
  const data: any = await res.json();
  return data.features.map((f: any) => ({
    event: f.properties.event,
    severity: f.properties.severity,
    headline: f.properties.headline,
    instruction: f.properties.instruction,
    ends: f.properties.ends,
  }));
}

async function getForecast() {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}` +
    `&hourly=temperature_2m,precipitation_probability,wind_gusts_10m` +
    `&forecast_hours=12&timezone=auto`;
  const h: any = (await (await fetch(url)).json()).hourly;
  return h.time.map((t: string, i: number) => ({
    time: t,
    tempC: h.temperature_2m[i],
    rainChancePct: h.precipitation_probability[i],
    gustKmh: h.wind_gusts_10m[i],
  }));
}

async function getNews() {
  try {
    const xml = await (await fetch(NEWS_RSS)).text();
    const items = new XMLParser().parse(xml)?.rss?.channel?.item ?? [];
    return (Array.isArray(items) ? items : [items]).slice(0, 5).map((i: any) => i.title);
  } catch {
    return []; // news is optional
  }
}

// ---------- 2. RULES (code decides IF it's bad) ----------
function findRisks(alerts: any[], hours: any[]) {
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
  const resp = await client.chat.completions.create({
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
  } as any);

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