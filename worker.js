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
          const { transcript, description } = await getYouTubeContent(videoId);

          // Concise, keyword-anchored system prompt
          const systemPrompt = `You are a concise technical note-taker. 
Extract only the essential insights and terminology spoken in the video transcript.

Strict Output Rules:
1. Every bullet must be short, dense, and punchy (maximum 12 to 18 words per line). No paragraphs or run-on sentences.
2. Bold the specific **key terms**, **metrics**, **tools**, or **mechanisms** discussed.
3. Eliminate intro filler, meta-talk (e.g., "The speaker discusses", "In this video"), and obvious context.
4. Output strictly as bullet points starting with "- ". Do not use markdown headers (# or ##).`;

          let contextBody = `Video Title: "${videoTitle}"\nURL: ${cleanUrl}\n\n`;
          if (description) {
            contextBody += `Description / Timestamps:\n${description}\n\n`;
          }
          if (transcript) {
            contextBody += `Spoken Transcript:\n${transcript}\n\n`;
          }

          contextBody +=
            aiMode === "short_summary"
              ? "Task: Output exactly 3 to 5 ultra-concise bullet points capturing the core takeaway. Keep each point under 15 words."
              : "Task: Output structured bullet points grouped by key points/concepts mentioned. Keep each bullet point short, direct, and keyword-heavy.";

          const aiResponse = await env.AI.run(
            "@cf/meta/llama-3.1-8b-instruct-fp8-fast",
            {
              messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: contextBody },
              ],
              max_tokens: 600, // Reduced from 1200 to enforce concise brevity
              temperature: 0.1, // Lowered for direct, factual extraction without embellishment
            },
          );

          const rawText = aiResponse?.response || "";
          if (rawText) {
            pageBlocks.push({
              object: "block",
              type: "heading_3",
              heading_3: {
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

            const lines = rawText.split("\n");
            for (const line of lines) {
              const clean = line.replace(/^[\*\-\•\#]+\s*/, "").trim();
              if (clean.length > 0 && !clean.startsWith("```")) {
                pageBlocks.push({
                  object: "block",
                  type: "bulleted_list_item",
                  bulleted_list_item: {
                    rich_text: parseMarkdownToRichText(
                      clean.substring(0, 1900),
                    ),
                  },
                });
              }
            }
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

      if (pageBlocks.length > 0) {
        notionPayload.children = pageBlocks;
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

// Helper: Extract English transcript and description from YouTube video
async function getYouTubeContent(videoId) {
  let transcript = "";
  let description = "";

  if (!videoId) return { transcript, description };

  try {
    const videoPageRes = await fetch(
      `[https://www.youtube.com/watch?v=$](https://www.youtube.com/watch?v=$){videoId}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
    );
    const html = await videoPageRes.text();

    const descMatch = html.match(/"shortDescription":"(.*?)"/);
    if (descMatch && descMatch[1]) {
      description = descMatch[1]
        .replace(/\\n/g, "\n")
        .replace(/\\"/g, '"')
        .substring(0, 1500);
    }

    const captionTracksMatch = html.match(/"captionTracks":\s*(\[.*?\])/);
    if (captionTracksMatch && captionTracksMatch[1]) {
      const captionTracks = JSON.parse(captionTracksMatch[1]);
      const track =
        captionTracks.find((t) => t.languageCode === "en") || captionTracks[0];

      if (track && track.baseUrl) {
        const transcriptRes = await fetch(track.baseUrl);
        const transcriptXml = await transcriptRes.text();

        const textMatches = [
          ...transcriptXml.matchAll(/<text[^>]*>(.*?)<\/text>/g),
        ];
        const rawLines = textMatches.map((m) =>
          m[1]
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/\n/g, " ")
            .trim(),
        );

        transcript = rawLines.join(" ").substring(0, 24000);
      }
    }
  } catch (e) {
    console.warn("Transcript extraction error:", e);
  }

  return { transcript, description };
}

function parseMarkdownToRichText(text) {
  const parts = [];
  const regex = /\*\*(.*?)\*\*/g;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({
        type: "text",
        text: { content: text.substring(lastIndex, match.index) },
        annotations: { bold: false },
      });
    }
    if (match[1].length > 0) {
      parts.push({
        type: "text",
        text: { content: match[1] },
        annotations: { bold: true },
      });
    }
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push({
      type: "text",
      text: { content: text.substring(lastIndex) },
      annotations: { bold: false },
    });
  }
  return parts.length > 0 ? parts : [{ type: "text", text: { content: text } }];
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
          statusDiv.innerText = "Saved! Opening Notion...";
          setTimeout(() => { window.location.href = data.appUrl; }, 300);
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
