// ccf-apng-webm.mjs — independent feature: auto-convert animated-PNG (APNG)
// tile images to alpha-preserving VP9 WebM on save.
//
// Flow: when a GM sets a Tile's image to an APNG and saves the Tile Config,
// this client (and only this client) detects the APNG, converts it to a
// transparent VP9 WebM entirely in the browser via ffmpeg.wasm, uploads the
// .webm to the world's data dir, then rewrites that tile's texture.src to the
// new file. Foundry then plays it through its native video-tile pipeline
// (loop / autoplay / streaming decode / low memory / multiplayer sync), all
// of which APNG tiles do not get.
//
// Why WebM (not runtime APNG decoding): once converted, playback costs zero
// at runtime and survives across Foundry versions (no PIXI mesh/texture
// internals). The cost is a one-time conversion on first save.
//
// Engine: single-threaded @ffmpeg/core (libvpx-vp9). Single-thread needs NO
// SharedArrayBuffer and NO COOP/COEP cross-origin-isolation headers — which a
// Foundry module cannot set anyway. Alpha is preserved with
// `-pix_fmt yuva420p -auto-alt-ref 0 -b:v 0 -crf <q>`; BOTH yuva420p and
// auto-alt-ref 0 are mandatory or libvpx silently drops/breaks transparency.
//
// Self-contained: re-declares MODULE_ID locally and copies ensureDirectory()
// from ccf-import.mjs to match the no-cross-file-import pattern of the module.

const MODULE_ID = "ccf-ui-v11";

// Pinned, mutually-compatible ffmpeg.wasm versions. Loaded lazily from a CDN
// on the first real conversion and cached by the browser thereafter.
const FFMPEG_VERSION = "0.12.15";   // @ffmpeg/ffmpeg
const FFUTIL_VERSION = "0.12.2";    // @ffmpeg/util
const FFCORE_VERSION = "0.12.10";   // @ffmpeg/core (single-thread)
const DEFAULT_CDN_BASE = "https://unpkg.com";

const DETECT_BYTES = 65535;         // first 64 KiB is plenty to find acTL/IDAT

// --- Settings helpers -------------------------------------------------------
function setting(key, fallback) {
  try { return game.settings.get(MODULE_ID, key); }
  catch (e) { return fallback; }
}

// --- Filesystem helpers (copied verbatim from ccf-import.mjs) ----------------
async function ensureDirectory(path) {
  const parts = path.split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    try {
      await FilePicker.createDirectory("data", cur);
    } catch (e) {
      if (!/exists|EEXIST/i.test(e?.message ?? "")) {
        console.warn(`[ccf-apng-webm] createDirectory(${cur})`, e);
      }
    }
  }
}

function cacheDir() {
  return `worlds/${game.world.id}/ccf-apng-webm-cache`;
}

// --- APNG detection ---------------------------------------------------------
// A PNG is an APNG iff it carries an `acTL` (Animation Control) chunk that
// appears BEFORE the first `IDAT`. PNG chunk lengths are big-endian — the
// opposite of the little-endian ZIP reader in ccf-import.mjs, an easy trap.
function bufferIsApng(buf) {
  const u8 = new Uint8Array(buf);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (u8.length < 8) return null;            // too small to tell
  for (let i = 0; i < 8; i++) if (u8[i] !== sig[i]) return false;

  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 8;
  while (p + 8 <= u8.length) {
    const len = view.getUint32(p, false);    // big-endian
    const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    if (type === "acTL") return true;        // animation control → APNG
    if (type === "IDAT") return false;       // first image data, no acTL → static
    if (type === "IEND") return false;
    p += 12 + len;                           // 4 len + 4 type + len data + 4 CRC
  }
  return null;                               // ran off the (partial) buffer
}

// Resolve a Foundry data path to a fetchable URL. Absolute URLs pass through;
// relative data paths go through getRoute so they resolve under a non-root
// Foundry route prefix.
function srcToUrl(src) {
  if (/^(https?:)?\/\//i.test(src) || src.startsWith("blob:") || src.startsWith("data:")) {
    return src;
  }
  return foundry.utils.getRoute(src);
}

async function isAnimatedPng(src) {
  const url = srcToUrl(src);
  // Ranged read first — cheap for the common (static-PNG) case.
  let verdict = null;
  try {
    const resp = await fetch(url, { headers: { Range: `bytes=0-${DETECT_BYTES}` } });
    if (!resp.ok && resp.status !== 206) return false;
    verdict = bufferIsApng(await resp.arrayBuffer());
  } catch (e) {
    return false;
  }
  if (verdict !== null) return verdict;
  // Inconclusive partial (acTL/IDAT not reached) — fall back to a full read.
  try {
    const resp = await fetch(url);
    if (!resp.ok) return false;
    return bufferIsApng(await resp.arrayBuffer()) === true;
  } catch (e) {
    return false;
  }
}

