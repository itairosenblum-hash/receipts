// מסמכים רפואיים: מודול נפרד מהקבלות.
// אוסף Firestore משלו (medical), בני משפחה (medicalMembers), תיקיית דרייב משלו ("מסמכים רפואיים")
// עם תת-תיקייה לכל בן משפחה, ופרומפט סריקה משלו. אין שום חיבור לאוספים של הקבלות.
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";
import { Readable } from "node:stream";
import {
  db, SECRETS, GEMINI_API_KEY, GEMINI_MODEL,
  requireAllowed, getDrive, localDateParts, slug, extension, driveQ, decodeFilesWith, trashQuietly
} from "./shared.js";

const COLLECTION = "medical";
const MEMBERS = "medicalMembers";
const FOLDER_NAME = "מסמכים רפואיים";
const NO_MEMBER_FOLDER = "כללי";
const MEDICAL_DRIVE = db.doc("config/medicalDrive");
const FILE_KINDS = { document: "מסמך" };

// חייב להיות זהה לרשימה ב-web/medical.js
const DOC_TYPES = {
  visit: "סיכום ביקור",
  lab: "בדיקות מעבדה",
  imaging: "הדמיה",
  prescription: "מרשם",
  referral: "הפניה",
  approval: "התחייבות / טופס 17",
  hospital: "אשפוז / שחרור",
  vaccine: "חיסונים",
  sick_note: "אישור מחלה",
  other: "אחר"
};

const decodeFiles = (files) => decodeFilesWith(files, FILE_KINDS, "document");

async function loadMembers() {
  const snap = await db.collection(MEMBERS).get();
  return snap.docs.map((d) => ({ id: d.id, name: String(d.data().name || "") }));
}

/* ---------- validation ---------- */

function cleanDoc(d, memberIds) {
  if (!d || typeof d !== "object") throw new HttpsError("invalid-argument", "נתוני מסמך חסרים");
  const date = Number(d.date);
  if (!Number.isFinite(date)) throw new HttpsError("invalid-argument", "תאריך לא תקין");
  const title = String(d.title || "").trim().slice(0, 120);
  if (!title) throw new HttpsError("invalid-argument", "חסר תיאור למסמך");
  // בן משפחה שנמחק בינתיים: המסמך נשמר בלי שיוך
  const memberId = memberIds.includes(String(d.memberId || "")) ? String(d.memberId) : "";
  const tags = Array.isArray(d.tags)
    ? [...new Set(d.tags.map((t) => String(t).trim().slice(0, 30)).filter(Boolean))].slice(0, 10)
    : [];
  return {
    memberId,
    docType: DOC_TYPES[d.docType] ? d.docType : "other",
    title,
    provider: String(d.provider || "").trim().slice(0, 80),
    date: Timestamp.fromMillis(date),
    tags,
    notes: String(d.notes || "").trim().slice(0, 1000)
  };
}

/* ---------- Drive folders ---------- */

async function findOrCreateFolder(drive, name, parent) {
  const q = [
    `name = '${driveQ(name)}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
    parent ? `'${parent}' in parents` : "'root' in parents"
  ].join(" and ");
  const existing = await drive.files.list({ q, fields: "files(id,webViewLink)", pageSize: 1 });
  if (existing.data.files?.[0]) return existing.data.files[0];
  const created = await drive.files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", ...(parent ? { parents: [parent] } : {}) },
    fields: "id,webViewLink"
  });
  return created.data;
}

// תיקיית "מסמכים רפואיים" בשורש הדרייב, נפרדת מתיקיית הקבלות. נוצרת בשמירה הראשונה.
async function rootFolder(drive) {
  const cfg = (await MEDICAL_DRIVE.get()).data() || {};
  if (cfg.folderId) {
    const alive = await drive.files.get({ fileId: cfg.folderId, fields: "id,trashed" })
      .then((r) => !r.data.trashed).catch(() => false);
    if (alive) return cfg.folderId;
  }
  const folder = await findOrCreateFolder(drive, FOLDER_NAME, null);
  await MEDICAL_DRIVE.set({
    folderId: folder.id,
    folderLink: folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`,
    members: {}
  });
  return folder.id;
}

