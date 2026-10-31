// ccf-scene-states.mjs — CCF-style "scene list": named snapshots of the
// current scene that the GM can switch between with one click.
//
// A snapshot ("state") records, for the scene being viewed:
//   - the backdrop (flags.ccf-ui-v11.backdrop), background.src and the
//     scene's foreground image
//   - every foreground-layer (overhead) tile, as full document data
//   - every AmbientSound, as full document data
//   - which playlist sounds were playing (the BGM)
// plus an optional Macro (by UUID) and an optional inline script that run
// after the state is applied.
//
// States live in the scene flag flags.ccf-ui-v11.sceneStates (an array in
// list order), so they travel with the scene through export / duplicate.
//
// Applying a state is a full restore: overhead tiles and ambient sounds that
// are on the scene but not in the state are deleted, missing ones are
// re-created with their original _id, and playlist sounds not in the state
// are stopped. Background-layer tiles are never touched.
//
// Entry point: a GM-only button at the bottom of the Token controls.
//
// Self-contained: re-declares MODULE_ID locally to match the rest of the module.

const MODULE_ID = "ccf-ui-v11";
const FLAG_KEY = "sceneStates";
const BACKDROP_KEY = "backdrop";
const TOOL_NAME = "ccfSceneStates";
const DRAG_TYPE = "CcfSceneState";

let SceneStatesApp = null;
let app = null;
let applying = false;

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// --- Storage ----------------------------------------------------------------
function getStates(scene) {
  const v = scene?.getFlag(MODULE_ID, FLAG_KEY);
  return Array.isArray(v) ? foundry.utils.deepClone(v) : [];
}

// The whole array is written back each time; Foundry replaces arrays on
// update rather than merging them, so order and deletions are preserved.
function setStates(scene, states) {
  return scene.setFlag(MODULE_ID, FLAG_KEY, states);
}

// --- Capture ----------------------------------------------------------------
function captureState(scene) {
  const bgm = [];
  for (const playlist of game.playlists) {
    for (const sound of playlist.sounds) {
      if (sound.playing) bgm.push({ playlistId: playlist.id, soundId: sound.id, name: sound.name });
    }
  }
  return {
    savedAt: Date.now(),
    images: {
      backdrop: scene.getFlag(MODULE_ID, BACKDROP_KEY) ?? "",
      background: scene.background?.src ?? null,
      foreground: scene.foreground ?? null,
    },
    tiles: scene.tiles.filter((t) => t.overhead).map((t) => t.toObject()),
    sounds: scene.sounds.map((s) => s.toObject()),
    bgm,
  };
}

// --- Apply ------------------------------------------------------------------
// Make the scene's embedded documents of `documentName` that pass `filter`
// match `saved` exactly. Uses embedded CRUD rather than scene.update({tiles})
// because "tiles" / "sounds" are redraw keys in Scene#_onUpdate and would
// force a full canvas.draw() on every client.
async function syncEmbedded(scene, documentName, saved, filter) {
  const collection = scene.getEmbeddedCollection(documentName);
  const data = foundry.utils.deepClone(saved ?? []);
  const savedIds = new Set(data.map((d) => d._id));
  const toDelete = collection.filter((d) => filter(d) && !savedIds.has(d.id)).map((d) => d.id);
  const toUpdate = data.filter((d) => collection.has(d._id));
  const toCreate = data.filter((d) => !collection.has(d._id));
  if (toDelete.length) await scene.deleteEmbeddedDocuments(documentName, toDelete);
  if (toUpdate.length) await scene.updateEmbeddedDocuments(documentName, toUpdate);
  if (toCreate.length) await scene.createEmbeddedDocuments(documentName, toCreate, { keepId: true });
}

