#!/usr/bin/env node
// Headless design-check runner for Reveal.js decks.
// Categories land incrementally. Active today:
//   - overflow: content exceeds the 960x700 (landscape) / 540x960 (portrait) slide box
//   - contrast: text below WCAG AA (<4.5:1 normal, <3:1 large) against its effective bg
//
// Playwright is not a repo dependency; it's resolved from the global
// install at /opt/node22/lib/node_modules/playwright (with local
// fallback so `npm i -D playwright` remains a drop-in replacement).

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PRESENTATIONS = ['cloud-migrations', 'secure-landing-zones', 'docker-training'];
const GLOBAL_PW = '/opt/node22/lib/node_modules/playwright';

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (_) {
    try {
      return require(GLOBAL_PW);
    } catch (e) {
      throw new Error(
        `Playwright not found. Install locally with "npm i -D playwright" ` +
          `or ensure the global install exists at ${GLOBAL_PW}. ` +
          `Underlying error: ${e.message}`
      );
    }
  }
}

function parseNonNegInt(flag, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(`--${flag} must be a non-negative integer, got: ${raw}`);
  }
  return n;
}

function parsePosFloat(flag, raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--${flag} must be a positive number, got: ${raw}`);
  }
  return n;
}

const CATEGORIES_AVAILABLE = ['overflow', 'contrast', 'resources', 'console'];

function parseArgs(argv) {
  const opts = {
    decks: [],
    viewport: 'both',
    out: path.join(ROOT, '.claude', 'cache', 'render-report.json'),
    thresholdInfo: 0,
    thresholdWarn: 4,
    thresholdCritical: 16,
    contrastAA: 4.5, // normal text AA
    contrastAALarge: 3.0, // large text AA
    categories: null, // default: all currently-implemented categories
    port: 0,
  };
  for (const arg of argv) {
    const m = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (m) {
      const [, k, v] = m;
      if (k === 'viewport') opts.viewport = v;
      else if (k === 'out') opts.out = path.resolve(v);
      else if (k === 'threshold-info') opts.thresholdInfo = parseNonNegInt(k, v);
      else if (k === 'threshold-warn') opts.thresholdWarn = parseNonNegInt(k, v);
      else if (k === 'threshold-critical') opts.thresholdCritical = parseNonNegInt(k, v);
      else if (k === 'contrast-aa') opts.contrastAA = parsePosFloat(k, v);
      else if (k === 'contrast-aa-large') opts.contrastAALarge = parsePosFloat(k, v);
      else if (k === 'categories') opts.categories = v.split(',').map((s) => s.trim()).filter(Boolean);
      else if (k === 'port') opts.port = parseNonNegInt(k, v);
      else throw new Error(`Unknown flag: --${k}`);
    } else if (!arg.startsWith('-')) {
      if (!PRESENTATIONS.includes(arg)) {
        throw new Error(`Unknown presentation: ${arg}. Known: ${PRESENTATIONS.join(', ')}`);
      }
      opts.decks.push(arg);
    } else {
      throw new Error(`Unrecognized arg: ${arg}`);
    }
  }
  if (opts.decks.length === 0) opts.decks = [...PRESENTATIONS];
  if (!['landscape', 'portrait', 'print', 'both', 'all'].includes(opts.viewport)) {
    throw new Error(`--viewport must be landscape|portrait|print|both|all`);
  }
  if (
    opts.thresholdInfo > opts.thresholdWarn ||
    opts.thresholdWarn >= opts.thresholdCritical
  ) {
    throw new Error(
      `Thresholds must satisfy info <= warn < critical (got info=${opts.thresholdInfo}, warn=${opts.thresholdWarn}, critical=${opts.thresholdCritical})`
    );
  }
  if (opts.contrastAALarge > opts.contrastAA) {
    throw new Error(
      `--contrast-aa-large must be <= --contrast-aa (got ${opts.contrastAALarge} vs ${opts.contrastAA})`
    );
  }
  if (!opts.categories) opts.categories = [...CATEGORIES_AVAILABLE];
  for (const c of opts.categories) {
    if (!CATEGORIES_AVAILABLE.includes(c)) {
      throw new Error(`Unknown category: ${c}. Available: ${CATEGORIES_AVAILABLE.join(', ')}`);
    }
  }
  return opts;
}

function ensureBuilt(decks) {
  const missing = decks.filter(
    (d) => !fs.existsSync(path.join(ROOT, d, 'dist', 'reveal.js'))
  );
  if (missing.length === 0) return;
  console.log(`Missing dist/ for ${missing.join(', ')} — running build...`);
  const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build.js')], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  if (res.status !== 0) {
    throw new Error(`build.js exited with status ${res.status}`);
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.md': 'text/markdown; charset=utf-8',
};

function startServer(rootDir, port) {
  const root = path.resolve(rootDir);
  const rootWithSep = root + path.sep;
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        if (rel === '' || rel.endsWith('/')) rel += 'index.html';
        const abs = path.resolve(root, rel);
        if (abs !== root && !abs.startsWith(rootWithSep)) {
          res.writeHead(403);
          return res.end();
        }
        fs.stat(abs, (err, stat) => {
          if (err || !stat.isFile()) {
            res.writeHead(404);
            return res.end();
          }
          res.writeHead(200, {
            'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store',
          });
          fs.createReadStream(abs).pipe(res);
        });
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function buildSectionLineMap(fileAbs) {
  // Return array of 1-based line numbers for each top-level <section ...> in DOM order.
  if (!fs.existsSync(fileAbs)) return [];
  const lines = fs.readFileSync(fileAbs, 'utf8').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*<section\b/.test(lines[i])) out.push(i + 1);
  }
  return out;
}

function indexHtmlLineFor(indexAbs, outerH) {
  // Line of the h-th top-level <section ...> inside <div class="slides">.
  const lines = fs.readFileSync(indexAbs, 'utf8').split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*<section\b/.test(lines[i])) hits.push(i + 1);
  }
  return hits[outerH] || 1;
}

function severityFor(px, t) {
  if (px <= t.info) return null;
  if (px <= t.warn) return 'INFO';
  if (px <= t.critical) return 'WARNING';
  return 'CRITICAL';
}

function severityForContrast(ratio, isLarge, aa, aaLarge) {
  const req = isLarge ? aaLarge : aa;
  if (ratio >= req) return null; // passes AA
  if (ratio >= 3.0) return 'WARNING'; // below normal-AA but above absolute readability
  return 'CRITICAL';
}

// In-page helpers injected into page.evaluate. Kept as a template string so the
// browser context can eval them; they depend only on window DOM APIs.
const IN_PAGE_CONTRAST_HELPERS = `
  function parseColor(str) {
    if (!str) return null;
    str = str.trim();
    let m = /^rgba?\\(([^)]+)\\)$/i.exec(str);
    if (m) {
      const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
      const a = parts.length >= 4 ? parts[3] : 1;
      if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
      return [parts[0], parts[1], parts[2], a];
    }
    m = /^#([0-9a-f]{6})$/i.exec(str);
    if (m) {
      const h = m[1];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
    }
    m = /^#([0-9a-f]{3})$/i.exec(str);
    if (m) {
      const h = m[1];
      return [parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16), 1];
    }
    return null;
  }
  function sRGBToLinear(c) {
    c = c / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function relLum(c) {
    return 0.2126 * sRGBToLinear(c[0]) + 0.7152 * sRGBToLinear(c[1]) + 0.0722 * sRGBToLinear(c[2]);
  }
  function contrastRatio(fg, bg) {
    const l1 = relLum(fg), l2 = relLum(bg);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  }
  function compositeOver(top, bottom) {
    const a = top[3];
    return [
      top[0] * a + bottom[0] * (1 - a),
      top[1] * a + bottom[1] * (1 - a),
      top[2] * a + bottom[2] * (1 - a),
      1,
    ];
  }
  function backgroundLayerFromComputed(cs) {
    const bg = parseColor(cs.backgroundColor);
    if (bg && bg[3] > 0) return bg;
    // Gradients live on background-image; average the stops for a conservative effective color.
    const bi = cs.backgroundImage;
    if (bi && bi !== 'none' && /gradient/i.test(bi)) {
      const colors = [];
      const re = /rgba?\\([^)]+\\)|#[0-9a-fA-F]{3,8}/g;
      let m;
      while ((m = re.exec(bi))) {
        const c = parseColor(m[0]);
        if (c) colors.push(c);
      }
      if (colors.length > 0) {
        const n = colors.length;
        return [
          colors.reduce((a, c) => a + c[0], 0) / n,
          colors.reduce((a, c) => a + c[1], 0) / n,
          colors.reduce((a, c) => a + c[2], 0) / n,
          colors.reduce((a, c) => a + c[3], 0) / n,
        ];
      }
    }
    return null;
  }
  function effectiveBackground(el) {
    const layers = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const layer = backgroundLayerFromComputed(getComputedStyle(node));
      if (layer) layers.unshift(layer);
      node = node.parentElement;
    }
    let bg = parseColor(getComputedStyle(document.body).backgroundColor);
    if (!bg || bg[3] === 0) bg = [255, 255, 255, 1];
    if (bg[3] < 1) bg = compositeOver(bg, [255, 255, 255, 1]);
    for (const l of layers) bg = compositeOver(l, bg);
    return bg;
  }
  function hexOf(c) {
    const h = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
    return '#' + h(c[0]) + h(c[1]) + h(c[2]);
  }
  function hasAriaHiddenAncestor(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.getAttribute('aria-hidden') === 'true') return true;
      node = node.parentElement;
    }
    return false;
  }
  function hasDirectText(el) {
    for (const n of el.childNodes) {
      if (n.nodeType === 3 && n.nodeValue.trim().length > 0) return true;
    }
    return false;
  }
