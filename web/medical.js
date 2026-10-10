// מסמכים רפואיים: מודול נפרד מהקבלות.
// אוסף משלו (medical), בני משפחה (medicalMembers), פונקציות שרת משלו ותיקייה נפרדת בדרייב.
// מקבל מ-app.js רק עזרים כלליים (תצוגה, קבצים, חלון צפייה) ולא נוגע בנתוני הקבלות.
import {
  collection, doc, query, orderBy, onSnapshot, addDoc, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

// חייב להיות זהה לרשימה ב-functions/medical.js
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

const TYPE_STYLE = {
  visit: { fg: "#1F4E9C", bg: "#E2EAF7", icon: '<path d="M6 3v6a4 4 0 0 0 8 0V3"/><path d="M10 13v3a5 5 0 0 0 10 0v-2"/><circle cx="20" cy="12" r="2"/>' },
  lab: { fg: "#7C2D92", bg: "#F2E5F6", icon: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/><path d="M7.5 15h9"/>' },
  imaging: { fg: "#0E6378", bg: "#DDF0F4", icon: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 7v10M9 9h6M8.5 12h7M9 15h6"/>' },
  prescription: { fg: "#B4235A", bg: "#FBE3EC", icon: '<rect x="4" y="9" width="16" height="7" rx="3.5" transform="rotate(-45 12 12.5)"/><path d="M9.5 10l5 5"/>' },
  referral: { fg: "#A15C07", bg: "#FBEEDB", icon: '<path d="M4 12h13"/><path d="M13 7l5 5-5 5"/><path d="M20 4v16"/>' },
  approval: { fg: "#2D6A2E", bg: "#E1F1E1", icon: '<path d="M7 3h10v18H7z"/><path d="M9.5 12l2 2 3.5-4"/>' },
  hospital: { fg: "#B42318", bg: "#FBE4E1", icon: '<path d="M4 21V7l8-4 8 4v14"/><path d="M12 9v6M9 12h6"/><path d="M10 21v-3h4v3"/>' },
  vaccine: { fg: "#0F6E6A", bg: "#DCEFEC", icon: '<path d="M18 2l4 4M17 7l3-3M19 9l-8 8-4 1 1-4 8-8zM7 17l-4 4M10 10l4 4"/>' },
  sick_note: { fg: "#5B4BB0", bg: "#E9E6F7", icon: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 15h6M13 12v6"/>' },
  other: { fg: "#57534E", bg: "#EEECE8", icon: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 13h6M10 17h4"/>' }
};
const typeStyle = (id) => TYPE_STYLE[id] || TYPE_STYLE.other;

export function initMedical(ctx) {
  const {
    db, call, $, el, toast, busy, show, currentView, errMsg, norm,
    toDate, fmtDate, isoDate, fmtSize, prepareFile, filePayload, thumb, displayFile,
    MAX_TOTAL_BYTES, isAdmin, driveConnected
  } = ctx;

  let docs = [];
  let docsLoaded = false;
  let members = [];
  let medDrive = null;
  let memberFilter = "";

  const memberName = (id) => members.find((m) => m.id === id)?.name || "";

  function typeBadge(id, cls = "cat-badge") {
    const st = typeStyle(id);
    const span = el("span", { class: cls, "aria-hidden": "true", style: `background:${st.bg};color:${st.fg}` });
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${st.icon}</svg>`;
    return span;
  }

  /* ---------- data ---------- */

  function start(unsubs) {
    docs = [];
    docsLoaded = false;
    unsubs.push(onSnapshot(query(collection(db, "medical"), orderBy("date", "desc")), (snap) => {
      docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      docsLoaded = true;
      renderList();
      renderMembersCard();
      const v = currentView();
      if (v === "med-detail" || (v === "loading" && location.hash.startsWith("#/m"))) route(location.hash);
    }, (e) => toast(errMsg(e))));

    unsubs.push(onSnapshot(query(collection(db, "medicalMembers"), orderBy("order")), (snap) => {
      members = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderList();
      renderMembersCard();
      if (currentView() === "med-edit") renderMemberPick();
      if (currentView() === "med-detail" && detailId) openDetail(detailId);
    }, (e) => console.error(e)));

    unsubs.push(onSnapshot(doc(db, "config", "medicalDrive"), (snap) => {
      medDrive = snap.exists() ? snap.data() : null;
      renderMembersCard();
    }, () => {}));
  }

  /* ---------- list ---------- */

  const docYear = (d) => toDate(d.date)?.getFullYear();

  function fillFilters() {
    const typeSel = $("med-filter-type"), yearSel = $("med-filter-year");
    const type = typeSel.value, year = yearSel.value;
    const used = new Set(docs.map((d) => d.docType));
    typeSel.replaceChildren(el("option", { value: "", text: "כל הסוגים" }),
      ...Object.entries(DOC_TYPES).filter(([id]) => used.has(id)).map(([id, name]) => el("option", { value: id, text: name })));
    const years = [...new Set(docs.map(docYear).filter(Boolean))].sort((a, b) => b - a);
    yearSel.replaceChildren(el("option", { value: "", text: "כל השנים" }), ...years.map((y) => el("option", { value: String(y), text: String(y) })));
    typeSel.value = [...typeSel.options].some((o) => o.value === type) ? type : "";
    yearSel.value = [...yearSel.options].some((o) => o.value === year) ? year : "";
  }

  function renderList() {
    fillFilters();
    const term = norm($("med-search").value);
    const type = $("med-filter-type").value;
    const year = $("med-filter-year").value;
    if (memberFilter && memberFilter !== "_none" && !members.some((m) => m.id === memberFilter)) memberFilter = "";

    const base = docs.filter((d) => {
      if (type && d.docType !== type) return false;
      if (year && String(docYear(d)) !== year) return false;
      if (!term) return true;
      return [d.title, d.provider, DOC_TYPES[d.docType], memberName(d.memberId), d.notes, ...(d.tags || [])]
        .filter(Boolean).some((s) => String(s).toLowerCase().includes(term));
    });
    const matchMember = (d, f) => !f || (f === "_none" ? !d.memberId || !memberName(d.memberId) : d.memberId === f);
    const list = base.filter((d) => matchMember(d, memberFilter));

    // שבבי בני משפחה עם מונים
    const hasUnassigned = docs.some((d) => !d.memberId || !memberName(d.memberId));
    const chips = [["", "כולם"], ...members.map((m) => [m.id, m.name]), ...(hasUnassigned ? [["_none", "ללא שיוך"]] : [])];
    $("med-member-chips").replaceChildren(...chips.map(([id, label]) => {
      const n = base.filter((d) => matchMember(d, id)).length;
      return el("button", {
        type: "button", class: "filter-chip" + (id === memberFilter ? " active" : ""), "aria-pressed": String(id === memberFilter),
        onclick: () => { memberFilter = id; renderList(); }
      }, label, id && el("span", { class: "count", text: String(n) }));
    }));
    $("med-filters").hidden = docs.length === 0;
    $("med-members-banner").hidden = members.length > 0;
    $("med-drive-banner").hidden = driveConnected();

    $("med-list").replaceChildren(...list.map((d) => el("a", { class: "receipt", href: `#/m/d/${d.id}` },
      typeBadge(d.docType),
      el("div", { class: "receipt-main" },
        el("div", { class: "receipt-title", text: d.title || DOC_TYPES[d.docType] || "מסמך" }),
        el("div", { class: "receipt-sub", text: [DOC_TYPES[d.docType], d.provider].filter(Boolean).join(" · ") }),
        memberName(d.memberId) && el("div", { class: "tag-row" }, el("span", { class: "tag tag-member", text: memberName(d.memberId) }))
      ),
      el("div", { class: "receipt-date", text: fmtDate(toDate(d.date)) })
    )));

    const empty = $("med-empty");
    empty.hidden = !docsLoaded || list.length > 0;
    empty.querySelector("h2").textContent = docs.length ? "לא נמצאו מסמכים" : "עוד אין מסמכים רפואיים";
    empty.querySelector("p").textContent = docs.length ? "נסו לשנות את החיפוש או הסינון." : "לחצו על הפלוס כדי להוסיף את המסמך הראשון.";
  }

  $("med-search").addEventListener("input", renderList);
  $("med-filter-type").addEventListener("change", renderList);
  $("med-filter-year").addEventListener("change", renderList);

  /* ---------- new / edit ---------- */

  const form = $("med-form");
  let editingId = null;
  let pendingFiles = [];
  let aiResult = null;
  let scanning = false;
  let scanSeq = 0;
  let pickedMember = "";
  const userEdited = new Set();
  const CONFIDENCE_FIELDS = { docType: "docType", title: "title", provider: "provider", date: "date" };

  $("med-type-select").replaceChildren(...Object.entries(DOC_TYPES).map(([id, name]) => el("option", { value: id, text: name })));
  const syncTypeIcon = () => $("med-type-icon").replaceChildren(typeBadge($("med-type-select").value || "other", "cat-badge small"));
  $("med-type-select").addEventListener("change", syncTypeIcon);

  function renderMemberPick() {
    const opts = [...members.map((m) => [m.id, m.name]), ["", "ללא שיוך"]];
    $("med-member-pick").replaceChildren(...opts.map(([id, label]) => el("button", {
      type: "button", class: "filter-chip" + (id === pickedMember ? " active" : ""), "aria-pressed": String(id === pickedMember),
      onclick: () => {
        pickedMember = id;
        userEdited.add("memberId");
        $("med-member-field").classList.remove("uncertain");
        renderMemberPick();
      }
    }, label)));
  }

  function openEdit(id) {
    const d = id ? docs.find((x) => x.id === id) : null;
    if (id && !d) {
      if (!docsLoaded) { show("loading"); return; }
      toast("המסמך לא נמצא");
      location.hash = "#/m";
      return;
    }
    editingId = id;
    pendingFiles.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    pendingFiles = [];
    form.reset();
    $("med-form-error").hidden = true;
    $("med-dup-warning").hidden = true;
    form.querySelectorAll(".invalid, .uncertain").forEach((n) => n.classList.remove("invalid", "uncertain"));
    resetScan();

    $("med-edit-title").textContent = d ? "עריכת מסמך" : "מסמך רפואי חדש";
    $("med-files-section").hidden = !!d;
    const back = d ? `#/m/d/${d.id}` : "#/m";
    $("med-edit-close").href = back;
    $("med-btn-cancel").href = back;

    const f = form.elements;
    if (d) {
      pickedMember = memberName(d.memberId) ? d.memberId : "";
      f.docType.value = d.docType || "other";
      f.title.value = d.title || "";
      f.provider.value = d.provider || "";
      f.date.value = isoDate(toDate(d.date) || new Date());
      f.tags.value = (d.tags || []).join(", ");
      f.notes.value = d.notes || "";
    } else {
      // ממשיכים עם בן המשפחה שמסונן ברשימה, אם יש
      pickedMember = memberFilter && memberFilter !== "_none" ? memberFilter : (members.length === 1 ? members[0].id : "");
      f.docType.value = "visit";
      f.date.value = isoDate(new Date());
    }
    renderMemberPick();
    syncTypeIcon();
    renderPendingFiles();
    show("med-edit");
  }

  function resetScan() {
    scanSeq++;
    aiResult = null;
    scanning = false;
    userEdited.clear();
    $("med-scan-status").hidden = true;
    setSaveState();
  }

  function setSaveState() {
    const btn = $("med-btn-save");
    btn.disabled = scanning;
    btn.classList.toggle("waiting", scanning);
    btn.setAttribute("aria-label", scanning ? "ממתין לסריקה" : "שמירה");
    btn.title = scanning ? "ממתין לסריקה…" : "שמירה";
  }

  function scanStatus(state, text) {
    $("med-scan-status").hidden = false;
    $("med-scan-status").classList.toggle("error", state === "error");
    $("med-scan-spinner").hidden = state !== "busy";
    $("med-scan-icon").hidden = state === "busy";
    $("med-scan-text").textContent = text;
    $("med-btn-rescan").hidden = state === "busy";
  }

  async function runScan(force) {
    const files = pendingFiles.slice(0, 3);
    if (!files.length) return;
    const seq = ++scanSeq;
    scanning = true;
    setSaveState();
    scanStatus("busy", "Gemini קורא את המסמך…");
    try {
      const res = await call("scanMedical", 200000)({ files: await Promise.all(files.map(filePayload)) });
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

  $("med-btn-rescan").addEventListener("click", () => { aiResult = null; runScan(true); });

  function applyScan(d, force) {
    const f = form.elements;
    const set = (name, value) => {
      if (value == null || value === "") return;
      if (!force && userEdited.has(name)) return;
      f[name].value = value;
    };
    set("docType", d.docType);
    set("title", d.title);
    set("provider", d.provider);
    set("date", d.date);
    if (d.tags?.length) set("tags", d.tags.join(", "));
    if (d.memberId && members.some((m) => m.id === d.memberId) && (force || !userEdited.has("memberId"))) {
      pickedMember = d.memberId;
      renderMemberPick();
    }
    syncTypeIcon();

    form.querySelectorAll(".uncertain").forEach((n) => n.classList.remove("uncertain"));
    const conf = d.confidence || {};
    for (const [key, name] of Object.entries(CONFIDENCE_FIELDS)) {
      if (userEdited.has(name) && !force) continue;
      const missing = ["title", "date"].includes(key) && d[key] == null;
      const low = d[key] != null && typeof conf[key] === "number" && conf[key] < 0.7;
      if (missing || low) f[name].closest(".field")?.classList.add("uncertain");
    }
    // לא זוהה בן משפחה, או זוהה בלי ודאות
    if (members.length && (force || !userEdited.has("memberId")) &&
        (!d.memberId || (typeof conf.memberId === "number" && conf.memberId < 0.7))) {
      $("med-member-field").classList.add("uncertain");
    }
  }

  form.addEventListener("input", (e) => {
    if (!e.target.name) return;
    userEdited.add(e.target.name);
    e.target.closest(".field")?.classList.remove("uncertain", "invalid");
  });
  form.elements.docType.addEventListener("change", () => userEdited.add("docType"));

  async function addPendingFiles(fileList) {
    for (const file of fileList) {
      try {
        pendingFiles.push(await prepareFile(file, "document"));
      } catch (e) {
        toast(e.message);
      }
    }
    renderPendingFiles();
    if (!editingId && !aiResult && !scanning && pendingFiles.length) runScan(false);
  }
  $("med-pick-camera").addEventListener("change", async (e) => { await addPendingFiles(e.target.files); e.target.value = ""; });
  $("med-pick-file").addEventListener("change", async (e) => { await addPendingFiles(e.target.files); e.target.value = ""; });

  function renderPendingFiles() {
    $("med-file-list").replaceChildren(...pendingFiles.map((f, i) => el("li", { class: "file-item" },
      thumb(f.mimeType, f.previewUrl),
      el("div", { class: "file-info" },
        el("span", { class: "file-name", text: pendingFiles.length > 1 ? `עמוד ${i + 1}` : f.name }),
        el("span", { class: "file-meta", text: fmtSize(f.size) })
      ),
      el("button", {
        type: "button", class: "link-btn danger", text: "הסרה", "aria-label": "הסרת " + f.name,
        onclick: () => {
          if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
          pendingFiles.splice(i, 1);
          renderPendingFiles();
        }
      })
    )));
    // אותו קובץ כבר הועלה למסמך אחר
    const dup = docs.find((d) => (d.fileHashes || []).some((h) => pendingFiles.some((p) => p.hash === h)));
    const warn = $("med-dup-warning");
    warn.hidden = !dup;
    if (dup) warn.textContent = `הקובץ הזה כבר הועלה: ${dup.title} · ${fmtDate(toDate(dup.date))}. אפשר לשמור בכל זאת.`;
  }

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = form.elements;
    const err = $("med-form-error");
    err.hidden = true;
    form.querySelectorAll(".invalid").forEach((n) => n.classList.remove("invalid"));

    const problems = [];
    if (!f.title.value.trim()) { problems.push("תיאור"); f.title.closest(".field").classList.add("invalid"); }
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

    const payload = {
      memberId: pickedMember,
      docType: f.docType.value || "other",
      title: f.title.value.trim(),
      provider: f.provider.value.trim(),
      date: new Date(`${f.date.value}T12:00`).getTime(),
      tags: f.tags.value.split(/[,،]/).map((t) => t.trim()).filter(Boolean),
      notes: f.notes.value.trim()
    };

    $("med-btn-save").disabled = true;
    try {
      if (editingId) {
        busy("שומר…");
        await call("updateMedical")({ id: editingId, doc: payload });
        location.hash = `#/m/d/${editingId}`;
        toast("השינויים נשמרו");
      } else {
        busy("מעלה לדרייב ושומר…");
        const files = await Promise.all(pendingFiles.map(filePayload));
        const res = await call("saveMedical")({ doc: payload, files });
        pendingFiles.forEach((x) => x.previewUrl && URL.revokeObjectURL(x.previewUrl));
        pendingFiles = [];
        location.hash = `#/m/d/${res.data.id}`;
        toast("המסמך נשמר");
      }
    } catch (e) {
      err.textContent = errMsg(e);
      err.hidden = false;
    } finally {
      busy(null);
      $("med-btn-save").disabled = false;
    }
  });

  /* ---------- detail ---------- */

  let detailId = null;
  let sharePrepared = null;
  let detailTimer = null;

  function openDetail(id) {
    const d = docs.find((x) => x.id === id);
    if (!d) {
      // מסמך שנשמר זה עתה עשוי להגיע שנייה אחרי המעבר אליו
      show("loading");
      clearTimeout(detailTimer);
      if (docsLoaded) {
        detailTimer = setTimeout(() => {
          if (location.hash === `#/m/d/${id}` && !docs.some((x) => x.id === id)) {
            toast("המסמך לא נמצא");
            location.hash = "#/m";
          }
        }, 5000);
      }
      return;
    }
    clearTimeout(detailTimer);
    const wasOpen = detailId === id && currentView() === "med-detail";
    if (!wasOpen) resetShare();
    detailId = id;

    $("med-detail-edit").href = `#/m/d/${d.id}/edit`;
    const st = typeStyle(d.docType);
    const typeEl = $("med-detail-type");
    typeEl.replaceChildren(typeBadge(d.docType, "cat-badge small"), DOC_TYPES[d.docType] || "מסמך");
    typeEl.style.cssText = `background:${st.bg};color:${st.fg}`;
    $("med-detail-title").textContent = d.title || DOC_TYPES[d.docType] || "מסמך";
    $("med-detail-member").textContent = memberName(d.memberId) || "ללא שיוך לבן משפחה";

    const date = toDate(d.date);
    const rows = [
      ["רופא / מוסד", d.provider],
      ["תאריך", date ? fmtDate(date) : ""],
      ["תגיות", (d.tags || []).join(", ")],
      ["הערות", d.notes],
      ["הועלה ע״י", d.createdBy]
    ].filter(([, v]) => v);
    $("med-detail-rows").replaceChildren(...rows.map(([k, v]) => el("div", {}, el("dt", { text: k }), el("dd", { text: v }))));
    $("med-detail-rows").hidden = !rows.length;

    const files = d.files || [];
    $("med-detail-files").replaceChildren(...files.map((f, i) => el("li", { class: "file-item" },
      thumb(f.mimeType),
      el("div", { class: "file-info" },
        el("span", { class: "file-name", text: files.length > 1 ? `עמוד ${i + 1}` : "המסמך" }),
        el("span", { class: "file-meta", text: f.name })
      ),
      el("button", { type: "button", class: "link-btn", text: "פתיחה", onclick: () => openFile(d.id, f) }),
      files.length > 1 && el("button", {
        type: "button", class: "link-btn danger", text: "מחיקה", "aria-label": "מחיקת " + f.name,
        onclick: () => removeFile(d.id, f)
      })
    )));
    if (!wasOpen) show("med-detail");
  }

  async function openFile(id, f) {
    busy("טוען קובץ…");
    try {
      const res = await call("getMedicalFile", 60000)({ id, driveFileId: f.driveFileId });
      await displayFile(f, res.data);
    } catch (e) {
      toast(errMsg(e));
    } finally {
      busy(null);
    }
  }

  async function removeFile(id, f) {
    if (!confirm(`למחוק את הקובץ "${f.name}"? הוא יועבר לאשפה בדרייב.`)) return;
    busy("מוחק…");
    try {
      await call("removeMedicalFile")({ id, driveFileId: f.driveFileId });
      toast("הקובץ נמחק");
    } catch (e) {
      toast(errMsg(e));
    } finally {
      busy(null);
    }
  }

  $("med-add-file-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    e.target.value = "";
    if (!file || !detailId) return;
    busy("מעלה לדרייב…");
    try {
      const prepared = await prepareFile(file, "document");
      if (prepared.size > MAX_TOTAL_BYTES) throw new Error("הקובץ גדול מדי (עד 7MB)");
      await call("addMedicalFile")({ id: detailId, file: await filePayload(prepared) });
      if (prepared.previewUrl) URL.revokeObjectURL(prepared.previewUrl);
      toast("הקובץ נוסף");
    } catch (err) {
      toast(err.code ? errMsg(err) : err.message);
    } finally {
      busy(null);
    }
  });

  $("med-btn-delete").addEventListener("click", async () => {
    const d = docs.find((x) => x.id === detailId);
    if (!d || !confirm(`למחוק את המסמך "${d.title}"? הקבצים יועברו לאשפה בדרייב.`)) return;
    busy("מוחק…");
    try {
      await call("deleteMedical")({ id: d.id });
      location.hash = "#/m";
      toast("המסמך נמחק");
    } catch (e) {
      toast(errMsg(e));
    } finally {
      busy(null);
    }
  });

  // שליחת המסמך עצמו (למשל לרופא) דרך חלון השיתוף של המכשיר. בלי קישור לאפליקציה.
  function resetShare() {
    sharePrepared = null;
    $("med-btn-share").classList.remove("ready");
    $("med-btn-share-text").textContent = "שליחת המסמך (למשל לרופא)";
  }

  async function doShare(p) {
    try {
      if (navigator.canShare?.({ files: p.files })) {
        await navigator.share({ files: p.files, title: p.title });
      } else {
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
      resetShare();
    }
  }

  $("med-btn-share").addEventListener("click", async () => {
    const d = docs.find((x) => x.id === detailId);
    if (!d) return;
    if (sharePrepared?.id === d.id) { await doShare(sharePrepared); return; }
    busy("מכין את המסמך…");
    try {
      const files = [];
      for (const f of (d.files || []).slice(0, 5)) {
        const res = await call("getMedicalFile", 60000)({ id: d.id, driveFileId: f.driveFileId });
        const bytes = Uint8Array.from(atob(res.data.data), (c) => c.charCodeAt(0));
        files.push(new File([bytes], f.name, { type: res.data.mimeType }));
      }
      sharePrepared = { id: d.id, files, title: d.title };
    } catch (e) {
      busy(null);
      toast(errMsg(e));
      return;
    }
    busy(null);
    if (navigator.userActivation?.isActive) {
      await doShare(sharePrepared);
    } else {
      $("med-btn-share").classList.add("ready");
      $("med-btn-share-text").textContent = "המסמך מוכן, לחצו לשליחה";
    }
  });

  /* ---------- family members (settings) ---------- */

  function renderMembersCard() {
    const counts = new Map();
    docs.forEach((d) => counts.set(d.memberId, (counts.get(d.memberId) || 0) + 1));
    $("med-members-list").replaceChildren(...members.map((m) => el("li", {},
      el("span", { text: m.name }),
      el("span", { class: "member-actions" },
        el("span", { class: "muted small", text: !counts.get(m.id) ? "" : counts.get(m.id) === 1 ? "מסמך אחד" : `${counts.get(m.id)} מסמכים` }),
        el("button", { class: "remove neutral", type: "button", text: "שינוי שם", onclick: () => renameMember(m) }),
        el("button", { class: "remove", type: "button", text: "הסרה", "aria-label": "הסרת " + m.name, onclick: () => removeMember(m, counts.get(m.id) || 0) })
      )
    )));
    if (!members.length) $("med-members-list").append(el("li", { class: "muted", text: "עוד לא הוגדרו בני משפחה" }));
    const link = $("med-folder-link");
    link.hidden = !(isAdmin() && medDrive?.folderLink);
    if (medDrive?.folderLink) link.href = medDrive.folderLink;
  }

  $("med-member-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const input = $("med-member-input");
    const name = input.value.trim().slice(0, 40);
    if (!name) return;
    if (members.some((m) => norm(m.name) === norm(name))) { toast("השם כבר ברשימה"); return; }
    try {
      await addDoc(collection(db, "medicalMembers"), {
        name, order: members.reduce((mx, m) => Math.max(mx, m.order || 0), 0) + 1, createdAt: serverTimestamp()
      });
      input.value = "";
      toast("נוסף");
    } catch (e) {
      toast(errMsg(e));
    }
  });

  async function renameMember(m) {
    const name = (prompt("שם חדש", m.name) || "").trim().slice(0, 40);
    if (!name || name === m.name) return;
    busy("שומר…");
    try {
      await call("renameMedicalMember")({ id: m.id, name });
      toast("השם עודכן");
    } catch (e) {
      toast(errMsg(e));
    } finally {
      busy(null);
    }
  }

  async function removeMember(m, count) {
    if (count) {
      toast(`יש ל${m.name} ${count} מסמכים. קודם מעבירים אותם לבן משפחה אחר או מוחקים.`);
      return;
    }
    if (!confirm(`להסיר את ${m.name} מרשימת בני המשפחה?`)) return;
    try {
      await deleteDoc(doc(db, "medicalMembers", m.id));
      toast("הוסר");
    } catch (e) {
      toast(errMsg(e));
    }
  }

  /* ---------- routing ---------- */

  function route(hash) {
    if (hash === "#/m/new") {
      if (currentView() !== "med-edit" || editingId) openEdit(null);
      return;
    }
    let m = /^#\/m\/d\/([^/]+)\/edit$/.exec(hash);
    if (m) {
      if (currentView() !== "med-edit" || editingId !== m[1]) openEdit(m[1]);
      return;
    }
    m = /^#\/m\/d\/([^/]+)$/.exec(hash);
    if (m) {
      openDetail(m[1]);
      return;
    }
    renderList();
    show("medical");
  }

  return { start, route, refresh: renderList, renderSettings: renderMembersCard };
}