// Play exactly the saved playlist sounds. A sound that is already playing
// and also saved is left alone so the BGM continues without restarting.
async function applyBgm(saved) {
  const target = new Set((saved ?? []).map((b) => `${b.playlistId}.${b.soundId}`));
  for (const playlist of game.playlists) {
    const wanted = (s) => target.has(`${playlist.id}.${s.id}`);
    const changed = playlist.sounds.filter((s) => s.playing !== wanted(s));
    if (!changed.length) continue;
    if (!playlist.sounds.some(wanted)) {
      await playlist.stopAll();
      continue;
    }
    await playlist.update({
      playing: true,
      sounds: changed.map((s) => ({ _id: s.id, playing: wanted(s), pausedTime: null })),
    });
  }
}

// Background / foreground changes trigger canvas.draw(), so this runs last
// and the redraw picks up the already-updated tiles. The backdrop flag is
// re-rendered by ccf-backdrop.mjs's own updateScene hook.
async function applyImages(scene, images = {}) {
  const update = {};
  const backdrop = images.backdrop ?? "";
  if ((scene.getFlag(MODULE_ID, BACKDROP_KEY) ?? "") !== backdrop) {
    update[`flags.${MODULE_ID}.${BACKDROP_KEY}`] = backdrop;
  }
  if ((scene.background?.src ?? "") !== (images.background ?? "")) {
    update["background.src"] = images.background ?? null;
  }
  if ((scene.foreground ?? "") !== (images.foreground ?? "")) {
    update.foreground = images.foreground ?? null;
  }
  if (!foundry.utils.isEmpty(update)) await scene.update(update);
}

// The Macro runs first, then the inline script. The script is executed
// through a temporary (unsaved) Macro so it gets the same scope as a normal
// script macro (speaker, actor, token, character) plus `scene` and `state`.
async function runStateMacros(scene, state) {
  const scope = { scene, state: foundry.utils.deepClone(state) };
  try {
    if (state.macro) {
      const macro = await fromUuid(state.macro);
      if (macro instanceof Macro) await macro.execute(scope);
      else ui.notifications?.warn(game.i18n.format("CCFUI.SceneStates.MacroMissing", { uuid: state.macro }));
    }
    if (state.script?.trim()) {
      const macro = new Macro({ name: state.name || TOOL_NAME, type: "script", command: state.script });
      await macro.execute(scope);
    }
  } catch (err) {
    console.error("[ccf-scene-states]", err);
    ui.notifications?.error(
      game.i18n.format("CCFUI.SceneStates.MacroFailed", { error: err?.message ?? String(err) })
    );
  }
}

async function applyState(scene, state) {
  if (applying || !scene || !state) return;
  applying = true;
  try {
    await syncEmbedded(scene, "Tile", state.tiles, (t) => t.overhead);
    await syncEmbedded(scene, "AmbientSound", state.sounds, () => true);
    await applyBgm(state.bgm);
    await applyImages(scene, state.images);
    ui.notifications?.info(game.i18n.format("CCFUI.SceneStates.Applied", { name: state.name }));
  } catch (err) {
    console.error("[ccf-scene-states]", err);
    ui.notifications?.error(
      game.i18n.format("CCFUI.SceneStates.Failed", { error: err?.message ?? String(err) })
    );
    return;
  } finally {
    applying = false;
  }
  await runStateMacros(scene, state);
}

// --- Edit dialog ------------------------------------------------------------
function macroLabel(uuid) {
  try {
    return fromUuidSync(uuid)?.name ?? uuid;
  } catch (err) {
    return uuid;
  }
}