async function fetchBytes(src) {
  const resp = await fetch(srcToUrl(src));
  if (!resp.ok) throw new Error(`fetch ${resp.status} for ${src}`);
  return new Uint8Array(await resp.arrayBuffer());
}

// --- Deterministic cache key/path -------------------------------------------
// Prefer SHA-1, but crypto.subtle only exists in secure contexts. Many Foundry
// servers run over plain http on a LAN IP (non-secure), where it's undefined —
// fall back to a dependency-free string hash so the cache filename still works.
function cyrb53(str, seed) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const n = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return n.toString(16).padStart(14, "0");
}

async function hashKey(str) {
  if (globalThis.crypto?.subtle) {
    try {
      const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(str));
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    } catch (e) { /* fall through to the string hash */ }
  }
  return cyrb53(str, 0) + cyrb53(str, 0x9e3779b9);
}

async function targetExists(targetPath) {
  const dir = targetPath.slice(0, targetPath.lastIndexOf("/"));
  try {
    const res = await FilePicker.browse("data", dir);
    return Array.isArray(res?.files) && res.files.includes(targetPath);
  } catch (e) {
    return false;   // dir not created yet → no cache
  }
}

// --- ffmpeg.wasm lazy loader ------------------------------------------------
// Single-thread core: no workerURL → no SharedArrayBuffer / COOP-COEP needed.
//
// The class worker that @ffmpeg/ffmpeg spawns is `new Worker(<worker.js>,
// {type:"module"})`. Loaded cross-origin from a CDN that worker URL would trip
// the same-origin worker restriction, so we hand it a same-origin BLOB module
// worker whose sole job is to `import` the absolute CDN worker.js. Module
// workers may cross-origin-import an absolute URL (CORS), and worker.js's own
// relative imports then resolve against its absolute CDN URL.
let _ffmpegPromise = null;

function getFfmpeg() {
  if (_ffmpegPromise) return _ffmpegPromise;
  _ffmpegPromise = (async () => {
    const base = (setting("apngCdnBase", DEFAULT_CDN_BASE) || DEFAULT_CDN_BASE).replace(/\/+$/, "");
    const ffBase = `${base}/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm`;
    const utilBase = `${base}/@ffmpeg/util@${FFUTIL_VERSION}/dist/esm`;
    const coreBase = `${base}/@ffmpeg/core@${FFCORE_VERSION}/dist/esm`;

    const { FFmpeg } = await import(/* @vite-ignore */ `${ffBase}/index.js`);
    const { toBlobURL } = await import(/* @vite-ignore */ `${utilBase}/index.js`);

    const classWorkerURL = URL.createObjectURL(new Blob(
      [`import ${JSON.stringify(`${ffBase}/worker.js`)};`],
      { type: "text/javascript" }
    ));

    const ffmpeg = new FFmpeg();
    await ffmpeg.load({
      classWorkerURL,
      coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, "application/wasm"),
    });
    return ffmpeg;
  })();
  // If loading fails, clear the cache so a later save can retry.
  _ffmpegPromise.catch(() => { _ffmpegPromise = null; });
  return _ffmpegPromise;
}

// --- Encode -----------------------------------------------------------------
async function encodeApngToWebm(ffmpeg, bytes, crf, premultiply) {
  const inName = "in.png";
  const outName = "out.webm";
  await ffmpeg.writeFile(inName, bytes);

  const args = ["-i", inName, "-c:v", "libvpx-vp9"];
  // Premultiplying the RGB by alpha sidesteps the PIXI "black matte on
  // semi-transparent edges" artifact on older Foundry builds (issue #8848).
  if (premultiply) args.push("-vf", "premultiply=inplace=1");
  args.push(
    "-pix_fmt", "yuva420p",   // alpha-carrying 4:2:0
    "-auto-alt-ref", "0",     // MANDATORY for alpha: alt-ref frames break it
    "-b:v", "0",              // constant-quality mode so -crf takes effect
    "-crf", String(crf),
    outName,
  );

  await ffmpeg.exec(args);
  const out = await ffmpeg.readFile(outName);
  try { await ffmpeg.deleteFile(inName); } catch (e) { /* ignore */ }
  try { await ffmpeg.deleteFile(outName); } catch (e) { /* ignore */ }
  if (!out || !out.length) throw new Error("ffmpeg produced an empty file");
  return out instanceof Uint8Array ? out : new Uint8Array(out);
}

// --- On-canvas progress badge (styled by ccf-apng-webm.css) -----------------
function showProgress(text) {
  let el = document.getElementById("ccf-apng-progress");
  if (!el) {
    el = document.createElement("div");
    el.id = "ccf-apng-progress";
    el.className = "ccf-apng-progress";
    document.body.appendChild(el);
  }
  el.textContent = text;
  return el;
}

function hideProgress() {
  document.getElementById("ccf-apng-progress")?.remove();
}

