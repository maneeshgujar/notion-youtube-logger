export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 1. Serve Service Worker (Required by Chrome for PWA installation)
    if (url.pathname === "/sw.js") {
      const swCode = `
        self.addEventListener("install", (e) => self.skipWaiting());
        self.addEventListener("activate", (e) => clients.claim());
        self.addEventListener("fetch", (e) => {
          e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
        });
      `;
      return new Response(swCode, {
        headers: { "Content-Type": "application/javascript; charset=utf-8" },
      });
    }

    // 2. Serve Web Manifest (With Share Target & Maskable Icon)
    if (url.pathname === "/manifest.json") {
      const manifest = {
        name: "Tube to Notion",
        short_name: "NotionClip",
        start_url: "/",
        scope: "/",
        display: "standalone",
        background_color: "#0f1117",
        theme_color: "#0f1117",
        icons: [
          {
            src: "/icon.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "any maskable",
          },
        ],
        share_target: {
          action: "/",
          method: "GET",
          params: { title: "title", text: "text", url: "url" },
        },
      };
      return new Response(JSON.stringify(manifest), {
        headers: { "Content-Type": "application/manifest+json" },
      });
    }

    // 3. Serve Built-in App Icon (Clean SVG rendered as high-res PNG fallback)
    if (url.pathname === "/icon.png") {
      const svgIcon = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
        <rect width="512" height="512" rx="110" fill="#0f1117"/>
        <rect x="20" y="20" width="472" height="472" rx="95" fill="#181c27" stroke="#282f44" stroke-width="8"/>
        <!-- YouTube Play Badge -->
        <rect x="70" y="166" width="190" height="180" rx="36" fill="#ef4444"/>
        <polygon points="145,216 205,256 145,296" fill="#ffffff"/>
        <!-- Notion N Box -->
        <rect x="250" y="146" width="190" height="220" rx="28" fill="#ffffff"/>
        <path d="M290 190 L335 190 L395 305 L395 190 L420 190 L420 322 L375 322 L315 207 L315 322 L290 322 Z" fill="#000000"/>
        <!-- Connecting Spark -->
        <circle cx="256" cy="256" r="14" fill="#6366f1"/>
      </svg>
      `;
      return new Response(svgIcon, {
        headers: {
          "Content-Type": "image/svg+xml",
          "Cache-Control": "public, max-age=604800",
        },
      });
    }

    // 4. Serve the App HTML
    if (request.method === "GET" && !url.searchParams.has("api")) {
      return new Response(renderHTML(url), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // 5. CORS Handling
    const origin = request.headers.get("Origin") || "*";
    const corsHeaders = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 6. Backend API: Workers AI & Notion Page Creation
    try {
      let body = {};
      if (request.method === "POST") {
        try {
          body = await request.json();
        } catch (e) {}
      }
      const videoUrl = body.url || url.searchParams.get("url") || "";
      const dbType = body.dbType || url.searchParams.get("db") || "notesTube";
      const aiMode = body.aiMode || url.searchParams.get("mode") || "manual";
      const customTitle = body.title || "";

      if (!videoUrl) {
        return new Response(JSON.stringify({ error: "Missing YouTube URL" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      let videoId = "";
      try {
        if (videoUrl.includes("youtu.be/")) {
          videoId = videoUrl.split("youtu.be/")[1].split("?")[0];
        } else if (videoUrl.includes("watch?v=")) {
          videoId = new URL(videoUrl).searchParams.get("v") || "";
        } else if (videoUrl.includes("shorts/")) {
          videoId = videoUrl.split("shorts/")[1].split("?")[0];
        }
      } catch (e) {}

      const cleanUrl = videoId
        ? "https://www.youtube.com/watch?v=" + videoId
        : videoUrl;
      const thumbUrl = videoId
        ? "https://img.youtube.com/vi/" + videoId + "/hqdefault.jpg"
        : "";

      let videoTitle = customTitle.trim();
      if (!videoTitle) {
        try {
          const oembedRes = await fetch(
            "https://www.youtube.com/oembed?url=" +
              encodeURIComponent(cleanUrl) +
              "&format=json",
          );
          if (oembedRes.ok) {
            const oembedData = await oembedRes.json();
            videoTitle = oembedData.title || "YouTube Video";
          }
        } catch (e) {
          videoTitle = "YouTube Video";
        }
      }

      // Step 6.1: Fetch Transcript & Description, then run Cloudflare Workers AI
      let pageBlocks = [];
      if (aiMode !== "manual" && env.AI) {
        try {
          const { transcript, description, title } = await getYouTubeContent(
            videoId,
            env.TRANSCRIPT_API_KEY,
          );

          if (title && (!videoTitle || videoTitle === "YouTube Video")) {
            videoTitle = title;
          }

          const rawText = await generateNotes(env.AI, {
            aiMode,
            videoTitle,
            cleanUrl,
            description,
            transcript,
          });
          if (rawText) {
            pageBlocks.push({
              object: "block",
              type: "callout",
              callout: {
                icon: { type: "emoji", emoji: "🎬" },
                color: "gray_background",
                rich_text: [
                  {
                    type: "text",
                    text: { content: videoTitle || "YouTube Video", link: { url: cleanUrl } },
                  },
                  { type: "text", text: { content: "\n" } },
                  {
                    type: "text",
                    text: {
                      content: "Watch on YouTube",
                      link: { url: cleanUrl },
                    },
                    annotations: { color: "blue" },
                  },
                ],
              },
            });

            pageBlocks.push({
              object: "block",
              type: "heading_2",
              heading_2: {
                rich_text: [
                  {
                    type: "text",
                    text: {
                      content:
                        aiMode === "short_summary"
                          ? "📌 Key Takeaways"
                          : "📝 Study Notes & Breakdown",
                    },
                  },
                ],
              },
            });

            pageBlocks.push(...markdownToBlocks(rawText));
          }
        } catch (aiErr) {
          console.error("Workers AI error:", aiErr);
        }
      }

      // Step 6.2: Create Notion Page
      const notionKey = (env.NOTION_API_KEY || "").trim();
      const databaseId =
        dbType === "techTube"
          ? (env.TECH_TUBE_DB_ID || "").trim()
          : (env.NOTES_TUBE_DB_ID || "").trim();

      const properties = {
        title: { title: [{ text: { content: videoTitle } }] },
        "Source Link": {
          rich_text: [{ text: { content: cleanUrl, link: { url: cleanUrl } } }],
        },
        Source: { multi_select: [{ name: "Youtube" }] },
      };

      if (thumbUrl) {
        properties["Thumbnail"] = {
          files: [
            {
              name: "thumbnail.jpg",
              type: "external",
              external: { url: thumbUrl },
            },
          ],
        };
      }

      const notionPayload = {
        parent: { database_id: databaseId },
        properties: properties,
      };

      // Notion allows at most 100 blocks per request, so send the first batch
      // on creation and append the remainder afterwards.
      const initialChildren = takeBlocks(pageBlocks, 100);
      const remainingBlocks = pageBlocks.slice(initialChildren.length);
      if (initialChildren.length > 0) {
        notionPayload.children = initialChildren;
      }

      const notionRes = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + notionKey,
          "Content-Type": "application/json",
          "Notion-Version": "2022-06-28",
        },
        body: JSON.stringify(notionPayload),
      });

      const notionData = await notionRes.json();
      if (!notionRes.ok) {
        return new Response(
          JSON.stringify({
            error: notionData.message || "Failed Notion creation",
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      // Append any leftover blocks in batches of 100.
      while (remainingBlocks.length > 0) {
        const batch = takeBlocks(remainingBlocks, 100);
        if (batch.length === 0) break;
        remainingBlocks.splice(0, batch.length);

        const appendRes = await fetch(
          "https://api.notion.com/v1/blocks/" + notionData.id + "/children",
          {
            method: "PATCH",
            headers: {
              Authorization: "Bearer " + notionKey,
              "Content-Type": "application/json",
              "Notion-Version": "2022-06-28",
            },
            body: JSON.stringify({ children: batch }),
          },
        );
        if (!appendRes.ok) {
          console.warn("Failed to append extra Notion blocks:", await appendRes.text());
          break;
        }
      }

      const cleanId = notionData.id.replace(/-/g, "");
      const appUrl = "notion://www.notion.so/" + cleanId;

      return new Response(
        JSON.stringify({ success: true, appUrl: appUrl, url: notionData.url }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  },
};

// Constants for YouTube access
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const ANDROID_VR_UA =
  "com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12; GB) gzip";
const ANDROID_VR_CLIENT = {
  clientName: "ANDROID_VR",
  clientVersion: "1.60.19",
  androidSdkVersion: 32,
  hl: "en",
  gl: "US",
};

// Safety ceiling only (~60k tokens). Long videos used to be hard-cut at 24k
// chars, which silently dropped everything past the first ~20-30 minutes.
const MAX_TRANSCRIPT_CHARS = 200000;

// Each chunk must fit comfortably in the model's input window, so long
// transcripts are summarized in overlapping map steps and then merged.
const NOTE_CHUNK_CHARS = 16000;

const NOTES_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";

const NOTES_SYSTEM_PROMPT = `You are an expert technical note-taker who turns video transcripts into clean, well-structured study notes in Markdown.

Formatting rules:
1. Group related ideas under short section headings written as "## Heading".
2. Under each heading, use "- " bullets. Use nested bullets with two-space indentation for sub-points.
3. Use numbered lists "1. " only for sequential steps or rankings.
4. Bold the **key terms**, **tools**, **metrics**, or **mechanisms** with **double asterisks**.
5. Wrap exact commands, code, file names, or identifiers in \`backticks\`.
6. Keep every line short and dense (roughly 8-18 words). No paragraphs, no filler, no meta-talk ("the speaker says", "in this video").
7. Never repeat the video title or add a top-level "# " heading.`;

function capTranscript(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > MAX_TRANSCRIPT_CHARS
    ? clean.slice(0, MAX_TRANSCRIPT_CHARS)
    : clean;
}

// Split on sentence boundaries near the target size so chunks stay coherent.
function chunkText(text, size) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= size) return clean ? [clean] : [];
  const chunks = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + size, clean.length);
    if (end < clean.length) {
      const dot = clean.lastIndexOf(". ", end);
      if (dot > start + size * 0.5) end = dot + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) chunks.push(piece);
    start = end;
  }
  return chunks;
}