// Resolves to { name, macro, script } or null when cancelled.
function editStateDialog(meta, titleKey) {
  const macros = game.macros.filter((m) => m.canExecute)
    .sort((a, b) => a.name.localeCompare(b.name));
  const options = [`<option value="">${escapeHtml(game.i18n.localize("CCFUI.SceneStates.MacroNone"))}</option>`];
  for (const m of macros) {
    const selected = m.uuid === meta.macro ? " selected" : "";
    options.push(`<option value="${escapeHtml(m.uuid)}"${selected}>${escapeHtml(m.name)}</option>`);
  }
  if (meta.macro && !macros.some((m) => m.uuid === meta.macro)) {
    options.push(`<option value="${escapeHtml(meta.macro)}" selected>${escapeHtml(macroLabel(meta.macro))}</option>`);
  }

  const t = (key) => escapeHtml(game.i18n.localize(`CCFUI.SceneStates.${key}`));
  const content = `
    <form class="ccf-ss-edit" autocomplete="off">
      <div class="form-group">
        <label>${t("Name")}</label>
        <input type="text" name="name" value="${escapeHtml(meta.name)}">
      </div>
      <div class="form-group ccf-ss-macro">
        <label>${t("Macro")}</label>
        <select name="macro">${options.join("")}</select>
        <p class="notes">${t("MacroHint")}</p>
      </div>
      <div class="form-group stacked">
        <label>${t("Script")}</label>
        <textarea name="script" rows="6" spellcheck="false">${escapeHtml(meta.script)}</textarea>
        <p class="notes">${t("ScriptHint")}</p>
      </div>
    </form>
  `;

  return new Promise((resolve) => {
    new Dialog({
      title: game.i18n.localize(`CCFUI.SceneStates.${titleKey}`),
      content,
      buttons: {
        save: {
          icon: `<i class="fas fa-save"></i>`,
          label: game.i18n.localize("CCFUI.SceneStates.Save"),
          callback: (html) => {
            const form = html[0].querySelector("form");
            const value = (name) => form.querySelector(`[name="${name}"]`).value;
            resolve({
              name: value("name").trim() || meta.name,
              macro: value("macro"),
              script: value("script"),
            });
          },
        },
        cancel: {
          icon: `<i class="fas fa-times"></i>`,
          label: game.i18n.localize("CCFUI.SceneStates.Cancel"),
          callback: () => resolve(null),
        },
      },
      default: "save",
      // Accept a Macro dragged from the Macro directory or the hotbar.
      render: (html) => {
        const select = html[0].querySelector('select[name="macro"]');
        const group = html[0].querySelector(".ccf-ss-macro");
        group.addEventListener("dragover", (ev) => ev.preventDefault());
        group.addEventListener("drop", (ev) => {
          ev.preventDefault();
          const data = TextEditor.getDragEventData(ev);
          if (data?.type !== "Macro" || !data.uuid) return;
          if (![...select.options].some((o) => o.value === data.uuid)) {
            select.add(new Option(macroLabel(data.uuid), data.uuid));
          }
          select.value = data.uuid;
        });
      },
      close: () => resolve(null),
    }, { width: 480, classes: ["dialog", "ccf-ss-dialog"] }).render(true);
  });
}

function confirmDialog(titleKey, contentKey, name) {
  return Dialog.confirm({
    title: game.i18n.localize(`CCFUI.SceneStates.${titleKey}`),
    content: `<p>${escapeHtml(game.i18n.format(`CCFUI.SceneStates.${contentKey}`, { name }))}</p>`,
    defaultYes: false,
  });
}

// --- List rendering ---------------------------------------------------------
function stateThumb(state) {
  const img = state.images ?? {};
  let src = img.foreground || img.background || img.backdrop || null;
  if (!src) {
    let area = 0;
    for (const t of state.tiles ?? []) {
      const a = (Number(t.width) || 0) * (Number(t.height) || 0);
      if (t.texture?.src && a > area) {
        src = t.texture.src;
        area = a;
      }
    }
  }
  if (!src) return `<i class="fas fa-image"></i>`;
  const attr = escapeHtml(src);
  return VideoHelper.hasVideoExtension(src)
    ? `<video src="${attr}" muted preload="metadata" draggable="false"></video>`
    : `<img src="${attr}" loading="lazy" draggable="false">`;
}

