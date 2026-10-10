import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged,
  signInWithPopup, signInWithRedirect, getRedirectResult, signOut
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot, writeBatch,
  collection, query, orderBy, arrayUnion, arrayRemove, Timestamp, serverTimestamp, deleteField
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";
import { getMessaging, getToken, onMessage, isSupported as messagingSupported } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-messaging.js";
import { firebaseConfig, ADMIN_EMAIL } from "./firebase-config.js?v=2";
import { initMedical } from "./medical.js?v=1";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
auth.languageCode = "he";
const db = getFirestore(app);
const functions = getFunctions(app, "europe-west1");
const call = (name, timeout = 120000) => httpsCallable(functions, name, { timeout });

const accessRef = doc(db, "config", "access");
const driveRef = doc(db, "config", "drive");

const $ = (id) => document.getElementById(id);
const VIEWS = ["loading", "login", "denied", "list", "edit", "detail", "settings", "bulk", "medical", "med-edit", "med-detail"];
const FILE_KINDS = { receipt: "קבלה", warranty: "תעודת אחריות", label: "מדבקה", other: "אחר" };
const MAX_TOTAL_BYTES = 7 * 1024 * 1024;
// הכתובת הראשית של האפליקציה, לקישורים ששולחים לאחרים
const SHARE_URL = "https://shopping-fa855.web.app/";
const whatsappHref = (text) => "https://wa.me/?text=" + encodeURIComponent(text);
const DEFAULT_CATEGORIES = [
  ["appliances", "מוצרי חשמל", 12],
  ["electronics", "אלקטרוניקה ומחשבים", 12],
  ["phones", "טלפונים", 12],
  ["furniture", "ריהוט", 12],
  ["car", "רכב ואביזרים", 12],
  ["tools", "כלי עבודה", 12],
  ["sports", "ספורט ופנאי", 12],
  ["home", "בית וגינה", 12],
  ["other", "אחר", 0]
];

let currentUser = null;
let isAdmin = false;
let allowed = false;
let receipts = [];
let receiptsLoaded = false;
let categories = [];
let driveCfg = null;
let unsubs = [];

/* ---------- helpers ---------- */

function show(view) {
  for (const v of VIEWS) $("view-" + v).hidden = v !== view;
  window.scrollTo(0, 0);
}
const currentView = () => VIEWS.find((v) => !$("view-" + v).hidden);

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3500);
}

function busy(text) {
  $("busy").hidden = !text;
  if (text) $("busy-text").textContent = text;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null && c !== false) node.append(c);
  return node;
}

const norm = (e) => (e || "").trim().toLowerCase();

function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

const pad = (n) => String(n).padStart(2, "0");
const fmtDate = (d) => d ? `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}` : "";
const fmtTime = (d) => d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "";
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function fmtAmount(n, currency = "ILS") {
  if (typeof n !== "number") return "";
  try {
    return new Intl.NumberFormat("he-IL", { style: "currency", currency, maximumFractionDigits: n % 1 ? 2 : 0 }).format(n);
  } catch {
    return String(n);
  }
}

function fmtSize(bytes) {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + "KB";
  return (bytes / 1024 / 1024).toFixed(1) + "MB";
}

function addMonths(ms, months) {
  const d = new Date(ms);
  d.setMonth(d.getMonth() + months);
  return d.getTime();
}

// מצב אחריות לתאריך סיום אחד
function warrantyStatus(endValue) {
  const end = toDate(endValue);
  if (!end) return null;
  const days = Math.ceil((end - new Date()) / 86400000);
  if (days < 0) return { days, end, text: "האחריות פגה", cls: "off" };
  if (days <= 30) return { days, end, text: `פגה בעוד ${days} יום`, cls: "soon" };
  return { days, end, text: `אחריות עד ${pad(end.getMonth() + 1)}.${end.getFullYear()}`, cls: "ok" };
}

// רשימת המוצרים של קבלה. קבלות ישנות (לפני תמיכה בכמה מוצרים) הופכות למוצר יחיד.
function itemsOf(r) {
  if (Array.isArray(r.items) && r.items.length) return r.items;
  return [{
    name: r.productName || "",
    price: typeof r.amount === "number" ? r.amount : null,
    warrantyMonths: r.warrantyMonths || 0,
    warrantyEnd: r.warrantyEnd || null,
    serialNumber: r.serialNumber || ""
  }];
}

// המוצר "הראשי" של קבלה: זה שסומן בכוכב, ואם לא סומן, זה עם המחיר הגבוה ביותר.
// בלי מחירים, או בשוויון, נשאר הסדר שבקבלה.
function mainItem(items) {
  if (!items?.length) return null;
  const starred = items.find((it) => it.main === true);
  if (starred) return starred;
  return items.reduce((best, it) => (priceValue(it.price) > priceValue(best.price) ? it : best), items[0]);
}

// מחיר כמספר, גם כשנשמר כטקסט ("1,299 ₪"); בלי מחיר: -1
function priceValue(p) {
  if (typeof p === "number") return Number.isFinite(p) ? p : -1;
  if (typeof p !== "string") return -1;
  const n = Number(p.replace(/[^\d.]/g, ""));
  return p.trim() && Number.isFinite(n) ? n : -1;
}

// תגית אחריות לקבלה: המוצר שהאחריות שלו תיגמר הכי קרוב מבין אלה שעדיין בתוקף; אם כולן פגו, "פגה"
function warrantyInfo(r) {
  const states = itemsOf(r).map((it) => warrantyStatus(it.warrantyEnd)).filter(Boolean);
  if (!states.length) return null;
  const active = states.filter((s) => s.days >= 0).sort((a, b) => a.days - b.days);
  return active[0] || states.sort((a, b) => b.days - a.days)[0];
}

/* ---------- duplicates ---------- */
// קבלה נחשבת כפולה כשאותו קובץ הועלה פעמיים, או כשהסכום והיום זהים וגם החנות (או מוצר) זהה.
// "זו לא כפילות" נשמר ברשימת notDuplicate של הקבלה.
const dayKey = (v) => { const d = toDate(v); return d ? isoDate(d) : ""; };
const normText = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

function dupKeyOf(r) {
  return {
    id: r.id,
    hashes: r.fileHashes || [],
    amount: typeof r.amount === "number" ? r.amount : null,
    day: dayKey(r.purchaseDate),
    store: normText(r.store),
    names: itemsOf(r).map((it) => normText(it.name)).filter(Boolean),
    ignore: r.notDuplicate || []
  };
}

function isDup(a, b) {
  if (a.id && b.id && (a.ignore.includes(b.id) || b.ignore.includes(a.id))) return false;
  if (a.hashes.some((h) => h && b.hashes.includes(h))) return true;
  if (a.amount == null || b.amount == null || Math.abs(a.amount - b.amount) > 0.009) return false;
  if (!a.day || a.day !== b.day) return false;
  if (a.store && b.store) return a.store.includes(b.store) || b.store.includes(a.store);
  return a.names.some((n) => b.names.includes(n));
}

const findDups = (cand, exceptId) => receipts.filter((r) => r.id !== exceptId && isDup(cand, dupKeyOf(r)));
// כל חלק מבודד בכיוון משלו, כדי ששם עם אותיות לועזיות לא יערבב את סדר החלקים
const describeReceipt = (r) => [mainItem(itemsOf(r))?.name || r.productName, fmtDate(toDate(r.purchaseDate)), fmtAmount(r.amount, r.currency || "ILS")]
  .filter(Boolean).map((x) => `\u2068${x}\u2069`).join(" · ");

// מפה של כל הכפילויות בין הקבלות השמורות: מזהה קבלה ← מזהי הקבלות שהיא נראית כפולה שלהן
let dupMap = new Map();
function computeDupMap() {
  const keys = receipts.map(dupKeyOf);
  dupMap = new Map();
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      if (!isDup(keys[i], keys[j])) continue;
      for (const [x, y] of [[keys[i].id, keys[j].id], [keys[j].id, keys[i].id]]) {
        if (!dupMap.has(x)) dupMap.set(x, []);
        dupMap.get(x).push(y);
      }
    }
  }
}

const categoryName = (id) => categories.find((c) => c.id === id)?.name || "";

