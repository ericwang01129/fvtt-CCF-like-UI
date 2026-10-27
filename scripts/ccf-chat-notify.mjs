// ccf-chat-notify.mjs — alert the user when the main chat channel gets a new
// message: a notification sound plus a red "unread" dot on the browser tab /
// taskbar entry.
//
// "Main channel" is a Multiple Chat Tabs (`multiple-chat-tabs`) tab: the one
// named by the `chatNotifyTab` setting, or MCT's first (default) tab when that
// is blank. Without MCT every message counts. MCT keeps its routing private,
// so the rules from its `module/messageFilter.js` are re-implemented here —
// the same port as in ccf-chatlog-export.mjs; keep the two in sync.
//
// The red dot is three things, since a page cannot touch the OS taskbar
// directly:
//   - the favicon redrawn with a red dot (browser tab, pinned tabs),
//   - an "(N) " unread counter in front of document.title,
//   - navigator.setAppBadge(N), which badges the taskbar / dock icon when
//     Foundry is installed as an app (Chrome / Edge "Install").
// All three clear as soon as the window regains focus.
//
// Self-contained: re-declares MODULE_ID locally to match the rest of the module.

const MODULE_ID = "ccf-ui-v11";
const MCT_ID = "multiple-chat-tabs";
const DEFAULT_SOUND = "sounds/notify.wav";
const SOUND_COOLDOWN_MS = 1000;
const BADGE_SIZE = 64;
const TITLE_PREFIX = /^\(\d+\+?\) /;

// --- Multiple Chat Tabs: tab list -------------------------------------------
function getTabs() {
  if (!game.modules.get(MCT_ID)?.active) return [];
  try {
    const tabs = JSON.parse(game.settings.get(MCT_ID, "tabs") ?? "[]");
    // Mirrors MultipleChatTabs.getTabs(): tabs without a label are dropped.
    if (Array.isArray(tabs)) return tabs.filter((tab) => tab?.label);
  } catch (err) {
    console.warn("[ccf-chat-notify] cannot parse multiple-chat-tabs tabs", err);
  }
  return [];
}

function mctSetting(key, fallback) {
  try {
    return game.settings.get(MCT_ID, key);
  } catch (err) {
    return fallback;
  }
}

// --- Multiple Chat Tabs: message routing ------------------------------------
// Faithful port of multiple-chat-tabs/module/messageFilter.js.
function getMessageType(message) {
  if (message.isRoll) return "roll";
  const styles = CONST.CHAT_MESSAGE_STYLES ?? CONST.CHAT_MESSAGE_TYPES ?? {};
  // v12 moved the numeric enum from `type` to `style`.
  const style = message.style ?? message.type;
  if (style === styles.IC) return "ic";
  if (style === styles.OOC) return "ooc";
  return "other";
}

function sameMembers(setA, setB) {
  if (setA.size !== setB.size) return false;
  for (const value of setA) if (!setB.has(value)) return false;
  return true;
}

function getVisibleTabsForMessage(message, allTabs) {
  const visibleTabIds = new Set();
  const whisper = message.whisper ?? [];

  // 1. Whisper tabs whose targets exactly equal author+recipients win outright.
  if (whisper.length > 0) {
    const authorId = (message.author ?? message.user)?.id;
    const whisperGroup = new Set(whisper);
    if (authorId) whisperGroup.add(authorId);
    const matches = allTabs.filter(
      (tab) => tab.isWhisperTab && sameMembers(new Set(tab.whisperTargets ?? []), whisperGroup)
    );
    if (matches.length > 0) return new Set(matches.map((tab) => tab.id));
  }

  const messageType = getMessageType(message);

  // 2. The first tab forcing a "move" for this type captures the message.
  const moveTarget = allTabs.find(
    (tab) => !tab.isWhisperTab && tab.force?.[messageType] === "move"
  );
  if (moveTarget) return new Set([moveTarget.id]);

  // 3. The sourceTab flag, else fall back to the first tab in array order.
  const sourceTabId = message.flags?.[MCT_ID]?.sourceTab;
  if (sourceTabId && allTabs.some((tab) => tab.id === sourceTabId)) {
    visibleTabIds.add(sourceTabId);
  } else if (mctSetting("showAloneMessageToDefaultTab", true) && allTabs[0]?.id) {
    visibleTabIds.add(allTabs[0].id);
  }

  // 4. Every tab asking for a duplicate of this type also gets it.
  for (const tab of allTabs) {
    if (!tab.isWhisperTab && tab.force?.[messageType] === "duplicate") visibleTabIds.add(tab.id);
  }

  return visibleTabIds;
}

function isMessageInTab(message, tab, visibleTabIds) {
  if (tab.showAllMessages) {
    // A whisper tab showing "all" still only ever shows whispers.
    if (tab.isWhisperTab) return (message.whisper ?? []).length > 0;
    return true;
  }
  return visibleTabIds.has(tab.id);
}

// --- Which messages alert ---------------------------------------------------
function getSetting(key) {
  try {
    return game.settings.get(MODULE_ID, key);
  } catch (err) {
    return undefined;
  }
}

// The tab named (by label or id) in the setting, else MCT's default tab.
function getMainTab(allTabs) {
  const wanted = String(getSetting("chatNotifyTab") ?? "").trim();
  if (wanted) {
    const match = allTabs.find((tab) => tab.label === wanted || tab.id === wanted);
    if (match) return match;
  }
  return allTabs[0] ?? null;
}

function isInMainChannel(message) {
  const allTabs = getTabs();
  if (!allTabs.length) return true;
  const mainTab = getMainTab(allTabs);
  return !!mainTab && isMessageInTab(message, mainTab, getVisibleTabsForMessage(message, allTabs));
}

