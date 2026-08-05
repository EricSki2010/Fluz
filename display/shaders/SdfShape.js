// A reusable SDF (signed-distance-field) shape: an ellipse that fills a
// width×height box, drawn with a custom shader on a single quad. Because it's a
// distance field it's crisp at ANY size (no texture to blur), and one shader
// gives you circles (width === height), ovals, and — via the `smooth` feather —
// soft/glowy edges. Ideal for UI: loaders, pulses, auras (animate width/height).
//
// Returns a PIXI.Mesh. A handful of these is the intended use (effects/UI), so
// there's no batching — each Mesh carries its own uniforms.
//
// Pixi v8 note: this uses a custom Mesh shader. The app should be created with
// `preference: "webgl"` so only the GLSL program below is needed (no WGSL twin).

// One unit quad shared by every shape (centered on origin → the Mesh's x/y is
// the shape's CENTER). Scaled to width×height in the vertex shader via uSize.
let _quad = null;
function quadGeometry() {
  if (_quad) return _quad;
  _quad = new PIXI.Geometry({
    attributes: {
      aPosition: [-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5],
      aUV: [0, 0, 1, 0, 1, 1, 0, 1],
    },
    indexBuffer: [0, 1, 2, 0, 2, 3],
  });
  return _quad;
}

// Pixi injects uProjectionMatrix / uWorldTransformMatrix / uTransformMatrix for a
// Mesh. uSize scales the unit quad to the requested width/height.
const VERTEX = `#version 300 es
  // ES 3.00 needed for the `+"`uniform sdfUniforms { ... }`"+` block below — Pixi v8 only
  // binds a UniformGroup resource via a UBO, and UBOs require GLSL ES 3.00.
  in vec2 aPosition;
  in vec2 aUV;
  out vec2 vUV;

  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;

  // Custom uniforms MUST be a block named after the resource ("sdfUniforms");
  // Pixi v8 only binds loose globals for its own matrices, not user groups.
  // Member order must match the UniformGroup below (std140 layout).
  uniform sdfUniforms {
    vec4 uColor;
    vec2 uSize;
    float uSmooth;
  };

  void main() {
    vUV = aUV;
    vec2 pos = aPosition * uSize;
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(pos, 1.0)).xy, 0.0, 1.0);
  }
`;

// Ellipse SDF in normalized space: the unit circle in p∈[-1,1] maps to an oval
// filling the (non-square) quad. `uSmooth` feathers the edge inward; even at 0
// we keep ~1px screen-space AA via fwidth so it never looks jagged. Output is
// premultiplied alpha (what Pixi's default blend expects).
const FRAGMENT = `#version 300 es
  precision highp float; // ES 3.00 fragment needs an explicit float precision
  in vec2 vUV;
  out vec4 finalColor;

  uniform sampler2D uTexture; // samplers stay loose — can't live in a UBO

  // Same block as the vertex shader (must match the UniformGroup member order).
  uniform sdfUniforms {
    vec4 uColor;
    vec2 uSize;
    float uSmooth;
  };

  void main() {
    vec2 p = (vUV - 0.5) * 2.0;
    float d = length(p) - 1.0;            // <0 inside the ellipse
    // ~1px edge width in field units (2 units span the shorter side's pixels).
    // Derived from uSize instead of fwidth() so it compiles on WebGL1 too.
    float aa = 2.0 / max(min(uSize.x, uSize.y), 1.0);
    float feather = max(uSmooth, aa);     // user feather, never below ~1px AA
    float alpha = 1.0 - smoothstep(-feather, 0.0, d);

    vec4 col = texture(uTexture, vUV) * uColor;
    float a = col.a * alpha;
    finalColor = vec4(col.rgb * a, a);    // premultiplied
  }
`;

/**
 * Build an SDF ellipse mesh.
 *
 * @param {Object} opts
 * @param {number} opts.width   Shape width in world/pixel units. *(required)*
 * @param {number} opts.height  Shape height. Equal to width → a circle. *(required)*
 * @param {number|string} [opts.color=0xffffff] Fill/tint color (hex or CSS string).
 * @param {any} [opts.texture] Optional PIXI.Texture sampled across the shape
 *   (UV 0..1 over the box). Omit for a solid color.
 * @param {number} [opts.smooth=0] Edge feather as a PERCENT of the radius (0–100).
 *   `0` (default) = crisp edge (1px anti-aliased). `100` = feathers all the way to
 *   the center (a soft radial blob / glow).
 * @returns {any} A `PIXI.Mesh`. Also gets `setSize(w,h)`, `setColor(c)`,
 *   `setSmooth(pct)` helpers for cheap per-frame animation (e.g. pulsing ovals).
 */
export function sdfShape({ width = 100, height = 100, color = 0xffffff, texture, smooth = 0 } = {}) {
  const tex = texture ?? PIXI.Texture.WHITE;
  const rgba = new PIXI.Color(color).toArray(); // [r,g,b,a] 0..1
  if (rgba.length === 3) rgba.push(1);
  const feather = Math.max(0, Math.min(100, smooth)) / 100;

  // Member order MUST match the GLSL `sdfUniforms` block (std140 UBO layout):
  // vec4 first, then vec2, then float — avoids vec2→vec4 padding ambiguity.
  // `ubo: true` makes Pixi upload it as a real uniform BUFFER (matching the GLSL
  // `uniform sdfUniforms { ... }` block); without it Pixi tries to set loose
  // individual uniforms, which the block doesn't expose → values stay zero.
  const uniforms = new PIXI.UniformGroup(
    {
      uColor: { value: new Float32Array(rgba), type: "vec4<f32>" },
      uSize: { value: new Float32Array([width, height]), type: "vec2<f32>" },
      uSmooth: { value: feather, type: "f32" },
    },
    { ubo: true }
  );

  const shader = PIXI.Shader.from({
    gl: { vertex: VERTEX, fragment: FRAGMENT },
    resources: {
      uTexture: tex.source,
      uSampler: tex.source.style,
      sdfUniforms: uniforms,
    },
  });

  const mesh = new PIXI.Mesh({ geometry: quadGeometry(), shader });

  // Convenience setters for animation (e.g. ovals changing size). `update()` is
  // optional-chained — v8 re-uploads the group each frame, so mutating the value
  // is enough; the call just flags it dirty where supported.
  const u = uniforms.uniforms;
  mesh.setSize = (w, h) => { u.uSize[0] = w; u.uSize[1] = h; uniforms.update?.(); };
  mesh.setColor = (c) => {
    const a = new PIXI.Color(c).toArray();
    u.uColor[0] = a[0]; u.uColor[1] = a[1]; u.uColor[2] = a[2]; u.uColor[3] = a[3] ?? 1;
    uniforms.update?.();
  };
  mesh.setSmooth = (pct) => { u.uSmooth = Math.max(0, Math.min(100, pct)) / 100; uniforms.update?.(); };

  return mesh;
}
