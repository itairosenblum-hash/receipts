// חיתוך ויישור אוטומטי לצילומי מסמכים (Auto-crop & Deskew), בלי ספריות חיצוניות.
// אחרי צילום: מזהה את גבולות הדף, מציג עורך עם 4 פינות שאפשר לגרור,
// ומיישר את המסמך למלבן (תיקון פרספקטיבה והטיה).

const MAX_SRC = 2400;   // רזולוציית עבודה מקסימלית
const MAX_OUT = 2200;   // גודל מקסימלי לתמונה המיושרת
const DETECT = 360;     // רזולוציה לזיהוי

/* ---------- API ---------- */

// מעביר כל תמונה בעורך. קבצים שאינם תמונה עוברים כמו שהם. ביטול משמיט את הקובץ.
export async function cropCameraFiles(fileList) {
  const out = [];
  for (const file of [...fileList]) {
    if (!/^image\//.test(file.type || "") || file.type === "image/gif") { out.push(file); continue; }
    const res = await cropDocument(file);
    if (res) out.push(res);
  }
  return out;
}

// מחזיר File חדש (חתוך ומיושר), את הקובץ המקורי ("ללא חיתוך"), או null בביטול
export async function cropDocument(file) {
  let src;
  try {
    src = await loadCanvas(file);
  } catch (e) {
    console.warn("crop: cannot decode image, using original", e);
    return file;
  }
  return openEditor(src, file);
}

/* ---------- loading ---------- */

async function loadCanvas(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const s = Math.min(1, MAX_SRC / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

function rotateCanvas(c) { // 90° עם כיוון השעון
  const r = document.createElement("canvas");
  r.width = c.height; r.height = c.width;
  const ctx = r.getContext("2d");
  ctx.translate(r.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(c, 0, 0);
  return r;
}

/* ---------- detection ---------- */

// מחזיר { quad: [tl,tr,br,bl], confident } בקואורדינטות של התמונה, או null
export function detectDocument(canvas) {
  const s = Math.min(1, DETECT / Math.max(canvas.width, canvas.height));
  const w = Math.max(8, Math.round(canvas.width * s)), h = Math.max(8, Math.round(canvas.height * s));
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  const px = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;

  // "דמיון לנייר": בהיר ולא צבעוני
  let score = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const r = px[j], g = px[j + 1], b = px[j + 2];
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    score[i] = Math.max(0, gray - 0.6 * sat);
  }
  score = boxBlur(boxBlur(score, w, h, 2), w, h, 2);

  const t = otsu(score);
  const bright = new Uint8Array(n), dark = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const b = score[i] > t; bright[i] = b; dark[i] = !b; }

  const cands = [];
  for (const [mask, weight] of [[erode(bright, w, h), 1], [erode(dark, w, h), 0.75]]) {
    const best = largestComponent(mask, w, h);
    if (!best) continue;
    const frac = best.area / n;
    if (frac < 0.06 || frac > 0.97) continue;
    const touchPenalty = best.touches >= 4 ? 0.05 : best.touches === 3 ? 0.35 : 1;
    cands.push({ ...best, score: best.area * weight * touchPenalty });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.score - a.score);
  const comp = cands[0];

  // נקודות שפה של הרכיב → קמור → המרובע הגדול ביותר
  const pts = [];
  const { labels, id } = comp;
  for (let y = 0; y < h; y++) {
    let a = -1, b = -1;
    for (let x = 0; x < w; x++) if (labels[y * w + x] === id) { if (a < 0) a = x; b = x; }
    if (a >= 0) { pts.push([a, y]); if (b !== a) pts.push([b, y]); }
  }
  for (let x = 0; x < w; x++) {
    let a = -1, b = -1;
    for (let y = 0; y < h; y++) if (labels[y * w + x] === id) { if (a < 0) a = y; b = y; }
    if (a >= 0) { pts.push([x, a]); if (b !== a) pts.push([x, b]); }
  }
  const hull = convexHull(pts);
  if (hull.length < 4) return null;
  let quad = bestQuad(hull);
  if (!quad) return null;

  // פיצוי על הכרסום והחזרה לקנה המידה המקורי
  const cx = quad.reduce((a, p) => a + p[0], 0) / 4, cy = quad.reduce((a, p) => a + p[1], 0) / 4;
  quad = quad.map(([x, y]) => {
    const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy) || 1;
    return [clamp((x + dx / d * 1.5) / s, 0, canvas.width), clamp((y + dy / d * 1.5) / s, 0, canvas.height)];
  });

  const ratio = polyArea(quad) / (polyArea(hull) / (s * s));
  return { quad: orderQuad(quad), confident: ratio > 0.82 && ratio < 1.25 };
}

function boxBlur(a, w, h, r) {
  const tmp = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    let sum = 0, cnt = 0;
    for (let x = -r; x < w + r; x++) {
      if (x + r < w) { sum += a[y * w + x + r]; cnt++; }
      if (x - r - 1 >= 0) { sum -= a[y * w + x - r - 1]; cnt--; }
      if (x >= 0 && x < w) tmp[y * w + x] = sum / cnt;
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0, cnt = 0;
    for (let y = -r; y < h + r; y++) {
      if (y + r < h) { sum += tmp[(y + r) * w + x]; cnt++; }
      if (y - r - 1 >= 0) { sum -= tmp[(y - r - 1) * w + x]; cnt--; }
      if (y >= 0 && y < h) out[y * w + x] = sum / cnt;
    }
  }
  return out;
}

function otsu(a) {
  const hist = new Float64Array(256);
  for (let i = 0; i < a.length; i++) hist[Math.min(255, a[i] | 0)]++;
  let total = a.length, sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, best = 0, t = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; t = i; }
  }
  return t;
}

