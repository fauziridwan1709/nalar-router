/**
 * Cursor-following smoke trail (WebGL2). Ported unchanged from the stackbyte website's NightHero
 * (`src/components/SparkTrail.tsx`), apart from the dev-mode check, which is Vite's here.
 */
import { useEffect, useRef } from "react";

export interface SparkTrailOptions {
  /** Hex colour mixed half-and-half into the direction hue of the trail. */
  tint?: string;
}

const DEFAULT_TINT = "#f50032";
/** The trail decays per frame, so the look depends on a fixed frame rate. */
const FRAME_MS = 1000 / 60;
/** Frames after the first pointer move during which no stroke is drawn, so the trail never streaks in from a stale position. */
const WARMUP_FRAMES = 6;
/** Still frames after which the trail has faded to black and the loop can sleep. */
const IDLE_FRAMES = 150;
const FLOW_SPEED = 9;

const VERTEX = `#version 300 es
in vec2 aPosition;
out vec2 vTextureCoord;
void main() {
  vTextureCoord = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const COLOR = `
vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-10;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec2 angleToDir(float angle) {
  float rad = angle * 2.0 * PI;
  return vec2(cos(rad), sin(rad));
}
mat2 rot(float a) {
  return mat2(cos(a), -sin(a), sin(a), cos(a));
}`;

/**
 * Advances the trail one frame: the previous frame is advected along its own
 * direction (stored as hue), blurred and faded, then the pointer segment since
 * the last frame is stamped in with a hue that encodes its direction.
 */
const TRAIL = `#version 300 es
precision highp float;
in vec2 vTextureCoord;
uniform sampler2D uTrail;
uniform vec2 uPreviousMousePos;
uniform vec2 uMousePos;
uniform vec2 uResolution;
out vec4 fragColor;
const float PI = 3.1415926;
const float TWOPI = 6.2831852;
${COLOR}

vec2 liquify(vec2 st) {
  float aspectRatio = uResolution.x / uResolution.y;
  st.x *= aspectRatio;
  for (float i = 1.0; i <= 5.0; i++) {
    st = st * rot(i / 5.0 * PI * 2.0);
    st += vec2(0.0025 * cos(i * 6.0 * st.y), 0.0025 * sin(i * 6.0 * st.x));
  }
  st.x /= aspectRatio;
  return st;
}

vec3 segment(vec2 mousePos, vec2 prevMousePos, vec2 correctedUv, float aspectRatio, float radius) {
  vec2 dir = (mousePos - prevMousePos) * vec2(aspectRatio, 1.0);
  float angle = atan(dir.y, dir.x);
  if (angle < 0.0) angle += TWOPI;
  vec2 mouseVec = mousePos - prevMousePos;
  float mouseLen = length(mouseVec);
  vec2 mouseDir = mouseLen > 0.0 ? mouseVec / mouseLen : vec2(0.0);
  vec2 posToUv = (correctedUv - prevMousePos) * vec2(aspectRatio, 1.0);
  float projection = clamp(dot(posToUv, mouseDir * vec2(aspectRatio, 1.0)), 0.0, mouseLen * aspectRatio);
  vec2 closestPoint = prevMousePos * vec2(aspectRatio, 1.0) + mouseDir * vec2(aspectRatio, 1.0) * projection;
  float distanceToLine = distance(correctedUv, closestPoint);
  float s = (1.0 + radius) / (distanceToLine + radius) * radius;
  vec3 pointColor = pow(hsv2rgb(vec3(angle / TWOPI, 1.0, 1.0)), vec3(2.2));
  return pointColor * pow(s, 6.0);
}

