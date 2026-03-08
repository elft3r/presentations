const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REVEAL_DIR = path.join(ROOT, 'node_modules', 'reveal.js');

const PRESENTATIONS = ['cloud-migrations', 'secure-landing-zones', 'docker-training'];

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

// Copy README.md to serve as the landing page
const readme = path.join(ROOT, 'README.md');
if (fs.existsSync(readme)) {
  fs.copyFileSync(readme, path.join(siteDir, 'README.md'));
}

console.log('\nBuild complete! Output in _site/');