// צבע ואייקון לכל קטגוריה. קטגוריה שאין לה עיצוב משלה מקבלת את העיצוב של "אחר".
const CATEGORY_STYLE = {
  appliances: { fg: "#1D4ED8", bg: "#E3EBFC", icon: '<path d="M9 2v5M15 2v5"/><path d="M6 7h12v4a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>' },
  electronics: { fg: "#6D28D9", bg: "#EEE7FB", icon: '<rect x="4" y="4" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>' },
  phones: { fg: "#0E7490", bg: "#DFF1F5", icon: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>' },
  furniture: { fg: "#A16207", bg: "#FAEFD9", icon: '<path d="M5 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3"/><path d="M3 18v-5a2 2 0 0 1 4 0v1h10v-1a2 2 0 0 1 4 0v5z"/><path d="M5 18v2M19 18v2"/>' },
  car: { fg: "#B91C1C", bg: "#FBE4E4", icon: '<path d="M5 15l1.6-4.6A2 2 0 0 1 8.5 9h7a2 2 0 0 1 1.9 1.4L19 15"/><rect x="3" y="15" width="18" height="4" rx="1"/><path d="M6 19v2M18 19v2"/>' },
  tools: { fg: "#C2410C", bg: "#FCE8DB", icon: '<path d="M14.7 6.3a4 4 0 0 0-5.3 5.3L3 18l3 3 6.4-6.4a4 4 0 0 0 5.3-5.3l-2.5 2.5-2.3-.5-.5-2.3z"/>' },
  sports: { fg: "#15803D", bg: "#E0F3E5", icon: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.5 2.5 15.5 0 18M12 3c-2.5 2.5-2.5 15.5 0 18"/>' },
  home: { fg: "#BE185D", bg: "#FBE3EE", icon: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-5h4v5"/>' },
  other: { fg: "#57534E", bg: "#EEECE8", icon: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>' }
};
const catStyle = (id) => CATEGORY_STYLE[id] || CATEGORY_STYLE.other;

// אייקון הקטגוריה בתוך ריבוע צבעוני
function catBadge(id, cls = "cat-badge") {
  const st = catStyle(id);
  const span = el("span", { class: cls, "aria-hidden": "true", style: `background:${st.bg};color:${st.fg}` });
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${st.icon}</svg>`;
  return span;
}

function syncCategoryIcon() {
  const id = $("category-select").value;
  $("category-icon").replaceChildren(catBadge(id || "other", "cat-badge small"));
}

function errMsg(e) {
  console.error(e);
  const code = String(e?.code || "");
  const msg = String(e?.message || "");
  if (/[֐-׿]/.test(msg)) return msg;
  if (code.includes("not-found") || code.includes("unavailable") || code.includes("internal")) {
    return `השרת לא זמין (${code.replace("functions/", "")}).`;
  }
  if (code.includes("deadline-exceeded")) return "הפעולה לקחה יותר מדי זמן. נסו שוב.";
  if (code.includes("permission-denied")) return "אין הרשאה לפעולה הזו";
  return "הפעולה נכשלה: " + (code || msg);
}

function stopListeners() {
  unsubs.forEach((u) => u());
  unsubs = [];
}

/* ---------- files ---------- */

async function sha256(buffer) {
  const hash = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function guessType(file) {
  if (file.type) return file.type;
  const ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] || "").toLowerCase();
  return { pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif" }[ext] || "";
}

// מקטין תמונות לרוחב/גובה של עד 2000 פיקסלים ודוחס ל-JPEG. PDF נשאר כמו שהוא.
async function prepareFile(file, kind) {
  const original = await file.arrayBuffer();
  const hash = await sha256(original);
  let blob = file;
  let mimeType = guessType(file);
  let name = file.name || "file";

  if (!/^image\/|^application\/pdf$/.test(mimeType)) throw new Error("סוג קובץ לא נתמך: " + (file.name || ""));

  if (mimeType.startsWith("image/") && mimeType !== "image/gif") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bitmap.width * scale);
      canvas.height = Math.round(bitmap.height * scale);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close?.();
      const jpeg = await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.85));
      if (jpeg && (jpeg.size < file.size || mimeType === "image/heic" || mimeType === "image/heif")) {
        blob = jpeg;
        mimeType = "image/jpeg";
        name = name.replace(/\.[^.]+$/, "") + ".jpg";
      }
    } catch (e) {
      console.warn("compression skipped", e);
    }
  }

  return {
    blob, name, mimeType, hash, kind,
    size: blob.size,
    previewUrl: mimeType.startsWith("image/") ? URL.createObjectURL(blob) : null
  };
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

async function filePayload(f) {
  return { name: f.name, mimeType: f.mimeType, kind: f.kind, hash: f.hash, data: await toBase64(f.blob) };
}

function thumb(mimeType, previewUrl) {
  if (previewUrl) return el("img", { class: "file-thumb", src: previewUrl, alt: "" });
  const pdf = mimeType === "application/pdf";
  return el("div", { class: "file-thumb" + (pdf ? " pdf" : ""), text: pdf ? "PDF" : "IMG" });
}

/* ---------- auth ---------- */

$("btn-login").addEventListener("click", async () => {
  const btn = $("btn-login");
  const err = $("login-error");
  err.hidden = true;
  btn.disabled = true;
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await signInWithPopup(auth, provider);
  } catch (e) {
    if (e.code === "auth/popup-blocked" || e.code === "auth/operation-not-supported-in-this-environment") {
      await signInWithRedirect(auth, provider);
      return;
    }
    if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
      err.textContent = e.code === "auth/unauthorized-domain"
        ? "הדומיין הזה לא מאושר ב-Firebase. יש להוסיף אותו ב-Authentication ← Settings ← Authorized domains."
        : "הכניסה נכשלה: " + (e.code || e.message);
      err.hidden = false;
    }
  } finally {
    btn.disabled = false;
  }
});

getRedirectResult(auth).catch((e) => {
  $("login-error").textContent = "הכניסה נכשלה: " + (e.code || e.message);
  $("login-error").hidden = false;
});

const logout = async () => {
  stopListeners();
  await signOut(auth);
};
$("btn-logout").addEventListener("click", logout);
$("btn-denied-logout").addEventListener("click", logout);

onAuthStateChanged(auth, async (user) => {
  stopListeners();
  currentUser = user;
  allowed = false;
  receiptsLoaded = false;
  if (!user) {
    show("login");
    return;
  }
  show("loading");
  const email = norm(user.email);
  isAdmin = user.emailVerified && email === norm(ADMIN_EMAIL);

  try {
    // ה-Rules מאפשרים לקרוא את רשימת המורשים רק למי שמורשה, כך שקריאה מוצלחת היא אישור גישה
    const snap = await getDoc(accessRef);
    const emails = (snap.exists() ? snap.data().emails || [] : []).map(norm);
    allowed = isAdmin || emails.includes(email);
  } catch (e) {
    if (e.code !== "permission-denied") toast("שגיאה בבדיקת הרשאות: " + (e.code || e.message));
    allowed = false;
  }

  if (!allowed) {
    $("denied-email").textContent = user.email || "";
    show("denied");
    return;
  }
  startApp();
});

/* ---------- app start ---------- */

function startApp() {
  renderAvatar();
  $("settings-email").textContent = currentUser.email;

  const q = query(collection(db, "receipts"), orderBy("purchaseDate", "desc"));
  unsubs.push(onSnapshot(q, (snap) => {
    receipts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    receiptsLoaded = true;
    renderReceipts();
    if (currentView() === "detail" || currentView() === "loading") route();
  }, (e) => toast(errMsg(e))));

  unsubs.push(onSnapshot(query(collection(db, "categories"), orderBy("order")), async (snap) => {
    categories = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!categories.length && isAdmin) await seedCategories();
    fillCategorySelect();
    renderReceipts();
  }, (e) => console.error(e)));

  unsubs.push(onSnapshot(driveRef, (snap) => {
    driveCfg = snap.exists() ? snap.data() : { connected: false };
    renderDrive();
  }, (e) => console.error(e)));

  medical.start(unsubs);
  listenForeground();

  unsubs.push(onSnapshot(accessRef, renderAccess, (e) => {
    console.error(e);
    $("access-error").textContent = "לא ניתן לטעון את רשימת המורשים";
    $("access-error").hidden = false;
  }));

  route();
}

async function seedCategories() {
  const batch = writeBatch(db);
  DEFAULT_CATEGORIES.forEach(([id, name, warrantyMonths], order) => {
    batch.set(doc(db, "categories", id), { name, warrantyMonths, order });
  });
  await batch.commit().catch((e) => console.error("seed failed", e));
}

function renderAvatar() {
  document.querySelectorAll(".avatar").forEach((a) => {
    a.replaceChildren();
    if (currentUser.photoURL) {
      a.append(el("img", { src: currentUser.photoURL, alt: "", referrerpolicy: "no-referrer" }));
    } else {
      a.textContent = (currentUser.displayName || currentUser.email || "?").trim().charAt(0).toUpperCase();
    }
  });
}

/* ---------- list ---------- */

let listFilter = "all";

function warrantyBucket(r) {
  const w = warrantyInfo(r);
  if (!w) return "none";
  return w.cls === "off" ? "expired" : w.cls === "soon" ? "soon" : "valid";
}
const matchesBucket = (r, f) => f === "all" || (f === "dups" ? dupMap.has(r.id) : (f === "valid" ? ["valid", "soon"].includes(warrantyBucket(r)) : warrantyBucket(r) === f));
const receiptYear = (r) => toDate(r.purchaseDate)?.getFullYear();

function fillFilterSelects() {
  const catSel = $("filter-category"), yearSel = $("filter-year");
  const cat = catSel.value, year = yearSel.value;
  const usedCats = new Set(receipts.map((r) => r.categoryId));
  catSel.replaceChildren(el("option", { value: "", text: "כל הקטגוריות" }),
    ...categories.filter((c) => usedCats.has(c.id)).map((c) => el("option", { value: c.id, text: c.name })));
  const years = [...new Set(receipts.map(receiptYear).filter(Boolean))].sort((a, b) => b - a);
  yearSel.replaceChildren(el("option", { value: "", text: "כל השנים" }), ...years.map((y) => el("option", { value: String(y), text: String(y) })));
  catSel.value = [...catSel.options].some((o) => o.value === cat) ? cat : "";
  yearSel.value = [...yearSel.options].some((o) => o.value === year) ? year : "";
}

function renderReceipts() {
  computeDupMap();
  fillFilterSelects();
  const term = norm($("search").value);
  const cat = $("filter-category").value;
  const year = $("filter-year").value;
  const base = receipts.filter((r) => {
    if (cat && r.categoryId !== cat) return false;
    if (year && String(receiptYear(r)) !== year) return false;
    if (!term) return true;
    return [...itemsOf(r).flatMap((it) => [it.name, it.printedName, it.serialNumber]), r.store, categoryName(r.categoryId), ...(r.tags || [])]
      .filter(Boolean).some((s) => String(s).toLowerCase().includes(term));
  });
  const list = base.filter((r) => matchesBucket(r, listFilter));

  // מונים על הכפתורים לפי שאר הסינונים
  document.querySelectorAll(".filter-chip").forEach((btn) => {
    const f = btn.dataset.filter;
    const n = base.filter((r) => matchesBucket(r, f)).length;
    const label = btn.dataset.label || (btn.dataset.label = btn.textContent);
    btn.replaceChildren(...(f === "all" ? [label] : [label, el("span", { class: "count", text: String(n) })]));
    btn.classList.toggle("active", f === listFilter);
    btn.setAttribute("aria-pressed", String(f === listFilter));
  });
  $("filters").hidden = receipts.length === 0;

  // התראה על קבלות כפולות, עם מעבר לתצוגה שלהן בלבד
  const dupCount = dupMap.size;
  const showingDups = listFilter === "dups";
  $("dup-banner").hidden = !dupCount && !showingDups;
  $("dup-banner-text").textContent = showingDups
    ? (dupCount ? `מוצגות ${dupCount} קבלות שנראות כפולות` : "לא נשארו קבלות כפולות")
    : `נמצאו ${dupCount} קבלות שנראות כפולות`;
  $("dup-banner-btn").textContent = showingDups ? "הצגת הכל" : "הצגה";

  $("receipts").replaceChildren(...list.map((r) => {
    const w = warrantyInfo(r);
    const items = itemsOf(r);
    return el("a", { class: "receipt", href: `#/r/${r.id}` },
      catBadge(r.categoryId),
      el("div", { class: "receipt-main" },
        el("div", { class: "receipt-title" },
          mainItem(items)?.name || r.productName || "ללא שם",
          items.length > 1 && el("span", { class: "more-items", text: ` +${items.length - 1}` })
        ),
        el("div", { class: "receipt-sub", text: [r.store, fmtDate(toDate(r.purchaseDate))].filter(Boolean).join(" · ") }),
        (w || dupMap.has(r.id)) && el("div", { class: "tag-row" },
          w && el("span", { class: "tag tag-" + w.cls, text: w.text }),
          dupMap.has(r.id) && el("span", { class: "tag tag-dup", text: "כפולה?" })
        )
      ),
      el("div", { class: "receipt-amount", text: fmtAmount(r.amount, r.currency || "ILS") })
    );
  }));

  const empty = $("empty");
  empty.hidden = !receiptsLoaded || list.length > 0;
  empty.querySelector("h2").textContent = receipts.length ? "לא נמצאו תוצאות" : "עוד אין קבלות";
  empty.querySelector("p").textContent = receipts.length ? "נסו לשנות את החיפוש או הסינון." : "לחצו על הפלוס כדי להוסיף את הקבלה הראשונה.";
  $("empty-bulk").hidden = receipts.length > 0;
}

