// ccf-import.mjs — independent feature: import a CCF-format room (.zip)
// as a Foundry scene.
//
// CCF zip layout:
//   __data.json — entities.room (foregroundUrl/backgroundUrl/markers/...),
//                 entities.items, resources
//   <hash>.png  — every image referenced by hash from __data.json
//   .token      — opaque CCF token (ignored)
//
// Mapping:
//   CCF foregroundUrl  → Foundry Scene background image (fills the field)
//   CCF backgroundUrl  → Foundry Scene backdrop (flag consumed by ccf-backdrop.mjs)
//   CCF markers+items  → Foundry tiles (one per CCF entity)
//   Scene grid         → square, gridless visual (alpha 0), 100 px / CCF unit
//   Token vision       → off
//   Global illumination → on
//
// Self-contained: re-declares MODULE_ID locally to match the rest of the module.

const MODULE_ID = "ccf-ui-v11";
const PX_PER_UNIT = 100;          // 1 CCF grid unit → 100 Foundry pixels
const SCENE_PADDING = 0;          // scene rect already covers the full bbox

// --- Minimal ZIP reader (v11 has no bundled JSZip) --------------------------
// Uses native DecompressionStream("deflate-raw"), available in v11's Electron
// (Chromium ≥ 113). Supports stored (method 0) and deflate (method 8) entries.
async function readZip(buffer) {
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  // Locate End-of-Central-Directory (signature 0x06054b50). It sits at the
  // tail of the file, possibly followed by up to 65535 bytes of comment.
  let eocd = -1;
  const minStart = Math.max(0, buffer.byteLength - (22 + 65535));
  for (let i = buffer.byteLength - 22; i >= minStart; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a valid ZIP (no EOCD).");

  const totalEntries = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);

  // Walk the Central Directory.
  const files = {};
  const decoder = new TextDecoder("utf-8");
  let p = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) {
      throw new Error(`Bad central directory header at offset ${p}.`);
    }
    const compMethod = view.getUint16(p + 10, true);
    const compSize   = view.getUint32(p + 20, true);
    const uncompSize = view.getUint32(p + 24, true);
    const fnLen      = view.getUint16(p + 28, true);
    const extraLen   = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const lfhOffset  = view.getUint32(p + 42, true);

    const name = decoder.decode(u8.subarray(p + 46, p + 46 + fnLen));
    files[name] = { compMethod, compSize, uncompSize, lfhOffset };
    p += 46 + fnLen + extraLen + commentLen;
  }

  async function readFile(name, type = "uint8array") {
    const e = files[name];
    if (!e) throw new Error(`File "${name}" not found in zip.`);

    // Skip the local file header to reach the actual entry data.
    if (view.getUint32(e.lfhOffset, true) !== 0x04034b50) {
      throw new Error(`Bad local file header for ${name}.`);
    }
    const lfhFn    = view.getUint16(e.lfhOffset + 26, true);
    const lfhExtra = view.getUint16(e.lfhOffset + 28, true);
    const dataStart = e.lfhOffset + 30 + lfhFn + lfhExtra;
    const compressed = u8.subarray(dataStart, dataStart + e.compSize);

    let raw;
    if (e.compMethod === 0) {
      raw = compressed.slice();
    } else if (e.compMethod === 8) {
      if (typeof DecompressionStream === "undefined") {
        throw new Error("DecompressionStream is unavailable; please update Foundry.");
      }
      const stream = new Blob([compressed]).stream()
        .pipeThrough(new DecompressionStream("deflate-raw"));
      const blob = await new Response(stream).blob();
      raw = new Uint8Array(await blob.arrayBuffer());
    } else {
      throw new Error(`Unsupported ZIP compression method ${e.compMethod}.`);
    }

    if (type === "string") return new TextDecoder().decode(raw);
    if (type === "blob")   return new Blob([raw]);
    return raw;
  }

  return { files, readFile };
}

// --- Filesystem helpers -----------------------------------------------------
async function ensureDirectory(path) {
  const parts = path.split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    try {
      await FilePicker.createDirectory("data", cur);
    } catch (e) {
      // EEXIST is fine — Foundry throws on collision; anything else is a
      // genuine error worth surfacing.
      if (!/exists|EEXIST/i.test(e?.message ?? "")) {
        // swallow but log; FilePicker.upload will fail loudly if the dir
        // truly is missing.
        console.warn(`[ccf-import] createDirectory(${cur})`, e);
      }
    }
  }
}

