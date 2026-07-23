# Transcription Pipeline

Audio in → **text with per-segment timestamps** out. TypeScript on Node (≥22),
run directly with no build step. Transcription uses the **Google Gemini** API
(free tier); everything else is Node built-ins.

## Architecture

```
audio ──▶ audio.ts ──▶ pipeline.ts ──▶ Backend ──▶ segments ──▶ HTTP + Web page
        (detect &     (orchestrate,   (Gemini)    (timestamps)      (JSON)
         probe)        clean, shape)
```

| File | Responsibility |
| --- | --- |
| `src/types.ts` | `Segment`, `TranscriptionResult`, and the `Backend` interface |
| `src/audio.ts` | format detection (magic bytes) and duration probe |
| `src/backends.ts` | the Gemini backend (structured-JSON transcription) |
| `src/pipeline.ts` | orchestration: transcribe → clean → shape |
| `src/server.ts` | HTTP service; also serves the browser page |
| `public/index.html` | browser mic recorder / file upload → timestamped transcript |

**Two design choices drive it:** (1) a **linear pipeline** where each stage does
one job, so pieces are independently testable; and (2) a **pluggable `Backend`**
so the STT engine — the part most likely to change — is swappable without
touching file handling, format detection, or output. Gemini is the shipped
implementation; another model would just be a new factory function.

## Setup

```bash
npm install                       # dev-only: @types/node, typescript
cp .env.example .env              # then add your GOOGLE_GEMINI_KEY
```

Get a free key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
Override the model with `GEMINI_MODEL` (default `gemini-flash-latest`).

## Usage

```bash
node src/server.ts                # then open http://localhost:3000
```

In the browser: **record from your mic or upload a file** → see the transcript
with per-segment timestamps. Or call the endpoint directly:

```bash
curl --data-binary @recording.mp3 -H "Content-Type: audio/mpeg" \
     "http://localhost:3000/transcribe?ext=mp3"
```

Output: `{ text, segments: [{ start, end, text }], language, durationSec }`.

## Key decisions

- **Backend interface** — transcription sits behind `{ name, transcribe }`, so the
  engine can be swapped without changing the pipeline.
- **Let Gemini decode** — audio is sent encoded and decoded server-side, so there's
  no ffmpeg or PCM handling on our side.
- **Structured output** — a `responseSchema` makes Gemini return typed
  `{start, end, text}` segments, avoiding brittle text parsing.
- **Detect by magic bytes**, not extension, so mislabeled files still work.
- **Functions over classes** — no per-backend state to model, so a factory is simpler.
- **Secrets in `.env`** — auto-loaded, gitignored, never committed.

## Notes on scale

- **Formats**: Gemini accepts wav/mp3/m4a/flac/ogg directly; the browser re-encodes
  its webm/opus recording to WAV client-side.
- **Long audio**: files are inlined up to ~15 MB, then Gemini's File API takes over.
  For an engine that can't ingest a long file at once, the fallback is to split into
  overlapping ~30 s windows and stitch the results back together by offset.
- **Production**: store audio in object storage + transcript rows in a DB, expose an
  async `POST` (job id) + `GET /{id}` API, and retry transient failures with backoff.
