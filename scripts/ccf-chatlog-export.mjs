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
 * Output mirrors `ref/我們的伊甸園_html_log/*.html` (ccfolia's styled log) in
 * shape: one `<article class="message">` per message with an avatar (inlined
 * as a base64 PNG through `.avatar-image-N` CSS classes), speaker, timestamp,
 * text and an optional `roll-result` line. The [すべて] file also tags every
 * message with its channel name; per-channel files do not.
 *
 * Like the other files in this module this one is self-contained: it does not
 * import sibling ESM files and exports nothing — it only registers its own
 * settings menu on `init`.
 */

const MODULE_ID = "ccf-ui-v11";
const MCT_ID = "multiple-chat-tabs";
const FALLBACK_COLOR = "#888888";
const FALLBACK_TAB_ID = "main";
const FALLBACK_TAB_LABEL = "main";
// ccfolia names the all-channels log "[すべて]" whatever the UI language.
const ALL_LABEL = "すべて";
const AVATAR_SIZE = 80;
const AVATAR_TIMEOUT_MS = 10000;

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

// --- Message → ccfolia article ----------------------------------------------
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

// ccfolia writes "1D10+20", Foundry "1d10 + 20".
function toCcfoliaFormula(formula) {
  return String(formula ?? "")
    .replace(/(\d*)d(\d|%|F)/g, "$1D$2")
    .replace(/\s*([+\-*/])\s*/g, "$1");
}

function getTermClasses() {
  // v12 namespaces the term classes; v11 only has the globals.
  const terms = foundry.dice?.terms ?? globalThis;
  return { DiceTerm: terms.DiceTerm, OperatorTerm: terms.OperatorTerm, NumericTerm: terms.NumericTerm };
}

// "3[3]+20" for 1d10+20 — each die term as total[faces], like ccfolia.
function formatRollDetail(roll) {
  const { DiceTerm, OperatorTerm, NumericTerm } = getTermClasses();
  return roll.terms
    .map((term) => {
      if (DiceTerm && term instanceof DiceTerm) {
        const faces = term.results.filter((r) => r.active !== false).map((r) => r.result);
        return `${term.total}[${faces.join(",")}]`;
      }
      if (OperatorTerm && term instanceof OperatorTerm) return term.operator;
      if (NumericTerm && term instanceof NumericTerm) return String(term.number);
      return term.expression ?? String(term.total ?? "");
    })
    .join("")
    .trim();
}

function isSingleDie(roll) {
  const { DiceTerm } = getTermClasses();
  const [term, ...rest] = roll.terms;
  return !rest.length && DiceTerm && term instanceof DiceTerm && term.results.length === 1;
}

function renderRolls(message) {
  const rolls = message.rolls ?? [];
  const parts = [];
  for (const roll of rolls) {
    try {
      const formula = toCcfoliaFormula(roll.formula);
      const total = roll.total ?? "";
      // ccfolia: "(1D10+20) ＞ 3[3]+20 ＞ 23", but "(1D100) ＞ 27" for one die.
      let line = formula ? `(${formula})` : "";
      if (roll._evaluated && !isSingleDie(roll)) {
        const detail = formatRollDetail(roll);
        if (detail && detail !== String(total)) line += ` ＞ ${detail}`;
      }
      parts.push(`${line} ＞ ${total}`.trim());
    } catch (err) {
      console.warn("[ccf-chatlog-export] cannot render roll", err);
    }
  }
  return parts.join("\n");
}

// First match wins, so the "大" variants must precede plain 成功/失敗.
const ROLL_OUTCOMES = [
  ["critical", /大成功|クリティカル|critical/i],
  ["fumble", /大失敗|ファンブル|fumble/i],
  ["failure", /失敗|failure|failed/i],
  ["success", /成功|success/i],
];

function getRollOutcome(text) {
  return ROLL_OUTCOMES.find(([, pattern]) => pattern.test(text))?.[0] ?? "";
}

function getMessageParts(message) {
  const content = stripHtml(message.content);
  const rollText = renderRolls(message);
  if (!rollText) return { text: content, rollText: "", rollClass: "" };
  // A bare roll renders its content as just the total, so show the flavor (or
  // the formula, like ccfolia's typed command) instead; a system card renders
  // a whole readable block, so keep it.
  const compact = content.replace(/\s+/g, " ").trim();
  const isBareRoll = !compact || /^[\d\s+\-*/().,[\]]+$/.test(compact);
  const text = isBareRoll
    ? stripHtml(message.flavor) || toCcfoliaFormula(message.rolls[0]?.formula)
    : content;
  return { text, rollText, rollClass: getRollOutcome(`${text}\n${rollText}`) };
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

function getHtmlLang() {
  try {
    return Intl.getCanonicalLocales(game.i18n.lang)[0] ?? "en";
  } catch (err) {
    return "en";
  }
}

function createDateFormat(lang) {
  const options = {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat(lang, options);
  } catch (err) {
    return new Intl.DateTimeFormat("en", options);
  }
}

// --- Avatars ----------------------------------------------------------------
const DEFAULT_AVATARS = new Set(["icons/svg/mystery-man.svg", CONST.DEFAULT_TOKEN]);

// ccfolia shows the character icon; the closest is the actor portrait.
function getAvatarSrc(message) {
  const speaker = message.speaker ?? {};
  const token = speaker.token ? game.scenes.get(speaker.scene)?.tokens.get(speaker.token) : null;
  const actor = token?.actor ?? (speaker.actor ? game.actors.get(speaker.actor) : null);
  const src = actor?.img || token?.texture?.src || null;
  return src && !DEFAULT_AVATARS.has(src) ? src : null;
}

function isVideoSrc(src) {
  const helper = foundry.helpers?.media?.VideoHelper ?? globalThis.VideoHelper;
  return !!helper?.hasVideoExtension?.(src);
}

function loadMedia(src) {
  const load = new Promise((resolve, reject) => {
    if (isVideoSrc(src)) {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.preload = "auto";
      video.onloadeddata = () => resolve(video);
      video.onerror = () => reject(new Error(`cannot load ${src}`));
      video.src = src;
    } else {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`cannot load ${src}`));
      img.src = src;
    }
  });
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timed out loading ${src}`)), AVATAR_TIMEOUT_MS)
  );
  return Promise.race([load, timeout]);
}

// Square-crops the image (first frame for video) to an 80×80 PNG data URL;
// null when it cannot be loaded or the canvas is tainted by a foreign origin.
async function rasterizeAvatar(src) {
  try {
    const media = await loadMedia(src);
    const width = media.videoWidth || media.naturalWidth || AVATAR_SIZE;
    const height = media.videoHeight || media.naturalHeight || AVATAR_SIZE;
    const scale = Math.max(AVATAR_SIZE / width, AVATAR_SIZE / height);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext("2d");
    const drawWidth = width * scale;
    const drawHeight = height * scale;
    ctx.drawImage(media, (AVATAR_SIZE - drawWidth) / 2, (AVATAR_SIZE - drawHeight) / 2, drawWidth, drawHeight);
    return canvas.toDataURL("image/png");
  } catch (err) {
    console.warn("[ccf-chatlog-export] avatar skipped", err);
    return null;
  }
}

async function loadAvatars(entries) {
  const srcs = [...new Set(entries.map((entry) => entry.avatarSrc).filter(Boolean))];
  const dataUrls = await Promise.all(srcs.map(rasterizeAvatar));
  return new Map(srcs.map((src, i) => [src, dataUrls[i]]));
}

// --- HTML -------------------------------------------------------------------
function toEntry(message, dateFormat) {
  const date = new Date(message.timestamp ?? 0);
  return {
    message,
    system: !String(message.alias ?? "").trim(),
    speaker: message.alias ?? "",
    color: getMessageColor(message),
    iso: date.toISOString(),
    time: dateFormat.format(date),
    edited: !!message.flags?.chatedit?.edited,
    avatarSrc: getAvatarSrc(message),
    ...getMessageParts(message),
  };
}

// `channel` is the {id, label} the message is filed under in this file;
// `showChannel` is only set for the [すべて] file.
function renderArticle(entry, channel, showChannel, avatarClass) {
  const channelId = escapeHtml(channel.id);
  const channelName = `<span class="channel-name">[${escapeHtml(channel.label)}]</span>`;
  const text = `<div class="message-text">${escapeHtml(entry.text)}</div>`;

  if (entry.system) {
    const header = showChannel
      ? `        <div class="message-header">\n` +
        `          ${channelName}\n` +
        `        </div>\n\n`
      : "";
    return (
      `\n      <article class="message system" data-channel="${channelId}">\n\n` +
      header +
      `        ${text}\n` +
      `      </article>\n\n`
    );
  }

  const avatar = avatarClass
    ? `<span class="avatar ${avatarClass}" aria-hidden="true"></span>`
    : `<span class="avatar-spacer" aria-hidden="true"></span>`;
  const rollClass = entry.rollClass ? ` ${entry.rollClass}` : "";
  return (
    `\n      <article class="message" data-channel="${channelId}">\n\n` +
    `        ${avatar}\n\n` +
    `        <div class="message-content">\n` +
    `          <div class="message-header">\n` +
    `            <span class="speaker" style="--speaker-color:${entry.color}">${escapeHtml(entry.speaker)}</span>\n` +
    `            <time class="timestamp" datetime="${entry.iso}">${escapeHtml(entry.time)}</time>\n\n` +
    (showChannel ? `            ${channelName}\n\n` : "") +
    `\n` +
    (entry.edited
      ? `            <span class="edited">${escapeHtml(game.i18n.localize("CCFUI.Export.Edited"))}</span>\n\n`
      : "") +
    `          </div>\n` +
    `          ${text}\n\n` +
    (entry.rollText
      ? `          <span class="roll-result${rollClass}">${escapeHtml(entry.rollText)}</span>\n\n`
      : "") +
    `        </div>\n` +
    `      </article>\n\n`
  );
}

const STYLE_HEAD = `
      :root {
        color-scheme: dark;
        color: #eee;
        background: #121212;
      }

      * {
        box-sizing: border-box;
      }

      body {
        min-width: 280px;
        margin: 0;
        background: #121212;
      }

      .message-list {
        width: 100%;
        max-width: 960px;
        margin: 0 auto;
        padding: 0 24px 48px;
      }

      .log-title {
        margin: 24px 0;
        font-size: 24px;
      }

      .message {
        display: grid;
        grid-template-columns: 40px minmax(0, 1fr);
        column-gap: 12px;
        padding: 16px 0;
        border-bottom: 1px solid #262626;
      }

      .message.system {
        display: block;
        padding-left: 52px;
        color: #888;
      }

      .avatar,
      .avatar-spacer {
        width: 40px;
        height: 40px;
      }

      .avatar {
        display: block;
        background-repeat: no-repeat;
        background-size: 100% 100%;
      }

`;

const STYLE_TAIL = `

      .message-content {
        min-width: 0;
      }

      .message-header {
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 8px;
      }

      .speaker {
        color: var(--speaker-color);
        font-size: 14px;
        font-weight: bold;
      }

      .timestamp,
      .edited,
      .channel-name {
        color: #888;
        font-size: 12px;
      }

      .message-text,
      .roll-result {
        font-size: 16px;
        line-height: 1.6;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }

      .roll-result {
        display: block;
        color: #888;
      }

      .roll-result.success,
      .roll-result.critical {
        color: #2196f3;
      }

      .roll-result.failure,
      .roll-result.fumble {
        color: #dc004e;
      }
`;

// `items` is [{entry, channel}] in file order. Avatar classes are numbered per
// file in order of first appearance, one per distinct image.
function buildHtml({ title, lang, items, showChannel, avatars }) {
  const avatarIndex = new Map();
  const articles = items.map(({ entry, channel }) => {
    const dataUrl = avatars.get(entry.avatarSrc);
    let avatarClass = null;
    if (dataUrl && !entry.system) {
      if (!avatarIndex.has(dataUrl)) avatarIndex.set(dataUrl, avatarIndex.size);
      avatarClass = `avatar-image-${avatarIndex.get(dataUrl)}`;
    }
    return renderArticle(entry, channel, showChannel, avatarClass);
  });
  const avatarStyles = [...avatarIndex]
    .map(([dataUrl, i]) => `\n      .avatar-image-${i} { background-image: url("${dataUrl}"); }\n`)
    .join("");
  const safeTitle = escapeHtml(title);

  return (
    `<!DOCTYPE html>\n` +
    `<html lang="${escapeHtml(lang)}">\n` +
    `  <head>\n` +
    `    <meta charset="UTF-8" />\n` +
    `    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n` +
    `    <title>${safeTitle}</title>\n` +
    `    <style>` +
    STYLE_HEAD +
    avatarStyles +
    STYLE_TAIL +
    `    </style>\n` +
    `  </head>\n` +
    `  <body>\n` +
    `    <main class="message-list">\n` +
    `      <h1 class="log-title">${safeTitle}</h1>\n\n` +
    articles.join("\n") +
    `\n    </main>\n` +
    `  </body>\n` +
    `</html>`
  );
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

const FALLBACK_CHANNEL = { id: FALLBACK_TAB_ID, label: FALLBACK_TAB_LABEL };

// Cheap pass shared by the dialog summary and the export: channel routing
// and file names only, no message rendering.
function planExport() {
  const worldTitle = game.world?.title ?? game.world?.id ?? "foundry";
  const base = sanitizeFileName(worldTitle);
  const allTabs = getTabs();
  const messages = getSortedMessages();

  const routes = messages.map((message) => {
    if (!allTabs.length) return { message, primary: FALLBACK_CHANNEL, tabs: [] };
    const visibleTabIds = getVisibleTabsForMessage(message, allTabs);
    // The [すべて] file tags each message with the first owning tab, in tab order.
    const primary = allTabs.find((tab) => visibleTabIds.has(tab.id)) ?? allTabs[0];
    const tabs = allTabs.filter((tab) => isMessageInTab(message, tab, visibleTabIds));
    return { message, primary, tabs };
  });

  const fileNames = [
    `${base}[${ALL_LABEL}].html`,
    ...allTabs.map((tab) => `${base}[${sanitizeFileName(tab.label)}].html`),
  ];

  return { worldTitle, base, allTabs, routes, fileNames };
}

async function buildExportFiles() {
  const { worldTitle, base, allTabs, routes, fileNames } = planExport();
  const lang = getHtmlLang();
  const dateFormat = createDateFormat(lang);

  const entries = new Map(routes.map(({ message }) => [message, toEntry(message, dateFormat)]));
  const avatars = await loadAvatars([...entries.values()]);

  const files = [
    {
      name: fileNames[0],
      content: buildHtml({
        title: `${worldTitle} [${ALL_LABEL}]`,
        lang,
        items: routes.map(({ message, primary }) => ({ entry: entries.get(message), channel: primary })),
        showChannel: true,
        avatars,
      }),
    },
  ];
  allTabs.forEach((tab, i) => {
    files.push({
      name: fileNames[i + 1],
      content: buildHtml({
        title: `${worldTitle} [${tab.label}]`,
        lang,
        items: routes
          .filter(({ tabs }) => tabs.includes(tab))
          .map(({ message }) => ({ entry: entries.get(message), channel: tab })),
        showChannel: false,
        avatars,
      }),
    });
  });

  return { base, files, messageCount: routes.length };
}

async function runExport() {
  if (!game.user?.isGM) {
    ui.notifications?.warn(game.i18n.localize("CCFUI.Export.NoPerm"));
    return;
  }
  const t0 = performance.now();
  try {
    if (!game.messages.size) {
      ui.notifications?.warn(game.i18n.localize("CCFUI.Export.NoMessages"));
      return;
    }
    const { base, files, messageCount } = await buildExportFiles();
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
  const { allTabs, routes, fileNames } = planExport();
  const list = fileNames.map((name) => `<li>${escapeHtml(name)}</li>`).join("");
  const notice = allTabs.length
    ? ""
    : `<p class="notification warning">${game.i18n.localize("CCFUI.Export.NoTabs")}</p>`;
  const content =
    `<p>${game.i18n.format("CCFUI.Export.Summary", { count: routes.length, files: fileNames.length })}</p>` +
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