// תת-תיקייה לבן משפחה (או "כללי" למסמך בלי שיוך)
async function memberFolder(drive, memberId, members) {
  const root = await rootFolder(drive);
  const key = memberId || "_none";
  const cfg = (await MEDICAL_DRIVE.get()).data() || {};
  if (cfg.members?.[key]) return cfg.members[key];
  const name = memberId ? (members.find((m) => m.id === memberId)?.name || NO_MEMBER_FOLDER) : NO_MEMBER_FOLDER;
  const folder = await findOrCreateFolder(drive, slug(name, 40) || NO_MEMBER_FOLDER, root);
  await MEDICAL_DRIVE.set({ members: { [key]: folder.id } }, { merge: true });
  return folder.id;
}

async function uploadFile(drive, file, { doc, members, index }) {
  const parent = await memberFolder(drive, doc.memberId, members);
  const { date } = localDateParts(doc.date.toMillis());
  const numSuffix = index > 0 ? `_${index + 1}` : "";
  const name = [date, slug(doc.title, 40), slug(doc.provider)].filter(Boolean).join("_")
    + numSuffix + "." + extension(file.mimeType, file.originalName);
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

async function getDocOrThrow(id) {
  const ref = db.collection(COLLECTION).doc(String(id || ""));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "המסמך לא נמצא");
  return { ref, data: snap.data() };
}

/* ---------- Gemini scanning ---------- */

const SCAN_INSTRUCTIONS = `You extract filing metadata from personal medical documents, usually Israeli and in Hebrew
(סיכום ביקור, תוצאות בדיקות, מרשם, הפניה, התחייבות / טופס 17, מכתב שחרור, אישור מחלה, פנקס חיסונים).
This is for organizing a family archive. Extract only what is needed to file the document, never medical interpretation.
Rules:
- docType: exactly one of the type ids given.
- title: a short Hebrew label (2 to 6 words) naming the document by its type and specialty, test or body area as printed,
  for example "ביקור אורתופד", "ספירת דם", "צילום חזה", "מרשם אנטיביוטיקה", "הפניה לרופא עיניים".
  Do not put findings, results, values or diagnoses in the title.
- provider: the doctor and/or institution as printed (for example "ד"ר כהן, מכבי" or "בית חולים איכילוב"), or null.
- date: the date the document refers to (visit, test or issue date), YYYY-MM-DD. Israeli documents print dates day first (DD/MM/YYYY).
- memberId: the family member the document is about. Match the patient name printed on the document to the family members list
  (a matching first name is enough when it is unique in the list). If no patient name is printed or none matches, null.
- Never output ID numbers (תעודת זהות), phone numbers or addresses.
- tags: up to 3 short Hebrew tags useful for search (specialty, body area, HMO). Prefer existing tags when they fit.
- Use null for anything not on the document. Never invent.
- confidence: 0 to 1 per field, honest. Use below 0.7 when the text is blurry, cut off or ambiguous.`;

const SCAN_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    docType: { type: Type.STRING },
    title: { type: Type.STRING, nullable: true },
    provider: { type: Type.STRING, nullable: true },
    date: { type: Type.STRING, nullable: true, description: "YYYY-MM-DD" },
    memberId: { type: Type.STRING, nullable: true },
    tags: { type: Type.ARRAY, items: { type: Type.STRING } },
    confidence: {
      type: Type.OBJECT,
      properties: {
        docType: { type: Type.NUMBER },
        title: { type: Type.NUMBER },
        provider: { type: Type.NUMBER },
        date: { type: Type.NUMBER },
        memberId: { type: Type.NUMBER }
      }
    }
  },
  required: ["docType", "title", "provider", "date", "memberId", "tags", "confidence"],
  propertyOrdering: ["docType", "title", "provider", "date", "memberId", "tags", "confidence"]
};

