#!/usr/bin/env node
// Record a short product demo of the running app, ScreenStudio-style: the app in a rounded
// window on a wallpaper, a drawn cursor that glides, hovers and clicks like a hand would,
// captured frame by frame at 2x and encoded to MP4.
//
//   node record.mjs --take out/product-demo/takes/run-modal.mjs --out out/product-demo/run-modal
//
// The take is a small module that scripts the cursor (see SKILL.md for the contract and
// references/run-modal.mjs for a full example). Writes <out>.mp4 and <out>.png (poster).
//
// Options:
//   --width 1200 --height 1200   canvas in CSS px; this is the video's aspect ratio
//   --scale 2                    device pixels per CSS px for the frames
//   --pad 40                     wallpaper margin around the app window; 0 = no window chrome
//   --wallpaper warm             warm | cool | dark | plain
//   --fps 30                     frames per second
//   --out-width 1080             width of the encoded MP4 (height follows the aspect)
//   --formats mp4,png            outputs; png is the poster frame (see t.poster())
//   --seed 1                     seed for the cursor's small random offsets (same seed, same take)
//   --still                      one PNG after the take's `still(t)` step, for framing checks
//   --keep-frames                write the frames next to the output (<out>.frames/) and leave them
//
// Deterministic enough to re-run: CSS animations are slowed to the measured frame cost so
// hover and open transitions land on the same frames; real time for JS is not controlled.
// Needs playwright-core (+ Chromium) and ffmpeg on PATH.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, token, i, all) => {
    if (!token.startsWith("--")) return pairs;
    const next = all[i + 1];
    const value = next === undefined || next.startsWith("--") ? "true" : next;
    return [...pairs, [token.slice(2), value]];
  }, []),
);

if (!args.take) {
  console.error(
    "Usage: node record.mjs --take <take.mjs> [--out out/product-demo/<take name>] [--width 1200 --height 1200] [--still]",
  );
  process.exit(1);
}

const WIDTH = Number(args.width ?? 1200);
const HEIGHT = Number(args.height ?? 1200);
const SCALE = Number(args.scale ?? 2);
const PAD = Number(args.pad ?? 40);
const WALLPAPER = args.wallpaper ?? "warm";
const FPS = Number(args.fps ?? 30);
const OUT_WIDTH = Number(args["out-width"] ?? 1080);
const FORMATS = new Set((args.formats ?? "mp4,png").split(","));
const STILL = args.still === "true";
const KEEP = args["keep-frames"] === "true";
const takeName = args.take.split("/").at(-1).replace(/\.m?js$/, "");
const out = resolve((args.out ?? `out/product-demo/${takeName}`).replace(/\.(mp4|png)$/, ""));
const here = dirname(fileURLToPath(import.meta.url));

// ---- dependencies ------------------------------------------------------------

// Playwright lives in this skill's own folder: installed next to this script on the first run,
// never looked up in the project, the npx cache or anywhere else.
const HERE = dirname(fileURLToPath(import.meta.url));

function loadPlaywright() {
  const path = join(HERE, "node_modules", "playwright");
  if (!existsSync(path)) {
    console.error("Installing Playwright into this skill's folder (first run)...");
    execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund"], { cwd: HERE, stdio: ["ignore", 2, 2] });
  }
  return createRequire(import.meta.url)(path);
}

// Downloads Playwright's Chromium the first time a launch can't find one.
async function launchBrowser(chromium, options = {}) {
  try {
    return await chromium.launch(options);
  } catch {
    execFileSync(join(HERE, "node_modules", ".bin", "playwright"), ["install", "chromium"], { stdio: ["ignore", 2, 2] });
    return chromium.launch(options);
  }
}

if (!STILL && FORMATS.has("mp4")) {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  } catch {
    console.error("ffmpeg not found on PATH (brew install ffmpeg).");
    process.exit(1);
  }
}

const take = await import(pathToFileURL(resolve(args.take)).href);
if (!take.url || typeof take.default !== "function") {
  console.error("The take must export `url` and a default async function.");
  process.exit(1);
}

// ---- browser -----------------------------------------------------------------

const WIN_W = WIDTH - PAD * 2;
const WIN_H = HEIGHT - PAD * 2;
const wrapper = readFileSync(join(here, "wrapper.html"), "utf8")
  .replaceAll("__APP__", take.url)
  .replaceAll("__PAD__", String(PAD))
  .replaceAll("__WIN_W__", String(WIN_W))
  .replaceAll("__WIN_H__", String(WIN_H))
  .replaceAll("__WALLPAPER__", WALLPAPER)
  .replaceAll("__CHROME__", PAD > 0 ? "chrome" : "");

// Frames go to a temp folder so a commit made mid-render never sweeps them up.
mkdirSync(dirname(out), { recursive: true });
let framesDir;
if (KEEP) {
  framesDir = `${out}.frames`;
  rmSync(framesDir, { recursive: true, force: true });
  mkdirSync(framesDir, { recursive: true });
} else {
  framesDir = mkdtempSync(join(tmpdir(), "video-demo-"));
}

