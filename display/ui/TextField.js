// TextField — a real `<input>` floated over the canvas, positioned to sit where a HUD
// element says it should.
//
// Pixi has no text input. Drawing one means hand-rolling a caret, selection, clipboard,
// IME, and password masking — and getting a worse result than the browser's, with no
// mobile keyboard. So the field IS a DOM `<input>`, absolutely positioned over the
// canvas and kept in step with the HUD each frame.
//
// It lives in page coordinates while the HUD lives in logical screen pixels, so
// `syncTo` converts: it reads the canvas's on-page rect every frame (cheap, and the
// only thing that survives a resize, a scroll, or a CSS zoom without extra bookkeeping).
//
// The element is removed from the DOM when hidden rather than just made invisible —
// a hidden-but-present input still takes tab focus, which would let Tab walk into a form
// that isn't on screen.

/** Styling that makes the input read as part of the board rather than a browser widget.
 * Kept here rather than in CSS because there's no stylesheet — the page is a canvas and
 * a script tag. @private */
const BASE_STYLE = {
  position: "fixed",
  boxSizing: "border-box",
  border: "none",
  outline: "none",
  borderRadius: "4px",
  background: "#241a0e",
  color: "#f0e2c8",
  fontFamily: "system-ui, sans-serif",
  fontWeight: "700",
  textAlign: "center",
  padding: "0 8px",
  zIndex: "10", // over the canvas, under nothing else (the page has no other chrome)
};

/**
 * Create a text field.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.password=false] Mask the value, and stop password managers
 *   offering to fill a field that isn't one.
 * @param {number} [opts.maxLength=32]
 * @param {string} [opts.placeholder=""]
 * @param {() => void} [opts.onSubmit] Fired when Enter is pressed — so a form can be
 *   completed from the keyboard rather than only by clicking Submit.
 * @returns {{el: HTMLInputElement, syncTo(canvas:HTMLCanvasElement, screenW:number,
 *   rect:{x:number,y:number,w:number,h:number}):void, setVisible(on:boolean):void,
 *   get value():string, clear():void, focus():void, destroy():void}}
 */
export function textField(opts = {}) {
  const el = document.createElement("input");
  el.type = opts.password ? "password" : "text";
  el.autocomplete = opts.password ? "current-password" : "username";
  el.maxLength = opts.maxLength ?? 32;
  el.placeholder = opts.placeholder ?? "";
  el.spellcheck = false;
  Object.assign(el.style, BASE_STYLE);

  if (opts.onSubmit) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); opts.onSubmit(); }
    });
  }
  // The game reads raw keys off `window` (WASD, number keys, R, Esc). Without this,
  // typing a username would also drive the player and swap petals. Stopping propagation
  // at the input keeps typing local to the field.
  for (const ev of ["keydown", "keyup", "keypress"]) {
    el.addEventListener(ev, (e) => e.stopPropagation());
  }

  let visible = false;

  return {
    el,

    /**
     * Put the field where the HUD says, converting logical screen pixels to page
     * pixels via the canvas's current on-page rect.
     *
     * @param {HTMLCanvasElement} canvas The game canvas.
     * @param {number} screenW The HUD's logical screen width (`app.screen.width`).
     * @param {{x:number,y:number,w:number,h:number}} rect Where to sit, in logical
     *   screen pixels, top-left origin.
     */
    syncTo(canvas, screenW, rect) {
      if (!visible || !canvas) return;
      const box = canvas.getBoundingClientRect();
      // Logical HUD pixels -> CSS pixels. Usually 1, but not when the canvas is styled
      // to a different size than its backing resolution.
      const k = screenW > 0 ? box.width / screenW : 1;
      el.style.left = `${box.left + rect.x * k}px`;
      el.style.top = `${box.top + rect.y * k}px`;
      el.style.width = `${rect.w * k}px`;
      el.style.height = `${rect.h * k}px`;
      el.style.fontSize = `${rect.h * k * 0.42}px`;
    },

    /** Attach or detach the element. Detached rather than hidden, so it can't take
     * tab focus while off screen. */
    setVisible(on) {
      if (on === visible) return;
      visible = on;
      if (on) document.body.appendChild(el);
      else { el.blur(); el.remove(); }
    },

    get value() { return el.value; },
    clear() { el.value = ""; },
    focus() { el.focus(); },
    destroy() { el.blur(); el.remove(); },
  };
}
