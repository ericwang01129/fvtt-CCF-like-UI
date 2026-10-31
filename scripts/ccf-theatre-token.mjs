// ccf-theatre-token.mjs — Theatre Inserts integration (only when the
// `theatre` module is active): choosing a speaking character in Theatre also
// selects (controls) that character's token on the current scene, so
// ChatMessage.getSpeaker() — which reads the controlled token — matches the
// Theatre speaker.
//
// Every speaker-selection path (nav-bar click, Alt+click on a text box, the
// Ctrl+1–0 activateStaged keybindings, theatre.functions.activateStagedByID)
// goes through Theatre.instance.activateInsertById, so that one method is
// patched at runtime instead of editing Theatre.
//
// Rules:
//   - only the scene being viewed, and only tokens the user can control;
//   - a token of that actor that is already controlled is kept, so picking
//     the same speaker never hops between duplicates;
//   - the camera is not moved;
//   - clearing the speaker (clicking it again, or it leaving the stage) does
//     not release the token;
//   - skipped while another canvas layer is active (GM on Tiles etc.).
//
// No feedback loop: Theatre's own controlToken hook only stages the actor if
// it is not staged yet, and activateInsertById has staged it by this point.
//
// Self-contained: re-declares MODULE_ID locally to match the rest of the module.

const MODULE_ID = "ccf-ui-v11";
const THEATRE_ID = "theatre";

function theatreAvailable() {
  return !!game.modules.get(THEATRE_ID)?.active && typeof Theatre === "function";
}

function enabled() {
  try {
    return game.settings.get(MODULE_ID, "theatreSelectToken") === true;
  } catch (e) {
    return false;
  }
}

function selectSpeakerToken(theatreId) {
  if (!enabled()) return;
  if (!theatreId || theatreId === Theatre.NARRATOR) return;
  if (!canvas?.ready || !canvas.tokens?.active) return;

  const actorId = String(theatreId).replace("theatre-", "");
  // document.actorId is the base actor for linked and unlinked tokens alike,
  // which is also what Theatre ids are built from.
  const candidates = canvas.tokens.placeables.filter(
    (t) => t.document.actorId === actorId && t.can(game.user, "control")
  );
  if (!candidates.length) return;

  const token = candidates.find((t) => t.controlled)
    ?? candidates.find((t) => t.visible)
    ?? candidates[0];
  token.control({ releaseOthers: true });
}

function installTheatrePatch() {
  const proto = Theatre.prototype;
  if (proto._ccfTokenPatched) return;

  // speakingAs is read after the original resolves: it is null when the call
  // toggled the speaker off, and then the selection is left alone.
  const origActivate = proto.activateInsertById;
  proto.activateInsertById = async function (id, ev) {
    const result = await origActivate.call(this, id, ev);
    selectSpeakerToken(this.speakingAs);
    return result;
  };

  proto._ccfTokenPatched = true;
}

Hooks.once("init", () => {
  if (!theatreAvailable()) return;

  game.settings.register(MODULE_ID, "theatreSelectToken", {
    name: "CCFUI.Settings.TheatreSelectToken.Name",
    hint: "CCFUI.Settings.TheatreSelectToken.Hint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  });

  installTheatrePatch();
});