document.querySelectorAll(".filter-chip").forEach((btn) => btn.addEventListener("click", () => {
  listFilter = btn.dataset.filter;
  renderReceipts();
}));
$("filter-category").addEventListener("change", renderReceipts);
$("dup-banner-btn").addEventListener("click", () => {
  listFilter = listFilter === "dups" ? "all" : "dups";
  renderReceipts();
  window.scrollTo(0, 0);
});
$("filter-year").addEventListener("change", renderReceipts);

$("search").addEventListener("input", renderReceipts);

/* ---------- new / edit ---------- */

let editingId = null;
let pendingFiles = [];
let aiResult = null;
let scanning = false;
let scanSeq = 0;
let formItems = [];
const userEdited = new Set();
const form = $("receipt-form");
const CONFIDENCE_FIELDS = {
  store: "store", amount: "amount", purchaseDate: "date", purchaseTime: "time", categoryId: "categoryId"
};
const blankItem = () => ({ name: "", printedName: "", price: null, warrantyMonths: null, serialNumber: "" });

function fillCategorySelect() {
  const sel = $("category-select");
  const current = sel.value;
  sel.replaceChildren(
    el("option", { value: "", text: "בחירה" }),
    ...categories.map((c) => el("option", { value: c.id, text: c.name }))
  );
  if (current) sel.value = current;
  syncCategoryIcon();
}
$("category-select").addEventListener("change", syncCategoryIcon);

function openEdit(id) {
  const r = id ? receipts.find((x) => x.id === id) : null;
  if (id && !r) {
    if (!receiptsLoaded) { show("loading"); return; }
    toast("הקבלה לא נמצאה");
    location.hash = "#/";
    return;
  }
  editingId = id;
  bulkEditId = null;
  pendingFiles.forEach((f) => !f.bulk && f.previewUrl && URL.revokeObjectURL(f.previewUrl));
  pendingFiles = [];
  form.reset();
  fillCategorySelect();
  $("form-error").hidden = true;
  $("dup-warning").hidden = true;
  form.querySelectorAll(".invalid, .uncertain").forEach((n) => n.classList.remove("invalid", "uncertain"));
  resetScan();

  $("edit-title").textContent = r ? "עריכת קבלה" : "קבלה חדשה";
  $("files-section").hidden = !!r;
  const back = r ? `#/r/${r.id}` : "#/";
  $("edit-close").href = back;
  $("btn-cancel").href = back;

  const f = form.elements;
  if (r) {
    const d = toDate(r.purchaseDate) || new Date();
    f.store.value = r.store || "";
    f.amount.value = formatMoney(r.amount);
    f.categoryId.value = r.categoryId || "";
    f.date.value = isoDate(d);
    f.time.value = r.hasTime ? fmtTime(d) : "";
    f.tags.value = (r.tags || []).join(", ");
    f.notes.value = r.notes || "";
    formItems = itemsOf(r).map((it) => ({
      name: it.name || "",
      printedName: it.printedName || "",
      price: typeof it.price === "number" ? it.price : null,
      warrantyMonths: it.warrantyMonths || null,
      serialNumber: it.serialNumber || "",
      main: it.main === true
    }));
  } else {
    f.date.value = isoDate(new Date());
    formItems = [blankItem()];
  }
  renderPendingFiles();
  renderItems();
  syncCategoryIcon();
  show("edit");
}

/* ---------- money inputs: 12,345.50 with ₪ ---------- */

