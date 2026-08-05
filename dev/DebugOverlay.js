// Dev-only debug overlay — ALL of it in one file: the immediate-mode drawing,
// the on-screen toggle button, the key shortcut, and the glue that rides it on
// top of the view. The production boot (index.html) carries none of this beyond
// a single `attachDebugOverlay(view)` call — delete that line to ship without it.
//
// Pixi-coupled by design (unlike the rest of GameEngine, which is headless).
// Requires the global `PIXI` to be loaded.
//
// Draws, over the world container (so it follows the camera):
//   - collision shapes  → RED    (the actual collider: circle, or rotated oval)
//   - broadphase bounds  → BLUE   (each entity's AABB; off by default — noisy)
//   - detection ranges   → ORANGE (each entity's effective seek range)

import { Disposition } from "../entities/Disposition.js";

/** Aggro grows a seeker's range by this once it's in combat — mirrors the server's
 * `Targeting.js`. Inlined here because the client doesn't target: the overlay only
 * DRAWS the range the server's decision implies, from fields snapshots already carry
 * (`disposition`, `aggroed`, `range`). @private */
const AGGRO_RANGE_MULT = 1.5;

/** How far this entity would detect from, or 0 if it isn't a seeker. Display-only.
 * @private */
function detectionRange(e) {
  if (e.disposition === Disposition.PASSIVE || e.disposition === Disposition.ALLIED) return 0;
  if (e.aggroed) return e.range * AGGRO_RANGE_MULT;
  if (e.disposition === Disposition.HOSTILE) return e.range;
  return 0;
}

const RED = 0xff0000; // collision shapes
const BLUE = 0x0000ff; // broadphase bounding boxes
const ORANGE = 0xffa500; // detection ranges

/**
 * Immediate-mode overlay: one Pixi Graphics, cleared and redrawn every frame.
 */
class DebugDraw {
  /**
   * @param {Object} worldContainer The view's camera-transformed container
   *   (`VisualEngine.shared.view.world`) to draw into.
   */
  constructor(worldContainer) {
    this.world = worldContainer;
    this.g = new PIXI.Graphics();
    // The world container is z-sorted (sortableChildren), so staying on top is by
    // zIndex, not child order — a huge value keeps the overlay above every entity.
    this.g.zIndex = 1e9;
    worldContainer.addChild(this.g);

    /** Master on/off. Off by default — players get a clean view; toggle with the
     * on-screen button or the toggle key (see `attachDebugOverlay`). */
    this.enabled = false;
    /** Per-layer toggles. */
    this.showCircles = true; // red collision shapes
    this.showBounds = false; // blue broadphase AABBs (off — noisy by default)
    this.showRanges = true; // orange detection ranges
  }

