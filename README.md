# Paper Flow

Paper Flow is an Obsidian plugin for paper-heavy notes. It detects paper URLs in Markdown files, resolves paper metadata, downloads open-access PDFs, refreshes citation counts, and generates Mermaid literature maps.

## Features

- Watches modified Markdown files and extracts paper URLs.
- Resolves metadata from Semantic Scholar, arXiv, Crossref, OpenAlex, and citation meta tags.
- Downloads open-access PDFs when a PDF URL is available.
- Inserts a managed metadata table between `paper-flow` HTML comments.
- Periodically refreshes citation counts.
- Generates a Mermaid paper map for the current note.

## Commands

- `Paper Flow: Process paper URLs in current note`
- `Paper Flow: Update known paper citation counts now`
- `Paper Flow: Generate Mermaid paper map for current note`

## Supported URLs

- arXiv abstract and PDF URLs.
- DOI URLs.
- Semantic Scholar paper URLs.
- Direct PDF URLs.
- Publisher pages that expose `citation_*` metadata.

## Privacy and Network Access

Paper Flow sends paper identifiers, paper URLs, and paper titles to public metadata services in order to resolve metadata and citation counts. The plugin currently uses:

- Semantic Scholar
- arXiv
- Crossref
- OpenAlex

The plugin does not upload your full note content. It reads Markdown files locally and extracts URLs from them.

## File Changes

Paper Flow can modify Markdown notes by inserting or replacing generated blocks marked with:

- `<!-- paper-flow:start -->`
- `<!-- paper-flow:end -->`
- `<!-- paper-flow-map:start -->`
- `<!-- paper-flow-map:end -->`

Downloaded PDFs are saved inside your vault. The default folder is `papers/`.

## Development

Install dependencies:

```bash
npm install
```

Run type checks:

```bash
npm run typecheck
```

Build the plugin:

```bash
npm run build
```

For an Obsidian community release, attach these files to the GitHub release:

- `main.js`
- `manifest.json`
- `styles.css`

The GitHub release tag must match the `version` field in `manifest.json`.

## Notes

- Citation counts prefer Semantic Scholar. If Semantic Scholar is rate limited, OpenAlex and Crossref are used as fallbacks.
- Precise paper-to-paper arrows require reference data from Semantic Scholar. When that is unavailable, the map falls back to chronological "later development" arrows.
- A Semantic Scholar API key is optional but recommended for stable citation updates and graph generation.