`;

async function measurePage(page, url, deck, viewport, opts, thresholds, errors) {
  const runOverflow = opts.categories.includes('overflow');
  const runContrast = opts.categories.includes('contrast');
  const runResources = opts.categories.includes('resources');
  const runConsole = opts.categories.includes('console');

  // Per-slide attribution. Updated inside the slide loop.
  let currentSlide = {
    h: null,
    v: null,
    sourceFile: `${deck}/index.html`,
    sourceLine: 1,
  };
  const resourceBuckets = new Map();
  const consoleBuckets = new Map();

  const resourceSeverity = (type) =>
    ['image', 'stylesheet', 'font', 'script', 'document'].includes(type) ? 'CRITICAL' : 'WARNING';

  page.on('response', (resp) => {
    const status = resp.status();
    if (status < 400) return;
    const u = resp.url();
    if (status === 404) errors.push({ presentation: deck, url: u, message: '404' });
    if (!runResources) return;
    const type = (resp.request().resourceType && resp.request().resourceType()) || 'other';
    const key = `${status}|${type}|${u}`;
    if (resourceBuckets.has(key)) {
      resourceBuckets.get(key).count += 1;
      return;
    }
    resourceBuckets.set(key, {
      ...currentSlide,
      presentation: deck,
      viewport,
      category: 'resources',
      severity: resourceSeverity(type),
      resource: { url: u, status, type },
      count: 1,
    });
  });
  page.on('pageerror', (err) => {
    errors.push({ presentation: deck, url, message: `pageerror: ${err.message}` });
    if (!runConsole) return;
    const key = `pageerror|${err.message}`;
    if (consoleBuckets.has(key)) {
      consoleBuckets.get(key).count += 1;
      return;
    }
    consoleBuckets.set(key, {
      ...currentSlide,
      presentation: deck,
      viewport,
      category: 'console',
      severity: 'CRITICAL',
      console: { kind: 'pageerror', message: err.message },
      count: 1,
    });
  });
  page.on('console', (msg) => {
    if (!runConsole) return;
    if (msg.type() !== 'error') return;
    const text = msg.text();
    const key = `console|${text}`;
    if (consoleBuckets.has(key)) {
      consoleBuckets.get(key).count += 1;
      return;
    }
    consoleBuckets.set(key, {
      ...currentSlide,
      presentation: deck,
      viewport,
      category: 'console',
      severity: 'WARNING',
      console: { kind: 'console.error', message: text },
      count: 1,
    });
  });

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.Reveal && window.Reveal.isReady && window.Reveal.isReady(), { timeout: 30000 });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  await page.evaluate(async () => {
    window.Reveal.configure({ viewDistance: 999, fragments: false });
    const imgs = Array.from(document.querySelectorAll('.reveal .slides img'));
    imgs.forEach((img) => img.setAttribute('loading', 'eager'));
    await Promise.all(
      imgs.map(
        (img) =>
          new Promise((resolve) => {
            if (img.complete) return resolve();
            const done = () => resolve();
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
            setTimeout(done, 5000);
          })
      )
    );
  });
  await page.waitForTimeout(250);

  const slides = await page.evaluate(() => {
    const out = [];
    const outers = document.querySelectorAll('.reveal .slides > section');
    outers.forEach((outer, h) => {
      const inners = outer.querySelectorAll(':scope > section');
      const external = outer.getAttribute('data-external') || null;
      if (inners.length === 0) {
        out.push({ h, v: 0, external });
      } else {
        inners.forEach((_inner, v) => out.push({ h, v, external }));
      }
    });
    return out;
  });

  const cfg = await page.evaluate(() => ({
    w: window.Reveal.getConfig().width,
    h: window.Reveal.getConfig().height,
  }));

  const severityRank = { INFO: 1, WARNING: 2, CRITICAL: 3 };
  const findings = [];
  for (const s of slides) {
    await page.evaluate(({ h, v }) => window.Reveal.slide(h, v), { h: s.h, v: s.v });
    // Let Reveal apply .present + layout
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    // Resolve source file/line once per slide.
    let sourceFile;
    let sourceLine;
    if (s.external) {
      sourceFile = path.posix.join(deck, s.external);
      const abs = path.join(ROOT, deck, s.external);
      const map = buildSectionLineMap(abs);
      sourceLine = map[s.v] || 1;
    } else {
      sourceFile = `${deck}/index.html`;
      sourceLine = indexHtmlLineFor(path.join(ROOT, deck, 'index.html'), s.h);
    }
    const base = { presentation: deck, viewport, h: s.h, v: s.v, sourceFile, sourceLine };
    currentSlide = { h: s.h, v: s.v, sourceFile, sourceLine };

    if (runOverflow) {
      const m = await page.evaluate(
        ({ slideW, slideH }) => {
          const section =
            document.querySelector('.reveal .slides section.present section.present') ||
            document.querySelector('.reveal .slides > section.present');
          if (!section) return null;
          const secRect = section.getBoundingClientRect();
          const scale = secRect.width > 0 ? secRect.width / slideW : 1;
          if (!scale || !isFinite(scale)) return null;
          const toLogical = (px) => px / scale;
          const axes = {
            right: { overflow: 0, el: null },
            bottom: { overflow: 0, el: null },
            left: { overflow: 0, el: null },
            top: { overflow: 0, el: null },
          };
          const note = (name, value, el) => {
            if (value > axes[name].overflow) {
              axes[name].overflow = value;
              axes[name].el = el;
            }
          };
          const isVisible = (el) => {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') return false;
            return true;
          };
          const walk = (el) => {
            if (!isVisible(el)) return;
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) {
              for (const child of el.children) walk(child);
              return;
            }
            const right = toLogical(r.right - secRect.left);
            const bottom = toLogical(r.bottom - secRect.top);
            const left = toLogical(r.left - secRect.left);
            const top = toLogical(r.top - secRect.top);
            note('right', right - slideW, el);
            note('bottom', bottom - slideH, el);
            note('left', -left, el);
            note('top', -top, el);
            for (const child of el.children) walk(child);
          };
          for (const child of section.children) walk(child);
          const describe = (el) =>
            el && {
              tag: el.tagName.toLowerCase(),
              classes: el.getAttribute('class') || '',
              snippet: (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 200),
            };
          const ranked = Object.entries(axes).sort((a, b) => b[1].overflow - a[1].overflow);
          const worstEl = ranked[0][1].el;
          return {
            overflowRight: axes.right.overflow,
            overflowBottom: axes.bottom.overflow,
            overflowLeft: axes.left.overflow,
            overflowTop: axes.top.overflow,
            offender: describe(worstEl),
          };
        },
        { slideW: cfg.w, slideH: cfg.h }
      );

      if (m) {
        const px = {
          right: Math.round(m.overflowRight),
          bottom: Math.round(m.overflowBottom),
          left: Math.round(m.overflowLeft),
          top: Math.round(m.overflowTop),
        };
        const severities = Object.values(px).map((v) => severityFor(v, thresholds)).filter(Boolean);
        if (severities.length > 0) {
          const worst = severities.sort((a, b) => severityRank[b] - severityRank[a])[0];
          findings.push({
            ...base,
            category: 'overflow',
            slideBox: { w: cfg.w, h: cfg.h },
            overflow: px,
            severity: worst,
            offender: m.offender || null,
          });
        }
      }
    }

    if (runContrast) {
      const items = await page.evaluate(
        ({ helpers }) => {
          // eslint-disable-next-line no-eval
          eval(helpers);
          const section =
            document.querySelector('.reveal .slides section.present section.present') ||
            document.querySelector('.reveal .slides > section.present');
          if (!section) return [];
          // Bucket by (fgHex, bgHex, isLarge) to suppress duplicates on a slide.
          const buckets = new Map();
          const walk = (el) => {
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return;
            if (hasAriaHiddenAncestor(el)) return;
            if (hasDirectText(el)) {
              const fgRaw = parseColor(cs.color);
              if (fgRaw) {
                const bg = effectiveBackground(el);
                const fg = fgRaw[3] < 1 ? compositeOver(fgRaw, bg) : fgRaw;
                const fontSize = parseFloat(cs.fontSize);
                const fontWeight = Number(cs.fontWeight) || 400;
                const isLarge = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);
                const ratio = contrastRatio(fg, bg);
                const fgHex = hexOf(fg);
                const bgHex = hexOf(bg);
                const key = fgHex + '|' + bgHex + '|' + isLarge;
                if (!buckets.has(key)) {
                  const text = (Array.from(el.childNodes)
                    .filter((n) => n.nodeType === 3)
                    .map((n) => n.nodeValue)
                    .join(' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 80));
                  buckets.set(key, {
                    ratio,
                    fg: fgHex,
                    bg: bgHex,
                    fontSize,
                    fontWeight,
                    isLarge,
                    count: 1,
                    offender: {
                      tag: el.tagName.toLowerCase(),
                      classes: el.getAttribute('class') || '',
                      snippet: (el.outerHTML || '').replace(/\s+/g, ' ').slice(0, 200),
                      text,
                    },
                  });
                } else {
                  buckets.get(key).count += 1;
                }
              }
            }
            for (const child of el.children) walk(child);
          };
          for (const child of section.children) walk(child);
          return Array.from(buckets.values());
        },
        { helpers: IN_PAGE_CONTRAST_HELPERS }
      );

      for (const it of items) {
        const sev = severityForContrast(it.ratio, it.isLarge, opts.contrastAA, opts.contrastAALarge);
        if (!sev) continue;
        const required = it.isLarge ? opts.contrastAALarge : opts.contrastAA;
        findings.push({
          ...base,
          category: 'contrast',
          severity: sev,
          contrast: {
            ratio: Math.round(it.ratio * 100) / 100,
            required,
            isLarge: it.isLarge,
            fg: it.fg,
            bg: it.bg,
            fontSize: it.fontSize,
            fontWeight: it.fontWeight,
            count: it.count,
          },
          offender: it.offender,
        });
      }
    }
  }

  // Settle late async events (e.g. deferred image loads) before flushing.
  await page.waitForTimeout(100);
  for (const f of resourceBuckets.values()) findings.push(f);
  for (const f of consoleBuckets.values()) findings.push(f);

  return findings;
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  ensureBuilt(opts.decks);

  const thresholds = {
    info: opts.thresholdInfo,
    warn: opts.thresholdWarn,
    critical: opts.thresholdCritical,
  };

  const { server, port } = await startServer(ROOT, opts.port);
  console.log(`Serving ${ROOT} on http://127.0.0.1:${port}`);

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch({ headless: true });

  const cleanup = () => {
    try { browser.close(); } catch (_) { /* ignore */ }
    try { server.close(); } catch (_) { /* ignore */ }
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  let viewports;
  if (opts.viewport === 'both') viewports = ['landscape', 'portrait'];
  else if (opts.viewport === 'all') viewports = ['landscape', 'portrait', 'print'];
  else viewports = [opts.viewport];

  const allFindings = [];
  const errors = [];

  for (const deck of opts.decks) {
    for (const vp of viewports) {
      // Print mode reuses landscape dimensions; Chromium's print CSS applies via emulateMedia.
      const viewport = vp === 'portrait' ? { width: 540, height: 960 } : { width: 960, height: 700 };
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      if (vp === 'print') await page.emulateMedia({ media: 'print' });
      const url = `http://127.0.0.1:${port}/${deck}/index.html${vp === 'portrait' ? '?mobile' : ''}`;
      console.log(`  Checking ${deck} (${vp})...`);
      try {
        const findings = await measurePage(page, url, deck, vp, opts, thresholds, errors);
        allFindings.push(...findings);
      } catch (e) {
        errors.push({ presentation: deck, url, message: `measure failed: ${e.message}` });
      } finally {
        await context.close();
      }
    }
  }

  await browser.close();
  server.close();

  const report = {
    generatedAt: new Date().toISOString(),
    categories: opts.categories,
    thresholds: {
      overflow: thresholds,
      contrast: { aa: opts.contrastAA, aaLarge: opts.contrastAALarge },
    },
    findings: allFindings,
    errors,
  };
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, JSON.stringify(report, null, 2));

  const parsedOut = path.parse(opts.out);
  const txtPath = path.format({ dir: parsedOut.dir, name: parsedOut.name, ext: '.txt' });
  const describeOffender = (o) =>
    o ? `${o.tag}${o.classes ? '.' + o.classes.replace(/\s+/g, '.') : ''}` : '(unknown)';
  const coord = (f) => `h=${f.h == null ? '-' : f.h}/v=${f.v == null ? '-' : f.v}`;
  const lineFor = (f) => {
    const prefix = `[${f.severity.padEnd(8)}] [${f.category.padEnd(9)}] ${f.sourceFile}:${f.sourceLine} (${f.viewport}, ${coord(f)})`;
    if (f.category === 'overflow') {
      const worstAxis = Object.entries(f.overflow).sort((a, b) => b[1] - a[1])[0];
      return `${prefix}: ${worstAxis[0]} ${worstAxis[1]}px — <${describeOffender(f.offender)}>`;
    }
    if (f.category === 'contrast') {
      const size = f.contrast.isLarge ? 'large' : 'normal';
      return `${prefix}: ${f.contrast.ratio}:1 ${f.contrast.fg} on ${f.contrast.bg} (${size}, req ${f.contrast.required}:1, x${f.contrast.count}) — <${describeOffender(f.offender)}>`;
    }
    if (f.category === 'resources') {
      return `${prefix}: ${f.resource.status} ${f.resource.type} ${f.resource.url} (x${f.count})`;
    }
    if (f.category === 'console') {
      return `${prefix}: ${f.console.kind} "${f.console.message.replace(/\s+/g, ' ').slice(0, 160)}" (x${f.count})`;
    }
    return prefix;
  };
  const lines = allFindings.map(lineFor);
  if (errors.length) {
    lines.push('');
    lines.push('Errors:');
    for (const e of errors) lines.push(`  ${e.presentation}: ${e.url} — ${e.message}`);
  }
  fs.writeFileSync(txtPath, lines.join('\n') + (lines.length ? '\n' : ''));

  const counts = { CRITICAL: 0, WARNING: 0, INFO: 0 };
  const perCategory = {};
  for (const f of allFindings) {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
    perCategory[f.category] = perCategory[f.category] || { CRITICAL: 0, WARNING: 0, INFO: 0 };
    perCategory[f.category][f.severity] += 1;
  }
  console.log(`\nFindings: ${counts.CRITICAL} critical / ${counts.WARNING} warning / ${counts.INFO} info`);
  for (const [cat, c] of Object.entries(perCategory)) {
    console.log(`  ${cat.padEnd(9)} ${c.CRITICAL}C / ${c.WARNING}W / ${c.INFO}I`);
  }
  console.log(`Report: ${opts.out}`);
  console.log(`        ${txtPath}`);

  process.exit(counts.CRITICAL ? 1 : 0);
}

run().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(2);
});
