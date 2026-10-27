/**
 * ccf-chatlog-export.mjs
 *
 * Exports the whole chat log as ccfolia-style HTML logs.
 *
 * Channel separation is read from the "Multiple Chat Tabs" module
 * (`multiple-chat-tabs`): every message carries a
 * `flags["multiple-chat-tabs"].sourceTab` flag, and the tab list lives in the
 * world setting `multiple-chat-tabs.tabs` (a JSON *string*). That module keeps
 * its classes ES-module private, so the routing rules from its
 * `module/messageFilter.js` are re-implemented below.
 *
 * Output mirrors `ref/天使の魔眼は死を殺す[all].html` byte-for-byte in shape:
 * one `<p style="color:#xxxxxx;">` per message holding three `<span>`s
 * (channel tag / speaker / body), no CSS classes, no timestamps.
 *
 * Like the other files in this module this one is self-contained: it does not
 * import sibling ESM files and exports nothing — it only registers its own
 * settings menu on `init`.
 */

const MODULE_ID = "ccf-ui-v11";
const MCT_ID = "multiple-chat-tabs";
const FALLBACK_COLOR = "#888888";
const FALLBACK_TAB_LABEL = "main";

// --- Multiple Chat Tabs: tab list -------------------------------------------
function getTabs() {
  if (!game.modules.get(MCT_ID)?.active) return [];
  try {
    const raw = game.settings.get(MCT_ID, "tabs");
    const tabs = JSON.parse(raw ?? "[]");
    // Mirrors MultipleChatTabs.getTabs(): tabs without a label are dropped.
    if (Array.isArray(tabs)) return tabs.filter((tab) => tab?.label);
  } catch (err) {
    console.warn("[ccf-chatlog-export] cannot parse multiple-chat-tabs tabs", err);
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
  const sourceTabId = message.getFlag(MCT_ID, "sourceTab");
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

// --- Message → ccfolia line -------------------------------------------------
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const BLOCK_SELECTOR = "p, div, li, tr, h1, h2, h3, h4, h5, h6, hr, section, article, header, footer";

function stripHtml(html) {
  if (!html) return "";
  // DOMParser gives an inert document: no scripts run and no images load.
  const doc = new DOMParser().parseFromString(String(html), "text/html");
  for (const el of doc.querySelectorAll("script, style, img, button, .dice-tooltip")) el.remove();
  for (const el of doc.querySelectorAll("br")) el.replaceWith(doc.createTextNode("\n"));
  for (const el of doc.querySelectorAll(BLOCK_SELECTOR)) el.append(doc.createTextNode("\n"));
  return doc.body.textContent
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderRolls(message) {
  const rolls = message.rolls ?? [];
  if (!rolls.length) return "";
  const flavor = stripHtml(message.flavor).replace(/\n+/g, " ").trim();
  const parts = [];
  for (const roll of rolls) {
    try {
      const formula = roll.formula ?? "";
      const result = roll._evaluated ? String(roll.result ?? "").trim() : "";
      const total = roll.total ?? "";
      // ccfolia writes "cc<=50 SC (1D100<=50) ＞ 81 ＞ 失敗" using a full-width ＞.
      let line = formula ? `(${formula})` : "";
      if (result && result !== String(total)) line += ` ＞ ${result}`;
      parts.push(`${line} ＞ ${total}`.trim());
    } catch (err) {
      console.warn("[ccf-chatlog-export] cannot render roll", err);
    }
  }
  if (!parts.length) return "";
  const body = parts.join("\n");
  return flavor ? `${flavor} ${body}` : body;
}

function getMessageText(message) {
  const content = stripHtml(message.content);
  const rollText = renderRolls(message);
  if (!rollText) return content;
  // A bare roll renders its content as just the total; a system card renders a
  // whole readable block. Replace the former, keep the latter.
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact || /^[\d\s+\-*/().,[\]]+$/.test(compact)) return rollText;
  return content;
}

function normalizeColor(value) {
  if (!value) return null;
  // v11 stores a hex string, v12 a Color instance.
  const css = typeof value === "string" ? value : (value.css ?? String(value));
  return /^#[0-9a-f]{6}$/i.test(css) ? css.toLowerCase() : null;
}

function getMessageColor(message) {
  const user = message.author ?? message.user;
  return normalizeColor(user?.color) ?? FALLBACK_COLOR;
}

function renderMessageBlock(message, tabLabel) {
  const color = getMessageColor(message);
  const name = escapeHtml(message.alias ?? "");
  const text = getMessageText(message);
  const isRoll = !!message.isRoll;
  // ccfolia trails plain text with a space but not dice results; match that.
  const body = escapeHtml(text).replace(/\n/g, "<br>") + (isRoll ? "" : " ");
  return (
    `\n<p style="color:${color};">\n` +
    `  <span> [${escapeHtml(tabLabel)}]</span>\n` +
    `  <span>${name}</span> :\n` +
    `  <span>\n` +
    `    ${body}\n` +
    `  </span>\n` +
    `</p>\n`
  );
}

const HTML_HEAD =
  `<!DOCTYPE html>\n` +
  `<html lang="ja">\n` +
  `  <head>\n` +
  `    <meta charset="UTF-8" />\n` +
  `    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n` +
  `    <meta http-equiv="X-UA-Compatible" content="ie=edge" />\n` +
  `    <title>ccfolia - logs</title>\n` +
  `  </head>\n` +
  `  <body>\n    \n\n`;

const HTML_TAIL = `\n  </body>\n</html>\n`;

function buildHtml(blocks) {
  return HTML_HEAD + blocks.join("") + HTML_TAIL;
}

// --- Store-only ZIP writer --------------------------------------------------
// ccf-import.mjs hand-rolls the *reading* side with DecompressionStream; this
// is the inverse, kept uncompressed so no CompressionStream is needed.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const ZIP_DOS_DATE = 0x0021; // 1980-01-01
const ZIP_UTF8_FLAG = 0x0800; // filenames are UTF-8 (tab labels may be CJK)

function buildZip(entries) {
  const encoder = new TextEncoder();
  const files = entries.map((entry) => {
    const data = encoder.encode(entry.content);
    return { nameBytes: encoder.encode(entry.name), data, crc: crc32(data) };
  });

  let total = 22;
  for (const file of files) total += 30 + 46 + 2 * file.nameBytes.length + file.data.length;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  const offsets = [];
  let off = 0;

  for (const file of files) {
    offsets.push(off);
    view.setUint32(off, 0x04034b50, true);
    view.setUint16(off + 4, 20, true); // version needed
    view.setUint16(off + 6, ZIP_UTF8_FLAG, true);
    view.setUint16(off + 8, 0, true); // method: store
    view.setUint16(off + 10, 0, true); // mod time
    view.setUint16(off + 12, ZIP_DOS_DATE, true);
    view.setUint32(off + 14, file.crc, true);
    view.setUint32(off + 18, file.data.length, true);
    view.setUint32(off + 22, file.data.length, true);
    view.setUint16(off + 26, file.nameBytes.length, true);
    view.setUint16(off + 28, 0, true); // extra length
    off += 30;
    out.set(file.nameBytes, off);
    off += file.nameBytes.length;
    out.set(file.data, off);
    off += file.data.length;
  }

  const centralStart = off;
  files.forEach((file, i) => {
    view.setUint32(off, 0x02014b50, true);
    view.setUint16(off + 4, 20, true); // version made by
    view.setUint16(off + 6, 20, true); // version needed
    view.setUint16(off + 8, ZIP_UTF8_FLAG, true);
    view.setUint16(off + 10, 0, true);
    view.setUint16(off + 12, 0, true);
    view.setUint16(off + 14, ZIP_DOS_DATE, true);
    view.setUint32(off + 16, file.crc, true);
    view.setUint32(off + 20, file.data.length, true);
    view.setUint32(off + 24, file.data.length, true);
    view.setUint16(off + 28, file.nameBytes.length, true);
    view.setUint16(off + 30, 0, true); // extra length
    view.setUint16(off + 32, 0, true); // comment length
    view.setUint16(off + 34, 0, true); // disk number start
    view.setUint16(off + 36, 0, true); // internal attributes
    view.setUint32(off + 38, 0, true); // external attributes
    view.setUint32(off + 42, offsets[i], true);
    off += 46;
    out.set(file.nameBytes, off);
    off += file.nameBytes.length;
  });

  view.setUint32(off, 0x06054b50, true);
  view.setUint16(off + 4, 0, true);
  view.setUint16(off + 6, 0, true);
  view.setUint16(off + 8, files.length, true);
  view.setUint16(off + 10, files.length, true);
  view.setUint32(off + 12, off - centralStart, true);
  view.setUint32(off + 16, centralStart, true);
  view.setUint16(off + 20, 0, true);

  return out;
}

// --- Export -----------------------------------------------------------------
function sanitizeFileName(name) {
  return String(name ?? "")
    .replace(/[\u0000-\u001f/\\:*?"<>|]/g, "_")
    .replace(/^[\s.]+|[\s.]+$/g, "")
    .slice(0, 80) || "log";
}

function getSortedMessages() {
  return [...game.messages.contents].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
}

function buildExportFiles() {
  const base = sanitizeFileName(game.world?.title ?? game.world?.id ?? "foundry");
  const allTabs = getTabs();
  const messages = getSortedMessages();

  const allBlocks = [];
  const perTabBlocks = allTabs.map(() => []);

  for (const message of messages) {
    if (!allTabs.length) {
      allBlocks.push(renderMessageBlock(message, FALLBACK_TAB_LABEL));
      continue;
    }
    const visibleTabIds = getVisibleTabsForMessage(message, allTabs);
    // The [all] file tags each line with the first owning tab, in tab order.
    const primary = allTabs.find((tab) => visibleTabIds.has(tab.id)) ?? allTabs[0];
    allBlocks.push(renderMessageBlock(message, primary?.label ?? FALLBACK_TAB_LABEL));
    allTabs.forEach((tab, i) => {
      if (isMessageInTab(message, tab, visibleTabIds)) {
        perTabBlocks[i].push(renderMessageBlock(message, tab.label));
      }
    });
  }

  const files = [{ name: `${base}[all].html`, content: buildHtml(allBlocks) }];
  allTabs.forEach((tab, i) => {
    files.push({
      name: `${base}[${sanitizeFileName(tab.label)}].html`,
      content: buildHtml(perTabBlocks[i]),
    });
  });

  return { base, files, messageCount: messages.length, tabCount: allTabs.length };
}

function runExport() {
  if (!game.user?.isGM) {
    ui.notifications?.warn(game.i18n.localize("CCFUI.Export.NoPerm"));
    return;
  }
  const t0 = performance.now();
  try {
    const { base, files, messageCount } = buildExportFiles();
    if (!messageCount) {
      ui.notifications?.warn(game.i18n.localize("CCFUI.Export.NoMessages"));
      return;
    }
    if (files.length === 1) {
      saveDataToFile(files[0].content, "text/html", files[0].name);
    } else {
      saveDataToFile(buildZip(files), "application/zip", `${base}-chatlog.zip`);
    }
    const ms = Math.round(performance.now() - t0);
    ui.notifications?.info(
      game.i18n.format("CCFUI.Export.Done", { count: messageCount, files: files.length, ms })
    );
  } catch (err) {
    console.error("[ccf-chatlog-export]", err);
    ui.notifications?.error(
      game.i18n.format("CCFUI.Export.Failed", { error: err?.message ?? String(err) })
    );
  }
}

function openExportDialog() {
  if (!game.user?.isGM) {
    ui.notifications?.warn(game.i18n.localize("CCFUI.Export.NoPerm"));
    return;
  }
  const { files, messageCount, tabCount } = buildExportFiles();
  const list = files.map((f) => `<li>${escapeHtml(f.name)}</li>`).join("");
  const notice = tabCount
    ? ""
    : `<p class="notification warning">${game.i18n.localize("CCFUI.Export.NoTabs")}</p>`;
  const content =
    `<p>${game.i18n.format("CCFUI.Export.Summary", { count: messageCount, files: files.length })}</p>` +
    notice +
    `<ul class="ccf-export-file-list">${list}</ul>`;

  new Dialog({
    title: game.i18n.localize("CCFUI.Export.DialogTitle"),
    content,
    buttons: {
      export: {
        icon: `<i class="fas fa-file-export"></i>`,
        label: game.i18n.localize("CCFUI.Export.Confirm"),
        callback: () => runExport(),
      },
      cancel: {
        icon: `<i class="fas fa-times"></i>`,
        label: game.i18n.localize("CCFUI.Export.Cancel"),
      },
    },
    default: "export",
  }).render(true);
}

// --- Settings menu ----------------------------------------------------------
Hooks.once("init", () => {
  // Defined here so `FormApplication` is guaranteed to exist. SettingsConfig
  // only ever does `new cls().render(true)`, so overriding render() lets the
  // menu entry act as a plain button instead of opening a form window.
  class ChatlogExportMenu extends FormApplication {
    render() {
      openExportDialog();
      return this;
    }

    async _updateObject() {}
  }

  game.settings.registerMenu(MODULE_ID, "exportChatlog", {
    name: "CCFUI.Export.MenuName",
    label: "CCFUI.Export.MenuLabel",
    hint: "CCFUI.Export.MenuHint",
    icon: "fas fa-file-export",
    type: ChatlogExportMenu,
    restricted: true,
  });
});
