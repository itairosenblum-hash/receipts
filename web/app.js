import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged,
  signInWithPopup, signInWithRedirect, getRedirectResult, signOut
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot,
  collection, query, orderBy, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";
import { firebaseConfig, ADMIN_EMAIL } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
auth.languageCode = "he";
const db = getFirestore(app);
const accessRef = doc(db, "config", "access");

const $ = (id) => document.getElementById(id);
const VIEWS = ["loading", "login", "denied", "list", "settings"];

let currentUser = null;
let isAdmin = false;
let allowed = false;
let receipts = [];
let unsubs = [];

/* ---------- helpers ---------- */

function show(view) {
  for (const v of VIEWS) $("view-" + v).hidden = v !== view;
  window.scrollTo(0, 0);
}

function toast(msg) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.hidden = true; }, 3000);
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

const normEmail = (e) => (e || "").trim().toLowerCase();

function toDate(v) {
  if (!v) return null;
  if (typeof v.toDate === "function") return v.toDate();
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

const fmtDate = (d) => d ? d.toLocaleDateString("he-IL", { day: "2-digit", month: "2-digit", year: "numeric" }) : "";

function fmtAmount(n, currency = "ILS") {
  if (typeof n !== "number") return "";
  try {
    return new Intl.NumberFormat("he-IL", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);
  } catch {
    return String(n);
  }
}

function warrantyTag(r) {
  const end = toDate(r.warrantyEnd);
  if (!end) return null;
  const days = Math.ceil((end - new Date()) / 86400000);
  if (days < 0) return { text: "האחריות פגה", cls: "tag-off" };
  if (days <= 30) return { text: `פגה בעוד ${days} יום`, cls: "tag-soon" };
  const m = String(end.getMonth() + 1).padStart(2, "0");
  return { text: `אחריות עד ${m}.${end.getFullYear()}`, cls: "tag-ok" };
}

function stopListeners() {
  unsubs.forEach((u) => u());
  unsubs = [];
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
  if (!user) {
    show("login");
    return;
  }
  show("loading");
  const email = normEmail(user.email);
  isAdmin = user.emailVerified && email === normEmail(ADMIN_EMAIL);

  try {
    // ה-Rules מאפשרים לקרוא את רשימת המורשים רק למי שמורשה, כך שקריאה מוצלחת היא אישור גישה
    const snap = await getDoc(accessRef);
    const emails = (snap.exists() ? snap.data().emails || [] : []).map(normEmail);
    allowed = isAdmin || emails.includes(email);
  } catch (e) {
    if (e.code !== "permission-denied") {
      console.error(e);
      toast("שגיאה בבדיקת הרשאות: " + (e.code || e.message));
    }
    allowed = false;
  }

  if (!allowed) {
    $("denied-email").textContent = user.email || "";
    show("denied");
    return;
  }
  startApp();
});

/* ---------- app ---------- */

function startApp() {
  renderAvatar();
  $("settings-email").textContent = currentUser.email;

  const q = query(collection(db, "receipts"), orderBy("purchaseDate", "desc"));
  unsubs.push(onSnapshot(q, (snap) => {
    receipts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderReceipts();
  }, (e) => {
    console.error(e);
    toast("שגיאה בטעינת הקבלות");
  }));

  unsubs.push(onSnapshot(accessRef, renderAccess, (e) => {
    console.error(e);
    $("access-error").textContent = "לא ניתן לטעון את רשימת המורשים";
    $("access-error").hidden = false;
  }));

  route();
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

function renderReceipts() {
  const term = normEmail($("search").value);
  const list = receipts.filter((r) => {
    if (!term) return true;
    return [r.productName, r.store, ...(r.tags || [])]
      .filter(Boolean).some((s) => String(s).toLowerCase().includes(term));
  });

  const box = $("receipts");
  box.replaceChildren(...list.map((r) => {
    const tag = warrantyTag(r);
    const date = fmtDate(toDate(r.purchaseDate));
    return el("article", { class: "receipt" },
      el("div", { class: "receipt-main" },
        el("div", { class: "receipt-title", text: r.productName || "ללא שם" }),
        el("div", { class: "receipt-sub", text: [r.store, date].filter(Boolean).join(" · ") }),
        tag && el("span", { class: "tag " + tag.cls, text: tag.text })
      ),
      el("div", { class: "receipt-amount", text: fmtAmount(r.amount, r.currency || "ILS") })
    );
  }));

  const empty = $("empty");
  empty.hidden = list.length > 0;
  empty.querySelector("h2").textContent = receipts.length ? "לא נמצאו תוצאות" : "עוד אין קבלות";
  empty.querySelector("p").textContent = receipts.length
    ? "נסו מילת חיפוש אחרת."
    : "העלאת קבלות תתווסף בשלב הבא של הפיתוח.";
}

$("search").addEventListener("input", renderReceipts);

/* ---------- access list (settings) ---------- */

function renderAccess(snap) {
  const list = $("access-list");
  const exists = snap.exists();
  const emails = exists ? (snap.data().emails || []) : [];
  $("access-error").hidden = true;

  $("access-form").hidden = !isAdmin || !exists;
  $("btn-init-access").hidden = !isAdmin || exists;
  $("access-hint").textContent = isAdmin
    ? (exists ? "רק חשבונות ברשימה יכולים להיכנס לאפליקציה." : "רשימת המורשים עוד לא נוצרה. אחרי היצירה תוכל להוסיף חשבונות.")
    : "רק המנהל יכול לשנות את הרשימה.";

  const adminNorm = normEmail(ADMIN_EMAIL);
  const all = [ADMIN_EMAIL, ...emails.filter((e) => normEmail(e) !== adminNorm)];

  list.replaceChildren(...all.map((email) => {
    const isAdminRow = normEmail(email) === adminNorm;
    return el("li", {},
      el("span", { class: "email", text: email }),
      isAdminRow
        ? el("span", { class: "badge", text: "מנהל" })
        : (isAdmin ? el("button", {
            class: "remove", type: "button", text: "הסרה",
            "aria-label": "הסרת " + email,
            onclick: () => removeEmail(email)
          }) : null)
    );
  }));
}

$("btn-init-access").addEventListener("click", async () => {
  try {
    await setDoc(accessRef, { emails: [normEmail(ADMIN_EMAIL)] });
    toast("רשימת המורשים נוצרה");
  } catch (e) {
    showAccessError(e);
  }
});

$("access-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const input = $("access-input");
  const email = normEmail(input.value);
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
  show(location.hash === "#/settings" ? "settings" : "list");
}
window.addEventListener("hashchange", route);
