#!/usr/bin/env node
// Headless overflow detector for Reveal.js decks.
// Renders every slide at 960x700 (landscape) and 540x960 (portrait) and
// reports content whose layout exceeds the logical slide box.
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

function parseArgs(argv) {
  const opts = {
    decks: [],
    viewport: 'both',
    out: path.join(ROOT, '.claude', 'cache', 'overflow-report.json'),
    thresholdInfo: 0,
    thresholdWarn: 4,
    thresholdCritical: 16,
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
  if (!['landscape', 'portrait', 'both'].includes(opts.viewport)) {
    throw new Error(`--viewport must be landscape|portrait|both`);
  }
  if (
    opts.thresholdInfo > opts.thresholdWarn ||
    opts.thresholdWarn >= opts.thresholdCritical
  ) {
    throw new Error(
      `Thresholds must satisfy info <= warn < critical (got info=${opts.thresholdInfo}, warn=${opts.thresholdWarn}, critical=${opts.thresholdCritical})`
    );
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

async function measurePage(page, url, deck, viewport, thresholds, errors) {
  page.on('response', (resp) => {
    if (resp.status() === 404) {
      errors.push({ presentation: deck, url: resp.url(), message: '404' });
    }
  });
  page.on('pageerror', (err) => {
    errors.push({ presentation: deck, url, message: `pageerror: ${err.message}` });
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

  const findings = [];
  for (const s of slides) {
    await page.evaluate(({ h, v }) => window.Reveal.slide(h, v), { h: s.h, v: s.v });
    // Let Reveal apply .present + layout
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    const m = await page.evaluate(
      ({ slideW, slideH }) => {
        const section =
          document.querySelector('.reveal .slides section.present section.present') ||
          document.querySelector('.reveal .slides > section.present');
        if (!section) return null;
        const secRect = section.getBoundingClientRect();
        // Reveal scales via CSS transform; recover the scale from the rendered section width.
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
        const ranked = Object.entries(axes).sort(
          (a, b) => b[1].overflow - a[1].overflow
        );
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

    if (!m) continue;
    const px = {
      right: Math.round(m.overflowRight),
      bottom: Math.round(m.overflowBottom),
      left: Math.round(m.overflowLeft),
      top: Math.round(m.overflowTop),
    };
    const severityRank = { INFO: 1, WARNING: 2, CRITICAL: 3 };
    const severities = Object.values(px)
      .map((v) => severityFor(v, thresholds))
      .filter(Boolean);
    if (severities.length === 0) continue;
    const worst = severities.sort((a, b) => severityRank[b] - severityRank[a])[0];

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

    findings.push({
      presentation: deck,
      viewport,
      h: s.h,
      v: s.v,
      sourceFile,
      sourceLine,
      slideBox: { w: cfg.w, h: cfg.h },
      overflow: { right: px.right, bottom: px.bottom, left: px.left, top: px.top },
      severity: worst,
      offender: m.offender || null,
    });
  }

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

  const viewports =
    opts.viewport === 'both' ? ['landscape', 'portrait'] : [opts.viewport];

  const allFindings = [];
  const errors = [];

  for (const deck of opts.decks) {
    for (const vp of viewports) {
      const viewport = vp === 'portrait' ? { width: 540, height: 960 } : { width: 960, height: 700 };
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const url = `http://127.0.0.1:${port}/${deck}/index.html${vp === 'portrait' ? '?mobile' : ''}`;
      console.log(`  Checking ${deck} (${vp})...`);
      try {
        const findings = await measurePage(page, url, deck, vp, thresholds, errors);
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
    thresholds,
    slides: allFindings,
    errors,
  };
  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, JSON.stringify(report, null, 2));

  const parsedOut = path.parse(opts.out);
  const txtPath = path.format({ dir: parsedOut.dir, name: parsedOut.name, ext: '.txt' });
  const lines = allFindings.map((f) => {
    const off = f.offender
      ? `${f.offender.tag}${f.offender.classes ? '.' + f.offender.classes.replace(/\s+/g, '.') : ''}`
      : '(unknown)';
    const worstAxis = Object.entries(f.overflow).sort((a, b) => b[1] - a[1])[0];
    const axis = `${worstAxis[0]} ${worstAxis[1]}px`;
    return `[${f.severity.padEnd(8)}] ${f.sourceFile}:${f.sourceLine} (${f.viewport}, h=${f.h}/v=${f.v}): ${axis} — <${off}>`;
  });
  if (errors.length) {
    lines.push('');
    lines.push('Errors:');
    for (const e of errors) lines.push(`  ${e.presentation}: ${e.url} — ${e.message}`);
  }
  fs.writeFileSync(txtPath, lines.join('\n') + '\n');

  const counts = allFindings.reduce(
    (acc, f) => ((acc[f.severity] = (acc[f.severity] || 0) + 1), acc),
    {}
  );
  console.log(
    `\nOverflow findings: ${counts.CRITICAL || 0} critical / ${counts.WARNING || 0} warning / ${counts.INFO || 0} info`
  );
  console.log(`Report: ${opts.out}`);
  console.log(`        ${txtPath}`);

  process.exit(counts.CRITICAL ? 1 : 0);
}

run().catch((e) => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(2);
});