function formatMoney(value) {
  if (value === null || value === undefined || value === "") return "";
  const n = typeof value === "number" ? value : parseMoney(value);
  if (n === null) return "";
  return n.toLocaleString("en-US", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
}

function parseMoney(text) {
  const clean = String(text ?? "").replace(/[^\d.]/g, "");
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

// מעצב תוך כדי הקלדה: פסיקים באלפים, נקודה אחת ועד שתי ספרות אחריה, והסמן נשאר אחרי אותה ספרה
function onMoneyInput(e) {
  const input = e.target;
  const raw = input.value;
  const caret = input.selectionStart ?? raw.length;
  const digitsBefore = raw.slice(0, caret).replace(/[^\d.]/g, "").length;
  let clean = raw.replace(/[^\d.]/g, "");
  const dot = clean.indexOf(".");
  if (dot !== -1) clean = clean.slice(0, dot + 1) + clean.slice(dot + 1).replace(/\./g, "").slice(0, 2);
  const [intPart, decPart] = clean.split(".");
  const intFmt = (intPart || (decPart !== undefined ? "0" : "")).replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const formatted = decPart !== undefined ? `${intFmt}.${decPart}` : intFmt;
  input.value = formatted;
  let pos = 0, seen = 0;
  while (pos < formatted.length && seen < digitsBefore) {
    if (/[\d.]/.test(formatted[pos])) seen++;
    pos++;
  }
  try { input.setSelectionRange(pos, pos); } catch {}
}

function moneyField(value, onChange) {
  const input = el("input", { type: "text", inputmode: "decimal", autocomplete: "off", class: "money-input", value: formatMoney(value) });
  input.addEventListener("input", (e) => { onMoneyInput(e); onChange(parseMoney(input.value), e); });
  return el("span", { class: "money" }, input, el("span", { class: "money-sign", "aria-hidden": "true", text: "₪" }));
}

/* ---------- products editor ---------- */

function itemEndText(months) {
  const date = form.elements.date.value;
  if (!months || !date) return "";
  return `בתוקף עד ${fmtDate(new Date(addMonths(new Date(date + "T12:00").getTime(), months)))}`;
}

function renderItems() {
  const box = $("items-list");
  box.replaceChildren(...formItems.map((it, i) => {
    const endEl = el("span", { class: "muted item-end", text: itemEndText(it.warrantyMonths) });
    const onInput = (key, parse) => (e) => {
      it[key] = parse ? parse(e.target.value) : e.target.value;
      userEdited.add("items");
      e.target.closest(".field")?.classList.remove("invalid");
      $("items-block").classList.remove("uncertain");
      if (key === "warrantyMonths") endEl.textContent = itemEndText(it.warrantyMonths);
      if (key === "price" || key === "name") updateStars();
    };
    const int = (v) => (parseInt(v, 10) > 0 ? parseInt(v, 10) : null);
    return el("div", { class: "item-card" },
      el("div", { class: "item-top" },
        formItems.length > 1 && el("button", {
          type: "button", class: "icon-btn item-star", "aria-label": `סימון מוצר ${i + 1} כראשי`,
          onclick: () => {
            formItems.forEach((x) => { x.main = x === it; });
            userEdited.add("items");
            updateStars();
          }
        }, el("span", { "aria-hidden": "true" })),
        el("label", { class: "field grow" }, formItems.length > 1 ? `מוצר ${i + 1}` : "מוצר",
          el("input", { value: it.name, maxlength: "120", placeholder: "למשל: מקרר LG 600 ליטר", oninput: onInput("name") })),
        formItems.length > 1 && el("button", {
          type: "button", class: "icon-btn item-remove", "aria-label": `הסרת מוצר ${i + 1}`,
          onclick: () => { formItems.splice(i, 1); userEdited.add("items"); renderItems(); }
        }, el("span", { "aria-hidden": "true", text: "✕" }))
      ),
      it.printedName && it.printedName !== it.name && el("div", { class: "muted small printed", text: `בקבלה: ${it.printedName}` }),
      el("div", { class: "grid-2" },
        el("label", { class: "field" }, "מחיר",
          moneyField(it.price, (v, e) => onInput("price", () => v)(e))),
        el("label", { class: "field" }, "אחריות (חודשים)",
          el("input", { type: "number", inputmode: "numeric", min: "0", max: "240", value: it.warrantyMonths ?? "", placeholder: "לא ידוע", oninput: onInput("warrantyMonths", int) }))
      ),
      endEl,
      el("label", { class: "field" }, "מספר סידורי (לא חובה)",
        el("input", { value: it.serialNumber, maxlength: "80", dir: "auto", oninput: onInput("serialNumber") }))
    );
  }));
  $("items-count").textContent = formItems.length > 1 ? `${formItems.length} מוצרים` : "";
  updateStars();
}

// הכוכב מסמן את המוצר שייתן לקבלה את שמה: הנבחר, ואם לא נבחר, היקר ביותר
function updateStars() {
  const main = mainItem(formItems.filter((it) => it.name.trim()).length ? formItems.filter((it) => it.name.trim()) : formItems);
  $("items-list").querySelectorAll(".item-card").forEach((card, i) => {
    const btn = card.querySelector(".item-star");
    if (!btn) return;
    const on = formItems[i] === main;
    btn.classList.toggle("on", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.firstChild.textContent = on ? "★" : "☆";
    btn.title = on ? "המוצר הראשי" : "סימון כמוצר הראשי";
  });
}

$("btn-add-item").addEventListener("click", () => {
  formItems.push(blankItem());
  userEdited.add("items");
  renderItems();
  $("items-list").lastElementChild?.querySelector("input")?.focus();
});

form.elements.amount.addEventListener("input", onMoneyInput);

form.elements.date.addEventListener("input", () => {
  $("items-list").querySelectorAll(".item-end").forEach((n, i) => { n.textContent = itemEndText(formItems[i]?.warrantyMonths); });
});

async function addPendingFiles(fileList) {
  for (const file of fileList) {
    try {
      const kind = pendingFiles.some((f) => f.kind === "receipt") ? "warranty" : "receipt";
      pendingFiles.push(await prepareFile(file, kind));
    } catch (e) {
      toast(e.message);
    }
  }
  renderPendingFiles();
  if (!editingId && !aiResult && !scanning && pendingFiles.length) runScan(false);
}

/* ---------- Gemini scan ---------- */

function resetScan() {
  scanSeq++;
  aiResult = null;
  scanning = false;
  userEdited.clear();
  $("scan-status").hidden = true;
  setSaveState();
}

function setSaveState() {
  const btn = $("btn-save");
  btn.disabled = scanning;
  btn.classList.toggle("waiting", scanning);
  btn.setAttribute("aria-label", scanning ? "ממתין לסריקה" : "שמירה");
  btn.title = scanning ? "ממתין לסריקה…" : "שמירה";
}

function scanStatus(state, text) {
  const box = $("scan-status");
  box.hidden = false;
  box.classList.toggle("error", state === "error");
  $("scan-spinner").hidden = state !== "busy";
  $("scan-icon").hidden = state === "busy";
  $("scan-text").textContent = text;
  $("btn-rescan").hidden = state === "busy";
}

async function runScan(force) {
  const toScan = pendingFiles.filter((f) => f.kind === "receipt");
  const files = (toScan.length ? toScan : pendingFiles.slice(0, 1)).slice(0, 3);
  if (!files.length) return;

  const seq = ++scanSeq;
  scanning = true;
  setSaveState();
  scanStatus("busy", "Gemini קורא את הקבלה…");
  try {
    const payload = await Promise.all(files.map(filePayload));
    const res = await call("scanReceipt", 200000)({ files: payload });
    if (seq !== scanSeq) return;
    aiResult = res.data;
    applyScan(res.data, force);
    scanStatus("done", "הפרטים מולאו אוטומטית. בדקו אותם לפני השמירה.");
  } catch (e) {
    if (seq !== scanSeq) return;
    scanStatus("error", errMsg(e));
  } finally {
    if (seq === scanSeq) {
      scanning = false;
      setSaveState();
    }
  }
}

$("btn-rescan").addEventListener("click", () => {
  aiResult = null;
  runScan(true);
});

function applyScan(d, force) {
  const f = form.elements;
  const set = (name, value) => {
    if (value == null || value === "") return;
    if (!force && userEdited.has(name)) return;
    f[name].value = value;
  };
  set("store", d.store);
  set("amount", formatMoney(d.amount));
  set("date", d.purchaseDate);
  set("time", d.purchaseTime);
  if (d.categoryId && categories.some((c) => c.id === d.categoryId)) set("categoryId", d.categoryId);
  syncCategoryIcon();
  queueMicrotask(updateDupWarning);
  if (d.tags?.length) set("tags", d.tags.join(", "));
  if (d.items?.length && (force || !userEdited.has("items"))) {
    formItems = d.items.map((it) => ({
      name: it.name || "",
      printedName: it.printedName || "",
      price: typeof it.price === "number" ? it.price : null,
      warrantyMonths: it.warrantyMonths || null,
      serialNumber: it.serialNumber || ""
    }));
  }
  renderItems();

  // סימון שדות שה-AI לא בטוח בהם, או שלא מצא בכלל
  form.querySelectorAll(".uncertain").forEach((n) => n.classList.remove("uncertain"));
  const conf = d.confidence || {};
  for (const [key, name] of Object.entries(CONFIDENCE_FIELDS)) {
    if (userEdited.has(name) && !force) continue;
    const missing = ["amount", "purchaseDate"].includes(key) && d[key] == null;
    const low = d[key] != null && typeof conf[key] === "number" && conf[key] < 0.7;
    if (missing || low) f[name].closest(".field")?.classList.add("uncertain");
  }
  if (!d.items?.length || (typeof conf.items === "number" && conf.items < 0.7)) {
    $("items-block").classList.add("uncertain");
  }
}

// כל עריכה ידנית מסמנת את השדה כ"נערך" כדי שהסריקה לא תדרוס אותו, ומסירה את סימון אי-הוודאות
form.addEventListener("input", (e) => {
  if (!e.target.name) return;
  userEdited.add(e.target.name);
  e.target.closest(".field")?.classList.remove("uncertain", "invalid");
});

$("pick-camera").addEventListener("change", async (e) => { await addPendingFiles(e.target.files); e.target.value = ""; });
$("pick-file").addEventListener("change", async (e) => { await addPendingFiles(e.target.files); e.target.value = ""; });

function renderPendingFiles() {
  $("file-list").replaceChildren(...pendingFiles.map((f, i) => {
    const kindSel = el("select", { "aria-label": "סוג הקובץ", onchange: (e) => { f.kind = e.target.value; } },
      ...Object.entries(FILE_KINDS).map(([k, label]) => el("option", { value: k, text: label })));
    kindSel.value = f.kind;
    return el("li", { class: "file-item" },
      thumb(f.mimeType, f.previewUrl),
      el("div", { class: "file-info" },
        el("span", { class: "file-name", text: f.name }),
        el("span", { class: "file-meta", text: fmtSize(f.size) })
      ),
      kindSel,
      el("button", {
        type: "button", class: "link-btn danger", text: "הסרה", "aria-label": "הסרת " + f.name,
        onclick: () => {
          if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
          pendingFiles.splice(i, 1);
          renderPendingFiles();
        }
      })
    );
  }));

  updateDupWarning();
}

// התראה בטופס כשהקבלה שממלאים כבר קיימת (אותו קובץ, או אותם סכום, תאריך וחנות)
function updateDupWarning() {
  const f = form.elements;
  const editing = editingId ? receipts.find((r) => r.id === editingId) : null;
  const cand = {
    id: editingId,
    hashes: pendingFiles.map((p) => p.hash),
    amount: parseMoney(f.amount.value),
    day: f.date.value,
    store: normText(f.store.value),
    names: formItems.map((it) => normText(it.name)).filter(Boolean),
    ignore: editing?.notDuplicate || []
  };
  const dups = findDups(cand, editingId);
  const warn = $("dup-warning");
  warn.hidden = !dups.length;
  if (dups.length) {
    const sameFile = dups[0].fileHashes?.some((h) => cand.hashes.includes(h));
    warn.textContent = `${sameFile ? "הקובץ הזה כבר הועלה" : "נראה שהקבלה הזו כבר קיימת"}: ${describeReceipt(dups[0])}${dups.length > 1 ? ` (ועוד ${dups.length - 1})` : ""}. אפשר לשמור בכל זאת.`;
  }
}
["store", "amount", "date"].forEach((name) => form.elements[name].addEventListener("input", updateDupWarning));

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = form.elements;
  const err = $("form-error");
  err.hidden = true;
  form.querySelectorAll(".invalid").forEach((n) => n.classList.remove("invalid"));

  const problems = [];
  const items = formItems
    .map((it) => ({ ...it, name: it.name.trim(), serialNumber: (it.serialNumber || "").trim() }))
    .filter((it) => it.name);
  if (!items.length) {
    problems.push("שם מוצר");
    $("items-list").querySelector("input")?.closest(".field")?.classList.add("invalid");
  }
  if (!f.date.value) { problems.push("תאריך"); f.date.closest(".field").classList.add("invalid"); }
  if (!editingId && !pendingFiles.length) problems.push("לפחות קובץ אחד");
  if (problems.length) {
    err.textContent = "חסרים: " + problems.join(", ");
    err.hidden = false;
    return;
  }

  const total = pendingFiles.reduce((s, x) => s + x.size, 0);
  if (total > MAX_TOTAL_BYTES) {
    err.textContent = `הקבצים גדולים מדי (${fmtSize(total)}). המקסימום הוא 7MB בסך הכל.`;
    err.hidden = false;
    return;
  }

  const hasTime = !!f.time.value;
  const purchaseMs = new Date(`${f.date.value}T${hasTime ? f.time.value : "12:00"}`).getTime();
  const receipt = {
    items,
    store: f.store.value.trim(),
    amount: parseMoney(f.amount.value),
    currency: "ILS",
    purchaseDate: purchaseMs,
    hasTime,
    categoryId: f.categoryId.value || "other",
    tags: f.tags.value.split(/[,،]/).map((t) => t.trim()).filter(Boolean),
    notes: f.notes.value.trim()
  };

  $("btn-save").disabled = true;
  try {
    if (editingId) {
      busy("שומר…");
      const savedItems = items.map((it) => ({
        name: it.name,
        printedName: it.printedName || "",
        price: typeof it.price === "number" && Number.isFinite(it.price) ? it.price : null,
        warrantyMonths: it.warrantyMonths || 0,
        warrantyEnd: it.warrantyMonths ? Timestamp.fromMillis(addMonths(purchaseMs, it.warrantyMonths)) : null,
        serialNumber: it.serialNumber,
        main: it.main === true
      }));
      const ends = items.filter((it) => it.warrantyMonths).map((it) => addMonths(purchaseMs, it.warrantyMonths));
      await updateDoc(doc(db, "receipts", editingId), {
        ...receipt,
        items: savedItems,
        productName: mainItem(savedItems).name,
        itemNames: savedItems.flatMap((it) => [it.name, it.printedName].filter(Boolean)),
        purchaseDate: Timestamp.fromMillis(purchaseMs),
        warrantyEnd: ends.length ? Timestamp.fromMillis(Math.max(...ends)) : null,
        warrantyMonths: deleteField(),
        serialNumber: deleteField(),
        updatedAt: serverTimestamp()
      });
      location.hash = `#/r/${editingId}`;
      toast("השינויים נשמרו");
    } else {
      busy("מעלה לדרייב ושומר…");
      const files = await Promise.all(pendingFiles.map(filePayload));
      const res = await call("saveReceipt")({ receipt, files, ai: aiResult });
      pendingFiles.forEach((x) => !x.bulk && x.previewUrl && URL.revokeObjectURL(x.previewUrl));
      pendingFiles = [];
      const fromBulk = bulkItems.find((b) => b.id === bulkEditId);
      if (fromBulk) {
        fromBulk.status = "saved";
        fromBulk.savedId = res.data.id;
        fromBulk.title = mainItem(receipt.items)?.name || fromBulk.title;
        bulkEditId = null;
        if (!finishBulkIfDone(0)) {
          location.hash = "#/bulk";
          toast("הקבלה נשמרה");
        }
      } else {
        location.hash = `#/r/${res.data.id}`;
        toast("הקבלה נשמרה");
      }
    }
  } catch (e) {
    err.textContent = errMsg(e);
    err.hidden = false;
  } finally {
    busy(null);
    $("btn-save").disabled = false;
  }
});

/* ---------- detail ---------- */

let detailId = null;

function openDetail(id) {
  const r = receipts.find((x) => x.id === id);
  if (!r) {
    // קבלה שנשמרה זה עתה עשויה להגיע מהמסד שנייה אחרי המעבר אליה
    show("loading");
    clearTimeout(openDetail._t);
    if (receiptsLoaded) {
      openDetail._t = setTimeout(() => {
        if (location.hash === `#/r/${id}` && !receipts.some((x) => x.id === id)) {
          toast("הקבלה לא נמצאה");
          location.hash = "#/";
        }
      }, 5000);
    }
    return;
  }
  clearTimeout(openDetail._t);
  const wasOpen = detailId === id && currentView() === "detail";
  if (!wasOpen) resetShareButton();
  detailId = id;
  renderDetail(r);
  if (!wasOpen) show("detail");
}

function renderDetail(r) {
  const twins = (dupMap.get(r.id) || []).map((id) => receipts.find((x) => x.id === id)).filter(Boolean);
  const dupBox = $("detail-dup");
  dupBox.hidden = !twins.length;
  if (twins.length) {
    dupBox.replaceChildren(
      el("b", { text: twins.length > 1 ? "הקבלה הזו נראית כפולה של:" : "הקבלה הזו נראית כפולה של:" }),
      ...twins.map((t) => el("a", { href: `#/r/${t.id}`, text: describeReceipt(t) })),
      el("div", { class: "dup-actions" },
        el("button", {
          type: "button", class: "link-btn", text: "זו לא כפילות",
          onclick: async () => {
            try {
              await updateDoc(doc(db, "receipts", r.id), { notDuplicate: arrayUnion(...twins.map((t) => t.id)) });
              toast("סומן שזו לא כפילות");
            } catch (e) { toast(errMsg(e)); }
          }
        }),
        el("span", { class: "muted small", text: "או מחקו את המיותרת בתחתית המסך" })
      )
    );
  }
  $("btn-whatsapp").href = whatsappHref(whatsappReceiptText(r));
  $("detail-edit").href = `#/r/${r.id}/edit`;
  const cst = catStyle(r.categoryId);
  const catEl = $("detail-category");
  catEl.replaceChildren(catBadge(r.categoryId, "cat-badge small"), categoryName(r.categoryId) || "ללא קטגוריה");
  catEl.style.cssText = `background:${cst.bg};color:${cst.fg}`;
  // מהיקר לזול, כך שהמוצר הראשי מופיע ראשון
  const items = [...itemsOf(r)].sort((a, b) => priceValue(b.price) - priceValue(a.price));
  const start = toDate(r.purchaseDate);
  $("detail-title").textContent = mainItem(items)?.name || r.productName || r.store || "ללא שם";
  $("detail-amount").textContent = fmtAmount(r.amount, r.currency || "ILS");

  // מוצרים, לכל אחד האחריות שלו
  const box = $("detail-warranty");
  box.replaceChildren(...[
    items.length > 1 && el("h2", { text: `${items.length} מוצרים` }),
    ...items.map((it) => {
      const w = warrantyStatus(it.warrantyEnd);
      let warrantyEls;
      if (!w || !start) {
        warrantyEls = [el("div", { class: "muted", text: "אחריות לא ידועה" })];
      } else {
        const used = Math.min(100, Math.max(0, ((Date.now() - start) / (w.end - start)) * 100));
        const left = w.days < 0 ? `פגה ב-${fmtDate(w.end)}`
          : w.days <= 60 ? `נותרו ${w.days} ימים`
          : `נותרו ${Math.floor(w.days / 30.44)} חודשים`;
        const title = w.cls === "off" ? "האחריות פגה" : w.cls === "soon" ? "האחריות פגה בקרוב" : "אחריות בתוקף";
        warrantyEls = [
          el("div", { class: "warranty-head" }, el("b", { text: title }), el("span", { class: "muted", text: `עד ${fmtDate(w.end)}` })),
          el("div", { class: "progress" + (w.cls === "soon" ? " soon" : "") }, el("div", { style: `width:${used.toFixed(1)}%` })),
          el("div", { class: "progress-meta" }, el("span", { text: left }), el("span", { text: `${it.warrantyMonths} חודשים בסך הכל` }))
        ];
      }
      return el("div", { class: "detail-item" },
        items.length > 1 && el("div", { class: "detail-item-head" },
          el("span", { class: "detail-item-name", text: it.name }),
          typeof it.price === "number" && el("span", { class: "detail-item-price", text: fmtAmount(it.price, r.currency || "ILS") })
        ),
        it.printedName && it.printedName !== it.name && el("div", { class: "muted small", text: `בקבלה: ${it.printedName}` }),
        ...warrantyEls,
        it.serialNumber && el("div", { class: "muted small", text: `מספר סידורי: ${it.serialNumber}` })
      );
    })
  ].filter(Boolean));

  // פרטים
  const rows = [
    ["חנות", r.store],
    ["תאריך", start ? fmtDate(start) + (r.hasTime ? ` · ${fmtTime(start)}` : "") : ""],
    ["תגיות", (r.tags || []).join(", ")],
    ["הערות", r.notes],
    ["הועלה ע״י", r.createdBy]
  ].filter(([, v]) => v);
  $("detail-rows").replaceChildren(...rows.map(([k, v]) => el("div", {}, el("dt", { text: k }), el("dd", { text: v }))));

  // קבצים
  const files = r.files || [];
  $("detail-files").replaceChildren(...files.map((f) => el("li", { class: "file-item" },
    thumb(f.mimeType),
    el("div", { class: "file-info" },
      el("span", { class: "file-name", text: FILE_KINDS[f.kind] || "קובץ" }),
      el("span", { class: "file-meta", text: f.name })
    ),
    el("button", { type: "button", class: "link-btn", text: "פתיחה", onclick: () => openFile(r.id, f) }),
    files.length > 1 && el("button", {
      type: "button", class: "link-btn danger", text: "מחיקה", "aria-label": "מחיקת " + f.name,
      onclick: () => removeFile(r.id, f)
    })
  )));
}

const PDFJS_BASE = "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.4.299/legacy/build/";
let pdfjsPromise = null;
function loadPdfjs() {
  pdfjsPromise ||= import(PDFJS_BASE + "pdf.min.mjs").then((lib) => {
    const workerUrl = PDFJS_BASE + "pdf.worker.min.mjs";
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    // Worker חייב להיטען מאותו דומיין; עוטפים את הקובץ מה-CDN בקובץ מקומי זמני שמייבא אותו
    try {
      const shim = URL.createObjectURL(new Blob([`import "${workerUrl}";`], { type: "text/javascript" }));
      lib.GlobalWorkerOptions.workerPort = new Worker(shim, { type: "module" });
    } catch (e) {
      console.warn("pdf worker fallback", e);
    }
    return lib;
  });
  return pdfjsPromise;
}

// מציג PDF כתמונות של כל העמודים. דפדפני Android לא מציגים PDF בתוך דף, ולכן מציירים אותו בעצמנו.
async function renderPdf(bytes, container) {
  const lib = await loadPdfjs();
  const pdf = await lib.getDocument({ data: bytes }).promise;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const width = Math.max(320, container.clientWidth - 16);
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (width * dpr) / base.width });
    const canvas = el("canvas", { class: "pdf-page", "aria-label": `עמוד ${n} מתוך ${pdf.numPages}` });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    container.append(canvas);
    await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport }).promise;
  }
}