function erode(m, w, h) {
  const o = new Uint8Array(m.length);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    o[i] = m[i] && m[i - 1] && m[i + 1] && m[i - w] && m[i + w] && m[i - w - 1] && m[i - w + 1] && m[i + w - 1] && m[i + w + 1] ? 1 : 0;
  }
  return o;
}

function largestComponent(m, w, h) {
  const labels = new Int32Array(m.length);
  const stack = new Int32Array(m.length);
  let next = 0, best = null;
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || labels[s]) continue;
    const id = ++next;
    let sp = 0, area = 0, touches = 0;
    stack[sp++] = s; labels[s] = id;
    while (sp) {
      const i = stack[--sp]; area++;
      const x = i % w, y = (i - x) / w;
      if (x <= 2) touches |= 1; if (x >= w - 3) touches |= 2; if (y <= 2) touches |= 4; if (y >= h - 3) touches |= 8;
      if (x > 0 && m[i - 1] && !labels[i - 1]) { labels[i - 1] = id; stack[sp++] = i - 1; }
      if (x < w - 1 && m[i + 1] && !labels[i + 1]) { labels[i + 1] = id; stack[sp++] = i + 1; }
      if (y > 0 && m[i - w] && !labels[i - w]) { labels[i - w] = id; stack[sp++] = i - w; }
      if (y < h - 1 && m[i + w] && !labels[i + w]) { labels[i + w] = id; stack[sp++] = i + w; }
    }
    if (!best || area > best.area) best = { id, area, touchMask: touches };
  }
  if (!best) return null;
  const t = best.touchMask;
  return { labels, id: best.id, area: best.area, touches: (t & 1) + ((t >> 1) & 1) + ((t >> 2) & 1) + ((t >> 3) & 1) };
}

function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

// מחפש בכל זווית סיבוב את 4 נקודות הקיצון של הקמור ובוחר את המרובע בעל השטח הגדול ביותר
function bestQuad(hull) {
  let best = null, bestA = 0;
  for (let deg = 0; deg < 90; deg += 2) {
    const t = deg * Math.PI / 180;
    const dirs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
      const ux = Math.cos(t), uy = Math.sin(t);
      return [a * ux - b * uy, a * uy + b * ux];
    });
    const q = dirs.map(([dx, dy]) => {
      let bp = hull[0], bv = -Infinity;
      for (const p of hull) { const v = p[0] * dx + p[1] * dy; if (v > bv) { bv = v; bp = p; } }
      return bp;
    });
    const a = polyArea(orderQuad(q));
    if (a > bestA) { bestA = a; best = q; }
  }
  return best;
}

/* ---------- geometry ---------- */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function polyArea(p) {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
  return Math.abs(s) / 2;
}

// סדר: שמאל-עליון, ימין-עליון, ימין-תחתון, שמאל-תחתון
function orderQuad(q) {
  const cx = q.reduce((a, p) => a + p[0], 0) / 4, cy = q.reduce((a, p) => a + p[1], 0) / 4;
  const s = q.slice().sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let k = 0;
  for (let i = 1; i < 4; i++) if (s[i][0] + s[i][1] < s[k][0] + s[k][1]) k = i;
  return [...s.slice(k), ...s.slice(0, k)];
}