  /**
   * Redraw the overlay for the given entities (e.g. the list `view.draw` returns).
   * @param {Array} entities
   */
  draw(entities) {
    const g = this.g;
    g.clear();
    if (!this.enabled) return;

    // Keep the overlay on top of the entity sprites (re-add = move to front).
    this.world.addChild(g);

    for (let i = 0; i < entities.length; i++) {
      const e = entities[i];

      // Detection range (orange) — the EFFECTIVE range it's seeking with right
      // now (×1.5 for hostile, on only when aggroed, 0 for player/passive), so it
      // updates live as things aggro. 0 → not seeking → no circle drawn.
      if (this.showRanges) {
        const r = detectionRange(e);
        if (r > 0) {
          g.circle(e.x, e.y, r);
          g.stroke({ color: ORANGE, width: 2, alpha: 0.5 });
        }
      }

      // Collision shape (red) — the ACTUAL collider: a rotated ellipse for an
      // oval (rx/ry rotated by facing + the collider's static offset, matching
      // the narrowphase), else the plain collision circle.
      if (this.showCircles) {
        const col = e.collider;
        if (col !== null && col.type === "oval") {
          const N = 24; // ellipse sampled as a 24-gon
          const a = e.angle + (col.angle || 0); // facing + static collider offset
          const c = Math.cos(a), s = Math.sin(a);
          const pts = [];
          for (let k = 0; k < N; k++) {
            const t = (k / N) * Math.PI * 2;
            const lx = Math.cos(t) * col.rx, ly = Math.sin(t) * col.ry;
            pts.push(e.x + lx * c - ly * s, e.y + lx * s + ly * c); // local→world
          }
          g.poly(pts);
          g.stroke({ color: RED, width: 2 });
        } else if (col !== null && col.type === "polygon") {
          // The procedural outline — verts are local (about the entity center) and
          // authored unrotated, so they're rotated by the entity's facing here, the
          // same way the narrowphase does. Drawing them unrotated would show a hitbox
          // sitting still under a sprite that's visibly spinning.
          const c = Math.cos(e.angle), s = Math.sin(e.angle);
          const pts = [];
          for (let k = 0; k < col.verts.length; k++) {
            const lx = col.verts[k].x, ly = col.verts[k].y;
            pts.push(e.x + lx * c - ly * s, e.y + lx * s + ly * c); // local→world
          }
          g.poly(pts);
          g.stroke({ color: RED, width: 2 });
        } else {
          g.circle(e.x, e.y, e.collisionRadius);
          g.stroke({ color: RED, width: 2 });
        }
      }

      // Broadphase bounds (blue) — the AABB (center ± collisionRadius) the grid
      // indexes the entity by and collision queries against.
      if (this.showBounds) {
        const r = e.collisionRadius;
        g.rect(e.x - r, e.y - r, r * 2, r * 2);
        g.stroke({ color: BLUE, width: 1, alpha: 0.5 });
      }
    }
  }

  /** Toggle the whole overlay. */
  toggle() {
    this.enabled = !this.enabled;
  }

  /** Remove the overlay graphics. */
  destroy() {
    this.g.destroy();
  }
}

/**
 * Build the on-screen toggle button (fixed top-left), wired to `debug.enabled`.
 * Returns a `refresh()` that re-syncs its label to the current state (so the key
 * shortcut and the click stay in agreement). @private
 */
function makeToggleButton(debug) {
  const btn = document.createElement("button");
  Object.assign(btn.style, {
    position: "fixed",
    top: "8px",
    left: "8px",
    zIndex: "1000",
    font: "12px monospace",
    padding: "4px 8px",
    cursor: "pointer",
    background: "#222",
    color: "#fff",
    border: "1px solid #555",
    borderRadius: "4px",
    userSelect: "none",
  });
  const refresh = () => {
    btn.textContent = `Debug: ${debug.enabled ? "ON" : "OFF"}`;
    btn.style.opacity = debug.enabled ? "1" : "0.6";
  };
  btn.addEventListener("click", () => {
    debug.toggle();
    refresh();
  });
  document.body.appendChild(btn);
  refresh();
  return refresh;
}

/**
 * Attach the debug overlay to `view`: draws collision shapes / ranges, adds a
 * clickable on/off button (top-left) AND a key shortcut, and WRAPS `view.draw`
 * so the overlay redraws every frame with whatever the view found visible — the
 * caller's render loop needs no debug code at all (remove this call → gone).
 *
 * @param {Object} view The ViewSubsystem (exposes `.world` and `.draw`).
 * @param {Object} [opts]
 * @param {string} [opts.toggleKey="KeyO"] `KeyboardEvent.code` that toggles it.
 * @returns {DebugDraw} the overlay instance (e.g. to flip `showBounds`, etc.).
 */
export function attachDebugOverlay(view, { toggleKey = "KeyO" } = {}) {
  const debug = new DebugDraw(view.world);
  const refresh = makeToggleButton(debug);

  addEventListener("keydown", (e) => {
    if (e.code === toggleKey) {
      debug.toggle();
      refresh(); // keep the button label in sync with the key
    }
  });

  // Wrap view.draw: run the real draw, then paint the overlay over its result
  // (the visible-entity list it returns). The render loop stays unaware of it.
  const draw = view.draw.bind(view);
  view.draw = (grid, camera, alpha) => {
    const visible = draw(grid, camera, alpha);
    debug.draw(visible);
    return visible;
  };

  return debug;
}