async function openFile(receiptId, f) {
  busy("טוען קובץ…");
  try {
    const res = await call("getFile", 60000)({ receiptId, driveFileId: f.driveFileId });
    await displayFile(f, res.data);
  } catch (e) {
    toast(errMsg(e));
  } finally {
    busy(null);
  }
}

// מציג קובץ שהגיע מהשרת (base64) בחלון הצפייה. משמש גם את המסמכים הרפואיים.
async function displayFile(f, data) {
  const bytes = Uint8Array.from(atob(data.data), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: data.mimeType });
  const url = URL.createObjectURL(blob);
  const body = $("viewer-body");
  const isPdf = data.mimeType === "application/pdf";
  body.classList.toggle("pdf", isPdf);
  body.replaceChildren();
  $("viewer-title").textContent = f.name;
  $("viewer-download").href = url;
  $("viewer-download").setAttribute("download", f.name);
  const drive = $("viewer-drive");
  drive.hidden = !(isAdmin && f.webViewLink);
  if (f.webViewLink) drive.href = f.webViewLink;
  $("viewer").hidden = false;
  $("viewer").dataset.url = url;
  if (isPdf) {
    try {
      await renderPdf(bytes.slice(), body);
    } catch (e) {
      console.error(e);
      body.replaceChildren(el("p", { class: "viewer-msg", text: "לא ניתן להציג את הקובץ כאן. אפשר להוריד אותו או לפתוח בדרייב." }));
    }
  } else {
    body.append(el("img", { src: url, alt: f.name }));
  }
}

