// עזרים משותפים לקבלות ולמסמכים הרפואיים: הגדרות, הרשאות, חיבור לדרייב ועיבוד קבצים
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { setGlobalOptions, logger } from "firebase-functions/v2";
import { defineSecret, defineString } from "firebase-functions/params";
import { OAuth2Client } from "google-auth-library";
import { drive as driveApi } from "@googleapis/drive";
import crypto from "node:crypto";

initializeApp();
export const db = getFirestore();
setGlobalOptions({ region: "europe-west1", maxInstances: 5 });

/* ---------- configuration ---------- */

export const CLIENT_ID = defineSecret("GOOGLE_OAUTH_CLIENT_ID");
export const CLIENT_SECRET = defineSecret("GOOGLE_OAUTH_CLIENT_SECRET");
export const DRIVE_FOLDER_ID = defineString("DRIVE_FOLDER_ID", { default: "" });
export const APP_URL = defineString("APP_URL", { default: "https://itairosenblum-hash.github.io/receipts/" });
export const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
export const GEMINI_MODEL = defineString("GEMINI_MODEL", { default: "gemini-3.8-flash" });
export const NOTIFY_URL = defineString("NOTIFY_URL", { default: "https://shopping-fa855.web.app/" });

export const ADMIN_EMAIL = "itai.rosenblum@gmail.com";
export const APP_FOLDER_NAME = "קבלות ואחריות";
export const TIME_ZONE = "Asia/Jerusalem";
export const MAX_TOTAL_BYTES = 7 * 1024 * 1024;
export const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"]);
export const DRIVE_SECRET = db.doc("secrets/drive");
export const DRIVE_CONFIG = db.doc("config/drive");
export const OAUTH_STATE = db.doc("secrets/oauthState");

export const SECRETS = [CLIENT_ID, CLIENT_SECRET];

export function projectId() {
  return process.env.GCLOUD_PROJECT || JSON.parse(process.env.FIREBASE_CONFIG || "{}").projectId;
}
export const redirectUri = () => `https://europe-west1-${projectId()}.cloudfunctions.net/driveCallback`;

// גישה לתיקייה קיימת של המשתמש דורשת הרשאת drive מלאה; תיקייה שהאפליקציה יוצרת מסתפקת ב-drive.file
export function driveScope() {
  return DRIVE_FOLDER_ID.value()
    ? "https://www.googleapis.com/auth/drive"
    : "https://www.googleapis.com/auth/drive.file";
}

export const oauthClient = () => new OAuth2Client(CLIENT_ID.value(), CLIENT_SECRET.value(), redirectUri());

/* ---------- auth helpers ---------- */

export async function requireAllowed(request) {
  const t = request.auth?.token;
  if (!t?.email || !t.email_verified) throw new HttpsError("unauthenticated", "נדרשת התחברות");
  const email = t.email.toLowerCase();
  if (email === ADMIN_EMAIL) return { email, admin: true };
  const snap = await db.doc("config/access").get();
  const list = (snap.data()?.emails || []).map((e) => String(e).toLowerCase());
  if (!list.includes(email)) throw new HttpsError("permission-denied", "אין הרשאה");
  return { email, admin: false };
}

export async function requireAdmin(request) {
  const user = await requireAllowed(request);
  if (!user.admin) throw new HttpsError("permission-denied", "פעולה למנהל בלבד");
  return user;
}

export async function getDrive() {
  const snap = await DRIVE_SECRET.get();
  const refreshToken = snap.data()?.refreshToken;
  if (!refreshToken) throw new HttpsError("failed-precondition", "הדרייב לא מחובר. יש לחבר אותו במסך ההגדרות.");
  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return driveApi({ version: "v3", auth: client });
}

/* ---------- formatting helpers ---------- */

export function localDateParts(ms) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type).value;
  return { year: get("year"), date: `${get("year")}-${get("month")}-${get("day")}` };
}

export function slug(s, max = 30) {
  return String(s || "")
    .trim()
    .replace(/[\\/:*?"<>|#%{}~&]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, max);
}

export function extension(mimeType, name) {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(name || "")?.[1];
  if (fromName) return fromName.toLowerCase();
  return { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "application/pdf": "pdf" }[mimeType] || "bin";
}

export function addMonths(ms, months) {
  const d = new Date(ms);
  d.setMonth(d.getMonth() + months);
  return d.getTime();
}

export const numOrNull = (v) => (v === null || v === "" || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

// שם תיקייה בדרייב לשאילתה: גרש בודד ולוכסן הפוך מוברחים
export const driveQ = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/* ---------- files ---------- */

// מפענח קבצים שנשלחו מהדפדפן (base64), בודק סוג וגודל. kinds: סוגי הקבצים המותרים, fallback: ברירת מחדל
export function decodeFilesWith(files, kinds, fallback) {
  if (!Array.isArray(files)) throw new HttpsError("invalid-argument", "קבצים חסרים");
  let total = 0;
  const out = files.map((f) => {
    const mimeType = String(f?.mimeType || "");
    if (!ALLOWED_TYPES.has(mimeType)) throw new HttpsError("invalid-argument", `סוג קובץ לא נתמך: ${mimeType}`);
    const buffer = Buffer.from(String(f.data || ""), "base64");
    if (!buffer.length) throw new HttpsError("invalid-argument", "קובץ ריק");
    total += buffer.length;
    return {
      buffer,
      mimeType,
      originalName: String(f.name || "").slice(0, 120),
      kind: kinds[f.kind] ? f.kind : fallback,
      hash: /^[a-f0-9]{64}$/.test(f.hash) ? f.hash : crypto.createHash("sha256").update(buffer).digest("hex")
    };
  });
  if (total > MAX_TOTAL_BYTES) throw new HttpsError("invalid-argument", "הקבצים גדולים מדי (עד 7MB בסך הכל)");
  return out;
}

export async function trashQuietly(drive, fileIds) {
  await Promise.all(fileIds.map((id) =>
    drive.files.update({ fileId: id, requestBody: { trashed: true } })
      .catch((e) => logger.warn("trash failed", id, e.message))
  ));
}
