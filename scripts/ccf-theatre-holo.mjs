// ccf-theatre-holo.mjs — Theatre Inserts integration (only when the
// `theatre` module is active):
//   1. A per-actor "hologram" style, toggled from a button in Theatre's emote
//      menu (right of the font-colour picker). The portrait and name label get
//      an animated electric-blue hologram filter and the actor's text box
//      turns into a translucent blue sci-fi comms panel
//      (styles/ccf-theatre-holo.css).
//   2. Hiding Theatre's narrator mode (world setting, on by default).
//
// The style is stored on the actor (flags.ccf-ui-v11.theatreStyle =
// "hologram"), so Foundry syncs it to every client, late joiners included,
// and it persists across stagings like Theatre's own font/colour settings.
//
// Theatre is a classic-script global, so it is patched at runtime instead of
// edited:
//   - _setupPortraitContainer: every path that (re)builds an insert's PIXI
//     containers ends here (a new insert, an emote change, a texture swap),
//     and the old dockContainer is destroyed each time, so the style is
//     re-applied after it.
//   - _renderTheatre: Theatre's own updateActor hook calls it unguarded,
//     which starts an extra requestAnimationFrame chain whenever a render loop
//     is already running. The hologram keeps a permanent tween (and so the
//     loop) alive, so those chains would pile up; collapse them by letting
//     only one call per animation-frame timestamp through.
//   - toggleNarratorBar: refuses to open the narrator bar while hidden, which
//     also covers the Alt+N keybinding and remote/resync events.
//
// Self-contained: re-declares MODULE_ID locally to match the rest of the module.

const MODULE_ID = "ccf-ui-v11";
const THEATRE_ID = "theatre";
const FLAG_KEY = "theatreStyle";
const HOLOGRAM = "hologram";
const TWEEN_ID = "ccfHologram";
const BOX_CLASS = "ccf-holo-box";
const NARRATOR_CLASS = "ccf-hide-theatre-narrator";

let HologramFilter = null;

// Fragment shader for the portrait. PIXI hands filters premultiplied colour.
// vTextureCoord * inputSize.xy is the pixel position inside the filter frame
// (outputFrame.zw), so effects are sized in screen pixels, not texture UVs.
// Must be highp and must start with "precision": inputSize / outputFrame are
// also declared (highp) in PIXI's default filter vertex shader, and a
// precision mismatch makes the program fail to link, so nothing renders.
const HOLOGRAM_FRAG = `precision highp float;

varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec4 inputSize;
uniform vec4 inputClamp;
uniform vec4 outputFrame;
uniform float time;
uniform vec3 glowColor;
uniform float glowRadius;

float hash(float n) { return fract(sin(n) * 43758.5453); }

vec4 sampleAt(vec2 uv) {
  return texture2D(uSampler, clamp(uv, inputClamp.xy, inputClamp.zw));
}

void main() {
  vec2 uv = vTextureCoord;
  vec2 px = uv * inputSize.xy;
  float yN = px.y / outputFrame.w;
  float screenY = px.y + outputFrame.y;

  // Occasional horizontal glitch band (~8% of 1/8 s slots).
  float slot = floor(time * 8.0);
  float glitchOn = step(0.92, hash(slot));
  float bandY = hash(slot + 1.7);
  float bandH = 0.02 + 0.05 * hash(slot + 3.1);
  float inBand = glitchOn * step(bandY, yN) * step(yN, bandY + bandH);
  uv.x += inBand * (hash(slot + 5.3) - 0.5) * 24.0 * inputSize.z;

  vec4 c = sampleAt(uv);

  // Electric-blue grade, keeping a little of the original colour.
  float lum = dot(c.rgb, vec3(0.299, 0.587, 0.114));
  vec3 graded = mix(c.rgb, glowColor * (0.25 * c.a + lum * 1.35), 0.72);

  // Scrolling scanlines, a slow bright sweep and a low flicker.
  float scan = 0.78 + 0.22 * sin(screenY * 1.4 - time * 8.0);
  float roll = fract(yN - time * 0.12);
  float sweep = smoothstep(0.0, 0.06, roll) * (1.0 - smoothstep(0.06, 0.16, roll));
  float flicker = 0.93 + 0.05 * sin(time * 31.0) + 0.02 * sin(time * 97.0);
  flicker *= 1.0 - 0.25 * step(0.97, hash(floor(time * 15.0)));

  // Outer glow from the alpha of 24 surrounding samples.
  float glow = 0.0;
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 0.5235988;
    vec2 off = vec2(cos(a), sin(a)) * glowRadius * inputSize.zw;
    glow += sampleAt(uv + off).a;
    glow += sampleAt(uv + off * 0.5).a;
  }
  glow /= 24.0;
  float outer = max(glow - c.a, 0.0);

  float alpha = c.a * 0.85 * flicker;
  vec3 body = (graded * scan + glowColor * sweep * 0.35 * c.a) * 0.85 * flicker;
  gl_FragColor = vec4(min(body + glowColor * outer * 0.7, vec3(1.0)), min(alpha + outer * 0.55, 1.0));
}
`;

