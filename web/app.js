import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged,
  signInWithPopup, signInWithRedirect, getRedirectResult, signOut
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot, writeBatch,
  collection, query, orderBy, arrayUnion, arrayRemove, Timestamp, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js";
import { firebaseConfig, ADMIN_EMAIL } from "./firebase-config.js?v=2";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
auth.languageCode = "he";
const db = getFirestore(app);
const functions = getFunctions(app, "europe-west1");
const call = (name, timeout = 120000) => httpsCallable(functions, name, { timeout });

const accessRef = doc(db, "config", "access");
const driveRef = doc(db, "config", "drive");

const $ = (id) => document.getElementById(id);
const VIEWS = ["loading", "login", "denied", "list", "edit", "detail", "settings"];
const FILE_KINDS = { receipt: "קבלה", warranty: "תעודת אחריות", label: "מדבקה", other: "אחר" };
const MAX_TOTAL_BYTES = 7 * 1024 * 1024;
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

function warrantyInfo(r) {
  const end = toDate(r.warrantyEnd);
  if (!end) return null;
  const days = Math.ceil((end - new Date()) / 86400000);
  if (days < 0) return { days, end, text: "האחריות פגה", cls: "off" };
  if (days <= 30) return { days, end, text: `פגה בעוד ${days} יום`, cls: "soon" };
  return { days, end, text: `אחריות עד ${pad(end.getMonth() + 1)}.${end.getFullYear()}`, cls: "ok" };
}

const categoryName = (id) => categories.find((c) => c.id === id)?.name || "";

function errMsg(e) {
  console.error(e);
  const code = String(e?.code || "");
  const msg = String(e?.message || "");
  if (/[֐-׿]/.test(msg)) return msg;
  if (code.includes("not-found") || code.includes("unavailable") || code.includes("internal")) {
    return "השרת לא זמין. ייתכן שה-Cloud Functions עוד לא נפרסו.";
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
      const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
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
  }, (e) => console.error(e)));

  unsubs.push(onSnapshot(driveRef, (snap) => {
    driveCfg = snap.exists() ? snap.data() : { connected: false };
    renderDrive();
  }, (e) => console.error(e)));

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
  const a = $("avatar");
  a.replaceChildren();
  if (currentUser.photoURL) {
    a.append(el("img", { src: currentUser.photoURL, alt: "", referrerpolicy: "no-referrer" }));
  } else {
    a.textContent = (currentUser.displayName || currentUser.email || "?").trim().charAt(0).toUpperCase();
  }
}

/* ---------- list ---------- */

function renderReceipts() {
  const term = norm($("search").value);
  const list = receipts.filter((r) => {
    if (!term) return true;
    return [r.productName, r.store, categoryName(r.categoryId), ...(r.tags || [])]
      .filter(Boolean).some((s) => String(s).toLowerCase().includes(term));
  });

  $("receipts").replaceChildren(...list.map((r) => {
    const w = warrantyInfo(r);
    return el("a", { class: "receipt", href: `#/r/${r.id}` },
      el("div", { class: "receipt-main" },
        el("div", { class: "receipt-title", text: r.productName || "ללא שם" }),
        el("div", { class: "receipt-sub", text: [r.store, fmtDate(toDate(r.purchaseDate))].filter(Boolean).join(" · ") }),
        w && el("span", { class: "tag tag-" + w.cls, text: w.text })
      ),
      el("div", { class: "receipt-amount", text: fmtAmount(r.amount, r.currency || "ILS") })
    );
  }));

  const empty = $("empty");
  empty.hidden = !receiptsLoaded || list.length > 0;
  empty.querySelector("h2").textContent = receipts.length ? "לא נמצאו תוצאות" : "עוד אין קבלות";
  empty.querySelector("p").textContent = receipts.length ? "נסו מילת חיפוש אחרת." : "לחצו על הפלוס כדי להוסיף את הקבלה הראשונה.";
}

$("search").addEventListener("input", renderReceipts);

/* ---------- new / edit ---------- */

let editingId = null;
let pendingFiles = [];
let warrantyTouched = false;
const form = $("receipt-form");

