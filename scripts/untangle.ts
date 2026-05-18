#!/usr/bin/env bun
/**
 * untangle.ts: Reverse-sync a changed source file back into the .lit.md,
 * then re-tangle (and optionally re-weave).
 *
 * Usage:  bun run untangle.ts <changed-file> [--lit-map <path>] [--weave]
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname, join } from "path";
import { execSync } from "child_process";

// ---------------------------------------------------------------------------
// Types (mirrored from tangle.ts)
// ---------------------------------------------------------------------------

interface Segment {
  outputStart: number;
  outputCount: number;
  chunkName: string;
  litmdStart: number;
  litmdCount: number;
  indent: string;
}

interface FileMapping {
  rootChunk: string;
  segments: Segment[];
}

interface SourceMap {
  litFile: string;
  outputDir: string;
  files: Record<string, FileMapping>;
}

// ---------------------------------------------------------------------------
// Find the .lit.map.json manifest
// ---------------------------------------------------------------------------

function findManifest(startDir: string, explicit?: string): string | null {
  if (explicit) {
    return existsSync(explicit) ? resolve(explicit) : null;
  }

  let dir = resolve(startDir);
  while (true) {
    const files = require("fs").readdirSync(dir) as string[];
    const match = files.find((f: string) => f.endsWith(".lit.map.json"));
    if (match) return join(dir, match);

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: bun run untangle.ts <changed-file> [--lit-map <path>] [--weave]",
    );
    process.exit(args.length === 0 ? 1 : 0);
  }

  const changedFile = args[0];
  const doWeave = args.includes("--weave");

  let litMapPath: string | undefined;
  const lmIdx = args.indexOf("--lit-map");
  if (lmIdx !== -1) {
    litMapPath = args[lmIdx + 1];
  }

  // Find the manifest
  const manifestPath = findManifest(process.cwd(), litMapPath);
  if (!manifestPath) {
    // Not a tangled project. Exit silently.
    process.exit(0);
  }

  const manifest: SourceMap = JSON.parse(readFileSync(manifestPath, "utf-8"));

  // Resolve the changed file relative to outputDir
  const absChanged = resolve(changedFile);
  const absOutputDir = resolve(dirname(manifestPath), manifest.outputDir);

  // Find matching file in manifest
  let relPath: string | null = null;
  let mapping: FileMapping | null = null;

  for (const [filePath, fileMapping] of Object.entries(manifest.files)) {
    const absFile = resolve(absOutputDir, filePath);
    if (absFile === absChanged) {
      relPath = filePath;
      mapping = fileMapping;
      break;
    }
  }

  if (!relPath || !mapping) {
    // File not in manifest. Exit silently.
    process.exit(0);
  }

  // Read the changed source file and the .lit.md
  const litFilePath = resolve(dirname(manifestPath), manifest.litFile);
  const sourceLines = readFileSync(absChanged, "utf-8").split("\n");
  const litLines = readFileSync(litFilePath, "utf-8").split("\n");

  // Process segments bottom-up to preserve line offsets
  const sortedSegments = [...mapping.segments].sort(
    (a, b) => b.litmdStart - a.litmdStart,
  );

  let changed = false;

  for (const seg of sortedSegments) {
    // Extract lines from the changed source file
    const newSourceLines = sourceLines.slice(
      seg.outputStart,
      seg.outputStart + seg.outputCount,
    );

    // Strip the indent that was added during tangling
    const strippedLines = newSourceLines.map((line) => {
      if (line === "") return "";
      if (seg.indent && line.startsWith(seg.indent)) {
        return line.slice(seg.indent.length);
      }
      return line;
    });

    // Extract current lines from the .lit.md
    const currentLitLines = litLines.slice(
      seg.litmdStart,
      seg.litmdStart + seg.litmdCount,
    );

    // Check if the source file segment has changed line count (structural change)
    if (strippedLines.length !== currentLitLines.length) {
      // Line count matches because outputCount === litmdCount in a well-formed map.
      // But the source file may have had lines added/removed.
      // For now, if the source file has exactly the expected number of lines, splice them.
      // Otherwise, warn and skip.
      console.warn(
        `Warning: structural change in ${relPath} at output lines ${seg.outputStart}-${seg.outputStart + seg.outputCount}. ` +
          `Expected ${seg.outputCount} lines, skipping segment.`,
      );
      continue;
    }

    // Check if anything actually changed
    const linesMatch = strippedLines.every(
      (line, i) => line === currentLitLines[i],
    );
    if (linesMatch) continue;

    // Splice the new lines into the .lit.md
    litLines.splice(seg.litmdStart, seg.litmdCount, ...strippedLines);
    changed = true;
  }

  if (!changed) {
    console.log("No changes detected. .lit.md is up to date.");
    process.exit(0);
  }

  // Write the updated .lit.md
  writeFileSync(litFilePath, litLines.join("\n"));
  console.log(`Updated ${manifest.litFile}`);

  // Re-tangle to regenerate source files and refresh the manifest
  const tanglePath = resolve(dirname(import.meta.path), "tangle.ts");
  const q = (p: string) => `"${p}"`;
  console.log("Re-tangling...");
  execSync(
    `bun run ${q(tanglePath)} ${q(litFilePath)} --output-dir ${q(manifest.outputDir)}`,
    { stdio: "inherit", cwd: dirname(manifestPath) },
  );

  // Optionally weave
  if (doWeave) {
    console.log("Weaving PDF...");
    const pdfPath = litFilePath.replace(/\.lit\.md$/, ".pdf");

    const isWindows = process.platform === "win32";
    let mermaidFilterPath: string | null = null;
    try {
      const probe = isWindows ? "where mermaid-filter" : "which mermaid-filter";
      const found = execSync(probe, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .split(/\r?\n/)
        .find((line) => line.trim().length > 0);
      if (found) mermaidFilterPath = found.trim();
    } catch {
      // not found
    }

    const filterArg = mermaidFilterPath
      ? `--filter ${q(mermaidFilterPath)} `
      : "";
    if (!mermaidFilterPath) {
      console.warn(
        "mermaid-filter not found. Weaving without it — any mermaid fences will appear as code blocks. Convert them to TikZ {=latex} blocks for proper rendering.",
      );
    }

    execSync(
      `pandoc ${q(litFilePath)} -o ${q(pdfPath)} --pdf-engine=xelatex ${filterArg}--toc --number-sections`,
      { stdio: "inherit", cwd: dirname(manifestPath) },
    );
    console.log(`Generated ${pdfPath}`);
  }
}

main();
