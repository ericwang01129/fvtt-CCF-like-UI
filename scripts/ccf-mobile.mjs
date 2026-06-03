// ccf-mobile.mjs — mobile-specific UI behavior (toggle, canvas fit, chat
// input, send button, login-popup suppression, screen-size warning override).
// Self-contained: registers its own settings + hooks. Re-declares MODULE_ID
// and the user-facing enable/applyToGM gate locally to avoid any cross-file
// ESM import resolution issues between sibling esmodules in Foundry.

const MODULE_ID = "ccf-ui-v11";
const MOBILE_QUERY = "(max-width: 900px), ((pointer: coarse) and (max-width: 1100px))";

// Mirror of ccf-ui.mjs#shouldApply — kept in sync there.
function shouldApply() {
  if (!game.settings.get(MODULE_ID, "enabled")) return false;
  if (game.user.isGM && !game.settings.get(MODULE_ID, "applyToGM")) return false;
  return true;
}

// --- Mode detection ---------------------------------------------------------
function isMobileMode() {
  if (!shouldApply()) return false;
  const mode = game.settings.get(MODULE_ID, "mobileMode");
  if (mode === "on") return true;
  if (mode === "off") return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

// --- Body class + CSS variables --------------------------------------------
function applyMobileBodyClass() {
  const wasMobile = document.body.classList.contains("ccf-ui-mobile");
  const isMobile = isMobileMode();
  document.body.classList.toggle("ccf-ui-mobile", isMobile);
  const sahScale = game.settings.get(MODULE_ID, "mobileSahScale") ?? 0.55;
  const sahSqueeze = game.settings.get(MODULE_ID, "mobileSahSqueeze") ?? 0.65;
  document.body.style.setProperty("--ccf-mobile-sah-scale", String(sahScale));
  document.body.style.setProperty("--ccf-mobile-sah-squeeze", String(sahSqueeze));
  if (isMobile && !wasMobile) notifyMobileEnabled();
  removeMobilePortrait();
}

// Remove any portrait element left over from a previous module version.
function removeMobilePortrait() {
  document.getElementById("ccf-mobile-portrait")?.remove();
}

// --- Notification override (suppress core small-screen warning) ------------
const SCREEN_WARNING_KEYWORDS = [
  "resolution", "screen size", "screen resolution", "window size", "viewport",
  "螢幕", "解析度", "尺寸", "視窗大小", "畫面"
];

function patchNotifications() {
  const n = ui?.notifications;
  if (!n || n._ccfPatched) return;
  n._ccfPatched = true;
  const wrap = (fnName) => {
    const orig = n[fnName]?.bind(n);
    if (!orig) return;
    n[fnName] = (message, ...rest) => {
      if (isMobileMode() && typeof message === "string") {
        const lower = message.toLowerCase();
        const hit = SCREEN_WARNING_KEYWORDS.some(k => lower.includes(k.toLowerCase()));
        if (hit) return null;
      }
      return orig(message, ...rest);
    };
  };
  wrap("notify");
  wrap("warn");
  wrap("error");
  wrap("info");
}

let _ccfMobileNotified = false;
function notifyMobileEnabled() {
  if (_ccfMobileNotified) return;
  if (!ui?.notifications) return;
  _ccfMobileNotified = true;
  ui.notifications.info(game.i18n.localize("CCFUI.Notifications.MobileEnabled"));
}

// --- Canvas fit (top half = full canvas, locked-center) --------------------
let _ccfPanning = false;
let _ccfFitTimer = null;

function fitCanvasMobile() {
  if (!isMobileMode()) return;
  if (!canvas?.ready || !canvas.scene) return;
  const dims = canvas.dimensions;
  if (!dims) return;
  const sceneRect = dims.sceneRect
    ?? { x: dims.sceneX ?? 0, y: dims.sceneY ?? 0, width: dims.sceneWidth ?? dims.width, height: dims.sceneHeight ?? dims.height };
  if (!sceneRect.width || !sceneRect.height) return;

  const W = window.innerWidth;
  const H = window.innerHeight;
  const scale = W / sceneRect.width;
  const cx = sceneRect.x + sceneRect.width / 2;
  // Place scene-center vertically at H/4 (middle of the top half).
  const cy = sceneRect.y + sceneRect.height / 2 + H / (4 * scale);

  _ccfPanning = true;
  try {
    canvas.pan({ x: cx, y: cy, scale });
  } finally {
    setTimeout(() => { _ccfPanning = false; }, 150);
  }
}

function scheduleFit() {
  if (_ccfFitTimer) clearTimeout(_ccfFitTimer);
  _ccfFitTimer = setTimeout(() => { _ccfFitTimer = null; fitCanvasMobile(); }, 80);
}

// --- Sidebar tab activation -------------------------------------------------
function activateChatTab() {
  if (!isMobileMode()) return;
  try {
    if (ui.sidebar?.activeTab !== "chat") {
      ui.sidebar?.activateTab?.("chat");
    }
  } catch (e) { /* ignore */ }
}

// --- Chat input: Enter = newline, send button on the right -----------------
async function sendChatMessage(textarea) {
  const content = textarea.value;
  if (!content || !content.trim()) return;
  try {
    await ui.chat.processMessage(content);
  } catch (err) {
    ui.notifications?.error(err?.message ?? String(err));
    console.error(err);
    return;
  }
  textarea.value = "";
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function ensureMobileSendButton(textarea) {
  let btn = document.getElementById("ccf-mobile-send");
  if (btn) return btn;
  btn = document.createElement("button");
  btn.id = "ccf-mobile-send";
  btn.type = "button";
  btn.title = game.i18n.localize("CCFUI.Mobile.Send");
  btn.innerHTML = `<i class="fas fa-paper-plane"></i>`;
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    sendChatMessage(textarea);
  });
  const form = textarea.closest("#chat-form") ?? textarea.parentElement;
  form?.appendChild(btn);
  return btn;
}

