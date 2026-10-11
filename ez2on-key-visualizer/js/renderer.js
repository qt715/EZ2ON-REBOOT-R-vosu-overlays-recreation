// Instanced rectangle renderer: one draw call per frame for every note, hold body and press.
// WebGPU when available, WebGL2 otherwise. Rectangles are written in canvas pixels.

export const STYLE_NOTE = 0;
export const STYLE_HOLD_BODY = 1;
export const STYLE_PRESS = 2;

const FLOATS_PER_INSTANCE = 12; // rect(4) colour(4) style, outline, 0, 0
const BYTES_PER_INSTANCE = FLOATS_PER_INSTANCE * 4;
const UNIFORM_FLOATS = 8; // viewport(2) nowY, travel, fadeStart, fadeEnabled, 0, 0

const WGSL = /* wgsl */ `
struct Uniforms {
  viewport: vec2f,
  nowY: f32,
  travel: f32,
  fadeStart: f32,
  fadeEnabled: f32,
  pad: vec2f,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VsOut {
  @builtin(position) position: vec4f,
  @location(0) local: vec2f,
  @location(1) color: vec4f,
  @location(2) @interpolate(flat) style: vec2f,
  @location(3) size: vec2f,
  @location(4) pixelY: f32,
};

@vertex
fn vs(@builtin(vertex_index) index: u32,
      @location(0) rect: vec4f, @location(1) color: vec4f, @location(2) style: vec4f) -> VsOut {
  let corner = vec2f(f32(index & 1u), f32(index >> 1u));
  let pixel = rect.xy + corner * rect.zw;
  var out: VsOut;
  out.position = vec4f(pixel.x / u.viewport.x * 2.0 - 1.0, 1.0 - pixel.y / u.viewport.y * 2.0, 0.0, 1.0);
  out.local = corner * rect.zw;
  out.color = color;
  out.style = style.xy;
  out.size = rect.zw;
  out.pixelY = pixel.y;
  return out;
}

@fragment
fn fs(in: VsOut) -> @location(0) vec4f {
  let style = in.style.x;
  let v = clamp(in.local.y / max(in.size.y, 1.0), 0.0, 1.0);
  var rgb = in.color.rgb;
  var alpha = in.color.a;
  if (style < 0.5) {
    // EZ2ON bar note: bright upper half melting into the lane colour, lit bottom edge.
    let upper = mix(rgb, vec3f(1.0), 0.62);
    rgb = mix(upper, rgb, smoothstep(0.3, 0.7, v));
    let edge = 1.0 - smoothstep(0.0, 2.0, in.size.y - in.local.y);
    rgb = mix(rgb, vec3f(1.0), edge * 0.55);
  } else if (style < 1.5) {
    // Long note body: translucent, darker at the sides.
    let x = abs(in.local.x / max(in.size.x, 1.0) - 0.5) * 2.0;
    rgb = mix(rgb, vec3f(1.0), 0.15) * (1.0 - 0.22 * x * x);
    alpha = alpha * 0.8;
  } else {
    // Press: outline plus a faint fill.
    let border = in.style.y;
    let dx = min(in.local.x, in.size.x - in.local.x);
    let dy = min(in.local.y, in.size.y - in.local.y);
    let outline = 1.0 - step(border, min(dx, dy));
    alpha = alpha * mix(0.14, 1.0, outline);
  }
  if (u.fadeEnabled > 0.5) {
    let d = clamp(abs(in.pixelY - u.nowY) / max(u.travel, 1.0), 0.0, 1.0);
    alpha = alpha * (1.0 - smoothstep(u.fadeStart, 1.0, d));
  }
  return vec4f(rgb * alpha, alpha);
}
`;

