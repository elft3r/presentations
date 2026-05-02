const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

const ROOT = path.resolve(__dirname, '..');
const REVEAL_DIR = path.join(ROOT, 'node_modules', 'reveal.js');
const PKG = require(path.join(ROOT, 'package.json'));

const { PRESENTATIONS } = require('./presentations');

// Drop raw HTML from rendered Markdown so a malicious or accidental
// <script>/<iframe> in README.md cannot reach the public landing page.
marked.use({
  renderer: {
    html: () => '',
  },
});

const STOCK_PLUGINS = ['highlight', 'markdown', 'notes'];

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;

  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Remove any existing symlink at dest (copyFileSync can't overwrite broken symlinks)
    const destLstat = fs.lstatSync(dest, { throwIfNoEntry: false });
    if (destLstat && destLstat.isSymbolicLink()) fs.unlinkSync(dest);
    fs.copyFileSync(src, dest);
  }
}

for (const pres of PRESENTATIONS) {
  const presDir = path.join(ROOT, pres);
  const distDir = path.join(presDir, 'dist');

  console.log(`\nBuilding ${pres}...`);

  // 1. Copy reveal.js dist files (core JS, CSS, themes)
  console.log('  Copying reveal.js dist files...');
  copyRecursive(path.join(REVEAL_DIR, 'dist'), distDir);

  // 2. Copy stock plugins
  console.log('  Copying reveal.js plugins...');
  for (const plugin of STOCK_PLUGINS) {
    copyRecursive(
      path.join(REVEAL_DIR, 'plugin', plugin),
      path.join(presDir, 'plugin', plugin)
    );
  }

  // 3. Copy custom theme (from the shared custom-themes directory)
  const customThemeDir = path.join(ROOT, 'custom-themes');
  if (fs.existsSync(customThemeDir)) {
    console.log('  Copying custom themes...');
    for (const file of fs.readdirSync(customThemeDir)) {
      fs.copyFileSync(
        path.join(customThemeDir, file),
        path.join(distDir, 'theme', file)
      );
    }
  }

  // 4. Copy shared files (JS, sections) from shared/ directory
  const sharedDir = path.join(ROOT, 'shared');
  if (fs.existsSync(sharedDir)) {
    console.log('  Copying shared files...');
    copyRecursive(sharedDir, presDir);
  }

  console.log(`  Done.`);
}

// 5. Stage presentations into _site/ output directory
const siteDir = path.join(ROOT, '_site');
if (fs.existsSync(siteDir)) {
  fs.rmSync(siteDir, { recursive: true });
}
fs.mkdirSync(siteDir, { recursive: true });

for (const pres of PRESENTATIONS) {
  console.log(`\nStaging ${pres} into _site/...`);
  copyRecursive(path.join(ROOT, pres), path.join(siteDir, pres));
}

// Render README.md to _site/index.html as the landing page
const readme = path.join(ROOT, 'README.md');
if (fs.existsSync(readme)) {
  console.log('\nRendering README.md to _site/index.html...');
  let markdown = fs.readFileSync(readme, 'utf8');
  // Rewrite the configured homepage to a site-relative path so the landing
  // page works on both production and PR preview deployments.
  if (PKG.homepage) {
    const homepage = PKG.homepage.endsWith('/') ? PKG.homepage : PKG.homepage + '/';
    const escaped = homepage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    markdown = markdown.replace(new RegExp(escaped, 'g'), './');
  }
  const rendered = marked.parse(markdown);
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Presentations</title>
  <style>
    :root {
      --bg: #F8F9FA;
      --text: #2d3748;
      --heading: #1a202c;
      --accent: #24584C;
      --link: #B39A6A;
      --link-hover: #6E5C3A;
    }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: "Source Sans Pro", Helvetica, Arial, sans-serif;
      font-size: 18px;
      line-height: 1.6;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    main {
      max-width: 720px;
      width: 100%;
      padding: 3rem 1.5rem;
    }
    h1, h2, h3 {
      color: var(--heading);
      font-weight: 600;
      letter-spacing: -0.01em;
      line-height: 1.2;
      margin: 0 0 1rem;
    }
    h1 { font-size: 2.5rem; border-bottom: 4px solid var(--accent); padding-bottom: 0.5rem; }
    p { margin: 0 0 1rem; }
    a { color: var(--link); text-decoration: none; border-bottom: 1px solid currentColor; }
    a:hover, a:focus { color: var(--link-hover); }
    ul { padding-left: 1.25rem; }
    li { margin: 0.4rem 0; }
    img { max-width: 100%; height: auto; }
  </style>
</head>
<body>
  <main>
${rendered}  </main>
</body>
</html>
`;
  fs.writeFileSync(path.join(siteDir, 'index.html'), html);
}

console.log('\nBuild complete! Output in _site/');
