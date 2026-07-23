# Transcription Pipeline

A simple audio-to-text pipeline that accepts an audio file, transcribes spoken
language, and returns **timestamped segments** for downstream use (captions,
search, diarization, etc.).

Written in **TypeScript**, run directly by Node (≥22) via native type-stripping —
**no build step** and no runtime dependencies of its own. Transcription uses
**Google Gemini** (free tier), which accepts audio directly and returns
timestamped segments. It sits behind a small **`Backend`** interface, so a
different engine could be dropped in later without touching the pipeline.

## Architecture

```
audio file ──▶ audio.ts ──▶ pipeline.ts ──▶ backend ──▶ segments ──▶ CLI / HTTP / Web
             (detect &      (orchestrate,   (Gemini)     (timestamps)  (json/vtt/text)
              probe)         clean, shape)
```

| File                | Responsibility                                                        |
| ------------------- | --------------------------------------------------------------------- |
| `src/types.ts`      | `Segment`, `TranscriptionResult`, and the `Backend` interface         |
| `src/audio.ts`      | format detection (magic bytes), duration probe, long-audio chunk planning |
| `src/backends.ts`   | the Gemini backend (structured-JSON transcription)                    |
| `src/pipeline.ts`   | orchestration: transcribe → clean → shape (json/vtt/text)             |
| `src/cli.ts`        | command-line entry point                                              |
| `src/server.ts`     | zero-dep HTTP service (also serves the recorder page)                 |
| `public/index.html` | browser mic-recorder UI — record/upload → timestamped transcript      |

The engine sits behind the `Backend` interface (`{ name, transcribe }`), so the
pipeline (file handling, format detection, long-audio strategy, output contract)
stays independent of the STT engine.

## Setup

```bash
npm install                       # dev-only deps (@types/node, typescript)

# put your key in a .env file (auto-loaded; .env is gitignored)
echo 'GOOGLE_GEMINI_KEY=your_key_from_ai_studio' > .env
```

The key is read from `GOOGLE_GEMINI_KEY`, `GEMINI_API_KEY`, or `GOOGLE_API_KEY`.
Set `GEMINI_MODEL` to override the default model (`gemini-flash-latest`).

## Quick start

**Speak into your browser** (easiest):

```bash
node src/server.ts        # then open http://localhost:3000
```

Click **Start recording**, talk, click **Stop** — the page records your mic,
encodes it to WAV in-browser (no ffmpeg), sends it to the server, and shows the
transcript with per-segment timestamps. You can also upload an audio file there.

**Command line:**

```bash
# transcribe any audio file with speech (mp3 / wav / m4a — no ffmpeg needed)
node src/cli.ts recording.mp3 --pretty          # human-readable + timestamps
node src/cli.ts recording.mp3 --format json     # structured segments
node src/cli.ts recording.mp3 --format vtt      # WebVTT subtitles

# raw HTTP call
curl --data-binary @recording.mp3 -H "Content-Type: audio/mpeg" \
     "http://localhost:3000/transcribe?ext=mp3"
```

---

## Answers

### Q1: Accept an audio file
Three ways in, all feeding the same pipeline:

- **Browser page** — `public/index.html` (served at `/`) records from the mic via
  `getUserMedia`, encodes to 16 kHz mono WAV client-side (Web Audio API), and
  posts it. It also accepts a file picker. No ffmpeg, works on any machine.
- **Script/CLI** — `src/cli.ts` takes a file path argument and streams the result
  to stdout or `--out`. It sniffs the format by magic bytes, not just extension.
- **Service** — `src/server.ts` exposes `POST /transcribe` (Node's built-in
  `http`, no framework). It accepts the raw audio bytes as the request body with a
  100 MB size guard, writes to a temp file, transcribes, cleans up, and returns
  JSON. Raw-body upload keeps it dependency-free; a production version would swap
  in `multipart/form-data` (busboy/multer) and stream to disk rather than buffer
  the whole file in memory.

### Q2: Transcribe spoken language into text
`transcribeFile()` in `src/pipeline.ts` calls the Gemini backend
(`src/backends.ts`). It sends the audio to Gemini's `generateContent` endpoint
and uses **structured JSON output** (a `responseSchema`) so the model returns
clean `{start, end, text}` segments instead of free-form text we'd have to parse.
No local model and no ffmpeg — Gemini decodes and transcribes server-side.

