import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { setGlobalOptions, logger } from "firebase-functions/v2";
import { defineSecret, defineString } from "firebase-functions/params";
import { OAuth2Client } from "google-auth-library";
import { drive as driveApi } from "@googleapis/drive";
import { Readable } from "node:stream";
import crypto from "node:crypto";

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: "europe-west1", maxInstances: 5 });

/* ---------- configuration ---------- */

const CLIENT_ID = defineSecret("GOOGLE_OAUTH_CLIENT_ID");
const CLIENT_SECRET = defineSecret("GOOGLE_OAUTH_CLIENT_SECRET");
const DRIVE_FOLDER_ID = defineString("DRIVE_FOLDER_ID", { default: "" });
const APP_URL = defineString("APP_URL", { default: "https://itairosenblum-hash.github.io/Shopping/" });

const ADMIN_EMAIL = "itai.rosenblum@gmail.com";
const APP_FOLDER_NAME = "קבלות ואחריות";
const TIME_ZONE = "Asia/Jerusalem";
const MAX_TOTAL_BYTES = 7 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif", "application/pdf"]);
const FILE_KINDS = { receipt: "קבלה", warranty: "תעודת אחריות", label: "מדבקה", other: "קובץ" };
const DRIVE_SECRET = db.doc("secrets/drive");
const DRIVE_CONFIG = db.doc("config/drive");
const OAUTH_STATE = db.doc("secrets/oauthState");

const SECRETS = [CLIENT_ID, CLIENT_SECRET];

function projectId() {
  return process.env.GCLOUD_PROJECT || JSON.parse(process.env.FIREBASE_CONFIG || "{}").projectId;
}
const redirectUri = () => `https://europe-west1-${projectId()}.cloudfunctions.net/driveCallback`;

// גישה לתיקייה קיימת של המשתמש דורשת הרשאת drive מלאה; תיקייה שהאפליקציה יוצרת מסתפקת ב-drive.file
function driveScope() {
  return DRIVE_FOLDER_ID.value()
    ? "https://www.googleapis.com/auth/drive"
    : "https://www.googleapis.com/auth/drive.file";
}

const oauthClient = () => new OAuth2Client(CLIENT_ID.value(), CLIENT_SECRET.value(), redirectUri());

/* ---------- auth helpers ---------- */

async function requireAllowed(request) {
  const t = request.auth?.token;
  if (!t?.email || !t.email_verified) throw new HttpsError("unauthenticated", "נדרשת התחברות");
  const email = t.email.toLowerCase();
  if (email === ADMIN_EMAIL) return { email, admin: true };
  const snap = await db.doc("config/access").get();
  const list = (snap.data()?.emails || []).map((e) => String(e).toLowerCase());
  if (!list.includes(email)) throw new HttpsError("permission-denied", "אין הרשאה");
  return { email, admin: false };
}

async function requireAdmin(request) {
  const user = await requireAllowed(request);
  if (!user.admin) throw new HttpsError("permission-denied", "פעולה למנהל בלבד");
  return user;
}

async function getDrive() {
  const snap = await DRIVE_SECRET.get();
  const refreshToken = snap.data()?.refreshToken;
  if (!refreshToken) throw new HttpsError("failed-precondition", "הדרייב לא מחובר. יש לחבר אותו במסך ההגדרות.");
  const client = oauthClient();
  client.setCredentials({ refresh_token: refreshToken });
  return driveApi({ version: "v3", auth: client });
}

/* ---------- formatting helpers ---------- */

function localDateParts(ms) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type).value;
  return { year: get("year"), date: `${get("year")}-${get("month")}-${get("day")}` };
}

