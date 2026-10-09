# קבלות ואחריות

אפליקציית PWA לשמירת קבלות וחשבוניות של רכישות גדולות ומעקב אחר אחריות.
Firebase (Auth, Firestore, Functions), סריקה עם Gemini, ושמירת קבצים ב-Google Drive.

## מבנה

```
web/               האתר (HTML, CSS, JS ללא build), נפרס ל-GitHub Pages
firestore.rules    Security Rules ל-Firestore
storage.rules      חסימה מלאה של Storage (לא בשימוש)
firebase.json      הגדרות Firebase CLI
```

## מצב הפיתוח

- [x] שלב 1: כניסה עם Google, רשימת מורשים, Security Rules, פריסה
- [ ] שלב 2: חיבור דרייב, העלאה ושמירה ידנית, פרטי קבלה
- [ ] שלב 3: סריקה וסיווג עם Gemini
- [ ] שלב 4: PWA מלא והתראות אחריות
- [ ] שלב 5: ליטוש

## הגדרה ראשונית

1. **GitHub Pages:** ב-Settings ← Pages ← Source לבחור **GitHub Actions**. כל push ל-`main` שמשנה את `web/` נפרס אוטומטית.
2. **Authentication:** ב-Firebase Console להפעיל את ספק Google, ותחת Settings ← Authorized domains להוסיף את `itairosenblum-hash.github.io`.
3. **Firestore Rules:** להעתיק את `firestore.rules` ל-Firestore Database ← Rules וללחוץ Publish
   (או `firebase deploy --only firestore:rules` מהלפטופ).
4. **רשימת מורשים:** להיכנס לאפליקציה עם חשבון המנהל, לעבור להגדרות וללחוץ "יצירת רשימת מורשים", ואז להוסיף את שאר החשבונות.

## פיתוח מקומי

```
cd web
npx serve .
```

ולהוסיף את `localhost` ל-Authorized domains (בדרך כלל כבר מופיע שם).
