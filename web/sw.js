// Service worker מינימלי: מאפשר התקנה כאפליקציה. אין כאן שמירה במטמון,
// כך שכל טעינה מקבלת את הגרסה העדכנית מהשרת. היקף הפעולה מוגבל לתיקייה שבה האפליקציה מותקנת.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