function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4], c = q[(i + 2) % 4];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cr) < 1e-6) return false;
    const sg = Math.sign(cr);
    if (sign && sg !== sign) return false;
    sign = sg;
  }
  return true;
}

function fullQuad(c, inset = 0) {
  const ix = c.width * inset, iy = c.height * inset;
  return [[ix, iy], [c.width - ix, iy], [c.width - ix, c.height - iy], [ix, c.height - iy]];
}

// מטריצת הומוגרפיה שממפה (u,v) במלבן היעד לנקודה בתמונת המקור
function homography(dst, src) {
  const A = [], B = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = dst[i], [x, y] = src[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); B.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); B.push(y);
  }
  for (let c = 0; c < 8; c++) { // אלימינציית גאוס עם פיבוט
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [B[c], B[p]] = [B[p], B[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      if (!f) continue;
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      B[r] -= f * B[c];
    }
  }
  return B.map((b, i) => b / A[i][i]);
}

// חיתוך + יישור פרספקטיבה (דגימה בילינארית)
function warp(src, quad) {
  const [tl, tr, br, bl] = quad;
  let W = Math.max(dist(tl, tr), dist(bl, br)), H = Math.max(dist(tl, bl), dist(tr, br));
  const s = Math.min(1, MAX_OUT / Math.max(W, H));
  W = Math.max(1, Math.round(W * s)); H = Math.max(1, Math.round(H * s));
  const [a, b, c, d, e, f, g, h] = homography([[0, 0], [W, 0], [W, H], [0, H]], quad);

  const sw = src.width, sh = src.height;
  const sp = src.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const octx = out.getContext("2d");
  const img = octx.createImageData(W, H);
  const op = img.data;
  let o = 0;
  for (let v = 0; v < H; v++) {
    const vv = v + 0.5;
    for (let u = 0; u < W; u++, o += 4) {
      const uu = u + 0.5;
      const den = g * uu + h * vv + 1;
      let x = (a * uu + b * vv + c) / den - 0.5, y = (d * uu + e * vv + f) / den - 0.5;
      x = clamp(x, 0, sw - 1.001); y = clamp(y, 0, sh - 1.001);
      const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
      op[o] = sp[i00] * w00 + sp[i10] * w10 + sp[i01] * w01 + sp[i11] * w11;
      op[o + 1] = sp[i00 + 1] * w00 + sp[i10 + 1] * w10 + sp[i01 + 1] * w01 + sp[i11 + 1] * w11;
      op[o + 2] = sp[i00 + 2] * w00 + sp[i10 + 2] * w10 + sp[i01 + 2] * w01 + sp[i11 + 2] * w11;
      op[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/* ---------- editor UI ---------- */

const ICON = {
  rotate: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
  auto: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z"/><path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/></svg>',
  full: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/></svg>'
};

let styled = false;
function injectStyle() {
  if (styled) return; styled = true;
  const css = `
.sc-overlay{position:fixed;inset:0;z-index:80;background:#111;color:#fff;display:flex;flex-direction:column;font-family:inherit;touch-action:none;overscroll-behavior:contain}
.sc-top{padding:calc(10px + env(safe-area-inset-top)) 16px 8px;text-align:center}
.sc-title{font-family:'Rubik','Assistant',sans-serif;font-weight:600;font-size:17px}
.sc-hint{font-size:14px;color:#cfcac0;margin-top:2px;min-height:20px}
.sc-hint.warn{color:#ffc56b}
.sc-stage{flex:1;min-height:0;position:relative;display:flex;align-items:center;justify-content:center;overflow:hidden}
.sc-frame{position:relative;direction:ltr}
.sc-frame canvas.sc-img{display:block}
.sc-frame svg{position:absolute;inset:0;overflow:visible;touch-action:none;cursor:crosshair}
.sc-loupe{position:absolute;top:10px;width:120px;height:120px;border-radius:50%;border:3px solid #fff;box-shadow:0 4px 16px rgba(0,0,0,.5);background:#000;pointer-events:none}
.sc-tools{display:flex;justify-content:center;gap:8px;padding:6px 12px 0;flex-wrap:wrap}
.sc-tool{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.1);color:#fff;border:1px solid rgba(255,255,255,.18);border-radius:999px;padding:8px 14px;font:inherit;font-size:14px;cursor:pointer}
.sc-tool:active{background:rgba(255,255,255,.2)}
.sc-actions{display:flex;gap:8px;padding:10px 12px calc(12px + env(safe-area-inset-bottom))}
.sc-actions button{flex:1;min-height:46px;border-radius:12px;font:inherit;font-weight:600;font-size:15px;cursor:pointer}
.sc-ghost{background:transparent;color:#fff;border:1px solid rgba(255,255,255,.3)}
.sc-main{flex:1.6 !important;background:var(--accent,#0F6E6A);color:#fff;border:0}
.sc-busy{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);font-size:16px}
`;
  document.head.append(Object.assign(document.createElement("style"), { textContent: css }));
}

function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "html") n.innerHTML = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  n.append(...kids);
  return n;
}
const SVGNS = "http://www.w3.org/2000/svg";
const s$ = (tag, attrs = {}) => { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };

function openEditor(initialSrc, originalFile) {
  injectStyle();
  return new Promise((resolve) => {
    let src = initialSrc;
    let det = detectDocument(src);
    let quad = det ? det.quad : fullQuad(src, 0.04);
    let scale = 1, dispW = 0, dispH = 0, drag = null;

    const hint = h("div", { class: "sc-hint" });
    const imgCanvas = h("canvas", { class: "sc-img" });
    const svg = s$("svg");
    const mask = s$("path", { fill: "rgba(0,0,0,.5)", "fill-rule": "evenodd" });
    const poly = s$("polygon", { fill: "none", stroke: "#3FD3C8", "stroke-width": "2.5", "stroke-linejoin": "round" });
    const handles = [0, 1, 2, 3].map(() => {
      const g = s$("g");
      g.append(s$("circle", { r: "26", fill: "transparent" }), s$("circle", { r: "11", fill: "rgba(63,211,200,.25)", stroke: "#fff", "stroke-width": "2.5" }));
      return g;
    });
    svg.append(mask, poly, ...handles);
    const frame = h("div", { class: "sc-frame" }, imgCanvas, svg);
    const loupe = h("canvas", { class: "sc-loupe", hidden: "" });
    const stage = h("div", { class: "sc-stage" }, frame, loupe);

    const setHint = (text, warn = false) => { hint.textContent = text; hint.classList.toggle("warn", warn); };
    const detHint = () => det
      ? setHint(det.confident ? "זוהה מסמך. אפשר לגרור את הפינות לדיוק" : "זוהה מסמך בערך. כדאי לבדוק את הפינות", !det.confident)
      : setHint("לא זוהה מסמך. גררו את הפינות לגבולות הדף", true);
    detHint();

    const done = (val) => {
      window.removeEventListener("resize", layout);
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(val);
    };
    const onKey = (e) => { if (e.key === "Escape") done(null); };

    const tool = (icon, label, onclick) => h("button", { type: "button", class: "sc-tool", html: icon + `<span>${label}</span>`, onclick });
    const overlay = h("div", { class: "sc-overlay", role: "dialog", "aria-modal": "true", "aria-label": "חיתוך ויישור" },
      h("div", { class: "sc-top" }, h("div", { class: "sc-title" }, "חיתוך ויישור"), hint),
      stage,
      h("div", { class: "sc-tools" },
        tool(ICON.rotate, "סיבוב", () => {
          const H0 = src.height;
          src = rotateCanvas(src);
          quad = orderQuad(quad.map(([x, y]) => [H0 - y, x]));
          if (det) det = { ...det, quad };
          layout();
        }),
        tool(ICON.auto, "זיהוי אוטומטי", () => {
          det = detectDocument(src);
          quad = det ? det.quad : fullQuad(src, 0.04);
          detHint(); render();
        }),
        tool(ICON.full, "כל התמונה", () => { quad = fullQuad(src); setHint("כל התמונה נבחרה"); render(); })
      ),
      h("div", { class: "sc-actions" },
        h("button", { type: "button", class: "sc-ghost", onclick: () => done(null) }, "ביטול"),
        h("button", { type: "button", class: "sc-ghost", onclick: () => done(originalFile) }, "ללא חיתוך"),
        h("button", { type: "button", class: "sc-main", onclick: apply }, "חיתוך ויישור")
      )
    );

    async function apply() {
      if (!isConvex(quad)) { setHint("הפינות יוצרות צורה לא תקינה. סדרו אותן מחדש", true); return; }
      const busy = h("div", { class: "sc-busy" }, "מיישר…");
      stage.append(busy);
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      try {
        const out = warp(src, quad);
        const blob = await new Promise((r) => out.toBlob(r, "image/jpeg", 0.92));
        if (!blob) throw new Error("toBlob failed");
        const base = (originalFile.name || "scan").replace(/\.[^.]+$/, "");
        done(new File([blob], base + "-scan.jpg", { type: "image/jpeg", lastModified: Date.now() }));
      } catch (e) {
        console.warn("crop failed", e);
        busy.remove();
        setHint("היישור נכשל. אפשר לשמור ללא חיתוך", true);
      }
    }

    function layout() {
      const r = stage.getBoundingClientRect();
      const pad = 30;
      scale = Math.max(0.01, Math.min((r.width - 2 * pad) / src.width, (r.height - 2 * pad) / src.height));
      dispW = Math.round(src.width * scale); dispH = Math.round(src.height * scale);
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      imgCanvas.width = Math.round(dispW * dpr); imgCanvas.height = Math.round(dispH * dpr);
      imgCanvas.style.width = dispW + "px"; imgCanvas.style.height = dispH + "px";
      const ctx = imgCanvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(src, 0, 0, imgCanvas.width, imgCanvas.height);
      frame.style.width = dispW + "px"; frame.style.height = dispH + "px";
      svg.setAttribute("width", dispW); svg.setAttribute("height", dispH);
      svg.setAttribute("viewBox", `0 0 ${dispW} ${dispH}`);
      loupe.width = loupe.height = Math.round(120 * dpr);
      render();
    }

    function render() {
      const d = quad.map(([x, y]) => [x * scale, y * scale]);
      const pts = d.map((p) => p.join(",")).join(" ");
      poly.setAttribute("points", pts);
      mask.setAttribute("d", `M0 0H${dispW}V${dispH}H0Z M${d.map((p) => p.join(" ")).join(" L")}Z`);
      handles.forEach((g, i) => g.setAttribute("transform", `translate(${d[i][0]} ${d[i][1]})`));
    }

    function drawLoupe(i) {
      const L = loupe.width, zoom = 3;
      const rs = 120 / (scale * zoom);           // גודל האזור בפיקסלי מקור
      const [cx, cy] = quad[i];
      const x0 = cx - rs / 2, y0 = cy - rs / 2;
      const k = L / rs;
      const ctx = loupe.getContext("2d");
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, L, L);
      const sx = Math.max(0, x0), sy = Math.max(0, y0);
      const ex = Math.min(src.width, x0 + rs), ey = Math.min(src.height, y0 + rs);
      if (ex > sx && ey > sy) ctx.drawImage(src, sx, sy, ex - sx, ey - sy, (sx - x0) * k, (sy - y0) * k, (ex - sx) * k, (ey - sy) * k);
      ctx.strokeStyle = "#3FD3C8"; ctx.lineWidth = 2 * (L / 120);
      ctx.beginPath();
      quad.forEach(([x, y], j) => { const px = (x - x0) * k, py = (y - y0) * k; j ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
      ctx.closePath(); ctx.stroke();
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5 * (L / 120);
      ctx.beginPath(); ctx.moveTo(L / 2 - 10, L / 2); ctx.lineTo(L / 2 + 10, L / 2); ctx.moveTo(L / 2, L / 2 - 10); ctx.lineTo(L / 2, L / 2 + 10); ctx.stroke();
      const leftSide = cx * scale + (stage.clientWidth - dispW) / 2 < stage.clientWidth / 2;
      loupe.style.left = leftSide ? "" : "10px";
      loupe.style.right = leftSide ? "10px" : "";
    }

    const local = (e) => { const r = frame.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    svg.addEventListener("pointerdown", (e) => {
      const [px, py] = local(e);
      let best = -1, bd = 46;
      quad.forEach(([x, y], i) => { const dd = Math.hypot(x * scale - px, y * scale - py); if (dd < bd) { bd = dd; best = i; } });
      if (best < 0) return;
      e.preventDefault();
      svg.setPointerCapture(e.pointerId);
      drag = { i: best, id: e.pointerId, ox: quad[best][0] * scale - px, oy: quad[best][1] * scale - py };
      loupe.hidden = false; drawLoupe(best);
    });
    svg.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const [px, py] = local(e);
      quad[drag.i] = [clamp((px + drag.ox) / scale, 0, src.width), clamp((py + drag.oy) / scale, 0, src.height)];
      render(); drawLoupe(drag.i);
    });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null; loupe.hidden = true;
      quad = orderQuad(quad);
      render();
    };
    svg.addEventListener("pointerup", end);
    svg.addEventListener("pointercancel", end);

    document.body.append(overlay);
    window.addEventListener("resize", layout);
    document.addEventListener("keydown", onKey);
    requestAnimationFrame(layout);
  });
}