// --- Core import ------------------------------------------------------------
async function importCcfRoomFromFile(file) {
  if (!file) return null;

  const t0 = performance.now();
  ui.notifications?.info(game.i18n.localize("CCFUI.Import.InProgress"));

  // 1. Read and parse the zip.
  const buf = await file.arrayBuffer();
  const zip = await readZip(buf);
  if (!zip.files["__data.json"]) throw new Error("Missing __data.json in the CCF zip.");
  const data = JSON.parse(await zip.readFile("__data.json", "string"));
  const room = data?.entities?.room;
  if (!room) throw new Error("CCF zip does not contain room data.");
  const items = data?.entities?.items ?? {};
  const markers = room?.markers ?? {};

  // 2. Upload every image asset to a per-import directory under the world.
  const importId = foundry.utils.randomID(16);
  const baseDir = `worlds/${game.world.id}/ccf-rooms/${importId}`;
  await ensureDirectory(baseDir);

  const fileMap = {}; // "<hash>.png" → uploaded URL
  const entries = Object.keys(zip.files).filter((name) => {
    if (name === "__data.json") return false;
    if (name.startsWith(".")) return false;
    if (name.endsWith("/")) return false;   // directory marker
    return true;
  });

  for (const name of entries) {
    const bytes = await zip.readFile(name);
    const ext = name.split(".").pop()?.toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg"
      : ext === "webp" ? "image/webp"
      : ext === "gif" ? "image/gif"
      : "image/png";
    const fileObj = new File([bytes], name, { type: mime });
    const result = await FilePicker.upload("data", baseDir, fileObj, {}, { notify: false });
    fileMap[name] = result?.path ?? `${baseDir}/${name}`;
  }

  const url = (hash) => (hash && fileMap[hash]) ? fileMap[hash] : null;

  // 3. Compute scene dimensions as the bounding box of EVERYTHING (field +
  //    markers + items). The CCF foreground image is placed in the centre
  //    as a tile at the field's location, with the rest of the canvas
  //    filled by the backdrop. This avoids Foundry's 0.5 padding cap when
  //    items live far outside the field.
  const fieldW = Number(room.fieldWidth) || 29;
  const fieldH = Number(room.fieldHeight) || 22;

  // CCF coords have (0, 0) at the centre of the field; entity x/y is the
  // top-left of each entity. Compute the bbox in CCF units.
  let minX = -fieldW / 2;
  let maxX =  fieldW / 2;
  let minY = -fieldH / 2;
  let maxY =  fieldH / 2;
  const allEntities = [...Object.values(markers), ...Object.values(items)];
  for (const e of allEntities) {
    const ex = Number(e.x), ey = Number(e.y);
    const ew = Number(e.width), eh = Number(e.height);
    if (!Number.isFinite(ex) || !Number.isFinite(ey)) continue;
    if (!Number.isFinite(ew) || !Number.isFinite(eh)) continue;
    if (ex < minX) minX = ex;
    if (ey < minY) minY = ey;
    if (ex + ew > maxX) maxX = ex + ew;
    if (ey + eh > maxY) maxY = ey + eh;
  }
  const sceneWidth  = Math.round((maxX - minX) * PX_PER_UNIT);
  const sceneHeight = Math.round((maxY - minY) * PX_PER_UNIT);

  // With padding=0, Foundry pixel (0,0) is the top-left of the canvas, so
  // map CCF (minX, minY) → pixel (0, 0). Then CCF (0, 0) (the centre of
  // the field) lands at pixel (offsetX, offsetY).
  const offsetX = Math.round(-minX * PX_PER_UNIT);
  const offsetY = Math.round(-minY * PX_PER_UNIT);

  // 4. Convert CCF entities → Foundry tile data.
  const toTile = (entity) => {
    const src = url(entity.imageUrl);
    if (!src) return null;
    const w = Number(entity.width) * PX_PER_UNIT;
    const h = Number(entity.height) * PX_PER_UNIT;
    if (!w || !h) return null;
    return {
      _id: foundry.utils.randomID(),
      x: Math.round(offsetX + Number(entity.x) * PX_PER_UNIT),
      y: Math.round(offsetY + Number(entity.y) * PX_PER_UNIT),
      width: Math.round(w),
      height: Math.round(h),
      rotation: Number(entity.angle) || 0,
      z: Number.isFinite(entity.z) ? entity.z : 100,
      alpha: 1,
      hidden: entity.visible === false,
      locked: !!entity.locked,
      overhead: false,
      texture: { src },
    };
  };

  const tiles = [];

  // 4a. CCF foreground → tile at the field position, going through the
  //     same toTile() pipeline as markers and items. z = -10000 keeps it
  //     at the bottom of the z-stack (every CCF entity z value seen ≥ -1)
  //     so all other tiles render above it.
  const foregroundTile = toTile({
    imageUrl: room.foregroundUrl,
    x: -fieldW / 2,
    y: -fieldH / 2,
    width: fieldW,
    height: fieldH,
    angle: 0,
    z: -10000,
    visible: true,
    locked: true,
  });
  if (foregroundTile) tiles.push(foregroundTile);

  // 4b. CCF markers → tiles.
  for (const m of Object.values(markers)) {
    const t = toTile(m);
    if (t) tiles.push(t);
  }

  // 4c. CCF items → tiles.
  for (const it of Object.values(items)) {
    const t = toTile(it);
    if (t) tiles.push(t);
  }

  // 5. Build and create the scene.
  const sceneName = (file.name || `CCF Room`).replace(/\.zip$/i, "");
  const sceneData = {
    name: sceneName,
    width: sceneWidth,
    height: sceneHeight,
    padding: SCENE_PADDING,
    // Foreground is placed as a tile (above), so the scene background is
    // empty — the backdrop fills the rest of the canvas behind it.
    background: { src: "" },
    backgroundColor: room.backgroundColor || "#000000",
    grid: {
      type: 1,                  // square
      size: PX_PER_UNIT,
      color: "#000000",
      alpha: 0,                 // hide the visual grid (CCF rooms read as gridless)
      distance: 1,
      units: "u",
    },
    initial: { x: offsetX, y: offsetY, scale: null },
    tokenVision: false,
    globalLight: true,
    fogExploration: false,
    tiles,
    flags: {
      [MODULE_ID]: {
        backdrop: url(room.backgroundUrl) ?? "",
        ccfImport: {
          id: importId,
          version: data?.meta?.version ?? null,
          fieldWidth: fieldW,
          fieldHeight: fieldH,
          importedAt: Date.now(),
        },
      },
    },
  };

  const scene = await Scene.create(sceneData);
  const ms = Math.round(performance.now() - t0);
  ui.notifications?.info(
    game.i18n.format("CCFUI.Import.Done", { name: sceneName, count: tiles.length, ms })
  );
  return scene;
}