void main() {
  float aspectRatio = uResolution.x / uResolution.y;
  vec2 uv = vTextureCoord;
  vec2 correctedUv = uv * vec2(aspectRatio, 1.0);
  vec3 lastFrameColor = texture(uTrail, uv).rgb;
  vec2 prevDir = angleToDir(rgb2hsv(lastFrameColor).x);
  float prevStrength = rgb2hsv(pow(lastFrameColor, vec3(2.2))).z;
  float dist = length((uMousePos - uPreviousMousePos) * vec2(aspectRatio, 1.0));

  uv = uv - prevDir * 0.03 * prevStrength;
  uv = mix(uv, liquify(uv - prevDir * 0.005), (1.0 - prevStrength) * 0.25);
  lastFrameColor = pow(texture(uTrail, uv).rgb, vec3(2.2));

  int numPoints = int(max(12.0, dist * 24.0));
  float radius = mix(0.1, 0.7, 0.528 * clamp(dist, 0.7, 1.3));
  vec3 trailColor = vec3(0.0);
  int iter = min(numPoints, 24);
  for (int i = 0; i <= iter; i++) {
    vec2 interpPos = mix(uPreviousMousePos, uMousePos, float(i) / float(numPoints));
    vec2 prevInterpPos = i > 0 ? mix(uPreviousMousePos, uMousePos, float(i - 1) / float(numPoints)) : uPreviousMousePos;
    trailColor += segment(interpPos, prevInterpPos, correctedUv, aspectRatio, radius);
  }
  trailColor /= float(min(numPoints, 50) + 1);

  float blurRadius = 0.005;
  vec3 blurred = lastFrameColor * 0.2;
  blurred += pow(texture(uTrail, uv + vec2(blurRadius, 0.0)).rgb, vec3(2.2)) * 0.2;
  blurred += pow(texture(uTrail, uv + vec2(-blurRadius, 0.0)).rgb, vec3(2.2)) * 0.2;
  blurred += pow(texture(uTrail, uv + vec2(0.0, blurRadius)).rgb, vec3(2.2)) * 0.2;
  blurred += pow(texture(uTrail, uv + vec2(0.0, -blurRadius)).rgb, vec3(2.2)) * 0.2;

  vec3 draw = mix(blurred, trailColor, clamp(length(trailColor) * dist, 0.0, 1.0));
  draw *= pow(0.5, 0.2);
  fragColor = vec4(pow(draw, vec3(1.0 / 2.2)), 1.0);
}`;

/**
 * Turns the trail into light and warps it with drifting fbm noise, which is
 * what makes the stroke read as smoke. Output is premultiplied so the canvas
 * adds light to whatever is behind it.
 */
const FLOW = `#version 300 es
precision highp float;
in vec2 vTextureCoord;
uniform sampler2D uTrail;
uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uTint;
out vec4 fragColor;
const float PI = 3.14159265359;
${COLOR}

vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.11369, 0.13787));
  p3 += dot(p3, p3.yxz + 19.19);
  return -1.0 + 2.0 * fract(vec3((p3.x + p3.y) * p3.z, (p3.x + p3.z) * p3.y, (p3.y + p3.z) * p3.x));
}
float perlin(vec3 p) {
  vec3 pi = floor(p);
  vec3 pf = p - pi;
  vec3 w = pf * pf * (3.0 - 2.0 * pf);
  float n000 = dot(pf - vec3(0.0, 0.0, 0.0), hash33(pi + vec3(0.0, 0.0, 0.0)));
  float n100 = dot(pf - vec3(1.0, 0.0, 0.0), hash33(pi + vec3(1.0, 0.0, 0.0)));
  float n010 = dot(pf - vec3(0.0, 1.0, 0.0), hash33(pi + vec3(0.0, 1.0, 0.0)));
  float n110 = dot(pf - vec3(1.0, 1.0, 0.0), hash33(pi + vec3(1.0, 1.0, 0.0)));
  float n001 = dot(pf - vec3(0.0, 0.0, 1.0), hash33(pi + vec3(0.0, 0.0, 1.0)));
  float n101 = dot(pf - vec3(1.0, 0.0, 1.0), hash33(pi + vec3(1.0, 0.0, 1.0)));
  float n011 = dot(pf - vec3(0.0, 1.0, 1.0), hash33(pi + vec3(0.0, 1.0, 1.0)));
  float n111 = dot(pf - vec3(1.0, 1.0, 1.0), hash33(pi + vec3(1.0, 1.0, 1.0)));
  return mix(
    mix(mix(n000, n100, w.x), mix(n010, n110, w.x), w.y),
    mix(mix(n001, n101, w.x), mix(n011, n111, w.x), w.y),
    w.z
  );
}
mat2 rotHalf = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
float fbm(vec3 st) {
  float value = 0.0;
  float amp = 0.25;
  for (int i = 0; i < 6; i++) {
    value += amp * perlin(st);
    st.xy *= rotHalf * 2.5;
    st.xy += vec2(100.0);
    amp *= 0.594;
  }
  return value;
}