const { chromium } = loadPlaywright();
const browser = await launchBrowser(chromium, { args: ["--hide-scrollbars"] });
const ctx = await browser.newContext({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: SCALE,
});
const page = await ctx.newPage();

// The take signs in (or seeds state) on the real origin first; the wrapper is
// then served from that same origin so the iframe shares its storage.
if (take.prepare) await take.prepare(page);
const origin = new URL(take.url).origin;
await page.route(`${origin}/__video-demo`, (route) =>
  route.fulfill({ contentType: "text/html", body: wrapper }),
);
await page.goto(`${origin}/__video-demo`);
const app = page.frame({ name: "app" });
const frame = page.frameLocator("#app");
await app.waitForLoadState("networkidle");
await app.evaluate((css) => {
  const style = document.createElement("style");
  style.textContent = `
    * { caret-color: transparent !important; }
    ::-webkit-scrollbar { display: none; }
    * { scrollbar-width: none; }
    ${css}
  `;
  document.head.appendChild(style);
}, take.css ?? "");

// ---- timing ------------------------------------------------------------------

// Wall-clock budget per frame. Frames cost more than this at 2x, so the CSS
// playback rate is retuned to the measured cost and animations stay in step.
const REAL_PER_FRAME = 150;
const cdp = await ctx.newCDPSession(page);
await cdp.send("Animation.enable");
let perFrame = REAL_PER_FRAME;
let rate = 0;
async function retune(ms) {
  perFrame = perFrame * 0.8 + ms * 0.2;
  const next = 1000 / FPS / Math.max(perFrame, REAL_PER_FRAME);
  if (!rate || Math.abs(next - rate) / rate > 0.05) {
    rate = next;
    await cdp.send("Animation.setPlaybackRate", { playbackRate: rate });
  }
}
await retune(REAL_PER_FRAME);

// ---- cursor ------------------------------------------------------------------

let seed = Number(args.seed ?? 1) >>> 0;
/** Small, repeatable randomness (mulberry32). */
function random() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const easeInOut = (t) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

let cur = { x: WIDTH * 0.55, y: HEIGHT * 0.6 };
let n = 0;
let posterFrame = null;

/** Whether what's under the cursor is clickable: the app's own pointer or a control. */
async function pointerUnder() {
  return app.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y);
      if (!el) return false;
      if (getComputedStyle(el).cursor === "pointer") return true;
      return Boolean(
        el.closest(
          "button, a[href], [role=button], [role=option], [role=menuitem], [role=tab], [role=link], [cmdk-item], summary, label, input[type=checkbox], input[type=radio], select",
        ),
      );
    },
    [cur.x - PAD, cur.y - PAD],
  );
}

async function tick() {
  const started = Date.now();
  const pointer = await pointerUnder();
  await page.evaluate(
    ([x, y, p]) => {
      window.__cursor(x, y);
      window.__shape(p);
    },
    [cur.x, cur.y, pointer],
  );
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "jpeg",
    quality: 92,
    clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT, scale: SCALE },
  });
  writeFileSync(
    join(framesDir, `${String(n++).padStart(5, "0")}.jpg`),
    Buffer.from(shot.data, "base64"),
  );
  const left = REAL_PER_FRAME - (Date.now() - started);
  if (left > 0) await sleep(left);
  await retune(Date.now() - started);
}

const framesFor = (ms) => Math.max(1, Math.round((ms / 1000) * FPS));

async function moveTo(x, y, opts = {}) {
  const from = { ...cur };
  const dist = Math.hypot(x - from.x, y - from.y);
  const ms = opts.ms ?? Math.min(900, Math.max(320, 260 + dist * 0.9));
  const frames = Math.max(2, framesFor(ms));
  // A slight bow in the path so it doesn't read as a straight line.
  const bow = (opts.bow ?? 0.08) * dist * (random() < 0.5 ? -1 : 1);
  const nx = -(y - from.y) / (dist || 1);
  const ny = (x - from.x) / (dist || 1);
  for (let i = 1; i <= frames; i++) {
    const t = easeInOut(i / frames);
    const arc = Math.sin(Math.PI * t) * bow;
    cur = {
      x: from.x + (x - from.x) * t + nx * arc,
      y: from.y + (y - from.y) * t + ny * arc,
    };
    await page.mouse.move(cur.x, cur.y);
    await tick();
  }
}

async function hold(ms) {
  const frames = framesFor(ms);
  for (let i = 0; i < frames; i++) await tick();
}

async function click() {
  await page.evaluate(() => window.__press(true));
  await page.mouse.down();
  await hold(70);
  await page.mouse.up();
  await page.evaluate(() => window.__press(false));
  await hold(60);
}