async function runNotesModel(ai, userContent, maxTokens) {
  const res = await ai.run(NOTES_MODEL, {
    messages: [
      { role: "system", content: NOTES_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    max_tokens: maxTokens,
    temperature: 0.1,
  });
  return (res && res.response ? res.response : "").trim();
}

// Generate study notes for the whole video. Short transcripts are done in one
// pass; long ones (tech talks, podcasts) are mapped chunk-by-chunk and then
// reduced into a single de-duplicated document so no segment is dropped.
async function generateNotes(
  ai,
  { aiMode, videoTitle, cleanUrl, description, transcript },
) {
  const isShort = aiMode === "short_summary";
  const header =
    `Video Title: "${videoTitle}"\nURL: ${cleanUrl}\n\n` +
    (description ? `Description / Timestamps:\n${description}\n\n` : "");

  const task = isShort
    ? 'Task: Output 3 to 5 ultra-concise bullets capturing the core takeaway. Start directly with "- " bullets (no headings). Keep each under 15 words.'
    : "Task: Output structured Markdown study notes using '## ' section headings and '-' bullets (plus nested sub-bullets where useful). Be short, direct, and keyword-heavy.";

  if (!transcript) {
    return runNotesModel(ai, header + task, isShort ? 300 : 800);
  }

  if (transcript.length <= NOTE_CHUNK_CHARS) {
    return runNotesModel(ai, `${header}Spoken Transcript:\n${transcript}\n\n${task}`, isShort ? 400 : 800);
  }

  const chunks = chunkText(transcript, NOTE_CHUNK_CHARS);
  const partials = [];
  for (let i = 0; i < chunks.length; i++) {
    const mapTask = isShort
      ? 'Task: List 3 to 5 ultra-concise bullets for THIS segment only. Start directly with "- " bullets, no headings.'
      : "Task: Extract detailed study notes covering EVERY point in THIS segment. Use '## ' section headings and '-' bullets with nested sub-bullets. Do not omit any point; no preamble.";
    const userContent = `${header}Spoken Transcript (part ${i + 1} of ${chunks.length}):\n${chunks[i]}\n\n${mapTask}`;
    try {
      const notes = await runNotesModel(ai, userContent, isShort ? 300 : 1200);
      if (notes) partials.push(notes);
    } catch (e) {
      console.warn(`Notes chunk ${i + 1} failed:`, e);
    }
  }

  if (partials.length === 0) return "";
  if (partials.length === 1) return partials[0];

  const reduceContent =
    header +
    "Below are study notes for each consecutive part of the video, in order. " +
    "Merge them into ONE coherent, de-duplicated set of study notes that preserves every unique point from every part.\n\n" +
    partials.map((p, i) => `--- Part ${i + 1} ---\n${p}`).join("\n\n") +
    (isShort
      ? '\n\nTask: Output 3 to 5 ultra-concise bullets capturing the core takeaway. Start directly with "- " bullets, no headings.'
      : "\n\nTask: Output the merged Markdown study notes using '## ' section headings and '-' bullets (nested where useful). Keep it short and keyword-heavy; never drop a unique point.");

  try {
    return await runNotesModel(ai, reduceContent, isShort ? 400 : 3000);
  } catch (e) {
    console.warn("Notes reduce step failed, using concatenated parts:", e);
    return partials.join("\n\n");
  }
}

// Helper: Extract English transcript and description from YouTube video
async function getYouTubeContent(videoId, transcriptApiKey) {
  let transcript = "";
  let description = "";
  let title = "";

  if (!videoId) return { transcript, description, title };

  // 1. Primary transcript source: FreeTranscriptAPI.
  //    Its servers handle YouTube's PoToken / datacenter-IP bot checks that
  //    make direct caption requests return empty bodies from Workers. It is
  //    keyless (anonymous IP rate limit) but accepts an optional API key for
  //    higher limits via the TRANSCRIPT_API_KEY secret.
  const apiResult = await getFreeTranscript(videoId, transcriptApiKey);
  if (apiResult) {
    transcript = capTranscript(apiResult.text);
    title = apiResult.title;
  }

  // 2. Watch page: used for the description and as a caption-track fallback
  let pageTracks = [];
  try {
    const videoPageRes = await fetch(
      `https://www.youtube.com/watch?v=${videoId}`,
      {
        headers: {
          "User-Agent": BROWSER_UA,
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
    );
    const html = await videoPageRes.text();

    const descMatch = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
    if (descMatch && descMatch[1]) {
      description = decodeEscapedString(descMatch[1]).substring(0, 1500);
    }

    const captionTracksMatch = html.match(/"captionTracks":\s*(\[[\s\S]*?\])/);
    if (captionTracksMatch && captionTracksMatch[1]) {
      try {
        pageTracks = JSON.parse(captionTracksMatch[1]);
      } catch (e) {}
    }
  } catch (e) {
    console.warn("Watch page extraction error:", e);
  }

  // 3. Fallback transcript source: InnerTube player via the Android VR client.
  //    Watch-page tracks carry `exp=xpe`, which require a PoToken and return
  //    empty bodies to server-side requests; the VR client sometimes still
  //    returns usable caption URLs. Only used when the API above failed.
  if (!transcript) {
    const innerTubeTracks = await fetchCaptionTracks(videoId);

    // 4. Build a de-duplicated, English-first candidate list and try each
    //    source until a transcript is actually returned.
    const candidates = [];
    const seenUrls = new Set();
    const ordered = [
      ...innerTubeTracks.filter((t) => isEnglish(t)),
      ...pageTracks.filter((t) => isEnglish(t)),
      ...innerTubeTracks,
      ...pageTracks,
    ];
    for (const track of ordered) {
      if (track && track.baseUrl && !seenUrls.has(track.baseUrl)) {
        seenUrls.add(track.baseUrl);
        candidates.push(track);
      }
    }

    for (const track of candidates) {
      try {
        const transcriptRes = await fetch(track.baseUrl, {
          headers: {
            "User-Agent": ANDROID_VR_UA,
            "Accept-Language": "en-US,en;q=0.9",
          },
        });
        const transcriptBody = await transcriptRes.text();
        const parsed = parseTranscript(transcriptBody);
        if (parsed) {
          transcript = capTranscript(parsed);
          break;
        }
      } catch (e) {
        console.warn("Transcript fetch error:", e);
      }
    }
  }

  return { transcript, description, title };
}

// FreeTranscriptAPI: keyless YouTube transcript endpoint. Returns
// { language, title, transcript: [{ text, start, duration }] }.
async function getFreeTranscript(videoId, apiKey) {
  try {
    const headers = { "User-Agent": BROWSER_UA, Accept: "application/json" };
    if (apiKey) headers.Authorization = "Bearer " + apiKey.trim();

    const res = await fetch(
      "https://api.freetranscriptapi.com/v1/transcript?video_url=" +
        encodeURIComponent(videoId),
      { headers },
    );
    if (!res.ok) {
      console.warn("FreeTranscriptAPI HTTP " + res.status);
      return null;
    }

    const data = await res.json();
    const segments = Array.isArray(data && data.transcript)
      ? data.transcript
      : [];
    const text = segments
      .map((s) => (s && s.text ? s.text : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) return null;
    return { text, title: (data && data.title) || "" };
  } catch (e) {
    console.warn("FreeTranscriptAPI error:", e);
    return null;
  }
}


function isEnglish(track) {
  return (
    track &&
    typeof track.languageCode === "string" &&
    track.languageCode.toLowerCase().startsWith("en")
  );
}

async function fetchCaptionTracks(videoId) {
  try {
    const res = await fetch(
      "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": ANDROID_VR_UA,
        },
        body: JSON.stringify({
          context: { client: ANDROID_VR_CLIENT },
          videoId: videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      },
    );
    const data = await res.json();
    return (
      (data &&
        data.captions &&
        data.captions.playerCaptionsTracklistRenderer &&
        data.captions.playerCaptionsTracklistRenderer.captionTracks) ||
      []
    );
  } catch (e) {
    console.warn("InnerTube caption error:", e);
    return [];
  }
}

function decodeEscapedString(str) {
  try {
    return JSON.parse('"' + str + '"');
  } catch (e) {
    return str
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\//g, "/")
      .replace(/\\\\/g, "\\");
  }
}

function decodeEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16)),
    )
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// YouTube returns either json3 or srv3/legacy XML. Handle both, because the
// Android VR caption URLs come back as srv3 (`<p t=".." d="..">text</p>`)
// which the old `<text>`-only parser silently dropped.
function parseTranscript(body) {
  const text = (body || "").trim();
  if (!text) return "";

  if (text.startsWith("{")) {
    try {
      const data = JSON.parse(text);
      return (data.events || [])
        .filter((ev) => Array.isArray(ev.segs))
        .map((ev) => ev.segs.map((s) => s.utf8 || "").join(""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    } catch (e) {}
  }

  const lines = [];
  const blockRegex = /<(?:p|text)\b[^>]*>([\s\S]*?)<\/(?:p|text)>/g;
  let match;
  while ((match = blockRegex.exec(text)) !== null) {
    const segment = decodeEntities(match[1].replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (segment) lines.push(segment);
  }
  return lines.join(" ");
}

// Convert inline Markdown (bold, italic, strikethrough, code, links) into
// Notion rich_text objects.
function parseRichText(text) {
  const source = String(text == null ? "" : text);
  const parts = [];
  const pattern =
    /(\*\*([^*]+)\*\*|__([^_]+)__|~~([^~]+)~~|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*]+)\*|_([^_]+)_)/g;
  let last = 0;
  let match;

  const pushText = (content, annotations, link) => {
    if (!content) return;
    const obj = { type: "text", text: { content: content.slice(0, 2000) } };
    if (link) obj.text.link = { url: link };
    if (annotations) obj.annotations = annotations;
    parts.push(obj);
  };

  while ((match = pattern.exec(source)) !== null) {
    if (match.index > last) pushText(source.slice(last, match.index));
    if (match[2] !== undefined) pushText(match[2], { bold: true });
    else if (match[3] !== undefined) pushText(match[3], { bold: true });
    else if (match[4] !== undefined) pushText(match[4], { strikethrough: true });
    else if (match[5] !== undefined) pushText(match[5], { code: true });
    else if (match[6] !== undefined) pushText(match[6], null, match[7]);
    else if (match[8] !== undefined) pushText(match[8], { italic: true });
    else if (match[9] !== undefined) pushText(match[9], { italic: true });
    last = pattern.lastIndex;
  }
  if (last < source.length) pushText(source.slice(last));

  if (parts.length === 0) {
    return [{ type: "text", text: { content: source.slice(0, 2000) } }];
  }
  return parts;
}

const NOTION_LANGUAGES = {
  js: "javascript",
  javascript: "javascript",
  ts: "typescript",
  typescript: "typescript",
  py: "python",
  python: "python",
  sh: "shell",
  bash: "shell",
  shell: "shell",
  zsh: "shell",
  json: "json",
  html: "html",
  css: "css",
  java: "java",
  go: "go",
  golang: "go",
  rust: "rust",
  sql: "sql",
  c: "c",
  cpp: "c++",
  "c++": "c++",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  markdown: "markdown",
};

function normalizeLanguage(lang) {
  return NOTION_LANGUAGES[(lang || "").toLowerCase()] || "plain text";
}

// Render a Markdown document (as emitted by the AI) into Notion blocks.
// Supports headings, bullets (with one nesting level), numbered lists, to-dos,
// quotes, fenced code blocks, dividers and paragraphs.
function markdownToBlocks(markdown) {
  const lines = String(markdown || "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const blocks = [];
  const stack = [];

  const attach = (block, indent) => {
    while (stack.length && indent <= stack[stack.length - 1].indent) stack.pop();
    if (stack.length === 0) {
      blocks.push(block);
      stack.push({ block, indent });
    } else if (stack.length === 1) {
      const parent = stack[0].block;
      parent[parent.type].children = parent[parent.type].children || [];
      parent[parent.type].children.push(block);
      stack.push({ block, indent });
    } else {
      const parent = stack[1].block;
      parent[parent.type].children = parent[parent.type].children || [];
      parent[parent.type].children.push(block);
    }
  };

  const simple = (type, content) => ({
    object: "block",
    type,
    [type]: { rich_text: parseRichText(content) },
  });

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      i++;
      stack.length = 0;
      blocks.push({
        object: "block",
        type: "code",
        code: {
          rich_text: [{ type: "text", text: { content: code.join("\n").slice(0, 2000) } }],
          language: normalizeLanguage(fence[1]),
        },
      });
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      stack.length = 0;
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      stack.length = 0;
      blocks.push({ object: "block", type: "divider", divider: {} });
      i++;
      continue;
    }

    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const type = "heading_" + Math.min(heading[1].length, 3);
      stack.length = 0;
      blocks.push(simple(type, heading[2]));
      i++;
      continue;
    }

    const indent = line.match(/^[ \t]*/)[0].replace(/\t/g, "  ").length;

    const todo = trimmed.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (todo) {
      attach(
        {
          object: "block",
          type: "to_do",
          to_do: {
            rich_text: parseRichText(todo[2]),
            checked: todo[1].toLowerCase() === "x",
          },
        },
        indent,
      );
      i++;
      continue;
    }

    const quote = trimmed.match(/^>\s?(.*)$/);
    if (quote) {
      stack.length = 0;
      blocks.push(simple("quote", quote[1]));
      i++;
      continue;
    }

    const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (numbered) {
      attach(simple("numbered_list_item", numbered[1]), indent);
      i++;
      continue;
    }

    const bullet = trimmed.match(/^[-*•+]\s+(.*)$/);
    if (bullet) {
      attach(simple("bulleted_list_item", bullet[1]), indent);
      i++;
      continue;
    }

    stack.length = 0;
    blocks.push(simple("paragraph", trimmed));
    i++;
  }

  return blocks;
}

// Count blocks including nested children so we never exceed Notion's 100-per-
// request limit.
function countBlocks(blocks) {
  let n = 0;
  for (const block of blocks) {
    n++;
    const payload = block && block[block.type];
    if (payload && Array.isArray(payload.children)) {
      n += countBlocks(payload.children);
    }
  }
  return n;
}

// Return the longest leading slice of `blocks` whose total block count
// (including nested children) is at most `max`.
function takeBlocks(blocks, max) {
  const out = [];
  let n = 0;
  for (const block of blocks) {
    const size = countBlocks([block]);
    if (n + size > max) break;
    out.push(block);
    n += size;
  }
  return out;
}


function renderHTML(url) {
  const sharedText =
    url.searchParams.get("text") ||
    url.searchParams.get("url") ||
    url.searchParams.get("title") ||
    "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>Tube to Notion</title>
  <link rel="manifest" href="/manifest.json" />
  <link rel="icon" type="image/svg+xml" href="/icon.png" />
  <link rel="apple-touch-icon" href="/icon.png" />
  <meta name="theme-color" content="#0f1117" />
  <style>
    :root {
      --bg: #0f1117; --card: #181c27; --border: #282f44;
      --primary: #6366f1; --text: #f3f4f6; --muted: #9ca3af;
      --success: #10b981; --danger: #ef4444;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg); color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 16px;
    }
    .card {
      background: var(--card); border: 1px solid var(--border);
      border-radius: 14px; width: 100%; max-width: 380px; padding: 22px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.5);
    }
    h2 { font-size: 17px; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
    label { font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; margin-bottom: 6px; display: block; }
    input, select {
      width: 100%; background: #11141f; border: 1px solid var(--border);
      color: var(--text); padding: 10px 12px; border-radius: 8px; margin-bottom: 14px;
      font-size: 13px; outline: none;
    }
    .mode-group { display: flex; gap: 6px; margin-bottom: 18px; }
    .mode-btn {
      flex: 1; padding: 9px 4px; background: #11141f; border: 1px solid var(--border);
      color: var(--muted); border-radius: 6px; font-size: 11px; cursor: pointer; font-weight: 600;
    }
    .mode-btn.active { background: var(--primary); color: #fff; border-color: var(--primary); }
    .btn-save {
      width: 100%; padding: 12px; background: var(--primary); color: #fff;
      border: none; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 14px;
    }
    .btn-save:disabled { opacity: 0.5; cursor: not-allowed; }
    #status { margin-top: 12px; font-size: 12px; text-align: center; min-height: 18px; }
  </style>
</head>
<body>
  <div class="card">
    <h2><span>⚡</span> Tube to Notion</h2>
    
    <label>YouTube Link</label>
    <input type="text" id="videoUrl" placeholder="Paste or shared link..." />

    <label>Destination</label>
    <select id="dbSelect">
      <option value="notesTube">Notes Tube</option>
      <option value="techTube">Tech Tube</option>
    </select>

    <label>Note Mode</label>
    <div class="mode-group" id="modeGroup">
      <button type="button" class="mode-btn" data-mode="manual">Manual</button>
      <button type="button" class="mode-btn active" data-mode="short_summary">Summary</button>
      <button type="button" class="mode-btn" data-mode="detailed_points">Detailed</button>
    </div>

    <button id="saveBtn" class="btn-save">Process & Save</button>
    <div id="status"></div>
  </div>

  <script>
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(err => console.error(err));
      });
    }

    const urlInput = document.getElementById("videoUrl");
    const dbSelect = document.getElementById("dbSelect");
    const saveBtn = document.getElementById("saveBtn");
    const statusDiv = document.getElementById("status");
    let currentMode = "short_summary";

    const shared = "${sharedText.replace(/"/g, '\\"')}";
    if (shared) {
      const match = shared.match(/https?:\\/\\/[^\\s]+/);
      urlInput.value = match ? match[0] : shared;
    }

    document.querySelectorAll(".mode-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".mode-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        currentMode = btn.dataset.mode;
      });
    });

    saveBtn.addEventListener("click", async () => {
      const rawUrl = urlInput.value.trim();
      if (!rawUrl) return;

      saveBtn.disabled = true;
      statusDiv.style.color = "var(--muted)";
      statusDiv.innerText = currentMode !== "manual" 
        ? "Fetching transcript & generating notes..." 
        : "Creating Notion page...";

      try {
        const resp = await fetch("/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: rawUrl,
            dbType: dbSelect.value,
            aiMode: currentMode
          })
        });

        const data = await resp.json();
        if (resp.ok && data.success && data.appUrl) {
          statusDiv.style.color = "var(--success)";
          statusDiv.innerText = "✅ Saved! Opening Notion…";

          // 1) Open the newly created Notion page / app via the deep link.
          try {
            window.location.href = data.appUrl;
          } catch (e) {}

          // 2) Auto-close this window. This succeeds when the page runs as an
          //    installed PWA / share-target window; regular browser tabs may
          //    refuse to close programmatically, so we leave a hint.
          setTimeout(() => {
            try { window.close(); } catch (e) {}
            setTimeout(() => {
              statusDiv.innerText = "✅ Saved to Notion. You can close this window.";
            }, 900);
          }, 800);
        } else {
          throw new Error(data.error || "Failed to process");
        }
      } catch (err) {
        statusDiv.style.color = "var(--danger)";
        statusDiv.innerText = "Error: " + err.message;
        saveBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}