// --- Orchestration ----------------------------------------------------------
async function convertTileApng(doc, src) {
  const crf = Number(setting("apngCrf", 30)) || 30;
  const premultiply = setting("apngPremultiply", false) === true;

  // 1. Detect — skip plain/static PNGs (and anything non-PNG) cheaply.
  if (!(await isAnimatedPng(src))) return;

  // 2. Deterministic cache key from the source path + quality knobs. Changing
  //    crf/premultiply forces a fresh encode rather than serving a stale file.
  const hash = await hashKey(`${src}|crf${crf}|pm${premultiply ? 1 : 0}`);
  const dir = cacheDir();
  const targetPath = `${dir}/${hash}.webm`;

  // 3. Cache hit → just rewrite the src, no ffmpeg.
  let webmPath = null;
  if (await targetExists(targetPath)) {
    webmPath = targetPath;
  } else {
    const t0 = performance.now();
    ui.notifications?.info(game.i18n.localize("CCFUI.Apng.Start"));
    const badge = showProgress(game.i18n.format("CCFUI.Apng.Progress", { pct: 0 }));
    try {
      const ffmpeg = await getFfmpeg();
      let last = 0;
      const onProgress = ({ progress }) => {
        const pct = Math.max(0, Math.min(100, Math.round((progress || 0) * 100)));
        if (pct >= last + 1) {                 // throttle DOM writes
          last = pct;
          badge.textContent = game.i18n.format("CCFUI.Apng.Progress", { pct });
        }
      };
      ffmpeg.on?.("progress", onProgress);
      let bytes;
      try {
        bytes = await fetchBytes(src);
        const out = await encodeApngToWebm(ffmpeg, bytes, crf, premultiply);
        await ensureDirectory(dir);
        const fileObj = new File([out], `${hash}.webm`, { type: "video/webm" });
        const result = await FilePicker.upload("data", dir, fileObj, {}, { notify: false });
        webmPath = result?.path ?? targetPath;
      } finally {
        ffmpeg.off?.("progress", onProgress);
      }
      const ms = Math.round(performance.now() - t0);
      ui.notifications?.info(game.i18n.format("CCFUI.Apng.Done", { ms }));
    } finally {
      hideProgress();
    }
  }

  // 4. Rewrite the tile's source. The skipApng flag + the .png/.apng-only
  //    guard in onTileWrite both prevent this update from re-triggering.
  if (webmPath && doc?.update) {
    await doc.update(
      { "texture.src": webmPath },
      { diff: true, [MODULE_ID]: { skipApng: true } }
    );
  }
}

// --- Hook entry point -------------------------------------------------------
function onTileWrite(doc, src, userId, options) {
  if (setting("apngEnabled", true) !== true) return;
  if (!game.user?.isGM) return;
  if (userId !== game.user.id) return;             // exactly one client converts
  if (options?.[MODULE_ID]?.skipApng === true) return;
  if (typeof src !== "string" || !/\.(png|apng)$/i.test(src)) return;

  if (!game.user.hasPermission("FILES_UPLOAD")) {
    console.warn("[ccf-apng-webm] skipped: missing FILES_UPLOAD permission.");
    if (!onTileWrite._warned) {
      onTileWrite._warned = true;
      ui.notifications?.warn(game.i18n.localize("CCFUI.Apng.NoPerm"));
    }
    return;
  }

  convertTileApng(doc, src).catch((err) => {
    hideProgress();
    console.error("[ccf-apng-webm]", err);
    ui.notifications?.error(
      game.i18n.format("CCFUI.Apng.Failed", { error: err?.message ?? String(err) })
    );
  });
}

// --- Settings ---------------------------------------------------------------
Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "apngEnabled", {
    name: "CCFUI.Settings.ApngEnabled.Name",
    hint: "CCFUI.Settings.ApngEnabled.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, "apngCrf", {
    name: "CCFUI.Settings.ApngCrf.Name",
    hint: "CCFUI.Settings.ApngCrf.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 4, max: 63, step: 1 },
    default: 30,
  });

  game.settings.register(MODULE_ID, "apngPremultiply", {
    name: "CCFUI.Settings.ApngPremultiply.Name",
    hint: "CCFUI.Settings.ApngPremultiply.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, "apngCdnBase", {
    name: "CCFUI.Settings.ApngCdnBase.Name",
    hint: "CCFUI.Settings.ApngCdnBase.Hint",
    scope: "world",
    config: true,
    type: String,
    default: DEFAULT_CDN_BASE,
  });
});

// --- Hooks ------------------------------------------------------------------
Hooks.on("createTile", (doc, options, userId) => {
  onTileWrite(doc, doc?.texture?.src, userId, options);
});

Hooks.on("updateTile", (doc, changes, options, userId) => {
  if (!foundry.utils.hasProperty(changes, "texture.src")) return;
  onTileWrite(doc, foundry.utils.getProperty(changes, "texture.src"), userId, options);
});