const GLSL_VS = `#version 300 es
layout(location = 0) in vec4 rect;
layout(location = 1) in vec4 color;
layout(location = 2) in vec4 style;
uniform vec2 viewport;
out vec2 vLocal;
out vec4 vColor;
flat out vec2 vStyle;
out vec2 vSize;
out float vPixelY;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 pixel = rect.xy + corner * rect.zw;
  gl_Position = vec4(pixel.x / viewport.x * 2.0 - 1.0, 1.0 - pixel.y / viewport.y * 2.0, 0.0, 1.0);
  vLocal = corner * rect.zw;
  vColor = color;
  vStyle = style.xy;
  vSize = rect.zw;
  vPixelY = pixel.y;
}`;

const GLSL_FS = `#version 300 es
precision highp float;
uniform float nowY;
uniform float travel;
uniform float fadeStart;
uniform float fadeEnabled;
in vec2 vLocal;
in vec4 vColor;
flat in vec2 vStyle;
in vec2 vSize;
in float vPixelY;
out vec4 outColor;
void main() {
  float style = vStyle.x;
  float v = clamp(vLocal.y / max(vSize.y, 1.0), 0.0, 1.0);
  vec3 rgb = vColor.rgb;
  float alpha = vColor.a;
  if (style < 0.5) {
    vec3 upper = mix(rgb, vec3(1.0), 0.62);
    rgb = mix(upper, rgb, smoothstep(0.3, 0.7, v));
    float edge = 1.0 - smoothstep(0.0, 2.0, vSize.y - vLocal.y);
    rgb = mix(rgb, vec3(1.0), edge * 0.55);
  } else if (style < 1.5) {
    float x = abs(vLocal.x / max(vSize.x, 1.0) - 0.5) * 2.0;
    rgb = mix(rgb, vec3(1.0), 0.15) * (1.0 - 0.22 * x * x);
    alpha *= 0.8;
  } else {
    float border = vStyle.y;
    float dx = min(vLocal.x, vSize.x - vLocal.x);
    float dy = min(vLocal.y, vSize.y - vLocal.y);
    float outline = 1.0 - step(border, min(dx, dy));
    alpha *= mix(0.14, 1.0, outline);
  }
  if (fadeEnabled > 0.5) {
    float d = clamp(abs(vPixelY - nowY) / max(travel, 1.0), 0.0, 1.0);
    alpha *= 1.0 - smoothstep(fadeStart, 1.0, d);
  }
  outColor = vec4(rgb * alpha, alpha);
}`;

/** CPU-side instance list shared by both backends. */
export class InstanceBatch {
  constructor(capacity = 2048) {
    this.data = new Float32Array(capacity * FLOATS_PER_INSTANCE);
    this.count = 0;
  }

  get capacity() {
    return this.data.length / FLOATS_PER_INSTANCE;
  }

  reset() {
    this.count = 0;
  }

  push(x, y, w, h, color, style, outline = 0) {
    if (w <= 0 || h <= 0) return;
    if (this.count === this.capacity) {
      // Growth happens only when a frame needs more rectangles than ever before.
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const o = this.count * FLOATS_PER_INSTANCE;
    const d = this.data;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = w;
    d[o + 3] = h;
    d[o + 4] = color[0];
    d[o + 5] = color[1];
    d[o + 6] = color[2];
    d[o + 7] = color[3];
    d[o + 8] = style;
    d[o + 9] = outline;
    this.count++;
  }
}

class WebGpuBackend {
  static async create(canvas) {
    if (!navigator.gpu) return null;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
    if (!adapter) return null;
    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    if (!context) return null;
    return new WebGpuBackend(device, context);
  }

