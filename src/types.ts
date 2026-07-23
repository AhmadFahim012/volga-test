// Shared types for the transcription pipeline.

// A contiguous chunk of transcribed speech with timing in seconds.
export interface Segment {
  start: number; // seconds from the beginning of the audio
  end: number; // seconds
  text: string;
}

// The full result the pipeline returns for one audio file.
export interface TranscriptionResult {
  text: string; // full transcript (all segments joined)
  segments: Segment[]; // per-segment text with timestamps
  language: string | null; // detected/forced language, if known
  durationSec: number; // total audio duration
  backend: string; // which engine produced this
}

// Any engine that can turn an audio file into timed segments.
// Decoupling behind this interface keeps the pipeline engine-agnostic — another
// backend could be added later without changing the orchestration code.
export interface Backend {
  readonly name: string;
  transcribe(audioPath: string, language?: string | null): Promise<Segment[]>;
}