export const scanMedical = onCall({ secrets: [GEMINI_API_KEY], timeoutSeconds: 300, memory: "512MiB" }, async (request) => {
  await requireAllowed(request);
  const files = decodeFiles(request.data?.files || []).slice(0, 3);
  if (!files.length) throw new HttpsError("invalid-argument", "אין קובץ לסריקה");

  const [members, tagSnap] = await Promise.all([
    loadMembers(),
    db.collection(COLLECTION).orderBy("createdAt", "desc").limit(200).select("tags").get()
  ]);
  const existingTags = [...new Set(tagSnap.docs.flatMap((d) => d.data().tags || []))].slice(0, 60);
  const memberIds = members.map((m) => m.id);

  const context = [
    "Document types (id: name):",
    ...Object.entries(DOC_TYPES).map(([id, name]) => `- ${id}: ${name}`),
    members.length ? "\nFamily members (id: name):" : "\nNo family members defined: memberId must be null.",
    ...members.map((m) => `- ${m.id}: ${m.name}`),
    existingTags.length ? `\nExisting tags: ${existingTags.join(", ")}` : "",
    `\nToday is ${localDateParts(Date.now()).date}.`
  ].filter(Boolean).join("\n");

  const schema = structuredClone(SCAN_SCHEMA);
  schema.properties.docType.enum = Object.keys(DOC_TYPES);

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
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
      }
    });
    result = JSON.parse(res.text);
  } catch (e) {
    logger.error("gemini medical scan failed", e?.message);
    const timedOut = /timeout|aborted/i.test(String(e?.message || e?.cause?.message || ""));
    throw new HttpsError("internal", timedOut
      ? "הסריקה לקחה יותר מדי זמן. נסו סריקה חוזרת או מלאו ידנית."
      : "הסריקה נכשלה. אפשר למלא את הפרטים ידנית.");
  }

  const date = typeof result.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(result.date) && !isNaN(Date.parse(result.date)) ? result.date : null;
  return {
    model: GEMINI_MODEL.value(),
    docType: DOC_TYPES[result.docType] ? result.docType : "other",
    title: result.title ? String(result.title).trim().slice(0, 120) : null,
    provider: result.provider ? String(result.provider).trim().slice(0, 80) : null,
    date,
    memberId: memberIds.includes(result.memberId) ? result.memberId : null,
    tags: Array.isArray(result.tags) ? result.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 3) : [],
    confidence: result.confidence || {}
  };
});

/* ---------- documents ---------- */

