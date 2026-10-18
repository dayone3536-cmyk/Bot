import express from "express";
import { existsSync } from "fs";
import { YoutubeTranscript } from "youtube-transcript";

const app = express();
app.use(express.json({ limit: "1mb" }));
// works whether index.html is in the repo root or in public/
const page = existsSync("public/index.html") ? "public/index.html" : "index.html";
app.get("/", (req, res) => res.sendFile(page, { root: process.cwd() }));

const E = process.env;
// formatter providers, tried in this order; if one fails the next one is used
const providers = [];
if (E.GROQ_API_KEY)
  providers.push({ name: "groq", kind: "openai", url: "https://api.groq.com/openai/v1/chat/completions",
    key: E.GROQ_API_KEY, model: E.GROQ_MODEL || "openai/gpt-oss-120b" });
if (E.GEMINI_API_KEY)
  providers.push({ name: "gemini", kind: "gemini", key: E.GEMINI_API_KEY,
    model: E.GEMINI_MODEL || E.FORMAT_MODEL || "gemini-3.8-flash" });
if (E.ANTHROPIC_API_KEY)
  providers.push({ name: "anthropic", kind: "anthropic", key: E.ANTHROPIC_API_KEY,
    model: E.ANTHROPIC_MODEL || "claude-haiku-5-5" });

const RULES =
  "You are a text formatter, not a writer. Reformat the text below so it is clean and easy to read: " +
  "fix broken line breaks, put paragraphs on their own lines, keep existing headings as headings (plain text, ALL CAPS or underlined, no markdown symbols), " +
  "turn obvious lists into lines starting with '- ', remove leftover menu/ad/cookie junk. " +
  "Do NOT summarize, shorten, reword, translate, add commentary, or leave anything out of the real content. " +
  "Output ONLY the formatted text.";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fc(path, body) {
  const r = await fetch(`https://api.firecrawl.dev/v2/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${E.FIRECRAWL_API_KEY}` },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || j.success === false) throw new Error(j.error || "Firecrawl error");
  return j;
}

async function callProvider(p, prompt) {
  let r, j, out;
  if (p.kind === "openai") {
    const body = { model: p.model, temperature: 0, max_completion_tokens: 8192,
      messages: [{ role: "user", content: prompt }] };
    if (p.model.includes("gpt-oss")) body.reasoning_effort = "low";
    r = await fetch(p.url, { method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${p.key}` },
      body: JSON.stringify(body) });
    j = await r.json();
    out = j.choices?.[0]?.message?.content;
  } else if (p.kind === "gemini") {
    r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${p.model}:generateContent?key=${p.key}`,
      { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 8192 } }) });
    j = await r.json();
    out = j.candidates?.[0]?.content?.parts?.map((x) => x.text || "").join("");
  } else {
    r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
      headers: { "content-type": "application/json", "x-api-key": p.key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: p.model, max_tokens: 8192, temperature: 0,
        messages: [{ role: "user", content: prompt }] }) });
    j = await r.json();
    out = j.content?.map((c) => c.text || "").join("");
  }
  return { r, j, out };
}

async function llm(prompt) {
  if (!providers.length) throw new Error("No formatter API key set (GROQ_API_KEY or GEMINI_API_KEY)");
  let lastErr = "Formatter failed";
  for (const p of providers) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const { r, j, out } = await callProvider(p, prompt);
        if (r.ok && out) return out.trim();
        lastErr = `${p.name}: ${j.error?.message || r.status}`;
        if (r.status !== 429 && r.status < 500) break; // hard error: go to next provider
        const wait = Number(r.headers.get("retry-after")) || 3 * (attempt + 1);
        await sleep(Math.min(wait, 20) * 1000);
      } catch (e) {
        lastErr = `${p.name}: ${e.message}`;
        break;
      }
    }
  }
  throw new Error(lastErr);
}

