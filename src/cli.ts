#!/usr/bin/env node
// CLI entry point (Q1–Q3): accept an audio file, transcribe it, and print the
// transcription with per-segment timestamps.
//
// Usage:
//   node src/cli.ts <audio-file> [--language en] [--format json|vtt|text]
//                                [--pretty] [--out <file>]

import { writeFileSync } from "node:fs";
import { getBackend } from "./backends.ts";
import { transcribeFile, toVtt, formatTimestamp } from "./pipeline.ts";

// Load .env (GOOGLE_GEMINI_KEY etc.) into process.env if the file exists.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — rely on the ambient environment */
}

interface Args {
  input?: string;
  backend: string;
  language: string | null;
  format: "json" | "vtt" | "text";
  pretty: boolean;
  out?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { backend: "gemini", language: null, format: "json", pretty: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--backend") args.backend = argv[++i];
    else if (a === "--language" || a === "--lang") args.language = argv[++i];
    else if (a === "--format") args.format = argv[++i] as Args["format"];
    else if (a === "--pretty") args.pretty = true;
    else if (a === "--out" || a === "-o") args.out = argv[++i];
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (!a.startsWith("-")) args.input = a;
  }
  return args;
}

function printHelp(): void {
  console.log(`transcribe — audio to timestamped text

Usage:
  node src/cli.ts <audio-file> [options]

Options:
  --backend <name>   gemini (default)
  --language <code>  force a language, e.g. en (default: auto)
  --format <fmt>     json (default) | vtt | text
  --pretty           human-readable text with timestamps
  --out, -o <file>   write output to a file instead of stdout
  --help, -h         show this help`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    printHelp();
    process.exit(1);
  }

  const result = await transcribeFile(args.input, {
    backend: getBackend(args.backend),
    language: args.language,
  });

  let output: string;
  if (args.pretty || args.format === "text") {
    output = result.segments
      .map((s) => `[${formatTimestamp(s.start)} → ${formatTimestamp(s.end)}] ${s.text}`)
      .join("\n");
  } else if (args.format === "vtt") {
    output = toVtt(result);
  } else {
    output = JSON.stringify(result, null, 2);
  }

  if (args.out) {
    writeFileSync(args.out, output);
    console.error(`Wrote ${result.segments.length} segments (${result.durationSec.toFixed(1)}s) to ${args.out}`);
  } else {
    console.log(output);
  }
}

main().catch((err) => {
  console.error("Error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
