// Service worker: מאפשר התקנה כאפליקציה ומציג התראות אחריות כשהאפליקציה סגורה.
// אין כאן שמירה במטמון, כך שכל טעינה מקבלת את הגרסה העדכנית. היקף הפעולה מוגבל לתיקייה שבה האפליקציה מותקנת.
importScripts("https://www.gstatic.com/firebasejs/11.10.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/11.10.0/firebase-messaging-compat.js");

firebase.initializeApp({
  "apiKey": "AIzaSyCqmRwramZv0pdPJPoj87sWAdTCj2y3qII",
  "authDomain": "shopping-fa855.firebaseapp.com",
  "projectId": "shopping-fa855",
  "storageBucket": "shopping-fa855.firebasestorage.app",
  "messagingSenderId": "911092259252",
  "appId": "1:911092259252:web:9ddcc6db4ae58b0483fae1"
});
// הודעות עם notification מוצגות אוטומטית; לחיצה פותחת את הקישור שנשלח עם ההודעה
firebase.messaging();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
// לחיצה על התראה שהאפליקציה הציגה בעצמה (כשהייתה פתוחה): פותחת את הקישור שצורף לה
self.addEventListener("notificationclick", (event) => {
  const link = event.notification.data?.link;
  if (!link) return;
  event.notification.close();
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const win = wins.find((w) => w.url.split("#")[0] === link.split("#")[0]);
    if (win) { await win.focus(); return win.navigate(link); }
    return self.clients.openWindow(link);
  })());
});