function fillCategorySelect() {
  const sel = $("category-select");
  const current = sel.value;
  sel.replaceChildren(
    el("option", { value: "", text: "בחירה" }),
    ...categories.map((c) => el("option", { value: c.id, text: c.name }))
  );
  if (current) sel.value = current;
}

function openEdit(id) {
  const r = id ? receipts.find((x) => x.id === id) : null;
  if (id && !r) {
    if (!receiptsLoaded) { show("loading"); return; }
    toast("הקבלה לא נמצאה");
    location.hash = "#/";
    return;
  }
  editingId = id;
  pendingFiles.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
  pendingFiles = [];
  warrantyTouched = !!r;
  form.reset();
  fillCategorySelect();
  $("form-error").hidden = true;
  $("dup-warning").hidden = true;
  form.querySelectorAll(".invalid").forEach((n) => n.classList.remove("invalid"));

  $("edit-title").textContent = r ? "עריכת קבלה" : "קבלה חדשה";
  $("files-section").hidden = !!r;
  const back = r ? `#/r/${r.id}` : "#/";
  $("edit-close").href = back;
  $("btn-cancel").href = back;

  const f = form.elements;
  if (r) {
    const d = toDate(r.purchaseDate) || new Date();
    f.productName.value = r.productName || "";
    f.store.value = r.store || "";
    f.amount.value = typeof r.amount === "number" ? r.amount : "";
    f.categoryId.value = r.categoryId || "";
    f.date.value = isoDate(d);
    f.time.value = r.hasTime ? fmtTime(d) : "";
    f.tags.value = (r.tags || []).join(", ");
    f.warrantyMonths.value = r.warrantyMonths || "";
    f.serialNumber.value = r.serialNumber || "";
    f.notes.value = r.notes || "";
  } else {
    f.date.value = isoDate(new Date());
  }
  renderPendingFiles();
  updateWarrantyEnd();
  show("edit");
}

function updateWarrantyEnd() {
  const f = form.elements;
  const months = parseInt(f.warrantyMonths.value, 10);
  const out = $("warranty-end");
  if (!months || !f.date.value) { out.textContent = ""; return; }
  const end = new Date(addMonths(new Date(f.date.value + "T12:00").getTime(), months));
  out.textContent = `בתוקף עד ${fmtDate(end)}`;
}

