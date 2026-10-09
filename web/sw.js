// Service worker מינימלי: מאפשר התקנה כאפליקציה. אין כאן שמירה במטמון,
// כך שכל טעינה מקבלת את הגרסה העדכנית מהשרת. היקף הפעולה מוגבל ל-/receipts/ בלבד.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