/** A point inside a box, a little off-center so it looks aimed by hand. */
function aim(box, fx = 0.5, fy = 0.5, jitter = 0.12) {
  const jx = (random() - 0.5) * jitter;
  const jy = (random() - 0.5) * jitter;
  return {
    x: box.x + box.width * (fx + jx),
    y: box.y + box.height * (fy + jy),
  };
}

/** A locator's box in canvas coordinates (Playwright already adds the iframe's offset). */
async function box(target) {
  if (target && typeof target.boundingBox === "function") {
    const b = await target.boundingBox();
    if (!b) throw new Error("Element to aim at isn't visible");
    return b;
  }
  return target;
}

async function hover(target, opts = {}) {
  const b = await box(target);
  const p = aim(b, opts.fx ?? 0.5, opts.fy ?? 0.5, opts.jitter);
  await moveTo(p.x, p.y, opts);
  await hold(opts.dwell ?? 360);
}

async function clickOn(target, opts = {}) {
  await hover(target, { ...opts, dwell: opts.dwell ?? 120 });
  await click();
  await hold(opts.settle ?? 180);
}

/** Boxes of the items that are fully inside `within` (a scroll container), in DOM order. */
async function visibleBoxes(items, opts = {}) {
  const limit = opts.within
    ? await box(opts.within)
    : { x: 0, y: 0, width: WIDTH, height: HEIGHT };
  const count = await items.count();
  const boxes = [];
  for (let i = 0; i < count && boxes.length < (opts.max ?? Infinity); i++) {
    const b = await items.nth(i).boundingBox();
    if (!b) continue;
    if (b.y >= limit.y - 4 && b.y + b.height <= limit.y + limit.height + 4)
      boxes.push(b);
  }
  return boxes;
}

/** Hover each visible item in turn: cards get the cursor on their top half, rows on their left. */
async function sweep(items, opts = {}) {
  for (const b of await visibleBoxes(items, opts)) {
    const tall = b.height > 120;
    await hover(b, {
      fx: opts.fx ?? (tall ? 0.5 : 0.35),
      fy: opts.fy ?? (tall ? 0.42 : 0.5),
      dwell: opts.dwell,
    });
  }
}

/** Type like a person: a keystroke every 60–130ms, with the frames to show it. */
async function type(text, opts = {}) {
  for (const ch of text) {
    await page.keyboard.type(ch);
    await hold(opts.perChar ?? 60 + random() * 70);
  }
}

/** Scroll with the wheel at the cursor, in steps over `ms`. */
async function wheel(dy, opts = {}) {
  const frames = framesFor(opts.ms ?? 500);
  for (let i = 1; i <= frames; i++) {
    const step = (easeInOut(i / frames) - easeInOut((i - 1) / frames)) * dy;
    await page.mouse.wheel(0, step);
    await tick();
  }
}

const t = {
  page,
  app,
  frame,
  width: WIDTH,
  height: HEIGHT,
  pad: PAD,
  fps: FPS,
  random,
  hold,
  moveTo,
  click,
  aim,
  box,
  hover,
  clickOn,
  visibleBoxes,
  sweep,
  type,
  wheel,
  /** Mark the current frame as the poster (default: the middle frame). */
  poster: () => {
    posterFrame = n;
  },
  get position() {
    return { ...cur };
  },
};

// ---- the take ------------------------------------------------------------------

if (take.ready) await take.ready(t);
else await page.waitForTimeout(1500);

if (STILL) {
  if (take.still) await take.still(t);
  await tick();
  const last = join(framesDir, `${String(n - 1).padStart(5, "0")}.jpg`);
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    last,
    `${out}.png`,
  ]);
  rmSync(framesDir, { recursive: true, force: true });
  await browser.close();
  console.log(`still: ${out}.png`);
  process.exit(0);
}

const started = Date.now();
await take.default(t);
await browser.close();
console.log(
  `frames: ${n} (${(n / FPS).toFixed(1)}s), ${((Date.now() - started) / n).toFixed(0)}ms per frame`,
);

// ---- encode ----------------------------------------------------------------------

const pattern = join(framesDir, "%05d.jpg");
if (FORMATS.has("mp4")) {
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-framerate",
    String(FPS),
    "-i",
    pattern,
    "-vf",
    `scale=${OUT_WIDTH}:-2:flags=lanczos`,
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "17",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    `${out}.mp4`,
  ]);
  console.log(`mp4: ${out}.mp4`);
}
if (FORMATS.has("png")) {
  const index = posterFrame ?? Math.floor(n / 2);
  execFileSync("ffmpeg", [
    "-y",
    "-loglevel",
    "error",
    "-i",
    join(framesDir, `${String(index).padStart(5, "0")}.jpg`),
    "-vf",
    `scale=${OUT_WIDTH}:-2:flags=lanczos`,
    `${out}.png`,
  ]);
  console.log(`poster: ${out}.png (frame ${index})`);
}
if (!KEEP) rmSync(framesDir, { recursive: true, force: true });