  constructor(device, context) {
    this.name = "webgpu";
    this.device = device;
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    context.configure({ device, format: this.format, alphaMode: "premultiplied" });
    const module = device.createShaderModule({ code: WGSL });
    this.pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module,
        entryPoint: "vs",
        buffers: [
          {
            arrayStride: BYTES_PER_INSTANCE,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x4" },
              { shaderLocation: 1, offset: 16, format: "float32x4" },
              { shaderLocation: 2, offset: 32, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: {
        module,
        entryPoint: "fs",
        targets: [
          {
            format: this.format,
            blend: {
              color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
              alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
            },
          },
        ],
      },
      primitive: { topology: "triangle-strip" },
    });
    this.uniforms = new Float32Array(UNIFORM_FLOATS);
    this.uniformBuffer = device.createBuffer({
      size: UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    this.instanceBuffer = null;
    this.instanceBytes = 0;
  }

  draw(batch, frame) {
    const { device } = this;
    const bytes = batch.count * BYTES_PER_INSTANCE;
    if (bytes > this.instanceBytes) {
      this.instanceBuffer?.destroy();
      this.instanceBytes = batch.data.byteLength;
      this.instanceBuffer = device.createBuffer({
        size: this.instanceBytes,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }
    const u = this.uniforms;
    u[0] = frame.width;
    u[1] = frame.height;
    u[2] = frame.nowY;
    u[3] = frame.travel;
    u[4] = frame.fadeStart;
    u[5] = frame.fade ? 1 : 0;
    device.queue.writeBuffer(this.uniformBuffer, 0, u);
    if (bytes > 0) device.queue.writeBuffer(this.instanceBuffer, 0, batch.data, 0, batch.count * FLOATS_PER_INSTANCE);

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    });
    if (bytes > 0) {
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.setVertexBuffer(0, this.instanceBuffer);
      pass.draw(4, batch.count);
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  destroy() {
    this.context.unconfigure();
    this.device.destroy();
  }
}

class WebGl2Backend {
  static create(canvas) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    });
    return gl ? new WebGl2Backend(gl) : null;
  }

  constructor(gl) {
    this.name = "webgl2";
    this.gl = gl;
    const program = gl.createProgram();
    for (const [type, source] of [
      [gl.VERTEX_SHADER, GLSL_VS],
      [gl.FRAGMENT_SHADER, GLSL_FS],
    ]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    this.program = program;
    this.locations = Object.fromEntries(
      ["viewport", "nowY", "travel", "fadeStart", "fadeEnabled"].map((name) => [
        name,
        gl.getUniformLocation(program, name),
      ]),
    );
    this.vao = gl.createVertexArray();
    this.buffer = gl.createBuffer();
    this.bufferBytes = 0;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    for (let location = 0; location < 3; location++) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, 4, gl.FLOAT, false, BYTES_PER_INSTANCE, location * 16);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  draw(batch, frame) {
    const { gl } = this;
    gl.viewport(0, 0, frame.width, frame.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (batch.count === 0) return;
    gl.useProgram(this.program);
    gl.uniform2f(this.locations.viewport, frame.width, frame.height);
    gl.uniform1f(this.locations.nowY, frame.nowY);
    gl.uniform1f(this.locations.travel, frame.travel);
    gl.uniform1f(this.locations.fadeStart, frame.fadeStart);
    gl.uniform1f(this.locations.fadeEnabled, frame.fade ? 1 : 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    if (batch.data.byteLength > this.bufferBytes) {
      this.bufferBytes = batch.data.byteLength;
      gl.bufferData(gl.ARRAY_BUFFER, this.bufferBytes, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, batch.data, 0, batch.count * FLOATS_PER_INSTANCE);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, batch.count);
    gl.bindVertexArray(null);
  }

  destroy() {
    this.gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/**
 * `preference` "webgpu" tries WebGPU first and falls back to WebGL2 when it is missing or fails to
 * initialise; "webgl2" goes straight to WebGL2. A canvas cannot switch context types, so the
 * fallback renders into a fresh canvas that replaces the original.
 */
export async function createBackend(canvas, preference = "webgl2") {
  if (preference === "webgpu") {
    try {
      const backend = await WebGpuBackend.create(canvas);
      if (backend) return { backend, canvas };
    } catch (error) {
      console.warn("WebGPU unavailable, using WebGL2", error);
    }
  }
  // A canvas that already holds another context type returns null here; retry on a fresh one.
  let target = canvas;
  let backend = WebGl2Backend.create(target);
  if (!backend) {
    target = canvas.cloneNode(false);
    canvas.replaceWith(target);
    backend = WebGl2Backend.create(target);
  }
  if (!backend) throw new Error("Neither WebGPU nor WebGL2 is available");
  return { backend, canvas: target };
}
