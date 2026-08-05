// Hud — a tag-aware container for screen-space UI. A normal `PIXI.Container` (so it
// adds to the stage / `view.ui` layer and tears down like any display object), plus
// a tiny TAG registry on top: every child can carry one or more string tags, and you
// can show/hide or list a whole tag group at once.
//
//   const hud = makeHud();
//   hud.add(bar, "health");            // tagged child
//   hud.add(icon, "buffs", "combat");  // a child can have several tags
//   hud.tag("buffs").hide();           // flip every "buffs" element off
//   hud.tag("buffs").show();           // …and back on
//   hud.listOf("buffs");               // → [icon, …] (all nodes with that tag)
//
// Built as a FACTORY that augments a container (like `healthBar`) rather than a
// `class extends PIXI.Container`, so `PIXI` is only referenced when called — never at
// module-eval time — keeping the headless engine/tests free of a PIXI dependency.

/**
 * Reserved tag with special behavior: a node carrying `"temporary"` is REMOVED (and
 * destroyed) the moment it becomes hidden through the HUD (`tag(x).hide()`,
 * `setTagVisible`, `toggle`). For transient UI — a notification, a popup — that
 * should clean itself up instead of lingering hidden. Tag it `temporary` alongside
 * whatever group controls it: `hud.add(toast, "Active", TEMP_TAG)` → when "Active"
 * is hidden (e.g. on pause), the toast is torn down rather than just hidden.
 */
export const TEMP_TAG = "temporary";

/**
 * Make a tag-aware HUD container.
 * @returns {any} A `PIXI.Container` with the tag API: `add`, `tagNode`, `remove`,
 *   `listOf`, `setTagVisible`, `tag(name)` (a group handle), the `temporary`
 *   auto-remove-on-hide behavior (see {@link TEMP_TAG}), and world-dependence:
 *   `add` enrolls nodes as world-dependent (chain `.noWorldDependency()` to opt out),
 *   `clearWorldDependent()` tears them down on a world change.
 */
export function makeHud() {
  const hud = new PIXI.Container();
  hud.sortableChildren = true; // order HUD pieces by zIndex

  /** tag name → Set of tagged display objects. @private */
  const tags = new Map();

  /** Nodes that belong to the CURRENT world — flat set, removed + destroyed by
   * `clearWorldDependent()` (called on a world change). Every `add` enrolls the node
   * here BY DEFAULT; opt a node out (a persistent HUD piece — health bar, pause menu)
   * with the `.noWorldDependency()` method `add` attaches to it. @private */
  const worldDependent = new Set();

  /** Record `node` under `name` (and back-reference the tag on the node). @private */
  function addTag(node, name) {
    let set = tags.get(name);
    if (set === undefined) { set = new Set(); tags.set(name, set); }
    set.add(node);
    (node._hudTags || (node._hudTags = new Set())).add(name);
  }

  /**
   * Add a display object to the HUD, with zero or more tags. Enrolled as
   * world-dependent by default — chain `.noWorldDependency()` on the returned node to
   * keep it across world changes (a persistent HUD piece). Returns the node.
   * @param {any} node A PIXI display object. @param {...string} names
   */
  hud.add = (node, ...names) => {
    hud.addChild(node);
    for (const n of names) addTag(node, n);
    worldDependent.add(node); // default: tied to the current world
    /** Opt this node OUT of world-dependence (persists across world changes). Chainable. */
    node.noWorldDependency = () => { worldDependent.delete(node); return node; };
    return node;
  };

  /** Attach more tags to an already-added node. @param {any} node @param {...string} names */
  hud.tagNode = (node, ...names) => {
    for (const n of names) addTag(node, n);
    return node;
  };

  /**
   * Remove a node from the HUD and every tag group it was in. Does NOT destroy it —
   * the caller owns its lifecycle (call `node.destroy()` if done).
   * @param {any} node
   */
  hud.remove = (node) => {
    if (node._hudTags) {
      for (const n of node._hudTags) tags.get(n)?.delete(node);
      node._hudTags.clear();
    }
    worldDependent.delete(node);
    if (node.parent === hud) hud.removeChild(node);
    return node;
  };

  /** Remove + destroy every world-dependent node. Call when the player's world
   * changes so per-world HUD doesn't bleed into the next world; nodes opted out via
   * `.noWorldDependency()` are kept. */
  hud.clearWorldDependent = () => {
    for (const node of [...worldDependent]) {
      hud.remove(node); // also drops it from worldDependent + its tag groups
      if (typeof node.destroy === "function") node.destroy({ children: true });
    }
  };

  /** Every node carrying `name` (a fresh array; empty if none). @param {string} name */
  hud.listOf = (name) => {
    const set = tags.get(name);
    return set ? [...set] : [];
  };

  /** Set a node's visibility — and if it's being HIDDEN and carries {@link TEMP_TAG},
   * remove + destroy it instead of leaving it parked invisible. @private */
  function setVisible(node, visible) {
    node.visible = visible;
    if (!visible && node._hudTags && node._hudTags.has(TEMP_TAG)) {
      hud.remove(node);
      if (typeof node.destroy === "function") node.destroy({ children: true });
    }
  }

  /** Set `.visible` on every node carrying `name`. @param {string} name @param {boolean} visible */
  hud.setTagVisible = (name, visible) => {
    const set = tags.get(name);
    if (set) for (const n of [...set]) setVisible(n, visible); // copy: setVisible may mutate the set
  };

  /**
   * A handle for one tag group — flip or list everything carrying `name`.
   * `hud.tag("buffs").hide()`, `.show()`, `.toggle()`, `.list()`, `.add(node)`.
   * Cheap to make on demand (it just closes over `name`), so you don't need to keep it.
   * @param {string} name
   */
  hud.tag = (name) => ({
    name,
    show: () => hud.setTagVisible(name, true),
    hide: () => hud.setTagVisible(name, false),
    toggle: () => { const s = tags.get(name); if (s) for (const n of [...s]) setVisible(n, !n.visible); },
    list: () => hud.listOf(name),
    add: (node) => hud.add(node, name),
  });

  return hud;
}
