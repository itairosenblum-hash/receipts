import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, onRequest, HttpsError } from "firebase-functions/v2/https";
import { setGlobalOptions, logger } from "firebase-functions/v2";
import { defineSecret, defineString } from "firebase-functions/params";
import { OAuth2Client } from "google-auth-library";
import { drive as driveApi } from "@googleapis/drive";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { Readable } from "node:stream";
import crypto from "node:crypto";

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: "europe-west1", maxInstances: 5 });

/* ---------- configuration ---------- */

const CLIENT_ID = defineSecret("GOOGLE_OAUTH_CLIENT_ID");
const CLIENT_SECRET = defineSecret("GOOGLE_OAUTH_CLIENT_SECRET");
const DRIVE_FOLDER_ID = defineString("DRIVE_FOLDER_ID", { default: "" });
const APP_URL = defineString("APP_URL", { default: "https://itairosenblum-hash.github.io/receipts/" });
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = defineString("GEMINI_MODEL", { default: "gemini-3.8-flash" });

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

const numOrNull = (v) => (v === null || v === "" || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));

// קבלה מכילה רשימת מוצרים; לכל מוצר אחריות משלו. השדות העליונים (productName, warrantyEnd) הם סיכום לתצוגה ולחיפוש.
function cleanReceipt(r) {
  if (!r || typeof r !== "object") throw new HttpsError("invalid-argument", "נתוני קבלה חסרים");
  const purchaseDate = Number(r.purchaseDate);
  if (!Number.isFinite(purchaseDate)) throw new HttpsError("invalid-argument", "תאריך לא תקין");
  const amount = numOrNull(r.amount);

  const rawItems = Array.isArray(r.items) && r.items.length ? r.items : [r];
  const items = rawItems.slice(0, 30).map((it) => {
    const warrantyMonths = Math.max(0, Math.min(240, parseInt(it?.warrantyMonths, 10) || 0));
    return {
      name: String(it?.name ?? it?.productName ?? "").trim().slice(0, 120),
      printedName: String(it?.printedName || "").trim().slice(0, 160),
      price: numOrNull(it?.price),
      warrantyMonths,
      warrantyEnd: warrantyMonths ? Timestamp.fromMillis(addMonths(purchaseDate, warrantyMonths)) : null,
      serialNumber: String(it?.serialNumber || "").trim().slice(0, 80)
    };
  }).filter((it) => it.name);
  if (!items.length) throw new HttpsError("invalid-argument", "חסר שם מוצר");

  const ends = items.map((it) => it.warrantyEnd?.toMillis()).filter(Boolean);
  const tags = Array.isArray(r.tags)
    ? [...new Set(r.tags.map((t) => String(t).trim().slice(0, 30)).filter(Boolean))].slice(0, 10)
    : [];
  return {
    productName: items[0].name,
    itemNames: items.flatMap((it) => [it.name, it.printedName].filter(Boolean)),
    items,
    store: String(r.store || "").trim().slice(0, 80),
    amount,
    currency: /^[A-Z]{3}$/.test(r.currency) ? r.currency : "ILS",
    purchaseDate: Timestamp.fromMillis(purchaseDate),
    hasTime: !!r.hasTime,
    categoryId: String(r.categoryId || "other").slice(0, 40),
    tags,
    warrantyEnd: ends.length ? Timestamp.fromMillis(Math.max(...ends)) : null,
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

// האפליקציה מוגשת מכמה כתובות; חוזרים לזו שממנה התחיל החיבור, רק אם היא ברשימה המותרת
function allowedReturnUrl(url) {
  const allowed = [
    APP_URL.value(),
    `https://${projectId()}.web.app/`,
    `https://${projectId()}.firebaseapp.com/`,
    "https://itairosenblum-hash.github.io/receipts/"
  ];
  return allowed.find((a) => typeof url === "string" && url.split("#")[0] === a) || APP_URL.value();
}

export const driveAuthUrl = onCall({ secrets: SECRETS }, async (request) => {
  await requireAdmin(request);
  const state = crypto.randomBytes(24).toString("hex");
  const returnUrl = allowedReturnUrl(request.data?.returnUrl);
  await OAUTH_STATE.set({ state, returnUrl, expiresAt: Date.now() + 10 * 60 * 1000 });
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
  let returnUrl = APP_URL.value();
  const back = (status) => res.redirect(`${returnUrl}#/settings?drive=${status}`);
  try {
    const { code, state, error } = req.query;
    const saved = (await OAUTH_STATE.get()).data();
    if (saved?.returnUrl) returnUrl = allowedReturnUrl(saved.returnUrl);
    if (error) return back("cancelled");

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

/* ---------- Gemini scanning ---------- */

const SCAN_INSTRUCTIONS = `You extract structured data from purchase receipts and tax invoices, usually Israeli and in Hebrew (קבלה, חשבונית מס, חשבונית מס/קבלה).
Rules:
- store: the business name as printed (Hebrew if printed in Hebrew). Drop legal suffixes like בע"מ unless they are part of the brand.
- items: every product line the customer bought, in the order printed. One entry per distinct product (merge quantity lines; price = that line's total).
  Skip lines that are not products: delivery, installation, bags, fees, deposits, rounding, discounts, coupons, payment lines and VAT lines.
  A purchased extended warranty is not a product: apply its period to the product it covers.
  - name: a clear, recognizable product name a person would use: brand + product line + model + key variant (capacity, size, color).
    Receipts often print only codes or specs (for example "12GB+512GB - כחול - F966BE"). Use your knowledge of model numbers to identify the product
    (F966B is Samsung Galaxy Z Fold7, so "Samsung Galaxy Z Fold7 512GB כחול"). Write it in Hebrew where natural, keeping brand and model names in Latin letters.
    If you cannot identify the product with confidence, use the printed text cleaned up, and lower confidence.items.
  - printedName: the product line exactly as printed on the receipt.
  - price: the line total as a number, or null.
  - warrantyMonths: ONLY if the document explicitly states a warranty period for that product (אחריות X שנים / חודשים). Then warrantyFromReceipt=true. Otherwise warrantyMonths=null and warrantyFromReceipt=false. Never estimate or use a typical value.
  - serialNumber: only if printed for that product (מס' סידורי, S/N, IMEI), else null.
- amount: the total actually paid including VAT (סה"כ לתשלום), as a number.
- currency: ISO code. ₪ / ש"ח / NIS = ILS.
- purchaseDate: YYYY-MM-DD. Israeli receipts print dates as DD/MM/YY or DD/MM/YYYY (day first).
- purchaseTime: HH:MM in 24h, or null.
- categoryId: exactly one of the category ids given, for the receipt as a whole (by its main product). Follow the user's past corrections when a similar product appears.
- tags: up to 3 short Hebrew tags useful for search (room, use, occasion). Prefer existing tags when they fit.
- Use null for anything not on the document. Never invent dates, amounts or products.
- confidence: 0 to 1 per field, honest. Use below 0.7 when the text is blurry, cut off or ambiguous.`;

const SCAN_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    store: { type: Type.STRING, nullable: true },
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          printedName: { type: Type.STRING, nullable: true },
          price: { type: Type.NUMBER, nullable: true },
          warrantyMonths: { type: Type.INTEGER, nullable: true },
          warrantyFromReceipt: { type: Type.BOOLEAN },
          serialNumber: { type: Type.STRING, nullable: true }
        },
        required: ["printedName", "name", "price", "warrantyMonths", "warrantyFromReceipt"],
        propertyOrdering: ["printedName", "name", "price", "warrantyMonths", "warrantyFromReceipt", "serialNumber"]
      }
    },
    amount: { type: Type.NUMBER, nullable: true },
    currency: { type: Type.STRING, nullable: true },
    purchaseDate: { type: Type.STRING, nullable: true, description: "YYYY-MM-DD" },
    purchaseTime: { type: Type.STRING, nullable: true, description: "HH:MM" },
    categoryId: { type: Type.STRING },
    tags: { type: Type.ARRAY, items: { type: Type.STRING } },
    confidence: {
      type: Type.OBJECT,
      properties: {
        store: { type: Type.NUMBER },
        items: { type: Type.NUMBER },
        amount: { type: Type.NUMBER },
        purchaseDate: { type: Type.NUMBER },
        purchaseTime: { type: Type.NUMBER },
        categoryId: { type: Type.NUMBER }
      }
    }
  },
  required: ["store", "items", "amount", "purchaseDate", "categoryId", "tags", "confidence"],
  propertyOrdering: ["store", "items", "amount", "currency", "purchaseDate", "purchaseTime", "categoryId", "tags", "confidence"]
};