The engineering decision here is the **`Backend` interface**: the pipeline owns
the file handling, format detection, long-audio strategy, and output contract,
while the STT engine stays swappable. Gemini is the one shipped implementation;
another (a local model, a different API) could be added without changing the
pipeline.

### Q3: Return transcription with timestamps per segment
The output is `{ text, segments, language, durationSec, backend }`, where each
segment is `{ start, end, text }` in seconds. `cleanSegments()` trims text, drops
empties, sorts by start time, and clamps any backward/overlapping timestamps so
downstream consumers get monotonic timing. Three renderings are built in:
- `--format json` — structured segments (for search, indexing, further processing)
- `--format vtt`  — WebVTT captions (`toVtt()`), a concrete downstream use
- `--pretty`      — `[HH:MM:SS.mmm → HH:MM:SS.mmm] text` lines for humans

### Q4: How do you handle different audio formats?
1. **Detect by content, not extension** — `detectFormat()` reads magic bytes
   (RIFF/WAVE, ID3/MPEG sync, `ftyp`, `OggS`, `fLaC`) and only falls back to the
   file extension when the header is inconclusive. This catches mislabeled files.
2. **Map to the right MIME type and let Gemini decode** — Gemini natively accepts
   `wav`, `mp3`, `m4a/aac`, `flac`, and `ogg`, so we map the detected format to
   its MIME type and send the encoded bytes as-is. There's **no local decoding or
   ffmpeg** — decoding happens server-side. Unsupported formats are rejected with
   a clear error rather than sent as garbage.
3. **Browser codec handled client-side** — the mic page records `webm/opus`
   (which Gemini doesn't accept), so it re-encodes to WAV in the browser via the
   Web Audio API before uploading. The format problem is solved where the audio
   is produced, again with no ffmpeg.

Duration is read straight from the WAV header (no deps); for other formats it
uses `ffprobe` if present, otherwise it falls back to the last segment's end
time — so a missing ffmpeg never breaks transcription.

### Q5: How do you deal with long audio files?
Long audio is a memory, latency, and accuracy problem. The strategy:

1. **Small files go inline** — the Gemini backend base64-inlines the audio and
   **guards at ~15 MB** (the request cap). Past that it errors with a pointer to
   Gemini's **File API** (upload once, reference by URI), which is the right path
   for large/long recordings and avoids buffering the whole file into a request.
2. **Chunk into overlapping windows** — `planChunks()` in `src/audio.ts` splits a
   long timeline into ~30 s windows with ~1 s overlap. The overlap prevents words
   from being cut at boundaries. This is the concrete strategy for an engine that
   can't ingest a long file in one call.
3. **Transcribe chunk-by-chunk and stitch** — each window is transcribed
   independently and its timestamps are shifted back by the window's start offset
   so the final timeline is continuous. This bounds peak memory (one window at a
   time, not the whole file) and lets windows run in parallel.
4. **De-duplicate overlaps** — because windows overlap, boundary words can appear
   twice; `cleanSegments()` sorts and normalizes timing, and a production version
   would drop duplicate text in the overlap region when merging.

For very large batches you'd also make it a **queue-backed async job**: upload →
enqueue → workers transcribe chunks → assemble → notify, rather than holding an
HTTP connection open for minutes.

---

## Design decisions (the "why")

- **No build step, no core dependencies** — Node runs the TypeScript directly;
  the only npm packages are dev-time types.
- **Backend interface** — transcription sits behind `{ name, transcribe }`, so
  the engine can be swapped without touching the pipeline's file handling,
  format detection, long-audio strategy, or output contract.
- **Let Gemini decode** — sending encoded audio and letting the API decode it
  server-side removes the whole ffmpeg/PCM-conversion surface from our side.
- **Structured output** — a `responseSchema` makes Gemini return typed
  `{start, end, text}` segments, so there's no brittle text parsing.
- **Functions over classes** — no per-backend mutable lifecycle to model, so a
  factory function returning the backend object is simpler than a class.
- **Content-based format detection** — identify by magic bytes, not extension,
  so mislabeled files are handled correctly.
- **Secrets in `.env`** — auto-loaded via `process.loadEnvFile()`, and `.env` is
  gitignored so keys never get committed.
