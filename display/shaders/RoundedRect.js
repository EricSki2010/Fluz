// A reusable SDF rounded-rectangle: a width×height box whose corners are curved
// by a single `radius` PERCENT, drawn with a custom shader on one quad. Being a
// distance field it's crisp at ANY size (no texture to blur), and the corner
// radius is recomputed per-frame from the live size so it stays proportional as
// you animate the box.
//
// The `radius` percent is the corner radius as a fraction of the SHORTER side.
// The largest a corner can curve before the shape degenerates is HALF the short
// side, so **50% is the maximum** — at 50% a square becomes a full circle and a
// rectangle becomes a stadium (a half-circle capping each short end). Values
// above 50% are clamped to that maximum. 0% = sharp rectangle.
//
// Returns a PIXI.Mesh (a handful is the intended use — UI panels, buttons, bars,
// health-bar tracks — so there's no batching; each Mesh carries its own uniforms).
//
// Pixi v8 note: custom Mesh shader, GLSL ES 3.00 (WebGL2). The app is created with
// `preference: "webgl"`, so only this GLSL program is needed (no WGSL twin).

// One unit quad shared by every rounded-rect (centered on origin → the Mesh's x/y
// is the box CENTER). Scaled to width×height in the vertex shader via uSize.
// Mirrors SdfShape's quad; kept local so the two shaders stay independent.
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
  in vec2 aPosition;
  in vec2 aUV;
  out vec2 vUV;

  uniform mat3 uProjectionMatrix;
  uniform mat3 uWorldTransformMatrix;
  uniform mat3 uTransformMatrix;

  // Custom uniforms MUST be a block named after the resource ("rectUniforms");
  // Pixi v8 only binds loose globals for its own matrices, not user groups.
  // Member order must match the UniformGroup below (std140 layout).
  uniform rectUniforms {
    vec4 uColor;
    vec2 uSize;
    float uRadiusPct;
  };

  void main() {
    vUV = aUV;
    vec2 pos = aPosition * uSize;
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    gl_Position = vec4((mvp * vec3(pos, 1.0)).xy, 0.0, 1.0);
  }
`;

// Rounded-box SDF in PIXEL space: corner radius `r = uRadiusPct × shortSide`,
// clamped to HALF the short side (the max — 50% → circle/stadium). `fwidth`
// gives ~1px screen-space AA at any zoom. Output is premultiplied alpha.
const FRAGMENT = `#version 300 es
  precision highp float;
  in vec2 vUV;
  out vec4 finalColor;

  uniform sampler2D uTexture; // samplers stay loose — can't live in a UBO

  uniform rectUniforms {
    vec4 uColor;
    vec2 uSize;
    float uRadiusPct;
  };

  void main() {
    vec2 p = (vUV - 0.5) * uSize;          // centered, pixel units
    vec2 b = uSize * 0.5;                   // half extents
    float minSide = min(uSize.x, uSize.y);
    float r = min(uRadiusPct * minSide, minSide * 0.5); // ≤ half short side
    // Signed distance to a box shrunk by r, then re-inflated by r (rounds corners).
    vec2 q = abs(p) - b + r;
    float d = min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r; // <0 inside
    float aa = fwidth(d);                   // ~1px in screen space
    float alpha = 1.0 - smoothstep(-aa, aa, d);

    vec4 col = texture(uTexture, vUV) * uColor;
    float a = col.a * alpha;
    finalColor = vec4(col.rgb * a, a);      // premultiplied
  }
`;

/**
 * Build a rounded-rectangle SDF mesh.
 *
 * @param {Object} opts
 * @param {number} opts.width   Box width in world/pixel units. *(required)*
 * @param {number} opts.height  Box height. Equal to width + radius 50 → a circle.
 * @param {number} [opts.radius=50] Corner radius as a PERCENT of the shorter side.
 *   `0` = sharp corners; `50` = maximum (square → circle, rectangle → stadium);
 *   values above 50 are clamped to 50.
 * @param {number|string} [opts.color=0xffffff] Fill/tint color (hex or CSS string).
 * @param {any} [opts.texture] Optional PIXI.Texture sampled across the box
 *   (UV 0..1). Omit for a solid color.
 * @returns {any} A `PIXI.Mesh`, plus `setSize(w,h)`, `setColor(c)`,
 *   `setRadius(pct)` helpers for cheap per-frame animation.
 */
export function roundedRect({ width = 100, height = 100, radius = 50, color = 0xffffff, texture } = {}) {
  const tex = texture ?? PIXI.Texture.WHITE;
  const rgba = new PIXI.Color(color).toArray(); // [r,g,b,a] 0..1
  if (rgba.length === 3) rgba.push(1);
  const pct = Math.max(0, Math.min(100, radius)) / 100;

  // Member order MUST match the GLSL `rectUniforms` block (std140 UBO layout):
  // vec4, then vec2, then float. `ubo: true` uploads it as a real uniform BUFFER
  // matching the GLSL `uniform rectUniforms { ... }` block.
  const uniforms = new PIXI.UniformGroup(
    {
      uColor: { value: new Float32Array(rgba), type: "vec4<f32>" },
      uSize: { value: new Float32Array([width, height]), type: "vec2<f32>" },
      uRadiusPct: { value: pct, type: "f32" },
    },
    { ubo: true }
  );

  const shader = PIXI.Shader.from({
    gl: { vertex: VERTEX, fragment: FRAGMENT },
    resources: {
      uTexture: tex.source,
      uSampler: tex.source.style,
      rectUniforms: uniforms,
    },
  });

  const mesh = new PIXI.Mesh({ geometry: quadGeometry(), shader });

  const u = uniforms.uniforms;
  mesh.setSize = (w, h) => { u.uSize[0] = w; u.uSize[1] = h; uniforms.update?.(); };
  mesh.setColor = (c) => {
    const a = new PIXI.Color(c).toArray();
    u.uColor[0] = a[0]; u.uColor[1] = a[1]; u.uColor[2] = a[2]; u.uColor[3] = a[3] ?? 1;
    uniforms.update?.();
  };
  mesh.setRadius = (p) => { u.uRadiusPct = Math.max(0, Math.min(100, p)) / 100; uniforms.update?.(); };

  return mesh;
}