// Whispers this user cannot read (including other people's private rolls,
// which core still lists as "visible") never alert.
function canRead(message) {
  if (message.visible === false) return false;
  const whisper = message.whisper ?? [];
  return !whisper.length || message.isAuthor || whisper.includes(game.user.id);
}

function isWindowAway() {
  return document.hidden || !document.hasFocus();
}

// --- Sound ------------------------------------------------------------------
let lastSoundAt = 0;

function playSound() {
  const src = String(getSetting("chatNotifySound") ?? "").trim();
  if (!src) return;
  const now = Date.now();
  if (now - lastSoundAt < SOUND_COOLDOWN_MS) return;
  lastSoundAt = now;

  // AudioHelper.play already scales this by the core "Interface" volume.
  // Above 1 the Web Audio gain amplifies, so the slider can boost quiet files.
  const volume = Number(getSetting("chatNotifyVolume") ?? 0.8);

  const helper = foundry.audio?.AudioHelper ?? globalThis.AudioHelper;
  try {
    helper?.play({ src, volume, autoplay: true, loop: false }, false);
  } catch (err) {
    console.warn("[ccf-chat-notify] cannot play notification sound", err);
  }
}

// --- Unread badge (favicon dot, title counter, app badge) -------------------
let unreadCount = 0;
let originalFavicon = null;
let badgedFavicon = null;

function getFaviconLink() {
  let link = document.querySelector("link[rel~='icon']");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    link.href = "icons/vtt.png";
    document.head.append(link);
  }
  return link;
}

// The original icon with a red dot in the top-right corner, as a PNG data
// URL; built once and cached.
function buildBadgedFavicon(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = BADGE_SIZE;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, BADGE_SIZE, BADGE_SIZE);
        const radius = BADGE_SIZE * 0.24;
        const center = BADGE_SIZE - radius - 2;
        ctx.beginPath();
        ctx.arc(center, radius + 2, radius, 0, Math.PI * 2);
        ctx.fillStyle = "#e53935";
        ctx.fill();
        ctx.lineWidth = BADGE_SIZE * 0.05;
        ctx.strokeStyle = "#ffffff";
        ctx.stroke();
        resolve(canvas.toDataURL("image/png"));
      } catch (err) {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function showFaviconDot() {
  const link = getFaviconLink();
  originalFavicon ??= link.getAttribute("href");
  badgedFavicon ??= await buildBadgedFavicon(originalFavicon);
  // The window may have regained focus while the icon was being drawn.
  if (badgedFavicon && unreadCount > 0) link.href = badgedFavicon;
}

function setTitleCount(count) {
  const title = document.title.replace(TITLE_PREFIX, "");
  document.title = count > 0 ? `(${count > 99 ? "99+" : count}) ${title}` : title;
}

function setAppBadge(count) {
  try {
    if (count > 0) navigator.setAppBadge?.(count)?.catch?.(() => {});
    else navigator.clearAppBadge?.()?.catch?.(() => {});
  } catch (err) { /* unsupported browser */ }
}

function markUnread() {
  unreadCount += 1;
  setTitleCount(unreadCount);
  setAppBadge(unreadCount);
  showFaviconDot();
}

function clearUnread() {
  if (!unreadCount) return;
  unreadCount = 0;
  setTitleCount(0);
  setAppBadge(0);
  if (originalFavicon) getFaviconLink().href = originalFavicon;
}

// --- Hooks ------------------------------------------------------------------
function onCreateChatMessage(message) {
  if (!getSetting("chatNotifyEnabled")) return;
  if (message.isAuthor) return;
  if (!canRead(message) || !isInMainChannel(message)) return;

  const away = isWindowAway();
  if (away || getSetting("chatNotifyMode") === "always") playSound();
  if (away && getSetting("chatNotifyBadge")) markUnread();
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "chatNotifyEnabled", {
    name: "CCFUI.Settings.ChatNotifyEnabled.Name",
    hint: "CCFUI.Settings.ChatNotifyEnabled.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: (value) => { if (!value) clearUnread(); },
  });

  game.settings.register(MODULE_ID, "chatNotifyMode", {
    name: "CCFUI.Settings.ChatNotifyMode.Name",
    hint: "CCFUI.Settings.ChatNotifyMode.Hint",
    scope: "client",
    config: true,
    type: String,
    choices: {
      away: "CCFUI.Settings.ChatNotifyMode.Away",
      always: "CCFUI.Settings.ChatNotifyMode.Always",
    },
    default: "away",
  });

  game.settings.register(MODULE_ID, "chatNotifySound", {
    name: "CCFUI.Settings.ChatNotifySound.Name",
    hint: "CCFUI.Settings.ChatNotifySound.Hint",
    scope: "client",
    config: true,
    type: String,
    filePicker: "audio",
    default: DEFAULT_SOUND,
  });

  game.settings.register(MODULE_ID, "chatNotifyVolume", {
    name: "CCFUI.Settings.ChatNotifyVolume.Name",
    hint: "CCFUI.Settings.ChatNotifyVolume.Hint",
    scope: "client",
    config: true,
    type: Number,
    range: { min: 0, max: 2, step: 0.05 },
    default: 0.8,
  });

  game.settings.register(MODULE_ID, "chatNotifyBadge", {
    name: "CCFUI.Settings.ChatNotifyBadge.Name",
    hint: "CCFUI.Settings.ChatNotifyBadge.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: (value) => { if (!value) clearUnread(); },
  });

  game.settings.register(MODULE_ID, "chatNotifyTab", {
    name: "CCFUI.Settings.ChatNotifyTab.Name",
    hint: "CCFUI.Settings.ChatNotifyTab.Hint",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });
});

Hooks.on("createChatMessage", onCreateChatMessage);

window.addEventListener("focus", clearUnread);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && document.hasFocus()) clearUnread();
});
