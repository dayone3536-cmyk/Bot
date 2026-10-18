import express from "express";
import { existsSync } from "fs";
import { YoutubeTranscript } from "youtube-transcript";

const app = express();
app.use(express.json({ limit: "1mb" }));
// works whether index.html is in the repo root or in public/
const page = existsSync("public/index.html") ? "public/index.html" : "index.html";
app.get("/", (req, res) => res.sendFile(page, { root: process.cwd() }));

const E = process.env;
const provider = E.FORMAT_PROVIDER || (E.GEMINI_API_KEY ? "gemini" : "anthropic");
const model =
  E.FORMAT_MODEL || (provider === "gemini" ? "gemini-3.8-flash" : "claude-haiku-5-5");

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

async function llm(prompt, attempt = 0) {
  let r, j, out;
  if (provider === "gemini") {
    r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${E.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 8192 },
        }),
      }
    );
    j = await r.json();
    out = j.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("");
  } else {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": E.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        temperature: 0,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    j = await r.json();
    out = j.content?.map((c) => c.text || "").join("");
  }
  if (r.status === 429 && attempt < 3) {
    await sleep(4000 * (attempt + 1));
    return llm(prompt, attempt + 1);
  }
  if (!r.ok || !out) throw new Error(j.error?.message || "Formatter failed");
  return out.trim();
}

// split into ~N-word chunks without losing any whitespace/newlines
function chunk(raw, n = 3000) {
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

    const note =
      s.kind === "video"
        ? "\n\nThis is a raw video transcript: add punctuation, capitalization and paragraph breaks only. Keep every word.\n\n"
        : "\n\n";
    let out = "";
    for (const c of chunk(raw)) out += (await llm(RULES + note + c)) + "\n\n";
    res.json({ text: out.trim() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(E.PORT || 3000, () => console.log(`running (formatter: ${provider}/${model})`));