function setupMobileChatInput() {
  const textarea = document.querySelector("#chat-message");
  if (!textarea) return;
  ensureMobileSendButton(textarea);

  if (textarea._ccfMobilePatched) return;
  textarea._ccfMobilePatched = true;

  // Capture-phase: intercept Enter BEFORE Foundry's default send handler.
  textarea.addEventListener("keydown", (event) => {
    if (!isMobileMode()) return;
    if (event.key !== "Enter" || event.isComposing) return;
    // Shift/Ctrl/Meta + Enter → send (escape hatch).
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      sendChatMessage(textarea);
      return;
    }
    // Plain Enter → insert newline at cursor.
    event.preventDefault();
    event.stopPropagation();
    const start = textarea.selectionStart ?? textarea.value.length;
    const end = textarea.selectionEnd ?? start;
    textarea.value = textarea.value.slice(0, start) + "\n" + textarea.value.slice(end);
    textarea.selectionStart = textarea.selectionEnd = start + 1;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }, true);
}

// --- Login-time popup suppression -------------------------------------------
let _ccfSuppressUntil = 0;

function suppressDialogsForLogin() {
  _ccfSuppressUntil = performance.now() + 6000;
}

function maybeCloseLoginDialog(app) {
  if (!isMobileMode()) return;
  if (!game.settings.get(MODULE_ID, "mobileSuppressLoginPopups")) return;
  if (performance.now() > _ccfSuppressUntil) return;
  try { app.close({ force: true }); } catch (e) { /* ignore */ }
}

// --- Hooks ------------------------------------------------------------------
Hooks.once("setup", () => {
  // ui.notifications exists by `setup`; patch before Foundry's small-viewport
  // warning fires around ready.
  patchNotifications();
});

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "mobileMode", {
    name: "CCFUI.Settings.MobileMode.Name",
    hint: "CCFUI.Settings.MobileMode.Hint",
    scope: "client",
    config: true,
    type: String,
    choices: {
      auto: "CCFUI.Settings.MobileMode.Auto",
      on: "CCFUI.Settings.MobileMode.On",
      off: "CCFUI.Settings.MobileMode.Off"
    },
    default: "auto",
    onChange: () => {
      applyMobileBodyClass();
      activateChatTab();
      scheduleFit();
    }
  });

  game.settings.register(MODULE_ID, "mobileSahScale", {
    name: "CCFUI.Settings.MobileSahScale.Name",
    hint: "CCFUI.Settings.MobileSahScale.Hint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0.2, max: 1.0, step: 0.05 },
    default: 0.55,
    onChange: () => applyMobileBodyClass()
  });

  game.settings.register(MODULE_ID, "mobileSahSqueeze", {
    name: "CCFUI.Settings.MobileSahSqueeze.Name",
    hint: "CCFUI.Settings.MobileSahSqueeze.Hint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0.3, max: 1.0, step: 0.05 },
    default: 0.65,
    onChange: () => applyMobileBodyClass()
  });

  game.settings.register(MODULE_ID, "mobileSuppressLoginPopups", {
    name: "CCFUI.Settings.MobileSuppressLoginPopups.Name",
    hint: "CCFUI.Settings.MobileSuppressLoginPopups.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true
  });
});

Hooks.once("ready", () => {
  // Patch again as a safety net; idempotent via _ccfPatched flag.
  patchNotifications();
  if (isMobileMode()) suppressDialogsForLogin();

  applyMobileBodyClass();
  activateChatTab();
  removeMobilePortrait();
  setupMobileChatInput();

  // Re-evaluate when the viewport crosses the breakpoint.
  try {
    const mql = window.matchMedia(MOBILE_QUERY);
    const handler = () => {
      applyMobileBodyClass();
      activateChatTab();
      scheduleFit();
    };
    if (mql.addEventListener) mql.addEventListener("change", handler);
    else if (mql.addListener) mql.addListener(handler);
  } catch (e) { /* ignore */ }

  window.addEventListener("resize", scheduleFit);
});

// React to core settings changes so mobile body-class re-evaluates without
// the core module needing to know about us.
Hooks.on("updateSetting", (setting) => {
  if (setting?.key === `${MODULE_ID}.enabled` || setting?.key === `${MODULE_ID}.applyToGM`) {
    applyMobileBodyClass();
    scheduleFit();
  }
});

// Auto-close login-time popups in mobile mode.
Hooks.on("renderDialog", maybeCloseLoginDialog);
Hooks.on("renderApplication", (app) => {
  if (!app?.options?.popOut) return;
  if (app.constructor?.name === "ActorSheet") return;
  if (app.constructor?.name === "Sidebar") return;
  maybeCloseLoginDialog(app);
});

Hooks.on("renderSidebar", () => {
  activateChatTab();
  setupMobileChatInput();
});

Hooks.on("renderSidebarTab", () => {
  setupMobileChatInput();
});

Hooks.on("renderChatLog", () => {
  setupMobileChatInput();
});

Hooks.on("canvasReady", () => {
  scheduleFit();
});

Hooks.on("canvasPan", () => {
  if (_ccfPanning) return;
  if (!isMobileMode()) return;
  // Re-center: user pans/zooms get snapped back to the locked fit.
  scheduleFit();
});

Hooks.on("updateScene", (scene) => {
  if (scene?.id === canvas?.scene?.id) scheduleFit();
});