function renderStateItem(state) {
  const t = (key) => escapeHtml(game.i18n.localize(`CCFUI.SceneStates.${key}`));
  const bgm = (state.bgm ?? []).map((b) => b.name).filter(Boolean).join(" / ");
  const summary = game.i18n.format("CCFUI.SceneStates.Summary", {
    tiles: state.tiles?.length ?? 0,
    sounds: state.sounds?.length ?? 0,
  });
  const badges = [
    state.macro ? `<i class="fas fa-terminal" data-tooltip="${t("HasMacro")}"></i>` : "",
    state.script?.trim() ? `<i class="fas fa-code" data-tooltip="${t("HasScript")}"></i>` : "",
  ].join("");
  return `
    <li class="ccf-ss-item" data-state-id="${escapeHtml(state.id)}">
      <a class="ccf-ss-thumb" data-action="apply" data-tooltip="${t("Apply")}">${stateThumb(state)}</a>
      <div class="ccf-ss-info">
        <a class="ccf-ss-name" data-action="apply" data-tooltip="${t("Apply")}">${escapeHtml(state.name)}</a>
        <span class="ccf-ss-sub" data-tooltip="${escapeHtml(summary)}">
          <span class="ccf-ss-bgm">${escapeHtml(bgm || game.i18n.localize("CCFUI.SceneStates.NoBgm"))}</span>${badges}
        </span>
      </div>
      <div class="ccf-ss-controls">
        <a data-action="overwrite" data-tooltip="${t("Overwrite")}"><i class="fas fa-save"></i></a>
        <a data-action="edit" data-tooltip="${t("Edit")}"><i class="fas fa-pen"></i></a>
        <a data-action="delete" data-tooltip="${t("Delete")}"><i class="fas fa-trash"></i></a>
      </div>
    </li>
  `;
}

function renderList(scene) {
  if (!scene) {
    return `<section class="ccf-ss"><p class="ccf-ss-empty">${escapeHtml(game.i18n.localize("CCFUI.SceneStates.NoScene"))}</p></section>`;
  }
  const states = getStates(scene);
  if (!states.length) {
    return `<section class="ccf-ss"><p class="ccf-ss-empty">${escapeHtml(game.i18n.localize("CCFUI.SceneStates.Empty"))}</p></section>`;
  }
  return `<section class="ccf-ss"><ol class="ccf-ss-list">${states.map(renderStateItem).join("")}</ol></section>`;
}

// --- Actions ----------------------------------------------------------------
async function addState() {
  const scene = canvas?.scene;
  if (!scene) return ui.notifications?.warn(game.i18n.localize("CCFUI.SceneStates.NoScene"));
  const states = getStates(scene);
  const meta = await editStateDialog({
    name: game.i18n.format("CCFUI.SceneStates.DefaultName", { n: states.length + 1 }),
    macro: "",
    script: "",
  }, "NewTitle");
  if (!meta) return;
  const state = { id: foundry.utils.randomID(), ...meta, ...captureState(scene) };
  // Re-read in case the list changed while the dialog was open.
  await setStates(scene, [...getStates(scene), state]);
  ui.notifications?.info(game.i18n.format("CCFUI.SceneStates.Saved", { name: state.name }));
}

async function onStateAction(action, id) {
  const scene = canvas?.scene;
  if (!scene) return;
  const states = getStates(scene);
  const state = states.find((s) => s.id === id);
  if (!state) return;

  switch (action) {
    case "apply":
      return applyState(scene, state);
    case "overwrite": {
      if (!await confirmDialog("Overwrite", "OverwriteConfirm", state.name)) return;
      return updateStoredState(scene, id, captureState(scene), true);
    }
    case "edit": {
      const meta = await editStateDialog(state, "EditTitle");
      if (meta) return updateStoredState(scene, id, meta);
      return;
    }
    case "delete": {
      if (!await confirmDialog("Delete", "DeleteConfirm", state.name)) return;
      return setStates(scene, getStates(scene).filter((s) => s.id !== id));
    }
  }
}

// Re-reads the list because a dialog may have been open in the meantime.
async function updateStoredState(scene, id, changes, notify = false) {
  const states = getStates(scene);
  const target = states.find((s) => s.id === id);
  if (!target) return;
  Object.assign(target, changes);
  await setStates(scene, states);
  if (notify) ui.notifications?.info(game.i18n.format("CCFUI.SceneStates.Saved", { name: target.name }));
}

function openSceneStates() {
  if (!game.user?.isGM || !SceneStatesApp) return;
  app ??= new SceneStatesApp();
  app.render(true);
}

