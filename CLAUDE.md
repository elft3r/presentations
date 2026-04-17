# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Reveal.js (v5.2.1) presentation repository containing multiple HTML slide decks deployed to GitHub Pages, with PR preview deployments via Cloudflare Pages.

## Common Commands

- **Build all presentations:** `npm run build` — copies reveal.js dist/plugins from node_modules into each presentation, copies custom themes, then stages everything into `_site/`
- **Serve locally:** `npm run start:cloud-migrations`, `npm run start:docker-training`, `npm run start:secure-landing-zones` — serves on port 8000 via `npx serve`
- **Check slide rendering:** `npm run check-render` — renders every slide headlessly in landscape and portrait and reports content that exceeds the logical slide box. Add deck names (`npm run check-render -- docker-training`) or `-- --viewport=portrait` to narrow. Output: `.claude/cache/overflow-report.{json,txt}`. (Further render-based categories — contrast, resources, console, print, motion, focus, regression — are being added incrementally.)
- **Install deps:** `npm install`

## Architecture

### Presentations

Three independent presentations live in top-level directories: `cloud-migrations/`, `docker-training/`, `secure-landing-zones/`. Each contains:
- `index.html` — main entry point with Reveal.js initialization
- `sections/` — individual slide HTML files loaded dynamically via the custom `plugin/external/external.js` plugin using `data-external` attributes
- `dist/` — reveal.js core files (copied by build, gitignored)
- `plugin/` — reveal.js plugins (stock ones copied by build + custom `external/` and `title-footer/`)
- `imgs/` — presentation-specific images

### Build System

`scripts/build.js` is the sole build script. It iterates over the `PRESENTATIONS` array, copies reveal.js dist and plugins from `node_modules/`, overlays custom themes from `custom-themes/`, and stages output into `_site/`. To add a new presentation, add its directory name to the `PRESENTATIONS` array in this file and add a corresponding `start:` script in `package.json`.

### Shared Theming

`custom-themes/` contains shared CSS files copied into each presentation's `dist/theme/` at build time:
- `white_contrast_compact_verbatim_headers.css` — main theme (accent: Mariposit Green `#24584C`, links: Metallic Gold `#B39A6A`). Includes component classes: `.section-title`, `.card`, `.badge`, `.styled-list`, `.source`, `.social-links`, `.divider`
- `utilities.css` — Tailwind-like layout utilities (flex, grid, spacing, sizing, typography)

Source of truth for design tokens, component classes, and layout utilities is `custom-themes/`. Do not duplicate values in slides (prefer CSS variables and utility classes over inline styles) and do not duplicate the rules in agent prompts — agents should read these files directly.

### CI/CD

- `.github/workflows/deploy.yml` — deploys `_site/` to GitHub Pages on push to main
- `.github/workflows/preview.yml` — deploys PR previews to Cloudflare Pages with bot comment