// --- UI: import button in the Scenes directory ------------------------------
function openImportPicker() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".zip,application/zip,application/x-zip-compressed";
  input.style.display = "none";
  document.body.appendChild(input);
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    try {
      await importCcfRoomFromFile(file);
    } catch (err) {
      console.error("[ccf-import]", err);
      ui.notifications?.error(
        game.i18n.format("CCFUI.Import.Failed", { error: err?.message ?? String(err) })
      );
    }
  }, { once: true });
  input.click();
}

function injectImportButton(app, html) {
  if (!game.user?.isGM) return;
  const $html = html?.jquery ? html : $(html);
  if ($html.find(".ccf-import-btn").length) return;

  const label = game.i18n.localize("CCFUI.Import.Button");
  const $btn = $(
    `<button type="button" class="ccf-import-btn">
       <i class="fas fa-file-archive"></i> ${label}
     </button>`
  );
  $btn.on("click", (ev) => {
    ev.preventDefault();
    openImportPicker();
  });

  // Foundry's SceneDirectory has a `.directory-header` containing the
  // search bar and the create-document button. Slot ours just below it,
  // before the scene list, to match the styling of similar module UIs.
  const header = $html.find(".directory-header").first();
  if (header.length) header.after($btn);
  else $html.prepend($btn);
}

// --- Hooks ------------------------------------------------------------------
Hooks.on("renderSceneDirectory", (app, html) => {
  injectImportButton(app, html);
});