$("viewer-close").addEventListener("click", () => {
  const v = $("viewer");
  v.hidden = true;
  $("viewer-body").replaceChildren();
  if (v.dataset.url) URL.revokeObjectURL(v.dataset.url);
});

async function removeFile(receiptId, f) {
  if (!confirm(`למחוק את הקובץ "${f.name}"? הוא יועבר לאשפה בדרייב.`)) return;
  busy("מוחק…");
  try {
    await call("removeFile")({ receiptId, driveFileId: f.driveFileId });
    toast("הקובץ נמחק");
  } catch (e) {
    toast(errMsg(e));
  } finally {
    busy(null);
  }
}

$("add-file-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !detailId) return;
  busy("מעלה לדרייב…");
  try {
    const prepared = await prepareFile(file, $("add-file-kind").value);
    if (prepared.size > MAX_TOTAL_BYTES) throw new Error("הקובץ גדול מדי (עד 7MB)");
    await call("addFile")({ receiptId: detailId, file: await filePayload(prepared) });
    if (prepared.previewUrl) URL.revokeObjectURL(prepared.previewUrl);
    toast("הקובץ נוסף");
  } catch (err) {
    toast(err.code ? errMsg(err) : err.message);
  } finally {
    busy(null);
  }
});

$("btn-delete").addEventListener("click", async () => {
  const r = receipts.find((x) => x.id === detailId);
  if (!r || !confirm(`למחוק את הקבלה "${r.productName}"? הקבצים יועברו לאשפה בדרייב.`)) return;
  busy("מוחק…");
  try {
    await call("deleteReceipt")({ receiptId: r.id });
    location.hash = "#/";
    toast("הקבלה נמחקה");
  } catch (e) {
    toast(errMsg(e));
  } finally {
    busy(null);
  }
});

/* ---------- share a receipt ---------- */

let sharePrepared = null; // { receiptId, files, text, title }

function receiptSummary(r) {
  const items = itemsOf(r);
  const d = toDate(r.purchaseDate);
  const lines = [
    items.map((it) => it.name).join(", "),
    [r.store, d ? fmtDate(d) : "", fmtAmount(r.amount, r.currency || "ILS")].filter(Boolean).join(" · ")
  ];
  for (const it of items) {
    const w = warrantyStatus(it.warrantyEnd);
    if (w) lines.push(`${items.length > 1 ? it.name + ": " : ""}אחריות עד ${fmtDate(w.end)}`);
    if (it.serialNumber) lines.push(`${items.length > 1 ? it.name + ": " : ""}מספר סידורי ${it.serialNumber}`);
  }
  return lines.filter(Boolean).join("\n");
}

function resetShareButton() {
  sharePrepared = null;
  $("btn-share").classList.remove("ready");
  $("btn-share-text").textContent = "שיתוף עם הקובץ";
}

// הודעת וואטסאפ להוצאה: הפרטים וקישור שפותח את הקבלה באפליקציה (לחשבונות מורשים)
function whatsappReceiptText(r) {
  const title = mainItem(itemsOf(r))?.name || "קבלה";
  return `*${title}*\n${receiptSummary(r)}\n\nהקבלה באפליקציה: ${SHARE_URL}#/r/${r.id}`;
}

$("btn-share-app").href = whatsappHref(`הכספת: הקבלות, האחריות והמסמכים הרפואיים של הבית במקום אחד\n${SHARE_URL}`);

async function doShare(p) {
  try {
    if (p.files.length && navigator.canShare?.({ files: p.files })) {
      await navigator.share({ files: p.files, title: p.title, text: p.text });
    } else if (navigator.share) {
      await navigator.share({ title: p.title, text: p.text });
      toast("הדפדפן לא תומך בשיתוף קבצים, נשלח רק הטקסט");
    } else {
      // אין שיתוף בכלל: מורידים את הקבצים
      p.files.forEach((f) => {
        const a = el("a", { href: URL.createObjectURL(f), download: f.name });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      });
      toast("הקבצים הורדו למכשיר");
    }
  } catch (e) {
    if (e.name !== "AbortError") toast("השיתוף נכשל");
  } finally {
    resetShareButton();
  }
}

$("btn-share").addEventListener("click", async () => {
  const r = receipts.find((x) => x.id === detailId);
  if (!r) return;
  // שלב שני: הקבצים כבר הוכנו, הלחיצה הזו פותחת את חלון השיתוף
  if (sharePrepared?.receiptId === r.id) {
    await doShare(sharePrepared);
    return;
  }
  busy("מכין את הקבלה לשיתוף…");
  try {
    const wanted = (r.files || []).filter((f) => f.kind === "receipt");
    const toFetch = (wanted.length ? wanted : (r.files || [])).slice(0, 3);
    const files = [];
    for (const f of toFetch) {
      const res = await call("getFile", 60000)({ receiptId: r.id, driveFileId: f.driveFileId });
      const bytes = Uint8Array.from(atob(res.data.data), (c) => c.charCodeAt(0));
      files.push(new File([bytes], f.name, { type: res.data.mimeType }));
    }
    const title = mainItem(itemsOf(r))?.name || "קבלה";
    sharePrepared = { receiptId: r.id, files, title, text: receiptSummary(r) };
  } catch (e) {
    busy(null);
    toast(errMsg(e));
    return;
  }
  busy(null);
  // דפדפנים מאפשרים לפתוח חלון שיתוף רק מיד אחרי לחיצה; אם ההורדה ארכה, מבקשים לחיצה נוספת
  if (navigator.userActivation?.isActive) {
    await doShare(sharePrepared);
  } else {
    $("btn-share").classList.add("ready");
    $("btn-share-text").textContent = "הקבלה מוכנה, לחצו לשליחה";
  }
});

/* ---------- Drive (settings) ---------- */

function renderDrive() {
  const connected = !!driveCfg?.connected;
  $("drive-banner").hidden = connected;
  medical.refresh();
  const status = $("drive-status");
  if (connected) {
    status.textContent = `מחובר לחשבון ${driveCfg.email}. הקבצים נשמרים בתיקייה "${driveCfg.folderName || ""}", בתת-תיקייה לפי שנה.`;
  } else {
    status.textContent = isAdmin
      ? "הדרייב עוד לא מחובר. אחרי החיבור, כל הקבלות של שניכם יישמרו בדרייב שלך."
      : "הדרייב עוד לא מחובר. המנהל צריך לחבר אותו.";
  }
  const link = $("drive-folder-link");
  link.hidden = !(connected && isAdmin && driveCfg.folderLink);
  if (driveCfg?.folderLink) link.href = driveCfg.folderLink;
  const btn = $("btn-drive-connect");
  btn.hidden = !isAdmin;
  btn.textContent = connected ? "חיבור מחדש" : "חיבור Google Drive";
  btn.className = connected ? "btn-secondary" : "btn-primary";
}

$("btn-drive-connect").addEventListener("click", async () => {
  busy("פותח את Google…");
  try {
    const res = await call("driveAuthUrl", 30000)({ returnUrl: location.origin + location.pathname });
    location.href = res.data.url;
  } catch (e) {
    busy(null);
    toast(errMsg(e));
  }
});

const DRIVE_RESULTS = {
  connected: "הדרייב חובר בהצלחה",
  cancelled: "החיבור בוטל",
  expired: "פג תוקף הבקשה. נסו שוב.",
  "wrong-account": "יש להתחבר עם חשבון המנהל",
  "no-refresh-token": "Google לא החזיר הרשאה קבועה. נסו שוב.",
  "missing-scope": "לא אושרה גישה לדרייב. יש לסמן את תיבת ההרשאה בזמן החיבור.",
  "folder-not-found": "תיקיית היעד לא נמצאה או שאין אליה גישה",
  error: "החיבור נכשל"
};

/* ---------- warranty notifications ---------- */

const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
let notifyBusy = false;

