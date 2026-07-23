// HTTP service built on Node's http module (no framework). Serves the recorder
// page and accepts a raw audio upload, returning the timestamped transcription
// as JSON.
//
//   node src/server.ts            # listens on :3000, open http://localhost:3000
//   curl -s --data-binary @recording.mp3 \
//        -H "Content-Type: audio/mpeg" \
//        http://localhost:3000/transcribe | jq
//
// Raw-body upload keeps this dependency-free; a production service would swap
// in multipart/form-data (busboy/multer) and stream to disk rather than buffer.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { getBackend } from "./backends.ts";
import { transcribeAudio } from "./pipeline.ts";

// Load .env (GOOGLE_GEMINI_KEY etc.) into process.env if the file exists.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — rely on the ambient environment */
}

const PORT = Number(process.env.PORT ?? 3000);
const MAX_BYTES = 100 * 1024 * 1024; // 100 MB guard

const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, { status: "ok" });
  }
  // Serve the browser recorder page.
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    try {
      const html = readFileSync(new URL("../public/index.html", import.meta.url));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    } catch {
      return json(res, 500, { error: "index.html not found" });
    }
  }
  if (req.method !== "POST" || !req.url?.startsWith("/transcribe")) {
    return json(res, 404, { error: "POST /transcribe with an audio body" });
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const backendName = url.searchParams.get("backend") ?? "gemini";
  const language = url.searchParams.get("language");

  // Read the upload as it streams in (the body arrives in network-sized pieces),
  // enforcing the size cap along the way, then join it into the full audio buffer.
  const parts: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > MAX_BYTES) {
      req.destroy();
      return json(res, 413, { error: "Payload too large" });
    }
    parts.push(part);
  }
  if (size === 0) return json(res, 400, { error: "Empty body — send audio bytes" });

  // Everything stays in memory — no temp file to write or clean up.
  try {
    const audio = Buffer.concat(parts);
    const result = await transcribeAudio(audio, { backend: getBackend(backendName), language });
    return json(res, 200, result);
  } catch (err) {
    return json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

function json(res: import("node:http").ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(payload);
}

server.listen(PORT, () => {
  console.log(`Transcription service on http://localhost:${PORT}`);
  console.log(`  GET  /                                     ← open this to record & transcribe`);
  console.log(`  POST /transcribe    (audio bytes as body)`);
  console.log(`  GET  /health`);
});
