// ccf-backdrop.mjs — per-scene blurred backdrop that fills the area Foundry
// would otherwise paint with the scene's "Background Color".
//
// Approach: each scene can store an image URL in flags.ccf-ui-v11.backdrop
// via the Scene Config dialog. When that scene is the one currently being
// viewed, a PIXI Sprite is inserted as the lowest child of `canvas.stage`
// with a BlurFilter applied, sized to cover the entire viewport. Because
// the scene background image (in `canvas.primary`) is a sibling drawn
// later, it visually sits ON TOP of our sprite — so the backdrop only
// shows through in the padding/letterbox area where no scene background
// covers it (i.e. exactly the region the scene background color used to
// fill). Tokens, drawings, etc. continue to render above as usual.
//
// Outline suppression: Foundry's InterfaceCanvasGroup draws a stray "scene
// outline" on top of the canvas (see InterfaceCanvasGroup##drawOutline) —
// a bold border around the padded canvas rect when scene.padding !== 0, and
// a faint border around the scene rect when the scene has no background
// image. Once a backdrop fills the viewport those read as floating frame
// lines, so we hide that outline graphics on any scene that has a backdrop.
//
// Self-contained: re-declares MODULE_ID locally to match the pattern in
// ccf-ui.mjs / ccf-mobile.mjs.

const MODULE_ID = "ccf-ui-v11";
const FLAG_KEY = "backdrop";
const SPRITE_NAME = "ccfBackdropSprite";

function getBackdropFor(scene) {
  if (!scene?.getFlag) return null;
  const v = scene.getFlag(MODULE_ID, FLAG_KEY);
  return (typeof v === "string" && v.trim()) ? v : null;
}

// Two backdrop sprites are attached so the underlay covers BOTH:
//   - the area outside the scene rect / past the padded canvas
//     (handled by the sprite living in canvas.stage), and
//   - the area inside the scene rect where the scene background image
//     is empty or has transparent pixels
//     (handled by the sprite living in canvas.primary, sorted below the
//      scene bg sprite via elevation/sort — see attachBackdropSprite for
//      why zIndex alone does NOT work inside the PrimaryCanvasGroup).
// They share one PIXI.Texture so the image only has to decode once.
function getBackdropContainers() {
  const out = [];
  if (canvas?.stage)   out.push(canvas.stage);
  if (canvas?.primary) out.push(canvas.primary);
  return out;
}

function getBackdropSprites() {
  const sprites = [];
  for (const c of getBackdropContainers()) {
    const s = c.getChildByName?.(SPRITE_NAME);
    if (s) sprites.push(s);
  }
  return sprites;
}

function detachBackdropSprite() {
  for (const c of getBackdropContainers()) {
    const old = c.getChildByName?.(SPRITE_NAME);
    if (!old) continue;
    try { c.removeChild(old); } catch (e) { /* ignore */ }
    try { old.destroy({ children: true }); } catch (e) { /* ignore */ }
  }
}

function attachBackdropSprite(scene) {
  detachBackdropSprite();
  if (!canvas?.ready) return;
  const url = getBackdropFor(scene);
  if (!url) return;

  let texture;
  try { texture = PIXI.Texture.from(url); } catch (e) { return; }

  for (const container of getBackdropContainers()) {
    const sprite = new PIXI.Sprite(texture);
    sprite.name = SPRITE_NAME;
    sprite.eventMode = "none";
    sprite.interactive = false;
    sprite.interactiveChildren = false;

    // Each sprite gets its own blur filter (filters are not safely shared
    // across sprites). `padding` keeps the blur halo from being clipped.
    const blur = new PIXI.BlurFilter();
    blur.blur = 8;
    blur.quality = 4;
    blur.padding = 48;
    sprite.filters = [blur];

    // Force this sprite to the very bottom of the parent's z-sort so it
    // renders before the scene bg sprite and any tile in that container.
    //
    // IMPORTANT: the two parent containers sort their children differently.
    //   - canvas.stage is a plain PIXI.Container → sorts by `zIndex`.
    //   - canvas.primary is a PrimaryCanvasGroup, which OVERRIDES
    //     sortChildren() and orders children by `elevation`, then
    //     `constructor.PRIMARY_SORT_ORDER`, then `sort` — and ignores
    //     `zIndex` entirely. The scene background mesh lives there with
    //     elevation 0 / sort -9999999999. So a sprite carrying only
    //     zIndex = -10000 is treated as sort 0 (> -9999999999) and the
    //     custom sorter floats it ABOVE the scene background image, hiding
    //     it. To keep the backdrop strictly beneath the scene background we
    //     must match the background's elevation and use an even lower sort.
    const isPrimary = container === canvas?.primary;
    sprite.zIndex = -10000;
    if (isPrimary) {
      sprite.elevation = container.background?.elevation ?? 0;
      sprite.sort = -1e12; // below the scene background mesh's -9999999999
    }
    if (typeof container.sortableChildren === "boolean") {
      container.sortableChildren = true;
    }
    container.addChildAt(sprite, 0);

    // PrimaryCanvasGroup re-runs its custom sort on every refresh and would
    // otherwise undo our insertion order; force it to settle the sprite
    // below the background right now using the elevation/sort set above.
    if (isPrimary && typeof container.sortChildren === "function") {
      container.sortDirty = true;
      container.sortChildren();
    }

    updateBackdropSpriteViewport(sprite);

    const baseTex = texture.baseTexture;
    if (baseTex && !baseTex.valid) {
      baseTex.once("loaded", () => updateBackdropSpriteViewport(sprite));
      baseTex.once("update", () => updateBackdropSpriteViewport(sprite));
    }
  }
}