function cleanAi(ai) {
  if (!ai || typeof ai !== "object") return null;
  const str = (v, max = 120) => (v == null ? null : String(v).slice(0, max));
  return {
    model: str(ai.model, 60),
    store: str(ai.store),
    items: Array.isArray(ai.items)
      ? ai.items.slice(0, 30).map((it) => ({ name: str(it?.name), printedName: str(it?.printedName, 160), price: numOrNull(it?.price), warrantyMonths: numOrNull(it?.warrantyMonths) }))
      : [],
    amount: numOrNull(ai.amount),
    purchaseDate: str(ai.purchaseDate, 10),
    purchaseTime: str(ai.purchaseTime, 5),
    categoryId: str(ai.categoryId, 40)
  };
}

export const scanReceipt = onCall({ secrets: [GEMINI_API_KEY], timeoutSeconds: 300, memory: "512MiB" }, async (request) => {
  await requireAllowed(request);
  const files = decodeFiles(request.data?.files || []).slice(0, 3);
  if (!files.length) throw new HttpsError("invalid-argument", "אין קובץ לסריקה");

  const [catSnap, corrSnap, recSnap] = await Promise.all([
    db.collection("categories").orderBy("order").get(),
    db.collection("corrections").orderBy("createdAt", "desc").limit(10).get(),
    db.collection("receipts").orderBy("createdAt", "desc").limit(200).select("tags").get()
  ]);
  const categories = catSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  if (!categories.length) categories.push({ id: "other", name: "אחר", warrantyMonths: 0 });
  const ids = categories.map((c) => c.id);
  const corrections = corrSnap.docs.map((d) => d.data());
  const existingTags = [...new Set(recSnap.docs.flatMap((d) => d.data().tags || []))].slice(0, 60);

  const context = [
    "Categories (id: name):",
    ...categories.map((c) => `- ${c.id}: ${c.name}`),
    corrections.length ? "\nPast corrections by the user (product → correct category):" : "",
    ...corrections.map((c) => `- "${c.productName}" from "${c.store}": not ${c.suggested}, correct is ${c.chosen}`),
    existingTags.length ? `\nExisting tags: ${existingTags.join(", ")}` : "",
    `\nToday is ${localDateParts(Date.now()).date}.`
  ].filter(Boolean).join("\n");

  const schema = structuredClone(SCAN_SCHEMA);
  schema.properties.categoryId.enum = ids;

  // מגבלת זמן לבקשה ל-Gemini, קצרה ממגבלת הפונקציה כדי להחזיר שגיאה ברורה במקום ניתוק
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY.value(), httpOptions: { timeout: 150000 } });
  let result;
  try {
    const res = await ai.models.generateContent({
      model: GEMINI_MODEL.value(),
      contents: [{
        role: "user",
        parts: [
          ...files.map((f) => ({ inlineData: { mimeType: f.mimeType, data: f.buffer.toString("base64") } })),
          { text: context }
        ]
      }],
      config: {
        systemInstruction: SCAN_INSTRUCTIONS,
        responseMimeType: "application/json",
        responseSchema: schema,
        temperature: 0,
        // קריאת קבלה לא דורשת חשיבה ארוכה; ברירת המחדל של המודל איטית מדי
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
      }
    });
    result = JSON.parse(res.text);
  } catch (e) {
    logger.error("gemini scan failed", e);
    const timedOut = /timeout|aborted/i.test(String(e?.message || e?.cause?.message || ""));
    throw new HttpsError("internal", timedOut
      ? "הסריקה לקחה יותר מדי זמן. נסו סריקה חוזרת או מלאו ידנית."
      : "הסריקה נכשלה. אפשר למלא את הפרטים ידנית.");
  }

  // ניקוי ובדיקות סבירות
  const valid = (re, v) => (typeof v === "string" && re.test(v) ? v : null);
  const date = valid(/^\d{4}-\d{2}-\d{2}$/, result.purchaseDate);
  return {
    model: GEMINI_MODEL.value(),
    store: result.store || null,
    items: (Array.isArray(result.items) ? result.items : []).slice(0, 30).map((it) => ({
      name: String(it?.name || it?.printedName || "").trim(),
      printedName: it?.printedName ? String(it.printedName).trim() : null,
      price: typeof it?.price === "number" && it.price >= 0 ? it.price : null,
      warrantyMonths: it?.warrantyFromReceipt && Number.isInteger(it?.warrantyMonths) && it.warrantyMonths > 0 && it.warrantyMonths <= 240 ? it.warrantyMonths : null,
      serialNumber: it?.serialNumber || null
    })).filter((it) => it.name),
    amount: typeof result.amount === "number" && result.amount >= 0 ? result.amount : null,
    currency: valid(/^[A-Z]{3}$/, result.currency) || "ILS",
    purchaseDate: date && !isNaN(Date.parse(date)) ? date : null,
    purchaseTime: valid(/^([01]\d|2[0-3]):[0-5]\d$/, result.purchaseTime),
    categoryId: ids.includes(result.categoryId) ? result.categoryId : "other",
    tags: Array.isArray(result.tags) ? result.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 3) : [],
    confidence: result.confidence || {}
  };
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
    const ai = cleanAi(request.data?.ai);
    const corrected = !!ai?.categoryId && ai.categoryId !== receipt.categoryId;
    const ref = db.collection("receipts").doc();
    await ref.set({
      ...receipt,
      files: uploaded.map(({ hash, ...f }) => f),
      fileHashes: uploaded.map((f) => f.hash),
      aiRaw: ai,
      corrected,
      createdBy: user.email,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    });
    if (corrected) {
      await db.collection("corrections").add({
        store: receipt.store,
        productName: receipt.productName,
        suggested: ai.categoryId,
        chosen: receipt.categoryId,
        createdAt: FieldValue.serverTimestamp()
      }).catch((e) => logger.warn("correction not saved", e.message));
    }
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