async function renderNotify() {
  const status = $("notify-status"), btn = $("btn-notify"), test = $("btn-notify-test");
  btn.hidden = test.hidden = true;
  const supported = "Notification" in window && "serviceWorker" in navigator && await messagingSupported().catch(() => false);
  if (!supported) {
    status.textContent = "הדפדפן הזה לא תומך בהתראות. אפשר להתקין את האפליקציה למסך הבית ולנסות שוב משם.";
    return;
  }
  const perm = Notification.permission;
  if (perm === "denied") {
    status.textContent = "ההתראות חסומות במכשיר הזה. כדי להפעיל: הגדרות הטלפון ← אפליקציות ← קבלות (או Chrome) ← התראות.";
    return;
  }
  let registered = false;
  try {
    const snap = await getDoc(doc(db, "tokens", currentUser.uid));
    registered = perm === "granted" && (snap.data()?.tokens || []).length > 0;
  } catch {}
  if (registered) {
    status.textContent = "פעילות במכשיר הזה. תקבלו תזכורת חודש ושבוע לפני שאחריות פגה, בבוקר בשעה 9.";
    test.hidden = false;
    btn.hidden = false;
    btn.textContent = "רענון הרישום";
    btn.className = "btn-secondary";
  } else {
    status.textContent = isStandalone()
      ? "תזכורת חודש ושבוע לפני שאחריות פגה, לכל המכשירים שהופעלו."
      : "תזכורת חודש ושבוע לפני שאחריות פגה. מומלץ להפעיל מתוך האפליקציה המותקנת.";
    btn.hidden = false;
    btn.textContent = "הפעלת התראות במכשיר הזה";
    btn.className = "btn-primary";
  }
}

// כשהאפליקציה פתוחה, Firebase מעביר את ההודעה לדף ולא מציג אותה בעצמו; מציגים אותה כאן דרך ה-Service Worker
let foregroundListening = false;
async function listenForeground() {
  if (foregroundListening || !("Notification" in window) || !("serviceWorker" in navigator)) return;
  if (!(await messagingSupported().catch(() => false))) return;
  foregroundListening = true;
  onMessage(getMessaging(app), async (payload) => {
    const n = payload.notification || {};
    const link = payload.fcmOptions?.link || payload.data?.link || "";
    try {
      if (Notification.permission !== "granted") throw new Error("no permission");
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(n.title || "הכספת", {
        body: n.body || "", icon: "icon-192.png", badge: "icon-192.png", dir: "rtl", lang: "he", data: { link }
      });
    } catch {
      toast([n.title, n.body].filter(Boolean).join(" · "));
    }
  });
}

$("btn-notify").addEventListener("click", async () => {
  if (notifyBusy) return;
  notifyBusy = true;
  busy("מפעיל התראות…");
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw Object.assign(new Error("לא אושרו התראות"), { user: true });
    const registration = await navigator.serviceWorker.ready;
    const token = await getToken(getMessaging(app), { serviceWorkerRegistration: registration });
    if (!token) throw new Error("לא התקבל מזהה מכשיר");
    await setDoc(doc(db, "tokens", currentUser.uid), {
      email: currentUser.email,
      tokens: arrayUnion(token),
      updatedAt: serverTimestamp()
    }, { merge: true });
    toast("ההתראות הופעלו במכשיר הזה");
    listenForeground();
  } catch (e) {
    console.error(e);
    toast(e.user ? e.message : "הפעלת ההתראות נכשלה: " + (e.code || e.message));
  } finally {
    busy(null);
    notifyBusy = false;
    renderNotify();
  }
});

$("btn-notify-test").addEventListener("click", async () => {
  busy("שולח התראת בדיקה…");
  try {
    await call("sendTestNotification", 30000)();
    toast("נשלחה התראת בדיקה");
  } catch (e) {
    toast(errMsg(e));
  } finally {
    busy(null);
  }
});

/* ---------- access list (settings) ---------- */

function renderAccess(snap) {
  const exists = snap.exists();
  const emails = exists ? (snap.data().emails || []) : [];
  $("access-error").hidden = true;

  $("access-form").hidden = !isAdmin || !exists;
  $("btn-init-access").hidden = !isAdmin || exists;
  $("access-hint").textContent = isAdmin
    ? (exists ? "רק חשבונות ברשימה יכולים להיכנס לאפליקציה." : "רשימת המורשים עוד לא נוצרה. אחרי היצירה תוכל להוסיף חשבונות.")
    : "רק המנהל יכול לשנות את הרשימה.";

  const adminNorm = norm(ADMIN_EMAIL);
  const all = [ADMIN_EMAIL, ...emails.filter((e) => norm(e) !== adminNorm)];
  $("access-list").replaceChildren(...all.map((email) => {
    const isAdminRow = norm(email) === adminNorm;
    return el("li", {},
      el("span", { class: "email", text: email }),
      isAdminRow
        ? el("span", { class: "badge", text: "מנהל" })
        : (isAdmin && el("button", {
            class: "remove", type: "button", text: "הסרה", "aria-label": "הסרת " + email,
            onclick: () => removeEmail(email)
          }))
    );
  }));
}

$("btn-init-access").addEventListener("click", async () => {
  try {
    await setDoc(accessRef, { emails: [norm(ADMIN_EMAIL)] });
    toast("רשימת המורשים נוצרה");
  } catch (e) {
    showAccessError(e);
  }
});

$("access-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const input = $("access-input");
  const email = norm(input.value);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    toast("כתובת מייל לא תקינה");
    return;
  }
  try {
    await updateDoc(accessRef, { emails: arrayUnion(email) });
    input.value = "";
    toast("החשבון נוסף");
  } catch (e) {
    showAccessError(e);
  }
});

async function removeEmail(email) {
  if (!confirm(`להסיר את ${email} מרשימת המורשים?`)) return;
  try {
    await updateDoc(accessRef, { emails: arrayRemove(email) });
    toast("החשבון הוסר");
  } catch (e) {
    showAccessError(e);
  }
}

function showAccessError(e) {
  console.error(e);
  const err = $("access-error");
  err.textContent = e.code === "permission-denied" ? "אין הרשאה לשנות את הרשימה" : "הפעולה נכשלה: " + (e.code || e.message);
  err.hidden = false;
}

/* ---------- bulk import ---------- */

let bulkItems = [];
let bulkEditId = null;
let bulkRunning = 0;
let bulkSaving = false;
const BULK_CONCURRENCY = 2;

const bulkComplete = (ai) => !!(ai && ai.items?.length && ai.purchaseDate);
const isKnownHash = (hash, except) =>
  receipts.some((r) => (r.fileHashes || []).includes(hash)) ||
  bulkItems.some((b) => b !== except && b.file?.hash === hash && b.status !== "removed");

function receiptFromAi(ai) {
  return {
    items: (ai.items || []).map((it) => ({
      name: it.name,
      printedName: it.printedName || "",
      price: typeof it.price === "number" ? it.price : null,
      warrantyMonths: it.warrantyMonths || 0,
      serialNumber: it.serialNumber || ""
    })),
    store: ai.store || "",
    amount: typeof ai.amount === "number" ? ai.amount : null,
    currency: ai.currency || "ILS",
    purchaseDate: new Date(`${ai.purchaseDate}T${ai.purchaseTime || "12:00"}`).getTime(),
    hasTime: !!ai.purchaseTime,
    categoryId: ai.categoryId || "other",
    tags: ai.tags || [],
    notes: ""
  };
}

async function addBulkFiles(fileList) {
  const fresh = [...fileList].map((file) => ({
    id: Math.random().toString(36).slice(2, 10),
    title: file.name,
    status: "preparing",
    source: file
  }));
  bulkItems.push(...fresh);
  renderBulk();
  for (const item of fresh) {
    try {
      item.file = await prepareFile(item.source, "receipt");
      item.file.bulk = true;
      delete item.source;
      if (item.file.size > MAX_TOTAL_BYTES) {
        item.status = "error";
        item.error = "הקובץ גדול מ-7MB";
      } else if (isKnownHash(item.file.hash, item)) {
        item.status = "dup";
      } else {
        item.status = "queued";
      }
    } catch (e) {
      item.status = "error";
      item.error = e.message;
    }
    renderBulk();
    pumpBulk();
  }
}

function pumpBulk() {
  while (bulkRunning < BULK_CONCURRENCY) {
    const next = bulkItems.find((b) => b.status === "queued");
    if (!next) break;
    bulkRunning++;
    scanBulkItem(next).finally(() => {
      bulkRunning--;
      renderBulk();
      pumpBulk();
    });
  }
}

function bulkDupKey(b) {
  const ai = b.ai || {};
  return {
    hashes: b.file?.hash ? [b.file.hash] : [],
    amount: typeof ai.amount === "number" ? ai.amount : null,
    day: ai.purchaseDate || "",
    store: normText(ai.store),
    names: (ai.items || []).map((it) => normText(it.name)).filter(Boolean),
    ignore: []
  };
}

async function scanBulkItem(item) {
  item.status = "scanning";
  renderBulk();
  try {
    const res = await call("scanReceipt", 200000)({ files: [await filePayload(item.file)] });
    item.ai = res.data;
    item.status = bulkComplete(res.data) ? "ready" : "review";
    item.scanFailed = false;
    delete item.error;
    // כפילות לפי התוכן: מול הקבלות השמורות או מול קובץ אחר בייבוא הזה
    const cand = bulkDupKey(item);
    const dupR = findDups(cand)[0];
    const dupB = !dupR && bulkItems.find((o) => o !== item && o.ai && !["removed", "dup", "error"].includes(o.status) && isDup(cand, bulkDupKey(o)));
    if (dupR || dupB) {
      item.status = "dup";
      item.dupOf = dupR ? describeReceipt(dupR) : `${mainItem(dupB.ai.items)?.name || dupB.title} (בייבוא הזה)`;
    }
  } catch (e) {
    item.status = "error";
    item.scanFailed = true;
    item.error = errMsg(e);
  }
}

