// Vercel serverless function at /api/generate, using Google's Gemini API.
// Runs on Vercel's servers, so GEMINI_API_KEY stays secret and is never sent to the browser.
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "";
const HOURLY_LIMIT = Number(process.env.QUIZ_HOURLY_LIMIT || 60);
const MAX_PROMPT = 80000;
const hits = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Per-IP limit to protect your quota. Serverless instances don't share memory,
// so this is a rough guard.
function overLimit(ip){
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 3600000);
  const blocked = recent.length >= HOURLY_LIMIT;
  if (!blocked) recent.push(now);
  hits.set(ip, recent);
  return blocked;
}

// One request to Gemini. Returns { up, data }, or null if the network failed.
async function callGemini(model, prompt, key){
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent";
  try {
    const up = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192 }
      })
    });
    const data = await up.json().catch(() => ({}));
    return { up, data };
  } catch {
    return null;
  }
}

// Overload and server errors from Google are usually temporary, so retry them briefly.
const TEMPORARY = status => status === 500 || status === 503 || status === 504;

export default async function handler(req, res){
  if (req.method !== "POST"){
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed.", code: "bad_request" });
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key)
    return res.status(500).json({ error: "Server is missing GEMINI_API_KEY.", code: "server" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (overLimit(ip))
    return res.status(429).json({ error: "Too many quizzes from this network. Try again later.", code: "rate_limited" });

  let body = req.body;
  if (typeof body === "string"){ try { body = JSON.parse(body); } catch { body = {}; } }
  const prompt = body && typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt || prompt.length > MAX_PROMPT)
    return res.status(400).json({ error: "Prompt is empty or too long.", code: "bad_request" });

  // Try the main model twice with a short wait, then the fallback model once if one is set.
  const attempts = [MODEL, MODEL];
  if (FALLBACK_MODEL) attempts.push(FALLBACK_MODEL);
  let last = null;
  for (let i = 0; i < attempts.length; i++){
    if (i > 0) await sleep(i === 1 ? 1500 : 0);
    const r = await callGemini(attempts[i], prompt, key);
    if (!r){ last = { status: 502, message: "Could not reach the AI service." }; continue; }
    const { up, data } = r;
    if (up.ok){
      const text = ((data.candidates || [])[0]?.content?.parts || []).map(p => p.text || "").join("");
      if (!text) return res.status(502).json({ error: "AI service returned no text.", code: "server" });
      return res.status(200).json({ text });
    }
    if (up.status === 429) return res.status(429).json({ error: "AI service is busy. Try again soon.", code: "rate_limited" });
    last = { status: up.status, message: (data.error && data.error.message) || ("HTTP " + up.status) };
    if (!TEMPORARY(up.status) && up.status !== 502) break; // not worth retrying
  }
  return res.status(502).json({ error: "AI service error: " + (last ? last.message : "unknown"), code: "server" });
}
