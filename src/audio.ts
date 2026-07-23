// Audio helpers: format detection and duration probing. Both operate on the
// in-memory audio bytes — no files, no decoding (Gemini decodes server-side).

export type AudioFormat = "wav" | "mp3" | "m4a" | "flac" | "ogg" | "unknown";

// Identify the format from the file's magic bytes (its signature), not a
// filename — more reliable, and we only ever have the raw bytes here.
export function detectFormat(buf: Buffer): AudioFormat {
  const head = buf.subarray(0, 4).toString("ascii");

  if (head === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WAVE") return "wav";
  if (head === "OggS") return "ogg";
  if (head === "fLaC") return "flac";
  if (buf.subarray(0, 3).toString("ascii") === "ID3") return "mp3";
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "mp3"; // MPEG frame sync
  if (buf.subarray(4, 8).toString("ascii") === "ftyp") return "m4a"; // MP4/M4A box

  return "unknown";
}

// Duration in seconds from a canonical PCM WAV header: dataSize / byteRate.
// Pure header arithmetic, no dependencies.
export function probeWavDuration(buf: Buffer): number {
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

// Best-effort duration: available cheaply for WAV. For other formats it throws,
// and the pipeline falls back to the last segment's end time.
export function probeDuration(buf: Buffer): number {
  if (detectFormat(buf) === "wav") return probeWavDuration(buf);
  throw new Error("Duration is only derivable from a WAV header here");
}