// --- Application ------------------------------------------------------------
Hooks.once("init", () => {
  // Defined here so `Application` is guaranteed to exist (same pattern as
  // ccf-chatlog-export.mjs). No template: the content is an inline string.
  SceneStatesApp = class extends Application {
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        id: "ccf-scene-states",
        classes: ["ccf-scene-states"],
        width: 380,
        height: 520,
        resizable: true,
        dragDrop: [{ dragSelector: ".ccf-ss-item", dropSelector: ".ccf-ss-item" }],
      });
    }

    get title() {
      const scene = canvas?.scene;
      return scene
        ? game.i18n.format("CCFUI.SceneStates.WindowTitle", { scene: scene.name })
        : game.i18n.localize("CCFUI.SceneStates.Title");
    }

    async _renderInner() {
      return $(renderList(canvas?.scene));
    }

    _getHeaderButtons() {
      const buttons = super._getHeaderButtons();
      buttons.unshift({
        label: "CCFUI.SceneStates.Add",
        class: "ccf-ss-add",
        icon: "fas fa-plus",
        onclick: () => addState(),
      });
      return buttons;
    }

    activateListeners(html) {
      super.activateListeners(html);
      html.on("click", "[data-action]", (ev) => {
        ev.preventDefault();
        const el = ev.currentTarget;
        onStateAction(el.dataset.action, el.closest(".ccf-ss-item")?.dataset.stateId);
      });
      html.on("dragend", () => this._clearDragOver());
    }

    _canDragStart() {
      return game.user.isGM;
    }

    _canDragDrop() {
      return game.user.isGM;
    }

    _onDragStart(event) {
      const id = event.currentTarget.dataset.stateId;
      event.dataTransfer.setData("text/plain", JSON.stringify({ type: DRAG_TYPE, id }));
    }

    _onDragOver(event) {
      const li = event.target.closest?.(".ccf-ss-item");
      this.element.find(".ccf-ss-item.drag-over").not(li).removeClass("drag-over");
      li?.classList.add("drag-over");
    }

    _clearDragOver() {
      this.element.find(".ccf-ss-item.drag-over").removeClass("drag-over");
    }

    // Move the dragged state into the drop target's position.
    async _onDrop(event) {
      this._clearDragOver();
      const data = TextEditor.getDragEventData(event);
      if (data?.type !== DRAG_TYPE) return;
      const targetId = event.target.closest(".ccf-ss-item")?.dataset.stateId;
      const scene = canvas?.scene;
      if (!scene || !targetId || targetId === data.id) return;
      const states = getStates(scene);
      const from = states.findIndex((s) => s.id === data.id);
      const to = states.findIndex((s) => s.id === targetId);
      if (from < 0 || to < 0) return;
      const [moved] = states.splice(from, 1);
      states.splice(to, 0, moved);
      return setStates(scene, states);
    }
  };
});

// --- Hooks ------------------------------------------------------------------
function addControlButton(controls) {
  controls.find((c) => c.name === "token")?.tools.push({
    name: TOOL_NAME,
    title: "CCFUI.SceneStates.Title",
    icon: "fas fa-images",
    button: true,
    onClick: () => openSceneStates(),
  });
}

// Registered on `ready` (after every module's load-time hooks) so this tool
// is pushed last and sits at the bottom of the Token controls; the controls
// were already built once during setup, so rebuild them now.
Hooks.once("ready", () => {
  if (!game.user?.isGM) return;
  Hooks.on("getSceneControlButtons", addControlButton);
  ui.controls?.initialize();
});

Hooks.on("updateScene", (scene, changes) => {
  if (!app?.rendered || scene.id !== canvas?.scene?.id) return;
  const flagsChanged = foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.${FLAG_KEY}`)
    || foundry.utils.hasProperty(changes, `flags.${MODULE_ID}.-=${FLAG_KEY}`);
  if (flagsChanged || "name" in changes) app.render();
});

Hooks.on("canvasReady", () => {
  if (app?.rendered) app.render();
});
