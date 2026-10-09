# קבלות ואחריות

אפליקציית PWA לשמירת קבלות וחשבוניות של רכישות גדולות ומעקב אחר אחריות.
Firebase (Auth, Firestore, Functions), סריקה עם Gemini, ושמירת קבצים ב-Google Drive.

## מבנה

```
web/               האתר (HTML, CSS, JS ללא build), נפרס ל-GitHub Pages
functions/         Cloud Functions: חיבור דרייב, שמירת קבלות וקבצים
firestore.rules    Security Rules ל-Firestore
storage.rules      חסימה מלאה של Storage (לא בשימוש)
firebase.json      הגדרות Firebase CLI
```

## מצב הפיתוח

- [x] שלב 1: כניסה עם Google, רשימת מורשים, Security Rules, פריסה
- [x] שלב 2: חיבור דרייב, העלאה ושמירה ידנית, פרטי קבלה
- [ ] שלב 3: סריקה וסיווג עם Gemini
- [ ] שלב 4: PWA מלא והתראות אחריות
- [ ] שלב 5: ליטוש

## הגדרה ראשונית (שלב 1)

1. **GitHub Pages:** ב-Settings ← Pages ← Source לבחור **GitHub Actions**. כל push ל-`main` שמשנה את `web/` נפרס אוטומטית.
2. **Authentication:** ב-Firebase Console להפעיל את ספק Google, ותחת Settings ← Authorized domains להוסיף את `itairosenblum-hash.github.io`.
3. **Firestore Rules:** `firebase deploy --only firestore:rules` (או העתקה ידנית ל-Console).
4. **רשימת מורשים:** להיכנס לאפליקציה עם חשבון המנהל, לעבור להגדרות וללחוץ "יצירת רשימת מורשים", ואז להוסיף את שאר החשבונות.

## הגדרת הדרייב וה-Functions (שלב 2)

כל השלבים ב-[Google Cloud Console](https://console.cloud.google.com/?project=shopping-fa855), בפרויקט `shopping-fa855`.

1. **Drive API:** APIs & Services ← Library ← Google Drive API ← **Enable**.
2. **מסך הסכמה (OAuth consent screen / Google Auth Platform):**
   - User type: **External**. שם אפליקציה: "קבלות ואחריות", ומייל התמיכה והמפתח: המייל של המנהל.
   - בתפריט Audience ללחוץ **Publish app** (מעבר ל-In production). במצב Testing ההרשאה לדרייב פגה כל 7 ימים.
3. **OAuth Client:** Clients (או Credentials) ← Create client ← **Web application**.
   - Authorized redirect URIs: `https://europe-west1-shopping-fa855.cloudfunctions.net/driveCallback`
   - לשמור את ה-Client ID וה-Client secret.
4. **מהלפטופ**, בתיקיית הריפו:
   ```
   npm install -g firebase-tools
   firebase login
   cd functions && npm install && cd ..
   firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_ID
   firebase functions:secrets:set GOOGLE_OAUTH_CLIENT_SECRET
   firebase deploy --only functions,firestore:rules
   ```
5. **חיבור:** באפליקציה ← הגדרות ← **חיבור Google Drive**, להתחבר עם חשבון המנהל ולאשר את כל ההרשאות.
   Google יציג אזהרה שהאפליקציה לא מאומתת: ללחוץ Advanced ← Go to (unsafe). זה צפוי באפליקציה פרטית.

### תיקיית היעד

התיקייה מוגדרת ב-`functions/.env` (`DRIVE_FOLDER_ID`). הקבצים נשמרים בתת-תיקייה לפי שנה.
גישה לתיקייה קיימת דורשת הרשאת Drive מלאה. השארת `DRIVE_FOLDER_ID` ריק עוברת להרשאה המצומצמת `drive.file`,
והאפליקציה יוצרת תיקייה בשם "קבלות ואחריות" בשורש הדרייב.
אחרי שינוי התיקייה: לפרוס מחדש את ה-Functions ולחבר מחדש את הדרייב.

### איך זה עובד

- ה-refresh token של הדרייב נשמר ב-`secrets/drive` ב-Firestore, אוסף שה-Rules חוסמים לחלוטין ללקוחות.
  רק ה-Functions (עם Admin SDK) קוראים אותו.
- העלאה, צפייה ומחיקה של קבצים עוברות דרך ה-Functions, כך שגם משתמשים שאינם המנהל
  רואים את הקבצים בלי שהתיקייה תהיה משותפת איתם.
- תמונות מוקטנות ל-2000 פיקסלים ונדחסות ל-JPEG בדפדפן. מגבלה: 7MB לקבלה.

## פיתוח מקומי

```
cd web
npx serve .
```

ולהוסיף את `localhost` ל-Authorized domains (בדרך כלל כבר מופיע שם).