function slug(s, max = 30) {
  return String(s || "")
    .trim()
    .replace(/[\\/:*?"<>|#%{}~&]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, max);
}

function extension(mimeType, name) {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(name || "")?.[1];
  if (fromName) return fromName.toLowerCase();
  return { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "application/pdf": "pdf" }[mimeType] || "bin";
}

function addMonths(ms, months) {
  const d = new Date(ms);
  d.setMonth(d.getMonth() + months);
  return d.getTime();
}

/* ---------- validation ---------- */

function cleanReceipt(r) {
  if (!r || typeof r !== "object") throw new HttpsError("invalid-argument", "נתוני קבלה חסרים");
  const productName = String(r.productName || "").trim().slice(0, 120);
  if (!productName) throw new HttpsError("invalid-argument", "חסר שם מוצר");
  const purchaseDate = Number(r.purchaseDate);
  if (!Number.isFinite(purchaseDate)) throw new HttpsError("invalid-argument", "תאריך לא תקין");
  const amount = r.amount === null || r.amount === "" || r.amount === undefined ? null : Number(r.amount);
  if (amount !== null && !Number.isFinite(amount)) throw new HttpsError("invalid-argument", "סכום לא תקין");
  const warrantyMonths = Math.max(0, Math.min(240, parseInt(r.warrantyMonths, 10) || 0));
  const tags = Array.isArray(r.tags)
    ? [...new Set(r.tags.map((t) => String(t).trim().slice(0, 30)).filter(Boolean))].slice(0, 10)
    : [];
  return {
    productName,
    store: String(r.store || "").trim().slice(0, 80),
    amount,
    currency: /^[A-Z]{3}$/.test(r.currency) ? r.currency : "ILS",
    purchaseDate: Timestamp.fromMillis(purchaseDate),
    hasTime: !!r.hasTime,
    categoryId: String(r.categoryId || "other").slice(0, 40),
    tags,
    warrantyMonths,
    warrantyEnd: warrantyMonths ? Timestamp.fromMillis(addMonths(purchaseDate, warrantyMonths)) : null,
    serialNumber: String(r.serialNumber || "").trim().slice(0, 80),
    notes: String(r.notes || "").trim().slice(0, 1000)
  };
}

function decodeFiles(files) {
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
      kind: FILE_KINDS[f.kind] ? f.kind : "other",
      hash: /^[a-f0-9]{64}$/.test(f.hash) ? f.hash : crypto.createHash("sha256").update(buffer).digest("hex")
    };
  });
  if (total > MAX_TOTAL_BYTES) throw new HttpsError("invalid-argument", "הקבצים גדולים מדי (עד 7MB בסך הכל)");
  return out;
}

/* ---------- Drive folders and uploads ---------- */

async function rootFolderId() {
  const cfg = (await DRIVE_CONFIG.get()).data();
  if (!cfg?.folderId) throw new HttpsError("failed-precondition", "תיקיית הדרייב לא הוגדרה. יש לחבר מחדש את הדרייב.");
  return cfg.folderId;
}

