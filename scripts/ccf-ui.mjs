// ccf-ui.mjs — core (non-mobile) behavior.
// Mobile-mode specifics live in ./ccf-mobile.mjs and self-register their
// own hooks. Each file is independent (no cross-file ESM import) — the
// shared MODULE_ID / shouldApply() pair is duplicated in ccf-mobile.mjs to
// avoid any sibling-esmodule import resolution issues in Foundry. Keep
// the two copies of shouldApply() in sync.

const MODULE_ID = "ccf-ui-v11";
const SMW_ID = "simple-message-window";

// Sidebar tabs whose visibility is user-configurable. `key` is the setting
// name; `default: true` keeps that tab visible (the pre-1.1 hard-coded set
// was chat + actors). The Settings tab is omitted on purpose — it must stay
// reachable so the GM can always change these settings back.
const SIDEBAR_TABS = [
  { id: "chat",       key: "tabChat",       name: "CCFUI.Settings.Tab.Chat",       default: true  },
  { id: "combat",     key: "tabCombat",     name: "CCFUI.Settings.Tab.Combat",     default: false },
  { id: "scenes",     key: "tabScenes",     name: "CCFUI.Settings.Tab.Scenes",     default: false },
  { id: "actors",     key: "tabActors",     name: "CCFUI.Settings.Tab.Actors",     default: true  },
  { id: "items",      key: "tabItems",      name: "CCFUI.Settings.Tab.Items",      default: false },
  { id: "journal",    key: "tabJournal",    name: "CCFUI.Settings.Tab.Journal",    default: false },
  { id: "tables",     key: "tabTables",     name: "CCFUI.Settings.Tab.Tables",     default: false },
  { id: "cards",      key: "tabCards",      name: "CCFUI.Settings.Tab.Cards",      default: false },
  { id: "playlists",  key: "tabPlaylists",  name: "CCFUI.Settings.Tab.Playlists",  default: false },
  { id: "compendium", key: "tabCompendium", name: "CCFUI.Settings.Tab.Compendium", default: false },
];

function shouldApply() {
  if (!game.settings.get(MODULE_ID, "enabled")) return false;
  if (game.user.isGM && !game.settings.get(MODULE_ID, "applyToGM")) return false;
  return true;
}

function applyBodyClass() {
  document.body.classList.toggle("ccf-ui-active", shouldApply());
  document.body.classList.toggle("ccf-ui-gm", !!game.user?.isGM);
  applyTabVisibility();
}

// Toggle a `ccf-hide-<tab>` body class for every sidebar tab whose
// "Show sidebar tab" setting is off. ccf-ui.css consumes these classes
// (scoped under body.ccf-ui-active) to hide both the nav item and panel.
function applyTabVisibility() {
  for (const tab of SIDEBAR_TABS) {
    let show = true;
    try {
      show = game.settings.get(MODULE_ID, tab.key) !== false;
    } catch (e) {
      // setting not registered yet (called before `init`); leave visible
    }
    document.body.classList.toggle(`ccf-hide-${tab.id}`, !show);
  }
}

// Foundry only lists a scene in a player's top navigation bar when BOTH the
// scene's "Show in Navigation" toggle is on AND the player has ≥LIMITED
// permission (SceneNavigation.prototype.scenes → `s.navigation && s.visible`).
// GMs additionally see whatever scene they are currently viewing, so a GM can
// have a populated nav while every player's is empty — the bar then collapses
// to zero height and players see nothing at the top.
//
// This module's intent is that scene *ownership* alone drives what players can
// navigate to. So for players (when active and the setting is on) we relax the
// scene set to "every scene the player can at least see" — dropping the
// per-scene nav toggle but KEEPING the permission check. GMs and the original
// behaviour are untouched. The patch wraps the prototype getter once.
function installPlayerNavPatch() {
  if (typeof SceneNavigation === "undefined") return;
  const proto = SceneNavigation.prototype;
  if (proto._ccfScenesPatched) return;
  const desc = Object.getOwnPropertyDescriptor(proto, "scenes");
  if (!desc?.get) return;
  const origGet = desc.get;
  Object.defineProperty(proto, "scenes", {
    configurable: true,
    get() {
      let byPermission = false;
      try {
        byPermission = shouldApply() && !game.user.isGM
          && game.settings.get(MODULE_ID, "playerNavByPermission");
      } catch (e) {
        // settings not ready yet; fall back to core behaviour
      }
      if (!byPermission) return origGet.call(this);
      // `s.visible` === testUserPermission(game.user, "LIMITED").
      const scenes = game.scenes.filter(s => s.visible || s.active || s.isView);
      scenes.sort((a, b) => a.navOrder - b.navOrder);
      return scenes;
    }
  });
  proto._ccfScenesPatched = true;
}

function lockTokenSelect() {
  if (!shouldApply()) return;
  if (!canvas?.ready) return;
  if (canvas.activeLayer?.name !== "TokenLayer") {
    canvas.tokens?.activate();
  }
  if (ui.controls) {
    ui.controls.activeControl = "token";
    ui.controls.activeTool = "select";
  }
}

function forceSmwOn() {
  const smw = game.modules.get(SMW_ID);
  if (!smw?.active) return;
  try {
    if (game.settings.get(SMW_ID, "smwEnable") !== true) {
      game.settings.set(SMW_ID, "smwEnable", true);
    }
  } catch (e) {
    // setting not yet registered or unavailable; ignore
  }
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "enabled", {
    name: "CCFUI.Settings.Enabled.Name",
    hint: "CCFUI.Settings.Enabled.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => {
      applyBodyClass();
      lockTokenSelect();
    }
  });

  game.settings.register(MODULE_ID, "applyToGM", {
    name: "CCFUI.Settings.ApplyToGM.Name",
    hint: "CCFUI.Settings.ApplyToGM.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => {
      applyBodyClass();
      lockTokenSelect();
    }
  });

  // Drive player scene-navigation by permission instead of each scene's
  // "Show in Navigation" toggle. World-scoped so the GM sets it once.
  game.settings.register(MODULE_ID, "playerNavByPermission", {
    name: "CCFUI.Settings.PlayerNavByPermission.Name",
    hint: "CCFUI.Settings.PlayerNavByPermission.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => ui.nav?.render()
  });

  // Per-tab sidebar visibility. World-scoped: the GM decides once and every
  // client applies the same result (onChange fires on all connected clients).
  for (const tab of SIDEBAR_TABS) {
    game.settings.register(MODULE_ID, tab.key, {
      name: `${tab.name}.Name`,
      hint: "CCFUI.Settings.TabVisibility.Hint",
      scope: "world",
      config: true,
      type: Boolean,
      default: tab.default,
      onChange: () => applyTabVisibility()
    });
  }
});

Hooks.once("ready", () => {
  applyBodyClass();
  installPlayerNavPatch();
  ui.nav?.render();
  forceSmwOn();
  lockTokenSelect();
});

Hooks.on("renderSidebar", () => {
  applyBodyClass();
});

Hooks.on("renderSidebarTab", () => {
  applyBodyClass();
});

Hooks.on("renderSceneControls", () => {
  if (!shouldApply()) return;
  forceSmwOn();
  lockTokenSelect();
});

Hooks.on("canvasReady", () => {
  lockTokenSelect();
});

// If anything tries to flip smwEnable off while we're active, snap it back on.
Hooks.on("updateSetting", (setting) => {
  if (!shouldApply()) return;
  if (setting?.key === `${SMW_ID}.smwEnable` && setting.value !== true && setting.value !== "true") {
    forceSmwOn();
  }
});