// Instant, free, no-AI formatting: markdown -> clean plain text. Nothing is summarized or reworded.
function cleanLocal(raw, kind) {
  if (kind === "video") {
    const words = raw.replace(/\s+/g, " ").trim().split(" ");
    const paras = [];
    for (let i = 0; i < words.length; i += 100) paras.push(words.slice(i, i + 100).join(" "));
    return paras.join("\n\n");
  }
  return raw
    .replace(/!\[[^\]]*\]\((?:[^()]|\([^)]*\))*\)/g, "")
    .replace(/\[\s*edit\s*\]\((?:[^()]|\([^)]*\))*\)/gi, "")
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1")
    .replace(/\[\s*edit\s*\]/gi, "")
    .replace(/\[\d{1,3}\]/g, "")
    .replace(/\\([_*\[\]()#>~`-])/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/^#{1,2}\s+(.+)$/gm, (_, t) => "\n" + t.toUpperCase() + "\n")
    .replace(/^#{3,6}\s+(.+)$/gm, "\n$1")
    .replace(/^\s*[*+]\s+/gm, "- ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// split into ~N-word chunks without losing any whitespace/newlines
function chunk(raw, n = Number(E.CHUNK_WORDS) || 1500) {
  const tokens = raw.match(/\S+\s*/g) || [];
  const out = [];
  for (let i = 0; i < tokens.length; i += n) out.push(tokens.slice(i, i + n).join(""));
  return out;
}

app.post("/api/sources", async (req, res) => {
  try {
    const topic = (req.body.topic || "").trim();
    if (!topic) return res.status(400).json({ error: "Type a topic first" });

    const queries = [
      topic,
      `${topic} guide tutorial`,
      `${topic} postmortem lessons learned`,
      `${topic} GDC talk article`,
    ];
    const results = await Promise.all(
      queries.map((q) =>
        fc("search", { query: q, limit: 5 })
          .then((j) => ({ results: j.data?.web || (Array.isArray(j.data) ? j.data : []) }))
          .catch(() => ({ results: [] }))
      )
    );

    const seen = new Set();
    let sources = [];
    for (const r of results)
      for (const x of r.results || []) {
        if (seen.has(x.url)) continue;
        seen.add(x.url);
        sources.push({
          kind: "web",
          title: x.title,
          url: x.url,
          site: new URL(x.url).hostname.replace(/^www\./, ""),
        });
      }
    sources = sources.slice(0, 10);

    if (E.YOUTUBE_API_KEY) {
      const u = new URL("https://www.googleapis.com/youtube/v3/search");
      u.search = new URLSearchParams({
        part: "snippet", q: topic, type: "video", order: "viewCount",
        videoCaption: "closedCaption", maxResults: "3", key: E.YOUTUBE_API_KEY,
      });
      const j = await (await fetch(u)).json();
      for (const i of j.items || [])
        sources.push({
          kind: "video",
          id: i.id.videoId,
          title: i.snippet.title,
          url: `https://www.youtube.com/watch?v=${i.id.videoId}`,
          site: `YouTube: ${i.snippet.channelTitle}`,
        });
    }
    res.json({ sources });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/read", async (req, res) => {
  try {
    const s = req.body;
    let raw;
    if (s.kind === "video") {
      raw = (await YoutubeTranscript.fetchTranscript(s.id)).map((p) => p.text).join(" ");
    } else {
      const j = await fc("scrape", { url: s.url, formats: ["markdown"], onlyMainContent: true });
      raw = j.data?.markdown;
    }
    if (!raw || raw.length < 200) throw new Error("no readable text");

    let out;
    if (E.FORMAT_WITH_AI === "true" && providers.length) {
      // optional AI pass (slow, uses free-tier tokens)
      const note =
        s.kind === "video"
          ? "\n\nThis is a raw video transcript: add punctuation, capitalization and paragraph breaks only. Keep every word.\n\n"
          : "\n\n";
      out = "";
      for (const c of chunk(raw)) out += (await llm(RULES + note + c)) + "\n\n";
    } else {
      out = cleanLocal(raw, s.kind);
    }
    res.json({ text: out.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(E.PORT || 3000, () => console.log(`running (AI formatting ${E.FORMAT_WITH_AI === "true" ? "ON" : "off, local cleanup"}; providers: ${providers.map((p) => p.name + "/" + p.model).join(", ") || "NONE"})`));