form.elements.categoryId.addEventListener("change", () => {
  if (warrantyTouched) return;
  const c = categories.find((x) => x.id === form.elements.categoryId.value);
  if (c && c.warrantyMonths) form.elements.warrantyMonths.value = c.warrantyMonths;
  updateWarrantyEnd();
});
form.elements.warrantyMonths.addEventListener("input", () => { warrantyTouched = true; updateWarrantyEnd(); });
form.elements.date.addEventListener("input", updateWarrantyEnd);

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
}

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

  const dups = pendingFiles
    .map((f) => receipts.find((r) => (r.fileHashes || []).includes(f.hash)))
    .filter(Boolean);
  const warn = $("dup-warning");
  warn.hidden = !dups.length;
  if (dups.length) {
    warn.textContent = `נראה שהקובץ כבר הועלה, בקבלה "${dups[0].productName}". אפשר להמשיך בכל זאת.`;
  }
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = form.elements;
  const err = $("form-error");
  err.hidden = true;
  form.querySelectorAll(".invalid").forEach((n) => n.classList.remove("invalid"));

  const problems = [];
  if (!f.productName.value.trim()) { problems.push("שם מוצר"); f.productName.closest(".field").classList.add("invalid"); }
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
  const warrantyMonths = parseInt(f.warrantyMonths.value, 10) || 0;
  const receipt = {
    productName: f.productName.value.trim(),
    store: f.store.value.trim(),
    amount: f.amount.value === "" ? null : Number(f.amount.value),
    currency: "ILS",
    purchaseDate: purchaseMs,
    hasTime,
    categoryId: f.categoryId.value || "other",
    tags: f.tags.value.split(/[,،]/).map((t) => t.trim()).filter(Boolean),
    warrantyMonths,
    serialNumber: f.serialNumber.value.trim(),
    notes: f.notes.value.trim()
  };

  $("btn-save").disabled = true;
  try {
    if (editingId) {
      busy("שומר…");
      await updateDoc(doc(db, "receipts", editingId), {
        ...receipt,
        purchaseDate: Timestamp.fromMillis(purchaseMs),
        warrantyEnd: warrantyMonths ? Timestamp.fromMillis(addMonths(purchaseMs, warrantyMonths)) : null,
        updatedAt: serverTimestamp()
      });
      location.hash = `#/r/${editingId}`;
      toast("השינויים נשמרו");
    } else {
      busy("מעלה לדרייב ושומר…");
      const files = await Promise.all(pendingFiles.map(filePayload));
      const res = await call("saveReceipt")({ receipt, files });
      pendingFiles.forEach((x) => x.previewUrl && URL.revokeObjectURL(x.previewUrl));
      pendingFiles = [];
      location.hash = `#/r/${res.data.id}`;
      toast("הקבלה נשמרה");
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
  detailId = id;
  renderDetail(r);
  if (!wasOpen) show("detail");
}

function renderDetail(r) {
  $("detail-edit").href = `#/r/${r.id}/edit`;
  $("detail-category").textContent = categoryName(r.categoryId);
  $("detail-title").textContent = r.productName || "ללא שם";
  $("detail-amount").textContent = fmtAmount(r.amount, r.currency || "ILS");

  // אחריות
  const box = $("detail-warranty");
  const w = warrantyInfo(r);
  const start = toDate(r.purchaseDate);
  if (!w || !start) {
    box.replaceChildren(el("div", { class: "warranty-head" }, el("b", { text: "אין אחריות רשומה" })));
  } else {
    const used = Math.min(100, Math.max(0, ((Date.now() - start) / (w.end - start)) * 100));
    const left = w.days < 0 ? `פגה ב-${fmtDate(w.end)}`
      : w.days <= 60 ? `נותרו ${w.days} ימים`
      : `נותרו ${Math.floor(w.days / 30.44)} חודשים`;
    const title = w.cls === "off" ? "האחריות פגה" : w.cls === "soon" ? "האחריות פגה בקרוב" : "אחריות בתוקף";
    box.replaceChildren(
      el("div", { class: "warranty-head" }, el("b", { text: title }), el("span", { class: "muted", text: `עד ${fmtDate(w.end)}` })),
      el("div", { class: "progress" + (w.cls === "soon" ? " soon" : "") }, el("div", { style: `width:${used.toFixed(1)}%` })),
      el("div", { class: "progress-meta" }, el("span", { text: left }), el("span", { text: `${r.warrantyMonths} חודשים בסך הכל` }))
    );
  }

  // פרטים
  const rows = [
    ["חנות", r.store],
    ["תאריך", start ? fmtDate(start) + (r.hasTime ? ` · ${fmtTime(start)}` : "") : ""],
    ["מספר סידורי", r.serialNumber],
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

async function openFile(receiptId, f) {
  busy("טוען קובץ…");
  try {
    const res = await call("getFile", 60000)({ receiptId, driveFileId: f.driveFileId });
    const bytes = Uint8Array.from(atob(res.data.data), (c) => c.charCodeAt(0));
    const blob = new Blob([bytes], { type: res.data.mimeType });
    const url = URL.createObjectURL(blob);
    const body = $("viewer-body");
    body.replaceChildren(res.data.mimeType.startsWith("image/")
      ? el("img", { src: url, alt: f.name })
      : el("iframe", { src: url, title: f.name }));
    $("viewer-title").textContent = f.name;
    $("viewer-download").href = url;
    $("viewer-download").setAttribute("download", f.name);
    $("viewer").hidden = false;
    $("viewer").dataset.url = url;
  } catch (e) {
    toast(errMsg(e));
  } finally {
    busy(null);
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

/* ---------- Drive (settings) ---------- */

function renderDrive() {
  const connected = !!driveCfg?.connected;
  $("drive-banner").hidden = connected;
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
    const res = await call("driveAuthUrl", 30000)();
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
