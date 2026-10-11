// Vercel serverless function at /api/generate, using Google's Gemini API.
// Runs on Vercel's servers, so GEMINI_API_KEY stays secret and is never sent to the browser.
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const HOURLY_LIMIT = Number(process.env.QUIZ_HOURLY_LIMIT || 60);
const MAX_PROMPT = 80000;
const hits = new Map();

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

export default async function handler(req, res){
  if (req.method !== "POST"){
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed.", code: "bad_request" });
  }
  if (!process.env.GEMINI_API_KEY)
    return res.status(500).json({ error: "Server is missing GEMINI_API_KEY.", code: "server" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (overLimit(ip))
    return res.status(429).json({ error: "Too many quizzes from this network. Try again later.", code: "rate_limited" });

  let body = req.body;
  if (typeof body === "string"){ try { body = JSON.parse(body); } catch { body = {}; } }
  const prompt = body && typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt || prompt.length > MAX_PROMPT)
    return res.status(400).json({ error: "Prompt is empty or too long.", code: "bad_request" });

  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(MODEL) + ":generateContent";
  let up;
  try {
    up = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192 }
      })
    });
  } catch {
    return res.status(502).json({ error: "Could not reach the AI service.", code: "server" });
  }

  const data = await up.json().catch(() => ({}));
  if (!up.ok){
    if (up.status === 429) return res.status(429).json({ error: "AI service is busy. Try again soon.", code: "rate_limited" });
    return res.status(502).json({ error: "AI service error: " + ((data.error && data.error.message) || ("HTTP " + up.status)), code: "server" });
  }
  const text = ((data.candidates || [])[0]?.content?.parts || []).map(p => p.text || "").join("");
  if (!text) return res.status(502).json({ error: "AI service returned no text.", code: "server" });
  return res.status(200).json({ text });
}