// סריקה חוזרת מתוך השורה: לקובץ שהסריקה שלו נכשלה או שחסרים בו פרטים
const canRescan = (b) => !!b.file && !bulkSaving && b.file.size <= MAX_TOTAL_BYTES &&
  (b.status === "review" || (b.status === "error" && b.scanFailed));

function rescanBulk(list) {
  list.forEach((b) => { b.status = "queued"; delete b.error; });
  renderBulk();
  pumpBulk();
}

$("bulk-retry-all").addEventListener("click", () => {
  rescanBulk(bulkItems.filter((b) => b.status === "error" && canRescan(b)));
});

$("bulk-pick").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (files.length) await addBulkFiles(files);
});

$("bulk-save-all").addEventListener("click", async () => {
  const ready = bulkItems.filter((b) => b.status === "ready");
  if (!ready.length || bulkSaving) return;
  bulkSaving = true;
  renderBulk();
  for (const item of ready) {
    item.status = "saving";
    renderBulk();
    try {
      const res = await call("saveReceipt")({
        receipt: receiptFromAi(item.ai),
        files: [await filePayload(item.file)],
        ai: item.ai
      });
      item.status = "saved";
      item.savedId = res.data.id;
      item.title = mainItem(item.ai.items)?.name || item.title;
    } catch (e) {
      item.status = "error";
      item.error = "השמירה נכשלה: " + errMsg(e);
    }
    renderBulk();
  }
  bulkSaving = false;
  renderBulk();
  const saved = ready.filter((b) => b.status === "saved").length;
  finishBulkIfDone(saved);
});

const BULK_STATUS = {
  preparing: ["chip-busy", "מכין…", true],
  queued: ["chip-busy", "ממתין לסריקה", false],
  scanning: ["chip-busy", "סורק…", true],
  ready: ["chip-ready", "מוכנה לשמירה", false],
  review: ["chip-review", "חסרים פרטים, צריך לבדוק", false],
  dup: ["chip-dup", "כבר קיימת, לא תישמר", false],
  error: ["chip-error", "נכשל", false],
  saving: ["chip-busy", "שומר…", true],
  saved: ["chip-saved", "נשמרה", false]
};

function renderBulk() {
  const items = bulkItems.filter((b) => b.status !== "removed");
  $("bulk-list").replaceChildren(...items.map((b) => {
    const [cls, label, spin] = BULK_STATUS[b.status] || BULK_STATUS.error;
    const ai = b.ai;
    const names = ai?.items?.map((it) => it.name) || [];
    const title = b.status === "saved" ? b.title : (mainItem(ai?.items)?.name || b.title);
    const date = ai?.purchaseDate ? fmtDate(new Date(ai.purchaseDate + "T12:00")) : "";
    const sub = [ai?.store, date, typeof ai?.amount === "number" ? fmtAmount(ai.amount, ai.currency || "ILS") : ""].filter(Boolean).join(" · ");
    const editable = ["ready", "review", "dup", "error"].includes(b.status) && b.file && !bulkSaving;
    const removable = !["scanning", "saving", "saved", "preparing"].includes(b.status) && !bulkSaving;
    return el("li", { class: "bulk-item" + (b.status === "saved" ? " saved" : "") },
      thumb(b.file?.mimeType || "", b.file?.previewUrl),
      el("div", { class: "bulk-main" },
        el("div", { class: "bulk-title" }, title, names.length > 1 && el("span", { class: "more-items", text: ` +${names.length - 1}` })),
        sub && el("div", { class: "bulk-sub", text: sub }),
        el("span", { class: "chip " + cls }, spin && el("span", { class: "spinner small" }), label),
        b.error && el("div", { class: "error small", text: b.error }),
        b.status === "dup" && b.dupOf && el("div", { class: "warn-text small", text: `נראית כפולה של: ${b.dupOf}` }),
        el("div", { class: "bulk-actions" },
          canRescan(b) && el("button", {
            type: "button", class: "link-btn", text: "סריקה חוזרת",
            onclick: () => rescanBulk([b])
          }),
          // שמירה שנכשלה (הסריקה עצמה הצליחה): חוזרים למצב שלפני השמירה
          b.status === "error" && !b.scanFailed && b.ai && !bulkSaving && el("button", {
            type: "button", class: "link-btn", text: "ניסיון חוזר",
            onclick: () => { b.status = bulkComplete(b.ai) ? "ready" : "review"; delete b.error; renderBulk(); }
          }),
          editable && el("a", { class: "link-btn", href: `#/bulk/edit/${b.id}`, text: b.status === "dup" ? "שמירה בכל זאת" : "בדיקה ועריכה" }),
          b.status === "saved" && b.savedId && el("a", { class: "link-btn", href: `#/r/${b.savedId}`, text: "פתיחה" }),
          removable && el("button", {
            type: "button", class: "link-btn danger", text: "הסרה",
            onclick: () => {
              if (b.file?.previewUrl) URL.revokeObjectURL(b.file.previewUrl);
              b.status = "removed";
              renderBulk();
            }
          })
        )
      )
    );
  }));

  const count = (st) => items.filter((b) => b.status === st).length;
  const ready = count("ready");
  const pending = items.filter((b) => ["preparing", "queued", "scanning"].includes(b.status)).length;
  $("bulk-summary").hidden = !items.length;
  $("bulk-progress").textContent = [
    pending ? `סורק ${items.length - pending} מתוך ${items.length}` : `${items.length} קבצים`,
    ready ? `${ready} מוכנות` : "",
    count("saved") ? `${count("saved")} נשמרו` : ""
  ].filter(Boolean).join(" · ");
  const failed = items.filter((b) => b.status === "error" && canRescan(b)).length;
  const retry = $("bulk-retry-all");
  retry.hidden = failed < 2;
  retry.textContent = `סריקה חוזרת ל-${failed} הקבצים שנכשלו`;
  const btn = $("bulk-save-all");
  btn.disabled = !ready || bulkSaving;
  btn.textContent = bulkSaving ? "שומר…" : ready === 1 ? "שמירת קבלה אחת" : ready ? `שמירת ${ready} קבלות` : "שמירת הכל";
}

// אם לא נשאר בייבוא שום דבר שדורש טיפול: מנקים את הרשימה וחוזרים למסך הראשי
function finishBulkIfDone(savedNow) {
  const active = bulkItems.filter((b) => b.status !== "removed");
  const pending = active.filter((b) => b.status !== "saved");
  if (active.length && !pending.length) {
    active.forEach((b) => b.file?.previewUrl && URL.revokeObjectURL(b.file.previewUrl));
    bulkItems = [];
    location.hash = "#/";
    toast(active.length === 1 ? "הקבלה נשמרה" : `כל ${active.length} הקבלות נשמרו`);
    return true;
  }
  if (savedNow) {
    toast(`${savedNow === 1 ? "קבלה אחת נשמרה" : savedNow + " קבלות נשמרו"} · ${pending.length === 1 ? "קבלה אחת נשארה" : pending.length + " נשארו"} לבדיקה`);
  }
  return false;
}

function openBulkEdit(id) {
  const item = bulkItems.find((b) => b.id === id && b.status !== "removed");
  if (!item || !item.file) { location.hash = "#/bulk"; return; }
  openEdit(null);
  bulkEditId = id;
  $("edit-title").textContent = "בדיקת קבלה";
  $("edit-close").href = "#/bulk";
  $("btn-cancel").href = "#/bulk";
  pendingFiles = [item.file];
  renderPendingFiles();
  if (item.ai) {
    aiResult = item.ai;
    applyScan(item.ai, true);
    scanStatus("done", "הפרטים מולאו מהסריקה. בדקו אותם לפני השמירה.");
  } else {
    runScan(false);
  }
}

window.addEventListener("beforeunload", (e) => {
  if (bulkItems.some((b) => ["preparing", "queued", "scanning", "ready", "review", "saving"].includes(b.status))) {
    e.preventDefault();
    e.returnValue = "";
  }
});

/* ---------- medical documents (separate module) ---------- */

const medical = initMedical({
  db, call, $, el, toast, busy, show, currentView, errMsg, norm,
  toDate, fmtDate, isoDate, fmtSize, prepareFile, filePayload, thumb, displayFile,
  MAX_TOTAL_BYTES, isAdmin: () => isAdmin, driveConnected: () => (driveCfg ? !!driveCfg.connected : true)
});

/* ---------- routing ---------- */

function route() {
  if (!allowed) return;
  const hash = location.hash || "#/";

  if (hash.startsWith("#/settings")) {
    const result = new URLSearchParams(hash.split("?")[1] || "").get("drive");
    if (result) {
      toast(DRIVE_RESULTS[result] || DRIVE_RESULTS.error);
      history.replaceState(null, "", "#/settings");
    }
    show("settings");
    renderNotify();
    medical.renderSettings();
    return;
  }
  if (hash === "#/m" || hash.startsWith("#/m/")) {
    medical.route(hash);
    return;
  }
  if (hash === "#/bulk") {
    renderBulk();
    show("bulk");
    return;
  }
  const bm = /^#\/bulk\/edit\/([^/]+)$/.exec(hash);
  if (bm) {
    if (currentView() !== "edit" || bulkEditId !== bm[1]) openBulkEdit(bm[1]);
    return;
  }
  if (hash === "#/new") {
    if (currentView() !== "edit" || editingId) openEdit(null);
    return;
  }
  let m = /^#\/r\/([^/]+)\/edit$/.exec(hash);
  if (m) {
    if (currentView() !== "edit" || editingId !== m[1]) openEdit(m[1]);
    return;
  }
  m = /^#\/r\/([^/]+)$/.exec(hash);
  if (m) {
    openDetail(m[1]);
    return;
  }
  show("list");
}
window.addEventListener("hashchange", route);

/* ---------- התקנה כאפליקציה ---------- */

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch((e) => console.warn("sw", e));
}