export const saveMedical = onCall({ secrets: SECRETS, timeoutSeconds: 120, memory: "512MiB" }, async (request) => {
  const user = await requireAllowed(request);
  const members = await loadMembers();
  const doc = cleanDoc(request.data?.doc, members.map((m) => m.id));
  const files = decodeFiles(request.data?.files || []);
  if (!files.length) throw new HttpsError("invalid-argument", "יש לצרף לפחות קובץ אחד");

  const drive = await getDrive();
  const uploaded = [];
  try {
    for (const [index, file] of files.entries()) {
      uploaded.push(await uploadFile(drive, file, { doc, members, index }));
    }
    const ref = db.collection(COLLECTION).doc();
    await ref.set({
      ...doc,
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
    logger.error("saveMedical failed", e?.message);
    throw new HttpsError("internal", "השמירה נכשלה");
  }
});

// עריכה עוברת דרך השרת: אם בן המשפחה השתנה, הקבצים עוברים לתיקייה שלו בדרייב
export const updateMedical = onCall({ secrets: SECRETS }, async (request) => {
  await requireAllowed(request);
  const members = await loadMembers();
  const { ref, data } = await getDocOrThrow(request.data?.id);
  const doc = cleanDoc(request.data?.doc, members.map((m) => m.id));

  if ((data.memberId || "") !== doc.memberId && (data.files || []).length) {
    const drive = await getDrive();
    const target = await memberFolder(drive, doc.memberId, members);
    await Promise.all((data.files || []).map(async (f) => {
      try {
        const meta = await drive.files.get({ fileId: f.driveFileId, fields: "parents" });
        await drive.files.update({
          fileId: f.driveFileId,
          addParents: target,
          removeParents: (meta.data.parents || []).join(","),
          fields: "id"
        });
      } catch (e) {
        logger.warn("move failed", f.driveFileId, e.message);
      }
    }));
  }
  await ref.update({ ...doc, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

export const addMedicalFile = onCall({ secrets: SECRETS, timeoutSeconds: 120, memory: "512MiB" }, async (request) => {
  await requireAllowed(request);
  const [file] = decodeFiles([request.data?.file]);
  const { ref, data } = await getDocOrThrow(request.data?.id);
  const members = await loadMembers();
  const drive = await getDrive();
  const meta = await uploadFile(drive, file, { doc: data, members, index: (data.files || []).length });
  const { hash, ...entry } = meta;
  await ref.update({
    files: FieldValue.arrayUnion(entry),
    fileHashes: FieldValue.arrayUnion(hash),
    updatedAt: FieldValue.serverTimestamp()
  });
  return { file: entry };
});

export const removeMedicalFile = onCall({ secrets: SECRETS }, async (request) => {
  await requireAllowed(request);
  const { driveFileId } = request.data || {};
  const { ref, data } = await getDocOrThrow(request.data?.id);
  const files = data.files || [];
  if (!files.some((f) => f.driveFileId === driveFileId)) throw new HttpsError("not-found", "הקובץ לא נמצא");
  if (files.length === 1) throw new HttpsError("failed-precondition", "לא ניתן למחוק את הקובץ האחרון");
  await trashQuietly(await getDrive(), [driveFileId]);
  await ref.update({ files: files.filter((f) => f.driveFileId !== driveFileId), updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

export const deleteMedical = onCall({ secrets: SECRETS }, async (request) => {
  await requireAllowed(request);
  const { ref, data } = await getDocOrThrow(request.data?.id);
  const ids = (data.files || []).map((f) => f.driveFileId);
  if (ids.length) await trashQuietly(await getDrive(), ids);
  await ref.delete();
  return { ok: true };
});

export const getMedicalFile = onCall({ secrets: SECRETS, memory: "512MiB" }, async (request) => {
  await requireAllowed(request);
  const { driveFileId } = request.data || {};
  const { data } = await getDocOrThrow(request.data?.id);
  const file = (data.files || []).find((f) => f.driveFileId === driveFileId);
  if (!file) throw new HttpsError("not-found", "הקובץ לא נמצא");
  const drive = await getDrive();
  const res = await drive.files.get({ fileId: driveFileId, alt: "media" }, { responseType: "arraybuffer" });
  return { name: file.name, mimeType: file.mimeType, data: Buffer.from(res.data).toString("base64") };
});

// שינוי שם של בן משפחה: גם התיקייה שלו בדרייב מקבלת את השם החדש
export const renameMedicalMember = onCall({ secrets: SECRETS }, async (request) => {
  await requireAllowed(request);
  const id = String(request.data?.id || "");
  const name = String(request.data?.name || "").trim().slice(0, 40);
  if (!id || !name) throw new HttpsError("invalid-argument", "חסר שם");
  const ref = db.collection(MEMBERS).doc(id);
  if (!(await ref.get()).exists) throw new HttpsError("not-found", "בן המשפחה לא נמצא");
  await ref.update({ name });
  const folderId = (await MEDICAL_DRIVE.get()).data()?.members?.[id];
  if (folderId) {
    try {
      await (await getDrive()).files.update({ fileId: folderId, requestBody: { name: slug(name, 40) || name } });
    } catch (e) {
      logger.warn("folder rename failed", e.message);
    }
  }
  return { ok: true };
});
