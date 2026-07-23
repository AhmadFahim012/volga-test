// Audio helpers: format detection, duration probing, and long-audio chunking.
//
// No decoding happens here — Gemini decodes audio server-side. We only need to
// identify the format (to pick a MIME type) and know the duration. WAV duration
// is parsed straight from the header (no deps); other formats use ffprobe if it
// happens to be installed, otherwise the pipeline falls back gracefully.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { extname } from "node:path";

export type AudioFormat = "wav" | "mp3" | "m4a" | "flac" | "ogg" | "unknown";

// Magic-byte sniffing so we identify by content, not just by extension.
export function detectFormat(filePath: string): AudioFormat {
  const buf = readFileSync(filePath);
  const head = buf.subarray(0, 4).toString("ascii");

  if (head === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WAVE") return "wav";
  if (head === "OggS") return "ogg";
  if (head === "fLaC") return "flac";
  if (buf.subarray(0, 3).toString("ascii") === "ID3") return "mp3";
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3"; // MPEG frame sync
  if (buf.subarray(4, 8).toString("ascii") === "ftyp") return "m4a"; // MP4/M4A box

  const ext = extname(filePath).slice(1).toLowerCase();
  if (["wav", "mp3", "m4a", "flac", "ogg"].includes(ext)) return ext as AudioFormat;
  return "unknown";
}

// Parse a canonical PCM WAV header to get duration in seconds. No deps.
export function probeWavDuration(filePath: string): number {
  const buf = readFileSync(filePath);
  if (buf.subarray(0, 4).toString("ascii") !== "RIFF") throw new Error("Not a RIFF/WAV file");

  let offset = 12; // skip "RIFF"<size>"WAVE"
  let byteRate = 0;
  let dataSize = 0;

  while (offset + 8 <= buf.length) {
    const chunkId = buf.subarray(offset, offset + 4).toString("ascii");
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "fmt ") byteRate = buf.readUInt32LE(offset + 8 + 8);
    else if (chunkId === "data") dataSize = chunkSize;
    offset += 8 + chunkSize + (chunkSize % 2); // chunks are word-aligned
  }

  if (!byteRate) throw new Error("WAV missing fmt chunk");
  return dataSize / byteRate;
}

// Duration for any format: WAV natively, else ffprobe if available.
export function probeDuration(filePath: string): number {
  if (detectFormat(filePath) === "wav") return probeWavDuration(filePath);
  try {
    const out = execFileSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration",
       "-of", "default=noprint_wrappers=1:nokey=1", filePath],
      { encoding: "utf8" }
    );
    return parseFloat(out.trim());
  } catch {
    throw new Error("Cannot probe non-WAV duration without ffprobe. Install ffmpeg or use WAV.");
  }
}

export function assertExists(filePath: string): void {
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
}
