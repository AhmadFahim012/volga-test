// Transcription backend: Google Gemini (free tier).
//
// The engine is a factory function returning a `Backend` object
// (`{ name, transcribe }`, see types.ts). Keeping it behind that interface means
// another engine could be dropped in later without touching the pipeline.
//
// Gemini accepts encoded audio directly and DECODES IT SERVER-SIDE, so we never
// need a local decoder or ffmpeg — we just send the bytes and ask for timestamped
// segments back via structured JSON output. Needs an API key (free from Google AI
// Studio). Small files are inlined as base64; see README/Q5 for the File API path
// used for large/long recordings.

import type { Backend, Segment } from "./types.ts";

// Map our detected format to the MIME type Gemini expects.
const GEMINI_MIME: Record<string, string> = {
  wav: "audio/wav",
  mp3: "audio/mp3",
  m4a: "audio/aac",
  flac: "audio/flac",
  ogg: "audio/ogg",
};
const GEMINI_INLINE_LIMIT = 15 * 1024 * 1024; // stay under the ~20MB request cap

export function createGeminiBackend(
  apiKey = process.env.GEMINI_API_KEY ??
    process.env.GOOGLE_GEMINI_KEY ??
    process.env.GOOGLE_API_KEY ??
    "",
  // "…-latest" alias tracks the current free-tier Flash model. Override with
  // GEMINI_MODEL if your project has quota for a specific pinned version.
  model = process.env.GEMINI_MODEL ?? "gemini-flash-latest"
): Backend {
  return {
    name: "gemini",
    async transcribe(audioPath: string, language?: string | null): Promise<Segment[]> {
      if (!apiKey) throw new Error("No Gemini API key set (GOOGLE_GEMINI_KEY)");
      const { readFileSync } = await import("node:fs");
      const { detectFormat } = await import("./audio.ts");

      const fmt = detectFormat(audioPath);
      const mimeType = GEMINI_MIME[fmt];
      if (!mimeType) throw new Error(`Unsupported audio format '${fmt}' for Gemini`);

      const bytes = readFileSync(audioPath);
      if (bytes.length > GEMINI_INLINE_LIMIT) {
        throw new Error(
          `File is ${(bytes.length / 1e6).toFixed(1)}MB; too large to inline. ` +
          `Use the Gemini File API for large/long audio (see README Q5).`
        );
      }

      const prompt =
        "Transcribe this audio into segments that cover the entire recording. " +
        "Split at natural sentence or pause boundaries. Provide accurate start " +
        "and end times in SECONDS (numbers) for each segment. " +
        (language ? `The spoken language is '${language}'. ` : "") +
        "Do not invent speech that is not present.";

      const url =
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [
            { parts: [{ text: prompt }, { inlineData: { mimeType, data: bytes.toString("base64") } }] },
          ],
          // Structured output: force clean {start, end, text} segments so we don't
          // have to parse free-form model text.
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                language: { type: "string" },
                segments: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      start: { type: "number" },
                      end: { type: "number" },
                      text: { type: "string" },
                    },
                    required: ["start", "end", "text"],
                  },
                },
              },
              required: ["segments"],
            },
          },
        }),
      });

      if (!res.ok) {
        // Surface the concise API message instead of dumping the whole payload.
        let detail = await res.text();
        try {
          detail = JSON.parse(detail)?.error?.message ?? detail;
        } catch {
          /* keep raw text */
        }
        if (res.status === 429) {
          detail +=
            `\nHint: free-tier quota for '${model}' may be 0 in your region. ` +
            `Try a different GEMINI_MODEL, or enable billing (Gemini still ` +
            `has a generous free allowance once billing is on).`;
        }
        throw new Error(`Gemini API error ${res.status}: ${detail}`);
      }

      const data: any = await res.json();
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!raw) throw new Error("Gemini API returned no content");

      const parsed = JSON.parse(raw);
      return (parsed.segments ?? []).map((s: any) => ({
        start: Number(s.start) || 0,
        end: Number(s.end) || 0,
        text: String(s.text ?? ""),
      }));
    },
  };
}

export function getBackend(name = "gemini"): Backend {
  switch (name.toLowerCase()) {
    case "gemini":
    case "google":
      return createGeminiBackend();
    default:
      throw new Error(`Unknown backend: ${name}`);
  }
}
