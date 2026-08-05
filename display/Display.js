import { ViewSubsystem } from "./ViewSubsystem.js";

/**
 * Central reference / coordinator for the game's visual subsystem.
 *
 * Other parts of the app talk to `VisualEngine` rather than reaching into the
 * individual `shaders/`, `geometry/`, `view/`, and `memory/` folders directly.
 * Each subsystem registers its public API here and `VisualEngine` exposes it
 * to the rest of the codebase as a single entry point.
 *
 * Usage (rough):
 *     VisualEngine.shared.view.present(scene)
 *
 * Subsystems live in their own folders; this file is intentionally lean — it
 * just wires them together.
 */
export class VisualEngine {
  constructor() {
    // Note: world state (the spatial grid) lives in GameEngine.memory now, not
    // here — the view receives the grid to draw from; it doesn't own it.
    // Circle/oval shapes are built by the view from each def's `visual` block
    // (via shaders/SdfShape.js); there's no separate geometry subsystem.

    /** PixiJS presentation layer. See `view/ViewSubsystem.js`. */
    this.view = new ViewSubsystem();
  }

  /**
   * Singleton instance — the canonical reference other files load.
   * @type {VisualEngine}
   */
  static get shared() {
    if (!VisualEngine._shared) {
      VisualEngine._shared = new VisualEngine();
    }
    return VisualEngine._shared;
  }
}
