// חיפוש בתוך תוכן המסמכים: Gemini מתמלל את הטקסט של כל קבלה ומסמך רפואי, והטקסט נשמר באוסף searchIndex
// (מסמך אחד לכל קבלה / מסמך רפואי). הדפדפן טוען את האינדקס רק כשמחפשים, ומחפש בו מקומית.
import { FieldValue } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
import { db, SECRETS, GEMINI_API_KEY, GEMINI_MODEL, requireAllowed, getDrive } from "./shared.js";

const KINDS = ["receipts", "medical"];
const MAX_TEXT = 8000;
const BATCH = 8;
const CONCURRENCY = 3;

const indexRef = (kind, id) => db.collection("searchIndex").doc(`${kind}_${id}`);
// מזהה לגרסת הקבצים של המסמך: הוספה או מחיקה של קובץ מחייבת תמלול מחדש
const fileKey = (data) => (data.files || []).map((f) => f.driveFileId).sort().join(",");

// אותיות קטנות, בלי ניקוד וטעמים, ורווח יחיד. גם הדפדפן מנרמל כך את מילות החיפוש
export function normalizeText(s) {
  return String(s || "").toLowerCase().replace(/[֑-ׇ]/g, "").replace(/\s+/g, " ").trim();
}

const PROMPT = `Transcribe all readable text in these document pages, in reading order, as plain text.
Keep the original language (usually Hebrew). Include product names, doctor and clinic names, test names, medication names,
diagnoses, numbers and dates exactly as printed. Do not summarize, translate, explain or add anything. If there is no text, return an empty string.`;

async function transcribe(drive, files) {
  const parts = [];
  let total = 0;
  for (const f of files.slice(0, 4)) {
    const res = await drive.files.get({ fileId: f.driveFileId, alt: "media" }, { responseType: "arraybuffer" });
    const buf = Buffer.from(res.data);
    total += buf.length;
    if (total > 15 * 1024 * 1024) break;
    parts.push({ inlineData: { mimeType: f.mimeType, data: buf.toString("base64") } });
  }
  if (!parts.length) return "";
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY.value(), httpOptions: { timeout: 120000 } });
  const res = await ai.models.generateContent({
    model: GEMINI_MODEL.value(),
    contents: [{ role: "user", parts: [...parts, { text: PROMPT }] }],
    config: { temperature: 0, maxOutputTokens: 6000, thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } }
  });
  return normalizeText(res.text).slice(0, MAX_TEXT);
}

async function indexOne(drive, kind, id, data) {
  const key = fileKey(data);
  let text = "";
  try {
    text = await transcribe(drive, data.files || []);
  } catch (e) {
    logger.warn("transcribe failed", kind, id, e?.message);
    // נכשל: נשמר בלי טקסט כדי לא לנסות בלי סוף; ייעשה שוב רק אם הקבצים ישתנו או בבקשה מפורשת
    await indexRef(kind, id).set({ kind, docId: id, text: "", fileKey: key, failed: true, indexedAt: FieldValue.serverTimestamp() });
    return false;
  }
  await indexRef(kind, id).set({ kind, docId: id, text, fileKey: key, failed: false, indexedAt: FieldValue.serverTimestamp() });
  return true;
}

// תמלול של מסמך אחד מיד אחרי שמירה (הדפדפן קורא לזה ברקע)
export const indexDoc = onCall({ secrets: [...SECRETS, GEMINI_API_KEY], timeoutSeconds: 300, memory: "1GiB" }, async (request) => {
  await requireAllowed(request);
  const kind = String(request.data?.kind || "");
  const id = String(request.data?.id || "");
  if (!KINDS.includes(kind) || !id) throw new HttpsError("invalid-argument", "בקשה לא תקינה");
  const snap = await db.collection(kind).doc(id).get();
  if (!snap.exists) throw new HttpsError("not-found", "המסמך לא נמצא");
  const ok = await indexOne(await getDrive(), kind, id, snap.data());
  return { ok };
});

// משלים תמלול למסמכים שעוד אין להם (או שהקבצים שלהם השתנו), עד 8 בכל קריאה. retryFailed: גם כאלה שנכשלו
export const indexPending = onCall({ secrets: [...SECRETS, GEMINI_API_KEY], timeoutSeconds: 540, memory: "1GiB" }, async (request) => {
  await requireAllowed(request);
  const retryFailed = request.data?.retryFailed === true;
  // בניסיון חוזר: רק מסמכים שנכשלו לפני תחילת הסבב הנוכחי, כדי לא לחזור שוב ושוב על אותו מסמך
  const since = Number(request.data?.since) || 0;
  // גודל מנה קטן נותן לדפדפן עדכוני התקדמות תכופים יותר
  const size = Math.max(1, Math.min(BATCH, parseInt(request.data?.batch, 10) || BATCH));
  const indexSnap = await db.collection("searchIndex").select("fileKey", "failed", "indexedAt").get();
  const existing = new Map(indexSnap.docs.map((d) => [d.id, d.data()]));
  const pending = [];
  let total = 0;
  for (const kind of KINDS) {
    const snap = await db.collection(kind).select("files").get();
    total += snap.size;
    for (const d of snap.docs) {
      const ix = existing.get(`${kind}_${d.id}`);
      const data = d.data();
      if (!(data.files || []).length) continue;
      if (!ix || ix.fileKey !== fileKey(data) || (retryFailed && ix.failed && (!since || (ix.indexedAt?.toMillis?.() || 0) < since))) pending.push({ kind, id: d.id, data });
    }
  }
  const failed = indexSnap.docs.filter((d) => d.data().failed).length;
  if (request.data?.dryRun) return { done: 0, remaining: pending.length, total, failed };
  const batch = pending.slice(0, size);
  if (batch.length) {
    const drive = await getDrive();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, async () => {
      while (next < batch.length) {
        const item = batch[next++];
        await indexOne(drive, item.kind, item.id, item.data);
      }
    }));
  }
  return { done: batch.length, remaining: pending.length - batch.length, total, failed };
});

// מחיקת האינדקס של מסמך שנמחק
export async function removeFromIndex(kind, id) {
  await indexRef(kind, id).delete().catch(() => {});
}