uvec2 pcg2d(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.y * 1664525u + 1013904223u;
  v.y += v.x * v.x * 1664525u + 1013904223u;
  v ^= v >> 16;
  v.x += v.y * v.y * 1664525u + 1013904223u;
  v.y += v.x * v.x * 1664525u + 1013904223u;
  return v;
}
float randFibo(vec2 p) {
  uvec2 v = pcg2d(floatBitsToUint(p));
  return float(v.x ^ v.y) / float(0xffffffffu);
}

void main() {
  vec2 uv = vTextureCoord;
  float aspectRatio = uResolution.x / uResolution.y;
  float multiplier = 6.0 * (0.15 / ((aspectRatio + 1.0) / 2.0));
  vec2 st = (uv - vec2(0.5685640362225097, 0.6510996119016818)) * vec2(aspectRatio, 1.0) * multiplier * aspectRatio;
  st = rot(0.135 * -2.0 * PI) * st;
  vec2 drift = vec2(uTime * 0.005) * 1.44;
  float time = uTime * 0.025;
  vec2 r = vec2(
    fbm(vec3(st - drift + vec2(1.7, 9.2), time)),
    fbm(vec3(st - drift + vec2(8.2, 1.3), time))
  );
  float f = fbm(vec3(st + r - drift, time)) * 0.31;

  vec3 trail = texture(uTrail, uv + f * 2.0 + r * 0.31).rgb;
  float strength = rgb2hsv(trail).z;
  vec3 color = strength * 2.5 * mix(trail, uTint, 0.5);
  float dither = (randFibo(gl_FragCoord.xy) - 0.5) / 255.0;
  vec3 light = clamp((color + dither) * strength, 0.0, 1.0);
  fragColor = vec4(light, max(light.r, max(light.g, light.b)));
}`;

function hexToRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function compile(gl: WebGL2RenderingContext, fragment: string): WebGLProgram | null {
  const program = gl.createProgram();
  const stages: [number, string][] = [
    [gl.VERTEX_SHADER, VERTEX],
    [gl.FRAGMENT_SHADER, fragment],
  ];
  for (const [type, source] of stages) {
    const shader = gl.createShader(type);
    if (!shader) return null;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.bindAttribLocation(program, 0, "aPosition");
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    if (import.meta.env.DEV) console.warn("SparkTrail:", gl.getProgramInfoLog(program));
    return null;
  }
  return program;
}

/**
 * Smoky light trail behind the pointer, ported from the Unicorn Studio
 * "mouse draw" and "flow" layers on onlook.com. Drives `canvas` until the
 * returned cleanup runs. The canvas should fill a positioned parent; it is
 * sized to its CSS box at one pixel per CSS pixel, like the original.
 */
export function mountSparkTrail(canvas: HTMLCanvasElement, { tint = DEFAULT_TINT }: SparkTrailOptions = {}): () => void {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false });
  if (!gl) return () => {};
  const halfFloat = !!gl.getExtension("EXT_color_buffer_float");
  const trailProgram = compile(gl, TRAIL);
  const flowProgram = compile(gl, FLOW);
  if (!trailProgram || !flowProgram) return () => {};

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.disable(gl.BLEND);

  const trailUniform = (name: string) => gl.getUniformLocation(trailProgram, name);
  const flowUniform = (name: string) => gl.getUniformLocation(flowProgram, name);
  const u = {
    trailResolution: trailUniform("uResolution"),
    mouse: trailUniform("uMousePos"),
    previousMouse: trailUniform("uPreviousMousePos"),
    flowResolution: flowUniform("uResolution"),
    time: flowUniform("uTime"),
    tint: flowUniform("uTint"),
  };
  gl.useProgram(flowProgram);
  gl.uniform3fv(u.tint, hexToRgb(tint));

  const targets = [0, 1].map(() => ({ texture: gl.createTexture(), framebuffer: gl.createFramebuffer() }));
  let read = 0;
  let width = 0;
  let height = 0;

  const allocate = () => {
    for (const { texture, framebuffer } of targets) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      if (halfFloat) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };

  const start = performance.now();
  let pointerX = 0;
  let pointerY = 0;
  let moved = false;
  let mouseX = 0.5;
  let mouseY = 0.5;
  let ticks = 0;
  let still = 0;
  let raf = 0;
  let lastFrame = -Infinity;
  let onScreen = true;

  const render = (now: number) => {
    const rect = canvas.getBoundingClientRect();
    const previousX = ticks >= WARMUP_FRAMES ? mouseX : (pointerX - rect.left) / rect.width;
    const previousY = ticks >= WARMUP_FRAMES ? mouseY : 1 - (pointerY - rect.top) / rect.height;
    mouseX = (pointerX - rect.left) / rect.width;
    mouseY = 1 - (pointerY - rect.top) / rect.height;
    ticks++;
    still = previousX === mouseX && previousY === mouseY ? still + 1 : 0;

    const write = 1 - read;
    gl.useProgram(trailProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, targets[write].framebuffer);
    gl.viewport(0, 0, width, height);
    gl.bindTexture(gl.TEXTURE_2D, targets[read].texture);
    gl.uniform2f(u.trailResolution, width, height);
    gl.uniform2f(u.mouse, mouseX, mouseY);
    gl.uniform2f(u.previousMouse, previousX, previousY);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    read = write;

    gl.useProgram(flowProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.bindTexture(gl.TEXTURE_2D, targets[read].texture);
    gl.uniform2f(u.flowResolution, width, height);
    gl.uniform1f(u.time, ((now - start) / 1000) * FLOW_SPEED);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const frame = (now: number) => {
    raf = 0;
    if (!onScreen || !width || !height) return;
    const elapsed = now - lastFrame;
    if (elapsed >= FRAME_MS - 1) {
      lastFrame = elapsed > FRAME_MS * 3 ? now : lastFrame + FRAME_MS;
      render(now);
      if (still > IDLE_FRAMES) return;
    }
    raf = requestAnimationFrame(frame);
  };

  const wake = () => {
    if (!raf && moved && onScreen) raf = requestAnimationFrame(frame);
  };

  const onMove = (event: PointerEvent) => {
    if (event.pointerType === "touch") return;
    pointerX = event.clientX;
    pointerY = event.clientY;
    moved = true;
    still = 0;
    wake();
  };

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, Math.round(rect.width));
    const nextHeight = Math.max(1, Math.round(rect.height));
    if (nextWidth === width && nextHeight === height) return;
    width = canvas.width = nextWidth;
    height = canvas.height = nextHeight;
    allocate();
    wake();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas);
  resize();

  const intersection = new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    wake();
  });
  intersection.observe(canvas);
  window.addEventListener("pointermove", onMove, { passive: true });

  return () => {
    window.removeEventListener("pointermove", onMove);
    intersection.disconnect();
    resizeObserver.disconnect();
    cancelAnimationFrame(raf);
    for (const { texture, framebuffer } of targets) {
      gl.deleteTexture(texture);
      gl.deleteFramebuffer(framebuffer);
    }
    gl.deleteBuffer(quad);
    gl.deleteProgram(trailProgram);
    gl.deleteProgram(flowProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.clear(gl.COLOR_BUFFER_BIT);
  };
}

/**
 * The pointer trail for a dark hero. Off for touch-only devices and
 * reduced-motion users, and idle while the pointer is still or the hero is
 * off screen.
 */
export default function SparkTrail({ tint, className = "" }: SparkTrailOptions & { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    let unmount: (() => void) | null = null;

    const sync = () => {
      const enabled = !reduced.matches && finePointer.matches;
      if (enabled && !unmount) unmount = mountSparkTrail(canvas, { tint });
      if (!enabled && unmount) {
        unmount();
        unmount = null;
      }
    };
    sync();
    reduced.addEventListener("change", sync);
    finePointer.addEventListener("change", sync);
    return () => {
      reduced.removeEventListener("change", sync);
      finePointer.removeEventListener("change", sync);
      unmount?.();
    };
  }, [tint]);

  return <canvas ref={ref} aria-hidden="true" className={`spark-trail ${className}`} />;
}
