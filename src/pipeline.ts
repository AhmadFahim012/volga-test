// Pipeline orchestration: file in -> backend -> cleaned, timestamped result.
//
// This ties together format handling (Q4) and the long-audio strategy (Q5)
// around the selected Backend. The backend does the actual speech-to-text (and,
// for Gemini, the audio decoding); this module owns the surrounding concerns:
// segment cleaning, duration, and output shaping.

import type { Backend, Segment, TranscriptionResult } from "./types.ts";
import { assertExists, probeDuration } from "./audio.ts";

export interface PipelineOptions {
  backend: Backend;
  language?: string | null;
}

export async function transcribeFile(
  inputPath: string,
  opts: PipelineOptions
): Promise<TranscriptionResult> {
  assertExists(inputPath);

  // Q4: no local conversion — Gemini accepts the encoded audio and decodes it
  // server-side. The backend maps the detected format to the right MIME type.
  // Q5: hand the whole file to the backend; Gemini windows long audio internally
  // (and the File API path handles very large files — see README).
  const rawSegments = await opts.backend.transcribe(inputPath, opts.language ?? null);
  const segments = cleanSegments(rawSegments);

  return {
    text: segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim(),
    segments,
    language: opts.language ?? null,
    durationSec: probeDurationSafe(inputPath, segments),
    backend: opts.backend.name,
  };
}

// Duration in seconds, best-effort: probe the file (WAV natively, else ffprobe)
// and fall back to the last segment's end time when no prober is available.
function probeDurationSafe(filePath: string, segments: Segment[]): number {
  try {
    return probeDuration(filePath);
  } catch {
    return segments.length ? segments[segments.length - 1].end : 0;
  }
}

// Normalize segment text/timing: trim, drop empties, sort, and clamp any
// backward/overlapping timestamps so downstream consumers get monotonic times.
export function cleanSegments(segments: Segment[]): Segment[] {
  const cleaned: Segment[] = [];
  for (const s of segments) {
    const text = s.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const start = Math.max(0, s.start);
    const end = Math.max(start, s.end);
    cleaned.push({ start, end, text });
  }
  cleaned.sort((a, b) => a.start - b.start);
  return cleaned;
}

// Format seconds as HH:MM:SS.mmm for human-readable transcripts and subtitles.
export function formatTimestamp(seconds: number): string {
  const ms = Math.floor((seconds % 1) * 1000);
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

// Render segments as WebVTT — a concrete "downstream use" (captions/subtitles).
export function toVtt(result: TranscriptionResult): string {
  const lines = ["WEBVTT", ""];
  for (const seg of result.segments) {
    lines.push(`${formatTimestamp(seg.start)} --> ${formatTimestamp(seg.end)}`);
    lines.push(seg.text, "");
  }
  return lines.join("\n");
}