function theatreAvailable() {
  return !!game.modules.get(THEATRE_ID)?.active && typeof Theatre === "function";
}

function narratorHidden() {
  try {
    return game.settings.get(MODULE_ID, "hideTheatreNarrator") === true;
  } catch (e) {
    return false;
  }
}

function applyNarratorClass() {
  document.body.classList.toggle(NARRATOR_CLASS, narratorHidden());
}

function isHologram(actorId) {
  return game.actors.get(actorId)?.getFlag(MODULE_ID, FLAG_KEY) === HOLOGRAM;
}

function actorIdOf(theatreId) {
  return String(theatreId ?? "").replace("theatre-", "");
}

// --- Insert styling ---------------------------------------------------------
// Idempotent: safe to call whenever an insert may have been (re)built.
function applyInsertStyle(insert) {
  const theatre = Theatre.instance;
  if (!theatre || !insert?.imgId) return;
  const on = isHologram(actorIdOf(insert.imgId));

  // The dockContainer holds the portrait, the name label and the typing
  // bubble, so one filter textures all three.
  const container = insert.dockContainer;
  if (container && !container.destroyed) {
    const filters = container.filters ?? [];
    let filter = filters.find((f) => f instanceof HologramFilter);
    if (on) {
      if (!filter) {
        filter = new HologramFilter(theatre.pixiCTX?.renderer?.resolution);
        container.filters = [...filters, filter];
      }
      // Theatre only renders while a dock tween is registered, so the shader
      // clock doubles as the "keep rendering" signal. Theatre kills it with
      // the rest of the insert's tweens when the container is rebuilt.
      if (!insert.tweens?.[TWEEN_ID]) {
        const tween = gsap.to(filter.uniforms, { time: 600, duration: 600, ease: "none", repeat: -1 });
        theatre._addDockTween(insert.imgId, tween, TWEEN_ID);
      }
    } else if (filter) {
      const rest = filters.filter((f) => f !== filter);
      container.filters = rest.length ? rest : null;
      theatre._removeDockTween(insert.imgId, null, TWEEN_ID);
      filter.destroy();
    }
  }

  theatre._getTextBoxById(insert.imgId)?.classList.toggle(BOX_CLASS, on);
  if (!theatre.rendering) theatre._renderTheatre(performance.now());
}

// --- Emote menu toggle ------------------------------------------------------
function speakingActor() {
  const id = Theatre.instance?.speakingAs;
  if (!id || id === Theatre.NARRATOR) return null;
  return game.actors.get(actorIdOf(id)) ?? null;
}

function refreshToggle() {
  const btn = Theatre.instance?.theatreEmoteMenu?.querySelector(".ccf-holo-toggle");
  if (!btn) return;
  const actor = speakingActor();
  const usable = !!actor?.isOwner;
  btn.classList.toggle("disabled", !usable);
  btn.classList.toggle("active", usable && isHologram(actor.id));
  btn.title = game.i18n.localize(usable ? "CCFUI.Theatre.HoloToggle" : "CCFUI.Theatre.HoloNoActor");
}

