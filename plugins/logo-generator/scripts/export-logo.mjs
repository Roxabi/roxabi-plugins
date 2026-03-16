#!/usr/bin/env node
/**
 * export-logo.mjs — Renders a logo brief into GIF/PNG exports via Puppeteer
 *
 * Usage:
 *   node export-logo.mjs <brief.json> [--output <dir>] [--gif] [--png] [--duration 10] [--fps 20]
 */

import puppeteer from 'puppeteer';
import { readFileSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Parse args ───────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (!args[0] || args[0] === '--help') {
  console.log(`Usage: node export-logo.mjs <brief.json> [options]

Options:
  --output <dir>    Output directory (default: ./brand/)
  --gif             Export animated GIF (default: true)
  --png             Export static PNG snapshot
  --duration <s>    GIF duration in seconds (default: 10)
  --fps <n>         GIF frames per second (default: 20)
  --width <px>      Viewport width (default: from brief or 520)
  --height <px>     Viewport height (default: from brief or 680)
  --no-gif          Skip GIF export
  --no-cleanup      Keep frame PNGs
`);
  process.exit(0);
}

const briefPath = args[0];
const brief = JSON.parse(readFileSync(briefPath, 'utf-8'));
const name = brief.identity?.name?.toLowerCase() || 'logo';

function getFlag(flag, def) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : def;
}
function hasFlag(flag) { return args.includes(flag); }

const outputDir = getFlag('--output', './brand');
const doGif = !hasFlag('--no-gif');
const doPng = hasFlag('--png');
const duration = parseInt(getFlag('--duration', brief.export?.gif?.duration_s || 10));
const fps = parseInt(getFlag('--fps', brief.export?.gif?.fps || 20));
const width = parseInt(getFlag('--width', brief.export?.gif?.width || 520));
const height = parseInt(getFlag('--height', brief.export?.gif?.height || 680));
const scale = brief.export?.gif?.scale || 2;
const noCleanup = hasFlag('--no-cleanup');
const totalFrames = fps * duration;

// ── Build HTML with embedded brief ──────────────────────────────────

const engineHtml = readFileSync(join(__dirname, 'logo-engine.html'), 'utf-8');
const injectedHtml = engineHtml.replace(
  '// Check inline brief (injected by generator script)',
  `// Injected brief\nvar LOGO_BRIEF = ${JSON.stringify(brief)};`
).replace(
  // Hide controls toggle in export mode
  '.toggle-controls {',
  '.toggle-controls { display: none !important; '
);

mkdirSync(outputDir, { recursive: true });
const tempHtml = join(outputDir, `_${name}-preview.html`);
writeFileSync(tempHtml, injectedHtml);

// ── Capture ──────────────────────────────────────────────────────────

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  });

  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: scale });
  await page.goto(`file://${tempHtml}`, { waitUntil: 'domcontentloaded' });

  // Static PNG
  if (doPng) {
    // Wait for intro to finish
    await new Promise(r => setTimeout(r, (brief.animation?.intro_duration_s || 5) * 1000 + 1000));
    const pngPath = join(outputDir, `${name}-logo.png`);
    await page.screenshot({ path: pngPath, clip: { x: 0, y: 0, width, height } });
    console.log(`PNG saved: ${pngPath}`);
  }

  // Animated GIF
  if (doGif) {
    const framesDir = join(outputDir, '_frames');
    rmSync(framesDir, { recursive: true, force: true });
    mkdirSync(framesDir, { recursive: true });

    // Reload for fresh animation
    await page.goto(`file://${tempHtml}`, { waitUntil: 'domcontentloaded' });

    console.log(`Capturing ${totalFrames} frames at ${fps} fps...`);
    for (let i = 0; i < totalFrames; i++) {
      const num = String(i).padStart(4, '0');
      await page.screenshot({
        path: join(framesDir, `frame_${num}.png`),
        clip: { x: 0, y: 0, width, height }
      });
      await new Promise(r => setTimeout(r, 1000 / fps));
      if (i % 40 === 0) console.log(`  frame ${i}/${totalFrames}`);
    }

    const gifPath = join(outputDir, `${name}-logo.gif`);
    console.log('Converting to GIF...');
    execSync(
      `ffmpeg -y -framerate ${fps} -i "${framesDir}/frame_%04d.png" ` +
      `-vf "fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];` +
      `[s0]palettegen=max_colors=128:stats_mode=diff[p];` +
      `[s1][p]paletteuse=dither=bayer:bayer_scale=3" "${gifPath}"`,
      { stdio: 'pipe' }
    );
    console.log(`GIF saved: ${gifPath}`);

    if (!noCleanup) rmSync(framesDir, { recursive: true, force: true });
  }

  await browser.close();

  // Clean temp HTML
  if (existsSync(tempHtml)) rmSync(tempHtml);

  // Also save the standalone preview HTML
  const previewPath = join(outputDir, `${name}-logo.html`);
  writeFileSync(previewPath, injectedHtml.replace('display: none !important; ', ''));
  console.log(`Preview HTML saved: ${previewPath}`);

  console.log('\nDone!');
}

main().catch(e => { console.error(e); process.exit(1); });