function updateBackdropSpriteViewport(sprite) {
  if (!sprite) {
    for (const s of getBackdropSprites()) updateBackdropSpriteViewport(s);
    return;
  }
  if (!sprite.parent) return;
  const stage = sprite.parent;
  const renderer = canvas?.app?.renderer;
  if (!renderer?.screen) return;

  const W = renderer.screen.width;
  const H = renderer.screen.height;
  // Pad in screen pixels so the blur halo and any rounding never reveal
  // an uncovered edge inside the viewport.
  const padPx = 80;

  // Foundry v11 pans via `canvas.stage.pivot` (not `position`), so going
  // through the stage's full world transform is the only correct way to
  // map the viewport rect back into stage-local coordinates regardless of
  // pan/zoom state.
  const tl = stage.toLocal({ x: -padPx, y: -padPx });
  const br = stage.toLocal({ x: W + padPx, y: H + padPx });

  sprite.x = tl.x;
  sprite.y = tl.y;
  // width/height stretch the sprite non-uniformly so the texture fills
  // the entire viewport regardless of its native aspect ratio.
  sprite.width = br.x - tl.x;
  sprite.height = br.y - tl.y;
}

// --- Foundry scene-outline suppression --------------------------------------
// Foundry's InterfaceCanvasGroup draws a single PIXI.Graphics "outline" on
// every canvas draw (InterfaceCanvasGroup##drawOutline):
//   - a 4px, 0.75-alpha border around dimensions.rect      when scene.padding !== 0
//   - a 4px, 0.25-alpha border around dimensions.sceneRect when the scene has
//     no background image (scene.background.src is empty)
// Against a backdrop these are stray frame lines, so we hide that graphics for
// any scene with a backdrop and leave Foundry's default behaviour otherwise.
function getOutlineGraphics() {
  const iface = canvas?.interface;
  if (!iface?.children?.length) return null;
  // The outline is the only direct PIXI.Graphics child of the interface group:
  // the scrolling-text container is a plain Container and every layer is a
  // CanvasLayer, so a Graphics instance can only be that outline.
  return iface.children.find((c) => c instanceof PIXI.Graphics) ?? null;
}

function applyOutlineVisibility(scene) {
  const outline = getOutlineGraphics();
  if (!outline) return;
  // Hidden while this scene has a backdrop; visible (Foundry default) when not.
  outline.visible = !getBackdropFor(scene);
}

function applyForCurrentScene() {
  const scene = canvas?.scene ?? game?.scenes?.viewed ?? game?.scenes?.active ?? null;
  attachBackdropSprite(scene);
  applyOutlineVisibility(scene);
}

// --- Scene Config UI: add a "Backdrop image" field --------------------------
function injectSceneConfigField(app, html) {
  const $html = html?.jquery ? html : $(html);
  if ($html.find(".ccf-backdrop-row").length) return;

  const scene = app.object ?? app.document;
  const current = scene?.getFlag?.(MODULE_ID, FLAG_KEY) ?? "";

  const labelText = game.i18n.localize("CCFUI.SceneConfig.Backdrop.Name");
  const hintText = game.i18n.localize("CCFUI.SceneConfig.Backdrop.Hint");
  const browseTitle = game.i18n.localize("FILES.BrowseTooltip") || "Browse Files";

  const escAttr = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const targetName = `flags.${MODULE_ID}.${FLAG_KEY}`;

  const fieldHtml = `
    <div class="form-group ccf-backdrop-row">
      <label>${labelText}</label>
      <div class="form-fields">
        <button type="button" class="file-picker" data-type="imagevideo" data-target="${targetName}" title="${browseTitle}" tabindex="-1">
          <i class="fas fa-file-import fa-fw"></i>
        </button>
        <input class="image" type="text" name="${targetName}" value="${escAttr(current)}" placeholder="path/to/image.webp">
      </div>
      <p class="notes">${hintText}</p>
    </div>
  `;

  const bgGroup = $html
    .find('input[name="background.src"], input[name="img"]')
    .first()
    .closest(".form-group");
  if (bgGroup.length) {
    bgGroup.after(fieldHtml);
  } else {
    const firstTab = $html.find('.tab').first();
    if (firstTab.length) firstTab.append(fieldHtml);
    else $html.find("form").first().append(fieldHtml);
  }

  $html.on("click.ccfBackdrop", ".ccf-backdrop-row button.file-picker", function (ev) {
    ev.preventDefault();
    const $input = $html.find(`input[name="${targetName}"]`);
    new FilePicker({
      type: "imagevideo",
      current: $input.val() || "",
      callback: (path) => $input.val(path).trigger("change"),
    }).render(true);
  });

  app.setPosition?.({ height: "auto" });
}

// --- Hooks ------------------------------------------------------------------
Hooks.on("renderSceneConfig", (app, html) => {
  injectSceneConfigField(app, html);
});

Hooks.on("canvasReady", () => {
  applyForCurrentScene();
});

Hooks.on("canvasPan", () => {
  updateBackdropSpriteViewport();
});

Hooks.on("updateScene", (scene) => {
  const current = canvas?.scene ?? game?.scenes?.viewed;
  if (scene?.id && current?.id && scene.id === current.id) {
    applyForCurrentScene();
  }
});

window.addEventListener("resize", () => {
  // Foundry resizes the renderer asynchronously after window resize; defer.
  setTimeout(() => updateBackdropSpriteViewport(), 100);
});
