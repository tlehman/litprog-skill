#!/usr/bin/env bun
/**
 * tangle.ts — Extract source code from a .lit.md literate program.
 *
 * Usage:  bun run tangle.ts <file.lit.md> [--output-dir <dir>]
 *
 * Parses fenced code blocks annotated with {chunk="name" file="path"},
 * resolves <<chunk-name>> references, and writes root chunks to disk.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname, resolve, join } from "path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Chunk {
  name: string;
  file?: string; // only root chunks carry a file path
  lang: string;
  lines: string[];
  startLine: number; // 0-based line in the .lit.md where chunk content starts
}

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
// Parsing
// ---------------------------------------------------------------------------

const FENCE_OPEN =
  /^```(\w*)\s*\{([^}]*)\}\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const ATTR_CHUNK = /chunk\s*=\s*"([^"]+)"/;
const ATTR_FILE = /file\s*=\s*"([^"]+)"/;
const CHUNK_REF = /^(\s*)<<([^>]+)>>\s*$/;
const CHUNK_REF_STRICT = /^(\s*)<<([^>]+)>>$/;

function parseChunks(source: string): Chunk[] {
  const lines = source.split("\n");
  const chunks: Chunk[] = [];
  let current: Chunk | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (current) {
      if (FENCE_CLOSE.test(line)) {
        chunks.push(current);
        current = null;
      } else {
        current.lines.push(line);
      }
      continue;
    }

    const m = line.match(FENCE_OPEN);
    if (!m) continue;

    const lang = m[1] || "";
    const attrs = m[2];
    const chunkMatch = attrs.match(ATTR_CHUNK);
    if (!chunkMatch) continue; // not a named chunk — skip

    const fileMatch = attrs.match(ATTR_FILE);
    current = {
      name: chunkMatch[1],
      file: fileMatch ? fileMatch[1] : undefined,
      lang,
      lines: [],
      startLine: i + 1, // content starts on the line after the fence opener
    };
  }

  if (current) {
    console.error(`Warning: unclosed chunk "${current.name}" at end of file`);
    chunks.push(current);
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Chunk dictionary (same name → concatenation)
// ---------------------------------------------------------------------------

interface Span {
  startLine: number; // 0-based line in .lit.md
  lineCount: number;
}

interface ChunkEntry {
  lang: string;
  lines: string[];
  spans: Span[];
  file?: string;
}

function buildDictionary(chunks: Chunk[]): Map<string, ChunkEntry> {
  const dict = new Map<string, ChunkEntry>();

  for (const c of chunks) {
    const span: Span = { startLine: c.startLine, lineCount: c.lines.length };
    const existing = dict.get(c.name);
    if (existing) {
      existing.lines.push(...c.lines);
      existing.spans.push(span);
      if (c.file) existing.file = c.file;
    } else {
      dict.set(c.name, {
        lang: c.lang,
        lines: [...c.lines],
        spans: [span],
        file: c.file,
      });
    }
  }

  return dict;
}

// ---------------------------------------------------------------------------
// Expansion (recursive, with cycle & indent handling)
// ---------------------------------------------------------------------------

interface ExpandResult {
  lines: string[];
  segments: Segment[];
}

function expand(
  name: string,
  dict: Map<string, ChunkEntry>,
  visited: Set<string>,
  referenced: Set<string>,
  outputOffset: number = 0,
  outerIndent: string = "",
): ExpandResult {
  if (visited.has(name)) {
    throw new Error(`Circular reference detected: ${name}`);
  }

  const entry = dict.get(name);
  if (!entry) {
    throw new Error(`Undefined chunk reference: <<${name}>>`);
  }

  visited.add(name);
  referenced.add(name);

  const lines: string[] = [];
  const segments: Segment[] = [];

  // Track position within the chunk's concatenated lines across all spans
  let chunkLineIdx = 0;

  for (const span of entry.spans) {
    let spanLocalIdx = 0;

    while (spanLocalIdx < span.lineCount) {
      const line = entry.lines[chunkLineIdx];
      // Use strict match (no trailing chars after >>)
      const ref = line.match(CHUNK_REF_STRICT);

      if (ref) {
        const indent = outerIndent + ref[1];
        const refName = ref[2].trim();
        const sub = expand(
          refName,
          dict,
          new Set(visited),
          referenced,
          outputOffset + lines.length,
          indent,
        );
        lines.push(...sub.lines);
        segments.push(...sub.segments);
      } else {
        // Literal line — start or continue a segment
        const lastSeg = segments[segments.length - 1];
        if (
          lastSeg &&
          lastSeg.chunkName === name &&
          lastSeg.litmdStart + lastSeg.litmdCount === span.startLine + spanLocalIdx &&
          lastSeg.outputStart + lastSeg.outputCount === outputOffset + lines.length &&
          lastSeg.indent === outerIndent
        ) {
          lastSeg.outputCount++;
          lastSeg.litmdCount++;
        } else {
          segments.push({
            outputStart: outputOffset + lines.length,
            outputCount: 1,
            chunkName: name,
            litmdStart: span.startLine + spanLocalIdx,
            litmdCount: 1,
            indent: outerIndent,
          });
        }
        lines.push(line === "" ? "" : outerIndent + line);
      }

      chunkLineIdx++;
      spanLocalIdx++;
    }
  }

  return { lines, segments };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: bun run tangle.ts <file.lit.md> [--output-dir <dir>] [--verify]");
    process.exit(args.length === 0 ? 1 : 0);
  }

  const inputFile = args[0];
  let outputDir = ".";
  const verifyMode = args.includes("--verify");

  const odIdx = args.indexOf("--output-dir");
  if (odIdx !== -1) {
    if (!args[odIdx + 1]) {
      console.error("Error: --output-dir requires a directory argument");
      process.exit(1);
    }
    outputDir = args[odIdx + 1];
  }

  const source = readFileSync(inputFile, "utf-8");
  const chunks = parseChunks(source);

  if (chunks.length === 0) {
    console.error("No named chunks found in", inputFile);
    process.exit(1);
  }

  const dict = buildDictionary(chunks);

  // Find root chunks (those with file=)
  const roots: [string, ChunkEntry][] = [];
  for (const [name, entry] of dict) {
    if (entry.file) roots.push([name, entry]);
  }

  if (roots.length === 0) {
    console.error('No root chunks (with file="...") found');
    process.exit(1);
  }

  const referenced = new Set<string>();
  let errors = 0;

  const sourceMap: SourceMap = {
    litFile: inputFile,
    outputDir,
    files: {},
  };

  let verifyMismatches = 0;

  // Group root chunks by output file — multiple roots can share the same file,
  // in which case they are concatenated in document order.
  const rootsByFile = new Map<string, [string, ChunkEntry][]>();
  for (const [name, entry] of roots) {
    const existing = rootsByFile.get(entry.file!);
    if (existing) {
      existing.push([name, entry]);
    } else {
      rootsByFile.set(entry.file!, [[name, entry]]);
    }
  }

  for (const [filePath, fileRoots] of rootsByFile) {
    const allLines: string[] = [];
    const allSegments: Segment[] = [];
    let outputOffset = 0;

    for (const [name, entry] of fileRoots) {
      try {
        const result = expand(name, dict, new Set(), referenced);
        for (const seg of result.segments) {
          // Adjust segment offsets to account for previously concatenated roots
          allSegments.push({
            ...seg,
            outputStart: seg.outputStart + outputOffset,
          });
        }
        allLines.push(...result.lines);
        outputOffset += result.lines.length;
      } catch (e: any) {
        console.error(`Error expanding chunk "${name}": ${e.message}`);
        errors++;
      }
    }

    const outPath = resolve(outputDir, filePath);
    const tangled = allLines.join("\n") + "\n";

    if (verifyMode) {
      if (existsSync(outPath)) {
        const existing = readFileSync(outPath, "utf-8");
        if (existing !== tangled) {
          const existingLines = existing.split("\n");
          const tangledLines = tangled.split("\n");
          let firstDiff = -1;
          const maxLen = Math.max(existingLines.length, tangledLines.length);
          for (let i = 0; i < maxLen; i++) {
            if (existingLines[i] !== tangledLines[i]) {
              firstDiff = i + 1;
              break;
            }
          }
          console.error(`MISMATCH: ${filePath} (first difference at line ${firstDiff})`);
          console.error(`  existing: ${JSON.stringify(existingLines[firstDiff - 1] ?? "<EOF>")}`);
          console.error(`  tangled:  ${JSON.stringify(tangledLines[firstDiff - 1] ?? "<EOF>")}`);
          verifyMismatches++;
        } else {
          console.log(`  OK: ${filePath}`);
        }
      } else {
        console.error(`MISSING: ${filePath} (file does not exist)`);
        verifyMismatches++;
      }
    } else {
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, tangled);
      console.log(`  ${filePath}`);
    }

    sourceMap.files[filePath] = {
      rootChunk: fileRoots.map(([n]) => n).join(", "),
      segments: allSegments,
    };
  }

  if (!verifyMode) {
    // Write source map
    const mapPath = inputFile.replace(/\.lit\.md$/, ".lit.map.json");
    writeFileSync(mapPath, JSON.stringify(sourceMap, null, 2) + "\n");
    console.log(`  ${mapPath} (source map)`);
  }

  // Warn about unused chunks
  for (const [name] of dict) {
    if (!referenced.has(name)) {
      console.warn(`Warning: chunk "${name}" is defined but never referenced`);
    }
  }

  if (errors > 0) {
    console.error(`\n${errors} error(s) during tangling`);
    process.exit(1);
  }

  if (verifyMode) {
    if (verifyMismatches > 0) {
      console.error(`\nVerification failed: ${verifyMismatches} file(s) differ`);
      process.exit(1);
    } else {
      console.log(`\nVerification passed: ${rootsByFile.size} file(s) match`);
    }
  } else {
    console.log(`\nTangled ${rootsByFile.size} file(s) into ${resolve(outputDir)}`);
  }
}

main();