async function yearFolderId(drive, year) {
  const cfg = (await DRIVE_CONFIG.get()).data() || {};
  const cached = cfg.years?.[year];
  if (cached) return cached;

  const root = await rootFolderId();
  const existing = await drive.files.list({
    q: `'${root}' in parents and name = '${year}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: "files(id)",
    pageSize: 1
  });
  let id = existing.data.files?.[0]?.id;
  if (!id) {
    const created = await drive.files.create({
      requestBody: { name: String(year), mimeType: "application/vnd.google-apps.folder", parents: [root] },
      fields: "id"
    });
    id = created.data.id;
  }
  await DRIVE_CONFIG.set({ years: { [year]: id } }, { merge: true });
  return id;
}

async function uploadFile(drive, file, { purchaseMs, store, productName, index }) {
  const { year, date } = localDateParts(purchaseMs);
  const parent = await yearFolderId(drive, year);
  const kindSuffix = file.kind === "receipt" ? "" : `_${slug(FILE_KINDS[file.kind])}`;
  const numSuffix = index > 0 ? `_${index + 1}` : "";
  const name = [date, slug(store), slug(productName)].filter(Boolean).join("_")
    + kindSuffix + numSuffix + "." + extension(file.mimeType, file.originalName);

  const res = await drive.files.create({
    requestBody: { name, parents: [parent] },
    media: { mimeType: file.mimeType, body: Readable.from(file.buffer) },
    fields: "id,name,mimeType,webViewLink,size"
  });
  return {
    driveFileId: res.data.id,
    name: res.data.name,
    mimeType: res.data.mimeType,
    webViewLink: res.data.webViewLink || null,
    size: Number(res.data.size) || file.buffer.length,
    kind: file.kind,
    hash: file.hash
  };
}

async function trashQuietly(drive, fileIds) {
  await Promise.all(fileIds.map((id) =>
    drive.files.update({ fileId: id, requestBody: { trashed: true } })
      .catch((e) => logger.warn("trash failed", id, e.message))
  ));
}

/* ---------- Drive connection (admin) ---------- */

export const driveAuthUrl = onCall({ secrets: SECRETS }, async (request) => {
  await requireAdmin(request);
  const state = crypto.randomBytes(24).toString("hex");
  await OAUTH_STATE.set({ state, expiresAt: Date.now() + 10 * 60 * 1000 });
  const url = oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [driveScope(), "openid", "email"],
    state,
    login_hint: ADMIN_EMAIL
  });
  return { url };
});

export const driveCallback = onRequest({ secrets: SECRETS }, async (req, res) => {
  const back = (status) => res.redirect(`${APP_URL.value()}#/settings?drive=${status}`);
  try {
    const { code, state, error } = req.query;
    if (error) return back("cancelled");

    const saved = (await OAUTH_STATE.get()).data();
    await OAUTH_STATE.delete();
    if (!saved || saved.state !== state || saved.expiresAt < Date.now() || !code) return back("expired");

    const client = oauthClient();
    const { tokens } = await client.getToken(String(code));
    const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: CLIENT_ID.value() });
    const email = ticket.getPayload()?.email?.toLowerCase();
    if (email !== ADMIN_EMAIL) return back("wrong-account");
    if (!tokens.refresh_token) return back("no-refresh-token");
    if (!String(tokens.scope || "").includes(driveScope())) return back("missing-scope");

    client.setCredentials(tokens);
    const drive = driveApi({ version: "v3", auth: client });

    let folder;
    const targetId = DRIVE_FOLDER_ID.value();
    if (targetId) {
      try {
        folder = (await drive.files.get({ fileId: targetId, fields: "id,name,webViewLink" })).data;
      } catch (e) {
        logger.error("target folder not reachable", e.message);
        return back("folder-not-found");
      }
    } else {
      const current = (await DRIVE_CONFIG.get()).data();
      if (current?.folderId) {
        folder = (await drive.files.get({ fileId: current.folderId, fields: "id,name,webViewLink,trashed" })
          .then((r) => (r.data.trashed ? null : r.data)).catch(() => null));
      }
      if (!folder) {
        folder = (await drive.files.create({
          requestBody: { name: APP_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" },
          fields: "id,name,webViewLink"
        })).data;
      }
    }

    await DRIVE_SECRET.set({ refreshToken: tokens.refresh_token, email, connectedAt: FieldValue.serverTimestamp() });
    const previous = (await DRIVE_CONFIG.get()).data();
    await DRIVE_CONFIG.set({
      connected: true,
      email,
      folderId: folder.id,
      folderName: folder.name,
      folderLink: folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`,
      years: previous?.folderId === folder.id ? (previous.years || {}) : {},
      connectedAt: FieldValue.serverTimestamp()
    });
    return back("connected");
  } catch (e) {
    logger.error("drive callback failed", e);
    return back("error");
  }
});

/* ---------- receipts ---------- */

export const saveReceipt = onCall({ secrets: SECRETS, timeoutSeconds: 120, memory: "512MiB" }, async (request) => {
  const user = await requireAllowed(request);
  const receipt = cleanReceipt(request.data?.receipt);
  const files = decodeFiles(request.data?.files || []);
  if (!files.length) throw new HttpsError("invalid-argument", "יש לצרף לפחות קובץ אחד");

  const drive = await getDrive();
  const uploaded = [];
  try {
    for (const [index, file] of files.entries()) {
      uploaded.push(await uploadFile(drive, file, {
        purchaseMs: receipt.purchaseDate.toMillis(),
        store: receipt.store,
        productName: receipt.productName,
        index
      }));
    }
    const ref = db.collection("receipts").doc();
    await ref.set({
      ...receipt,
      files: uploaded.map(({ hash, ...f }) => f),
      fileHashes: uploaded.map((f) => f.hash),
      createdBy: user.email,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    return { id: ref.id };
  } catch (e) {
    await trashQuietly(drive, uploaded.map((f) => f.driveFileId));
    if (e instanceof HttpsError) throw e;
    logger.error("saveReceipt failed", e);
    throw new HttpsError("internal", "השמירה נכשלה");
  }
});

export const addFile = onCall({ secrets: SECRETS, timeoutSeconds: 120, memory: "512MiB" }, async (request) => {
  await requireAllowed(request);
  const receiptId = String(request.data?.receiptId || "");
  const [file] = decodeFiles([request.data?.file]);
  const ref = db.collection("receipts").doc(receiptId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "הקבלה לא נמצאה");
  const r = snap.data();

  const drive = await getDrive();
  const meta = await uploadFile(drive, file, {
    purchaseMs: r.purchaseDate.toMillis(),
    store: r.store,
    productName: r.productName,
    index: (r.files || []).length
  });
  const { hash, ...entry } = meta;
  await ref.update({
    files: FieldValue.arrayUnion(entry),
    fileHashes: FieldValue.arrayUnion(hash),
    updatedAt: FieldValue.serverTimestamp()
  });
  return { file: entry };
});

export const removeFile = onCall({ secrets: SECRETS }, async (request) => {
  await requireAllowed(request);
  const { receiptId, driveFileId } = request.data || {};
  const ref = db.collection("receipts").doc(String(receiptId || ""));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "הקבלה לא נמצאה");
  const files = snap.data().files || [];
  if (!files.some((f) => f.driveFileId === driveFileId)) throw new HttpsError("not-found", "הקובץ לא נמצא");
  if (files.length === 1) throw new HttpsError("failed-precondition", "לא ניתן למחוק את הקובץ האחרון");

  await trashQuietly(await getDrive(), [driveFileId]);
  await ref.update({ files: files.filter((f) => f.driveFileId !== driveFileId), updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

export const deleteReceipt = onCall({ secrets: SECRETS }, async (request) => {
  await requireAllowed(request);
  const ref = db.collection("receipts").doc(String(request.data?.receiptId || ""));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "הקבלה לא נמצאה");
  const ids = (snap.data().files || []).map((f) => f.driveFileId);
  if (ids.length) await trashQuietly(await getDrive(), ids);
  await ref.delete();
  return { ok: true };
});

export const getFile = onCall({ secrets: SECRETS, memory: "512MiB" }, async (request) => {
  await requireAllowed(request);
  const { receiptId, driveFileId } = request.data || {};
  const snap = await db.collection("receipts").doc(String(receiptId || "")).get();
  const file = snap.exists ? (snap.data().files || []).find((f) => f.driveFileId === driveFileId) : null;
  if (!file) throw new HttpsError("not-found", "הקובץ לא נמצא");

  const drive = await getDrive();
  const res = await drive.files.get({ fileId: driveFileId, alt: "media" }, { responseType: "arraybuffer" });
  return {
    name: file.name,
    mimeType: file.mimeType,
    data: Buffer.from(res.data).toString("base64")
  };
});
