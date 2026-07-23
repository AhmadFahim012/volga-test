// Pipeline orchestration: audio bytes -> backend -> cleaned, timestamped result.
//
// The backend does the actual speech-to-text (and, for Gemini, the audio
// decoding); this module owns the surrounding concerns: segment cleaning,
// duration, and output shaping.

import type { Backend, Segment, TranscriptionResult } from "./types.ts";
import { probeDuration } from "./audio.ts";

export interface PipelineOptions {
  backend: Backend;
  language?: string | null;
}

export async function transcribeAudio(
  audio: Buffer,
  opts: PipelineOptions
): Promise<TranscriptionResult> {
  // No local conversion — Gemini accepts the encoded bytes and decodes them
  // server-side, so we hand the audio straight to the backend.
  const rawSegments = await opts.backend.transcribe(audio, opts.language ?? null);
  const segments = cleanSegments(rawSegments);

  return {
    text: segments.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim(),
    segments,
    language: opts.language ?? null,
    durationSec: probeDurationSafe(audio, segments),
    backend: opts.backend.name,
  };
}

// Best-effort duration: derive it from a WAV header when possible, otherwise
// fall back to the last segment's end time.
function probeDurationSafe(audio: Buffer, segments: Segment[]): number {
  try {
    return probeDuration(audio);
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
