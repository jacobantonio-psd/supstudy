// Quiz server: serves the tracker page and proxies quiz requests to Anthropic.
// The API key stays on the server and is never sent to the browser.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const API_URL = process.env.ANTHROPIC_API_URL || "https://api.anthropic.com/v1/messages";
const MODEL = process.env.QUIZ_MODEL || "claude-sonnet-5-5";
const HOURLY_LIMIT = Number(process.env.QUIZ_HOURLY_LIMIT || 60);
const MAX_PROMPT = 80000;
const PUBLIC = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
const hits = new Map();

function send(res, status, obj){
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function clientIp(req){
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
}

// Simple per-IP limit so a public link can't run up the API bill.
function overLimit(ip){
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 3600000);
  const blocked = recent.length >= HOURLY_LIMIT;
  if (!blocked) recent.push(now);
  hits.set(ip, recent);
  return blocked;
}

function readBody(req){
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => {
      size += c.length;
      if (size > 200000){ reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function generate(req, res){
  if (!API_KEY) return send(res, 500, { error: "Server is missing ANTHROPIC_API_KEY.", code: "server" });
  if (overLimit(clientIp(req))) return send(res, 429, { error: "Too many quizzes from this network. Try again later.", code: "rate_limited" });

  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return send(res, 400, { error: "Bad request.", code: "bad_request" }); }
  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt || prompt.length > MAX_PROMPT) return send(res, 400, { error: "Prompt is empty or too long.", code: "bad_request" });

  let up;
  try {
    up = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages: [{ role: "user", content: prompt }] })
    });
  } catch { return send(res, 502, { error: "Could not reach the AI service.", code: "server" }); }

  const data = await up.json().catch(() => ({}));
  if (!up.ok){
    if (up.status === 429) return send(res, 429, { error: "AI service is busy. Try again soon.", code: "rate_limited" });
    return send(res, 502, { error: "AI service error.", code: "server" });
  }
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  send(res, 200, { text });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "POST" && url.pathname === "/api/generate") return generate(req, res);
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed." });

  let rel;
  try { rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1)); }
  catch { return send(res, 400, { error: "Bad request." }); }
  const full = path.normalize(path.join(PUBLIC, rel));
  if (!full.startsWith(PUBLIC + path.sep) || !fs.existsSync(full) || fs.statSync(full).isDirectory())
    return send(res, 404, { error: "Not found." });
  res.writeHead(200, { "content-type": MIME[path.extname(full)] || "application/octet-stream" });
  fs.createReadStream(full).pipe(res);
});

server.listen(PORT, () => console.log("Quiz server running on port " + PORT));
