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
  visit: { fg: "#1F4E9C", bg: "#E2EAF7", icon: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2.5h6V4"/><path d="M9 10h6M9 14h6M9 18h3"/>' },
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

// תחום הרופא / המרפאה. חייב להיות זהה לרשימה ב-functions/medical.js
const SPECIALTIES = {
  family: { name: "רפואת משפחה", fg: "#1F4E9C", bg: "#E2EAF7", icon: '<path d="M6 3v6a4 4 0 0 0 8 0V3"/><path d="M10 13v3a5 5 0 0 0 10 0v-2"/><circle cx="20" cy="12" r="2"/>' },
  pediatrics: { name: "רפואת ילדים", fg: "#C2410C", bg: "#FCE8DB", icon: '<circle cx="12" cy="13" r="7.5"/><path d="M12 5.5c0-1.5 1-2.5 2.5-2.5"/><path d="M9.5 11.5v.5M14.5 11.5v.5"/><path d="M9.5 15.5a3 3 0 0 0 5 0"/>' },
  orthopedics: { name: "אורתופדיה", fg: "#57534E", bg: "#ECEAE5", icon: '<path d="M17 10c.7.5 1.6.5 2.3 0a2 2 0 1 0-2.4-3.2A2 2 0 1 0 13.7 4.4c-.5.7-.5 1.6 0 2.3l-7 7c-.7-.5-1.6-.5-2.3 0a2 2 0 1 0 2.4 3.2 2 2 0 1 0 3.2 2.4c.5-.7.5-1.6 0-2.3z"/>' },
  ophthalmology: { name: "עיניים", fg: "#0E6378", bg: "#DDF0F4", icon: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>' },
  ent: { name: "אף אוזן גרון", fg: "#9A3412", bg: "#FBE7DC", icon: '<path d="M6 9.5a6 6 0 1 1 12 0c0 3-2 4-3 5.5S14 18.5 13 20a3 3 0 0 1-5.5-1.5"/><path d="M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.5-1.5 2-1.5 3"/>' },
  dermatology: { name: "עור", fg: "#A16207", bg: "#FAEFD9", icon: '<circle cx="10" cy="10" r="6.5"/><path d="M15 15l5.5 5.5"/><circle cx="8.5" cy="9" r=".8" fill="currentColor"/><circle cx="11.5" cy="11.5" r=".8" fill="currentColor"/><circle cx="11" cy="7.5" r=".6" fill="currentColor"/>' },
  cardiology: { name: "לב", fg: "#B42318", bg: "#FBE4E1", icon: '<path d="M20.8 5.6a5 5 0 0 0-7.6.5L12 7.4l-1.2-1.3a5 5 0 0 0-7.6 6.5L12 21l8.8-8.4a5 5 0 0 0 0-7z"/><path d="M6 12.5h3l1.5-2 2 4 1.5-2h4"/>' },
  gynecology: { name: "נשים", fg: "#BE185D", bg: "#FBE3EE", icon: '<circle cx="12" cy="9" r="5.5"/><path d="M12 14.5V21M9 18h6"/>' },
  dental: { name: "שיניים", fg: "#0F6E6A", bg: "#DCEFEC", icon: '<path d="M7.5 3C5 3 3.5 5 3.5 7.5c0 3 1.5 4.5 2 7 .5 3 1 6.5 3 6.5s2-3 2.5-5.5c.2-1 .5-1.2 1-1.2s.8.2 1 1.2c.5 2.5.5 5.5 2.5 5.5s2.5-3.5 3-6.5c.5-2.5 2-4 2-7C20.5 5 19 3 16.5 3c-2 0-3 1-4.5 1s-2.5-1-4.5-1z"/>' },
  neurology: { name: "נוירולוגיה", fg: "#6D28D9", bg: "#EEE7FB", icon: '<path d="M11 4.5A3 3 0 0 0 5.5 6 3 3 0 0 0 4 11a3 3 0 0 0 1.5 5A3 3 0 0 0 11 19.5z"/><path d="M13 4.5A3 3 0 0 1 18.5 6 3 3 0 0 1 20 11a3 3 0 0 1-1.5 5 3 3 0 0 1-5.5 3.5z"/><path d="M8 9.5h3M13 13.5h3"/>' },
  gastro: { name: "גסטרו", fg: "#A15C07", bg: "#FBEEDB", icon: '<path d="M14 3v3a4 4 0 0 1-4 4H9a5 5 0 0 0-5 5v1a5 5 0 0 0 5 5h3a8 8 0 0 0 8-8v-1a4 4 0 0 0-4-4"/>' },
  pulmonology: { name: "ריאות", fg: "#0369A1", bg: "#DFEFF9", icon: '<path d="M12 3v9M12 12l-2.5 2M12 12l2.5 2"/><path d="M8.5 7C6 7 3 11 3 16c0 2 1 4 3 4s3.5-1.5 3.5-4V8.5A1.5 1.5 0 0 0 8.5 7z"/><path d="M15.5 7C18 7 21 11 21 16c0 2-1 4-3 4s-3.5-1.5-3.5-4V8.5A1.5 1.5 0 0 1 15.5 7z"/>' },
  urology: { name: "אורולוגיה", fg: "#7C2D12", bg: "#F6E6DC", icon: '<path d="M14.5 3.5c3.5 0 6 3 6 7.5s-2.5 9.5-7 9.5c-2.2 0-3.5-1.4-3.5-3.5 0-2.4 2-3.5 0-5s-5-1-5-4.5 4-4 9.5-4z"/>' },
  endocrinology: { name: "אנדוקרינולוגיה וסוכרת", fg: "#1D4ED8", bg: "#E3EBFC", icon: '<path d="M12 3c3 4 6 7 6 11a6 6 0 0 1-12 0c0-4 3-7 6-11z"/><path d="M10 15a2.5 2.5 0 0 0 2 2.5"/>' },
  mental: { name: "בריאות הנפש", fg: "#5B4BB0", bg: "#E9E6F7", icon: '<path d="M6 21v-3.5A7.5 7.5 0 1 1 17 20v1"/><path d="M11.5 14l-2.3-2.2a1.5 1.5 0 0 1 2.3-1.9 1.5 1.5 0 0 1 2.3 1.9z"/>' },
  physio: { name: "פיזיותרפיה", fg: "#15803D", bg: "#E0F3E5", icon: '<circle cx="14" cy="4.5" r="2"/><path d="M5 21l3.5-5.5 3 2 1.5-6.5 4 3.5h3"/><path d="M8 10.5l3.5-2.5 2.5 1"/>' },
  allergy: { name: "אלרגיה", fg: "#A21CAF", bg: "#F7E3F8", icon: '<circle cx="12" cy="7" r="3"/><circle cx="12" cy="17" r="3"/><circle cx="7" cy="12" r="3"/><circle cx="17" cy="12" r="3"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>' },
  emergency: { name: "מיון ורפואה דחופה", fg: "#B91C1C", bg: "#FBE4E4", icon: '<path d="M7 18v-6a5 5 0 0 1 10 0v6"/><path d="M5 18h14v3H5z"/><path d="M12 2v2M4.3 5.3l1.4 1.4M19.7 5.3l-1.4 1.4M12 10v4M10 12h4"/>' }
};
const specName = (id) => SPECIALTIES[id]?.name || "";

export function initMedical(ctx) {
  const {
    db, call, $, el, toast, busy, show, currentView, errMsg, norm,
    toDate, fmtDate, isoDate, fmtSize, prepareFile, filePayload, thumb, displayFile, withYearDividers,
    ensureSearchIndex, textSnippet, snippetEl, indexInBackground, uploadUI, uploadWithProgress,
    makeRowCard, previewTextEl, previewActions,
    MAX_TOTAL_BYTES, setupBulkSources, isAdmin, driveConnected
  } = ctx;

  let docs = [];
  let docsLoaded = false;
  let members = [];
  let medDrive = null;
  let memberFilter = "";

  const memberName = (id) => members.find((m) => m.id === id)?.name || "";

  // אייקון למסמך: לפי תחום הרופא אם ידוע, אחרת לפי סוג המסמך
  function docBadge(d, cls = "cat-badge") {
    return SPECIALTIES[d.specialty] ? specBadge(d.specialty, cls) : typeBadge(d.docType, cls);
  }
  function specBadge(id, cls = "cat-badge") {
    const st = SPECIALTIES[id];
    if (!st) return typeBadge("other", cls);
    const span = el("span", { class: cls, "aria-hidden": "true", style: `background:${st.bg};color:${st.fg}` });
    span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${st.icon}</svg>`;
    return span;
  }

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
      if (currentView() === "med-bulk") { renderBulkMember(); renderBulk(); }
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
      return [d.title, d.provider, DOC_TYPES[d.docType], specName(d.specialty), memberName(d.memberId), d.notes, ...(d.tags || [])]
        .filter(Boolean).some((s) => String(s).toLowerCase().includes(term)) || !!textSnippet("medical", d.id, term);
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
    const people = new Set(docs.map((d) => d.memberId).filter((id) => memberName(id))).size;
    $("med-summary").textContent = !docsLoaded ? "" : !docs.length ? "עוד אין מסמכים"
      : (docs.length === 1 ? "מסמך אחד" : `${docs.length} מסמכים`) + (people > 1 ? ` של ${people} בני משפחה` : people === 1 ? ` של ${memberName(docs.find((d) => memberName(d.memberId))?.memberId)}` : "");
    $("med-members-banner").hidden = members.length > 0;
    $("med-drive-banner").hidden = driveConnected();

    $("med-list").replaceChildren(...withYearDividers(list, (d) => toDate(d.date), (d) => makeRowCard("med", d.id, el("a", { class: "receipt", href: `#/m/d/${d.id}` },
      docBadge(d),
      el("div", { class: "receipt-main" },
        el("div", { class: "receipt-title", text: d.title || DOC_TYPES[d.docType] || "מסמך" }),
        el("div", { class: "receipt-sub", text: [specName(d.specialty) || DOC_TYPES[d.docType], d.provider].filter(Boolean).join(" · ") }),
        memberName(d.memberId) && el("div", { class: "tag-row" }, el("span", { class: "tag tag-member", text: memberName(d.memberId) })),
        term && snippetEl(textSnippet("medical", d.id, term))
      ),
      el("div", { class: "receipt-date", text: fmtDate(toDate(d.date)) })
    ), () => medPreview(d))));

    $("med-empty-bulk").hidden = docs.length > 0;
    const empty = $("med-empty");
    empty.hidden = !docsLoaded || list.length > 0;
    empty.querySelector("h2").textContent = docs.length ? "לא נמצאו מסמכים" : "עוד אין מסמכים רפואיים";
    empty.querySelector("p").textContent = docs.length ? "נסו לשנות את החיפוש או הסינון." : "לחצו על הפלוס כדי להוסיף את המסמך הראשון.";
  }

  // תצוגה מקדימה של מסמך ברשימה: פרטים עיקריים ושורות מתוך המסמך
  function medPreview(d) {
    const facts = [
      ["סוג", DOC_TYPES[d.docType]],
      ["תחום", specName(d.specialty)],
      ["רופא / מוסד", d.provider],
      ["של", memberName(d.memberId)]
    ].filter(([, v]) => v);
    const pages = (d.files || []).length;
    return [
      el("dl", { class: "pv-dl" }, ...facts.map(([k, v]) => el("div", {}, el("dt", { text: k }), el("dd", { text: v })))),
      ((d.tags || []).length || d.notes) && el("div", { class: "pv-facts" },
        ...(d.tags || []).map((t) => el("span", { class: "pv-chip", text: t })),
        d.notes && el("div", { class: "pv-notes", text: d.notes })
      ),
      previewTextEl("medical", d.id),
      previewActions(`#/m/d/${d.id}`, pages ? () => openFile(d.id, d.files[0]) : null, pages > 1 ? `צפייה (${pages} עמודים)` : "צפייה במסמך")
    ];
  }

  $("med-search").addEventListener("input", () => { if ($("med-search").value.trim()) ensureSearchIndex(); renderList(); });
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
  $("med-spec-select").replaceChildren(el("option", { value: "", text: "לא ידוע / כללי" }),
    ...Object.entries(SPECIALTIES).map(([id, sp]) => el("option", { value: id, text: sp.name })));
  const syncSpecIcon = () => $("med-spec-icon").replaceChildren(SPECIALTIES[$("med-spec-select").value]
    ? specBadge($("med-spec-select").value, "cat-badge small") : typeBadge($("med-type-select").value || "other", "cat-badge small"));
  $("med-spec-select").addEventListener("change", () => { userEdited.add("specialty"); syncSpecIcon(); });
  $("med-type-select").addEventListener("change", () => syncSpecIcon());
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
    bulkEditId = null;
    pendingFiles.forEach((f) => !bulkItems.some((b) => b.file === f) && f.previewUrl && URL.revokeObjectURL(f.previewUrl));
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
      f.specialty.value = SPECIALTIES[d.specialty] ? d.specialty : "";
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
    syncSpecIcon();
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
    if (force || !userEdited.has("specialty")) f.specialty.value = SPECIALTIES[d.specialty] ? d.specialty : "";
    set("title", d.title);
    set("provider", d.provider);
    set("date", d.date);
    if (d.tags?.length) set("tags", d.tags.join(", "));
    if (d.memberId && members.some((m) => m.id === d.memberId) && (force || !userEdited.has("memberId"))) {
      pickedMember = d.memberId;
      renderMemberPick();
    }
    syncTypeIcon();
    syncSpecIcon();

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
      specialty: f.specialty.value || "",
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
        const totalSize = pendingFiles.reduce((n, x) => n + x.size, 0);
        uploadUI.open("שומר את המסמך", pendingFiles.length > 1 ? `${pendingFiles.length} עמודים` : pendingFiles[0]?.name);
        const files = await Promise.all(pendingFiles.map(filePayload));
        const res = await uploadWithProgress("saveMedical", { doc: payload, files }, { sizeText: fmtSize(totalSize) });
        await uploadUI.done("המסמך נשמר");
        indexInBackground("medical", res.data.id);
        const fromBulk = bulkItems.find((b) => b.id === bulkEditId);
        pendingFiles.forEach((x) => x !== fromBulk?.file && x.previewUrl && URL.revokeObjectURL(x.previewUrl));
        pendingFiles = [];
        if (fromBulk) {
          fromBulk.status = "saved";
          fromBulk.savedId = res.data.id;
          fromBulk.title = payload.title;
          bulkEditId = null;
          if (!finishBulkIfDone(0)) {
            location.hash = "#/m/bulk";
            toast("המסמך נשמר");
          }
        } else {
          location.hash = `#/m/d/${res.data.id}`;
          toast("המסמך נשמר");
        }
      }
    } catch (e) {
      err.textContent = errMsg(e);
      err.hidden = false;
    } finally {
      busy(null);
      uploadUI.close();
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
    $("med-detail-icon").replaceChildren(docBadge(d, "cat-badge big"));

    const date = toDate(d.date);
    const rows = [
      ["תחום", specName(d.specialty)],
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
      indexInBackground("medical", id);
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
    uploadUI.open("מוסיף עמוד", file.name);
    try {
      const prepared = await prepareFile(file, "document");
      if (prepared.size > MAX_TOTAL_BYTES) throw new Error("הקובץ גדול מדי (עד 7MB)");
      await uploadWithProgress("addMedicalFile", { id: detailId, file: await filePayload(prepared) }, { sizeText: fmtSize(prepared.size) });
      await uploadUI.done("העמוד נוסף");
      indexInBackground("medical", detailId);
      if (prepared.previewUrl) URL.revokeObjectURL(prepared.previewUrl);
      toast("הקובץ נוסף");
    } catch (err) {
      toast(err.code ? errMsg(err) : err.message);
    } finally {
      uploadUI.close();
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

  /* ---------- bulk import ---------- */

  let bulkItems = [];
  let bulkEditId = null;
  let bulkRunning = 0;
  let bulkSaving = false;
  let bulkMember = null; // null = עוד לא נבחר; "" = ללא שיוך
  const BULK_CONCURRENCY = 2;

  const bulkComplete = (ai) => !!(ai && ai.title && ai.date);
  const isKnownHash = (hash, except) =>
    docs.some((d) => (d.fileHashes || []).includes(hash)) ||
    bulkItems.some((b) => b !== except && b.file?.hash === hash && b.status !== "removed");
  // למי שייך מסמך בייבוא: תיקייה בשם של בן משפחה קובעת, אחריה מה ש-Gemini זיהה, ואחרונה בחירת ברירת המחדל
  const bulkMemberOf = (ai, item) => item?.folderMember
    || (ai?.memberId && members.some((m) => m.id === ai.memberId) ? ai.memberId : (bulkMember || ""));
  function memberFromPath(path) {
    const dirs = String(path || "").split("/").slice(0, -1).map(norm);
    return members.find((m) => dirs.includes(norm(m.name)))?.id || "";
  }

  function docFromAi(ai, item) {
    return {
      memberId: bulkMemberOf(ai, item),
      docType: ai.docType || "other",
      specialty: ai.specialty || "",
      title: ai.title || DOC_TYPES[ai.docType] || "מסמך",
      provider: ai.provider || "",
      date: new Date(`${ai.date}T12:00`).getTime(),
      tags: ai.tags || [],
      notes: ""
    };
  }

  function renderBulkMember() {
    if (bulkMember === null) bulkMember = memberFilter && memberFilter !== "_none" ? memberFilter : "";
    const opts = [["", "ללא שיוך"], ...members.map((m) => [m.id, m.name])];
    $("med-bulk-member-field").hidden = !members.length;
    $("med-bulk-member").replaceChildren(...opts.map(([id, label]) => el("button", {
      type: "button", class: "filter-chip" + (id === bulkMember ? " active" : ""), "aria-pressed": String(id === bulkMember),
      onclick: () => { bulkMember = id; renderBulkMember(); renderBulk(); }
    }, label)));
  }

  async function addBulkFiles(fileList) {
    const fresh = [...fileList].map((file) => ({
      id: Math.random().toString(36).slice(2, 10), title: file.name, status: "preparing", source: file,
      folderMember: memberFromPath(file.relPath || file.webkitRelativePath)
    }));
    bulkItems.push(...fresh);
    renderBulk();
    for (const item of fresh) {
      try {
        item.file = await prepareFile(item.source, "document");
        delete item.source;
        if (item.file.size > MAX_TOTAL_BYTES) { item.status = "error"; item.error = "הקובץ גדול מ-7MB"; }
        else if (isKnownHash(item.file.hash, item)) item.status = "dup";
        else item.status = "queued";
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
      scanBulkItem(next).finally(() => { bulkRunning--; renderBulk(); pumpBulk(); });
    }
  }

  async function scanBulkItem(item) {
    item.status = "scanning";
    renderBulk();
    try {
      const res = await call("scanMedical", 200000)({ files: [await filePayload(item.file)] });
      item.ai = res.data;
      item.status = bulkComplete(res.data) ? "ready" : "review";
      item.scanFailed = false;
      delete item.error;
    } catch (e) {
      item.status = "error";
      item.scanFailed = true;
      item.error = errMsg(e);
    }
  }

  const canRescan = (b) => !!b.file && !bulkSaving && b.file.size <= MAX_TOTAL_BYTES &&
    (b.status === "review" || (b.status === "error" && b.scanFailed));
  function rescanBulk(list) {
    list.forEach((b) => { b.status = "queued"; delete b.error; });
    renderBulk();
    pumpBulk();
  }

  $("med-bulk-retry-all").addEventListener("click", () => rescanBulk(bulkItems.filter((b) => b.status === "error" && canRescan(b))));
  setupBulkSources("view-med-bulk", "med-bulk-folder", addBulkFiles);
  $("med-bulk-pick").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    e.target.value = "";
    if (files.length) await addBulkFiles(files);
  });

  $("med-bulk-save-all").addEventListener("click", async () => {
    const ready = bulkItems.filter((b) => b.status === "ready");
    if (!ready.length || bulkSaving) return;
    bulkSaving = true;
    renderBulk();
    uploadUI.open(ready.length === 1 ? "שומר מסמך אחד" : `שומר ${ready.length} מסמכים`, "");
    for (const [n, item] of ready.entries()) {
      item.status = "saving";
      renderBulk();
      uploadUI.set({ sub: `${n + 1} מתוך ${ready.length}: ${item.ai.title || item.title}` });
      try {
        const res = await uploadWithProgress("saveMedical", { doc: docFromAi(item.ai, item), files: [await filePayload(item.file)] },
          { sizeText: fmtSize(item.file.size), from: n / ready.length, to: (n + 1) / ready.length, savingText: `שומר בדרייב (${n + 1}/${ready.length})…` });
        indexInBackground("medical", res.data.id);
        item.status = "saved";
        item.savedId = res.data.id;
        item.title = item.ai.title || item.title;
      } catch (e) {
        item.status = "error";
        item.error = "השמירה נכשלה: " + errMsg(e);
      }
      renderBulk();
    }
    bulkSaving = false;
    renderBulk();
    const saved = ready.filter((b) => b.status === "saved").length;
    if (saved) await uploadUI.done(saved === 1 ? "המסמך נשמר" : `${saved} מסמכים נשמרו`); else uploadUI.close();
    finishBulkIfDone(saved);
  });

  const BULK_STATUS = {
    preparing: ["chip-busy", "מכין…", true],
    queued: ["chip-busy", "ממתין לסריקה", false],
    scanning: ["chip-busy", "סורק…", true],
    ready: ["chip-ready", "מוכן לשמירה", false],
    review: ["chip-review", "חסרים פרטים, צריך לבדוק", false],
    dup: ["chip-dup", "הקובץ כבר הועלה, לא יישמר", false],
    error: ["chip-error", "נכשל", false],
    saving: ["chip-busy", "שומר…", true],
    saved: ["chip-saved", "נשמר", false]
  };

  function renderBulk() {
    const items = bulkItems.filter((b) => b.status !== "removed");
    $("med-bulk-list").replaceChildren(...items.map((b) => {
      const [cls, label, spin] = BULK_STATUS[b.status] || BULK_STATUS.error;
      const ai = b.ai;
      const who = ai || b.folderMember ? memberName(bulkMemberOf(ai, b)) : "";
      const sub = ai ? [specName(ai.specialty) || DOC_TYPES[ai.docType], ai.provider, ai.date ? fmtDate(new Date(ai.date + "T12:00")) : ""].filter(Boolean).join(" · ") : "";
      const editable = ["ready", "review", "dup", "error"].includes(b.status) && b.file && !bulkSaving;
      const removable = !["scanning", "saving", "saved", "preparing"].includes(b.status) && !bulkSaving;
      return el("li", { class: "bulk-item" + (b.status === "saved" ? " saved" : "") },
        ai ? docBadge(ai) : thumb(b.file?.mimeType || "", b.file?.previewUrl),
        el("div", { class: "bulk-main" },
          el("div", { class: "bulk-title", text: (b.status === "saved" ? b.title : ai?.title) || b.title }),
          (sub || who) && el("div", { class: "bulk-sub" }, sub, who && el("span", { class: "tag tag-member", text: who })),
          el("span", { class: "chip " + cls }, spin && el("span", { class: "spinner small" }), label),
          b.error && el("div", { class: "error small", text: b.error }),
          el("div", { class: "bulk-actions" },
            canRescan(b) && el("button", { type: "button", class: "link-btn", text: "סריקה חוזרת", onclick: () => rescanBulk([b]) }),
            b.status === "error" && !b.scanFailed && b.ai && !bulkSaving && el("button", {
              type: "button", class: "link-btn", text: "ניסיון חוזר",
              onclick: () => { b.status = bulkComplete(b.ai) ? "ready" : "review"; delete b.error; renderBulk(); }
            }),
            editable && el("a", { class: "link-btn", href: `#/m/bulk/edit/${b.id}`, text: b.status === "dup" ? "שמירה בכל זאת" : "בדיקה ועריכה" }),
            b.status === "saved" && b.savedId && el("a", { class: "link-btn", href: `#/m/d/${b.savedId}`, text: "פתיחה" }),
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
    $("med-bulk-summary").hidden = !items.length;
    $("med-bulk-progress").textContent = [
      pending ? `סורק ${items.length - pending} מתוך ${items.length}` : `${items.length} קבצים`,
      ready ? `${ready} מוכנים` : "",
      count("saved") ? `${count("saved")} נשמרו` : ""
    ].filter(Boolean).join(" · ");
    const failed = items.filter((b) => b.status === "error" && canRescan(b)).length;
    $("med-bulk-retry-all").hidden = failed < 2;
    $("med-bulk-retry-all").textContent = `סריקה חוזרת ל-${failed} הקבצים שנכשלו`;
    const btn = $("med-bulk-save-all");
    btn.disabled = !ready || bulkSaving;
    btn.textContent = bulkSaving ? "שומר…" : ready === 1 ? "שמירת מסמך אחד" : ready ? `שמירת ${ready} מסמכים` : "שמירת הכל";
  }

  function finishBulkIfDone(savedNow) {
    const active = bulkItems.filter((b) => b.status !== "removed");
    const pending = active.filter((b) => b.status !== "saved");
    if (active.length && !pending.length) {
      active.forEach((b) => b.file?.previewUrl && URL.revokeObjectURL(b.file.previewUrl));
      bulkItems = [];
      bulkMember = null;
      location.hash = "#/m";
      toast(active.length === 1 ? "המסמך נשמר" : `כל ${active.length} המסמכים נשמרו`);
      return true;
    }
    if (savedNow) {
      toast(`${savedNow === 1 ? "מסמך אחד נשמר" : savedNow + " מסמכים נשמרו"} · ${pending.length === 1 ? "אחד נשאר" : pending.length + " נשארו"} לבדיקה`);
    }
    return false;
  }

  function openBulkEdit(id) {
    const item = bulkItems.find((b) => b.id === id && b.status !== "removed");
    if (!item || !item.file) { location.hash = "#/m/bulk"; return; }
    openEdit(null);
    bulkEditId = id;
    $("med-edit-title").textContent = "בדיקת מסמך";
    $("med-edit-close").href = "#/m/bulk";
    $("med-btn-cancel").href = "#/m/bulk";
    pendingFiles = [item.file];
    renderPendingFiles();
    if (item.ai) {
      aiResult = item.ai;
      applyScan(item.ai, true);
      const who = bulkMemberOf(item.ai, item);
      if (who !== pickedMember && (item.folderMember || !item.ai.memberId)) { pickedMember = who; renderMemberPick(); }
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
    if (hash === "#/m/bulk") {
      renderBulkMember();
      renderBulk();
      show("med-bulk");
      return;
    }
    const bm = /^#\/m\/bulk\/edit\/([^/]+)$/.exec(hash);
    if (bm) {
      if (currentView() !== "med-edit" || bulkEditId !== bm[1]) openBulkEdit(bm[1]);
      return;
    }
    if (hash === "#/m/new") {
      if (currentView() !== "med-edit" || editingId || bulkEditId) openEdit(null);
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