async function onToggleClick(ev) {
  ev.preventDefault();
  const actor = speakingActor();
  if (!actor?.isOwner) {
    ui.notifications?.warn(game.i18n.localize("CCFUI.Theatre.HoloNoActor"));
    return;
  }
  if (isHologram(actor.id)) await actor.unsetFlag(MODULE_ID, FLAG_KEY);
  else await actor.setFlag(MODULE_ID, FLAG_KEY, HOLOGRAM);
  document.getElementById("chat-message")?.focus();
}

// Theatre rebuilds the whole emote menu via innerHTML on many events, so the
// button is re-inserted after every rebuild.
function injectToggle() {
  const menu = Theatre.instance?.theatreEmoteMenu;
  const colorSelect = menu?.querySelector(".emotebar .colorselect");
  if (!colorSelect || menu.querySelector(".ccf-holo-toggle")) return;
  const btn = document.createElement("div");
  btn.className = "ccf-holo-toggle theatre-control-btn";
  btn.innerHTML = `<i class="fas fa-tower-broadcast"></i>`;
  btn.addEventListener("click", onToggleClick);
  colorSelect.after(btn);
  refreshToggle();
}

// --- Patches ----------------------------------------------------------------
function installTheatrePatches() {
  const proto = Theatre.prototype;
  if (proto._ccfHoloPatched) return;

  const origSetup = proto._setupPortraitContainer;
  proto._setupPortraitContainer = async function (imgId, ...args) {
    const result = await origSetup.call(this, imgId, ...args);
    applyInsertStyle(this.getInsertById(imgId));
    return result;
  };

  // rAF callbacks in the same frame receive the same timestamp, so a second
  // chain is dropped here and stops rescheduling itself.
  const origRender = proto._renderTheatre;
  proto._renderTheatre = function (time) {
    if (time === this._ccfLastRender) return;
    this._ccfLastRender = time;
    return origRender.call(this, time);
  };

  const origToggleNarrator = proto.toggleNarratorBar;
  proto.toggleNarratorBar = function (active, remote) {
    if (active && narratorHidden()) return;
    return origToggleNarrator.call(this, active, remote);
  };

  proto._ccfHoloPatched = true;
}

// --- Hooks ------------------------------------------------------------------
Hooks.once("init", () => {
  if (!theatreAvailable()) return;

  // Defined here so PIXI is guaranteed to exist (same pattern as the
  // Application subclasses in the other files).
  HologramFilter = class extends PIXI.Filter {
    constructor(resolution) {
      super(undefined, HOLOGRAM_FRAG, {
        time: 0,
        glowColor: new Float32Array([0.31, 0.78, 1.0]),
        glowRadius: 10,
      });
      this.padding = 16;
      if (resolution) this.resolution = resolution;
    }
  };

  game.settings.register(MODULE_ID, "hideTheatreNarrator", {
    name: "CCFUI.Settings.HideTheatreNarrator.Name",
    hint: "CCFUI.Settings.HideTheatreNarrator.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: true,
    onChange: (hidden) => {
      applyNarratorClass();
      // Every client gets onChange, so close locally without re-broadcasting.
      if (hidden && Theatre.instance?.isNarratorActive) Theatre.instance.toggleNarratorBar(false, true);
    },
  });

  installTheatrePatches();
});

Hooks.once("ready", () => {
  if (!theatreAvailable() || !Theatre.instance) return;
  applyNarratorClass();

  // Inserts staged before the patches took effect (e.g. by a resync).
  for (const insert of Theatre.instance.portraitDocks ?? []) applyInsertStyle(insert);

  const menu = Theatre.instance.theatreEmoteMenu;
  if (menu) {
    new MutationObserver(injectToggle).observe(menu, { childList: true });
    injectToggle();
  }
});

Hooks.on("updateActor", (actor, changes) => {
  if (!HologramFilter || !Theatre.instance) return;
  if (!foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) return;
  applyInsertStyle(Theatre.instance.getInsertById(`theatre-${actor.id}`));
  refreshToggle();
});
