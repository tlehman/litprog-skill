# Literate Programming Skill for Claude Code

A Claude Code skill that transforms codebases into literate programs. These are documents written for human comprehension that also generate the original source code.

## What is Literate Programming?

Literate programming was invented by **Donald Knuth** in 1984. Knuth is the author of *The Art of Computer Programming*, creator of TeX, and winner of the 1974 Turing Award. He introduced literate programming as a paradigm where programs are written as essays for human readers, with code embedded in a narrative.

A literate program produces two outputs:

- **Weave**: Produce a readable document (PDF, HTML) with prose, diagrams, and syntax-highlighted code.
- **Tangle**: Extract runnable source files from the document.

The key insight: present code in *psychological order*. That is, the order that makes it easiest to understand, not the order the compiler needs.

## What This Skill Does

- Installs as a Claude Code skill (via `SKILL.md`)
- Gives Claude the ability to analyze a codebase and produce a `.lit.md` file
- The `.lit.md` file weaves prose, Mermaid diagrams, LaTeX math, and syntax-highlighted code into a narrative
- Includes a tangler (`scripts/tangle.ts`) that extracts source files back from the `.lit.md`
- Includes a reverse-sync engine (`scripts/untangle.ts`) that updates the `.lit.md` when source files are edited directly
- Includes a PostToolUse hook (`scripts/hook-reverse-sync.ts`) for automatic reverse-sync in Claude Code
- Running `/literate-programming` on an existing `.lit.md` just weaves + tangles (idempotent)
- Supports PDF generation via Pandoc

## Installation

Copy `SKILL.md` into your project's `.claude/skills/` directory:

```bash
git clone https://github.com/tlehman/litprog-skill.git
mkdir -p your-project/.claude/skills/
cp litprog-skill/SKILL.md your-project/.claude/skills/literate-programming.md
```

Claude Code automatically discovers skills from `.claude/skills/` in your project root. After copying, the `/literate-programming` slash command will be available in any Claude Code session within that project.

## Usage

### Create a literate program

Ask Claude to create a literate program from your codebase:

> /literate-programming

Claude will analyze your code, determine the best narrative order, and produce a `.lit.md` file with prose, diagrams, and named code chunks.

If a `.lit.md` already exists, running `/literate-programming` will just tangle and weave the existing file without recreating it.

### Reverse-sync (automatic)

After creation, a PostToolUse hook is configured so that when you edit a source file directly, the changes are automatically synced back into the `.lit.md` and re-tangled. This keeps the `.lit.md` as the single source of truth.

The hook does NOT regenerate the PDF on every edit. To regenerate the PDF, run `/literate-programming` again.

### Tangle (extract source code)

```bash
bun run scripts/tangle.ts project.lit.md --output-dir ./src/
```

This expands all root chunks and writes the source files. Verify by diffing against the original source.

### Weave (generate PDF)

```bash
pandoc project.lit.md \
  -o project.pdf \
  --pdf-engine=xelatex \
  --filter mermaid-filter \
  --toc \
  --number-sections
```

**Prerequisites for weave:** pandoc, xelatex, mermaid-filter

For setup instructions, see `references/pandoc-setup.md`.

## Why Use This?

- **Optimized for reading**: Code is read far more often than it is written. Literate programs optimize for reading.
- **Explains the why**: Forces the author to explain *why*, not just *what*. Every code block is preceded by prose that motivates its existence.
- **Beautiful PDFs**: Produces documents with diagrams and math alongside code.
- **Architectural clarity**: Reveals architectural decisions that comments and READMEs miss. The narrative structure shows how pieces fit together.
- **Knowledge transfer**: Useful for onboarding, code reviews, and preserving institutional knowledge. A new team member can read the literate program start to finish and understand the system.
