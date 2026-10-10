# הכספת

אפליקציית PWA לשמירת קבלות וחשבוניות של רכישות גדולות ומעקב אחר אחריות, ומסמכים רפואיים של המשפחה במודול נפרד.
Firebase (Auth, Firestore, Functions), סריקה עם Gemini, ושמירת קבצים ב-Google Drive.

## מבנה

```
web/                         האתר (HTML, CSS, JS ללא build), נפרס ל-GitHub Pages
functions/                   Cloud Functions: דרייב, סריקה, שמירת קבלות וקבצים
firestore.rules              Security Rules ל-Firestore
.github/workflows/pages.yml      פריסת האתר בכל שינוי ב-web/
.github/workflows/functions.yml  פריסת ה-Functions וה-Rules בכל שינוי בהם
```

## מצב הפיתוח

- [x] שלב 1: כניסה עם Google, רשימת מורשים, Security Rules, פריסה
- [x] שלב 2: חיבור דרייב, העלאה ושמירה, פרטי קבלה, עריכה
- [x] שלב 3: סריקה וסיווג אוטומטיים עם Gemini, למידה מתיקונים
- [x] שלב 4: התקנה כאפליקציה, התראות אחריות, סינון, שיתוף, ייבוא מרובה
- [ ] שלב 5: ליטוש

## הגדרה חד-פעמית (אפשר מהטלפון)

כל קישורי Google Cloud פותחים את הפרויקט `shopping-fa855`. בטלפון כדאי להפעיל בדפדפן "גרסת מחשב".

### 1. Google Drive API
[Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com?project=shopping-fa855) ← **Enable**.

### 2. מסך הסכמה
[Google Auth Platform](https://console.cloud.google.com/auth/overview?project=shopping-fa855) ← Get started:
- שם אפליקציה: "קבלות ואחריות", מייל תמיכה: המייל שלך.
- Audience: **External**. מייל ליצירת קשר: המייל שלך.
- אחרי היצירה: **Audience ← Publish app** (מעבר ל-In production). במצב Testing ההרשאה לדרייב פגה כל 7 ימים.

### 3. OAuth Client
[Clients](https://console.cloud.google.com/auth/clients?project=shopping-fa855) ← Create client:
- Application type: **Web application**
- Authorized redirect URIs: `https://europe-west1-shopping-fa855.cloudfunctions.net/driveCallback`
- לשמור את ה-**Client ID** וה-**Client secret**.

### 4. מפתח Gemini
[Google AI Studio](https://aistudio.google.com/apikey) ← Create API key ← לבחור את הפרויקט **shopping-fa855**.
כך המפתח משויך לפרויקט עם החיוב, והנתונים לא משמשים לאימון מודלים.

### 5. חשבון שירות לפריסה
[Service accounts](https://console.cloud.google.com/iam-admin/serviceaccounts?project=shopping-fa855) ← Create service account:
- שם: `github-deploy`.
- תפקידים (Roles): **Editor**, **Cloud Functions Admin**, **Cloud Run Admin**, **Secret Manager Admin**, **Service Account User**.
- אחרי היצירה: לפתוח את החשבון ← Keys ← Add key ← Create new key ← **JSON**. קובץ יורד.

### 6. Secrets בריפו
בריפו: Settings ← Secrets and variables ← Actions ← **New repository secret**, ארבעה:

| שם | ערך |
| --- | --- |
| `FIREBASE_SERVICE_ACCOUNT` | כל התוכן של קובץ ה-JSON משלב 5 |
| `GOOGLE_OAUTH_CLIENT_ID` | Client ID משלב 3 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Client secret משלב 3 |
| `GEMINI_API_KEY` | המפתח משלב 4 |

### 7. פריסה
Actions ← **Deploy Firebase (functions + rules)** ← Run workflow. הריצה הראשונה לוקחת כמה דקות.
מכאן והלאה, כל שינוי בקוד השרת נפרס אוטומטית.

### 8. חיבור הדרייב
באפליקציה ← הגדרות ← **חיבור Google Drive**, להתחבר עם חשבון המנהל ולאשר את כל ההרשאות.
בשורש "האחסון שלי" תיווצר תיקייה בשם **"קבלות ואחריות"**. אפשר להעביר אותה לכל תיקייה אחרת בדרייב,
והאפליקציה תמשיך לשמור בה.

## איך זה עובד

- **סריקה:** אחרי בחירת קובץ, `scanReceipt` שולח אותו ל-Gemini עם רשימת הקטגוריות, 10 התיקונים האחרונים
  והתגיות הקיימות, ומקבל JSON מובנה. שדות עם ביטחון נמוך מסומנים בכתום. שדה שהמשתמש ערך לא נדרס.
- **למידה:** אם הקטגוריה שנשמרה שונה מזו שה-AI הציע, נשמר תיקון ב-`corrections` ומצורף לסריקות הבאות.
- **דרייב:** הרשאה מצומצמת (`drive.file`): האפליקציה ניגשת רק לתיקייה ולקבצים שהיא יצרה, ולא לשום דבר אחר בדרייב.
  הקבצים נשמרים בתיקייה "קבלות ואחריות", בתת-תיקייה לפי שנה. העברת התיקייה למקום אחר לא פוגעת בגישה.
  אפשר לבחור תיקייה קיימת דרך `DRIVE_FOLDER_ID` ב-`functions/.env`, אבל זה מחייב הרשאת Drive מלאה ולא מומלץ.
- **אבטחה:** ה-refresh token של הדרייב נשמר ב-`secrets/drive` ב-Firestore, אוסף שה-Rules חוסמים ללקוחות.
  העלאה, צפייה ומחיקה של קבצים עוברות דרך ה-Functions, כך שהתיקייה לא צריכה להיות משותפת.
- **גודל:** תמונות מוקטנות ל-2000 פיקסלים ונדחסות ל-JPEG בדפדפן. מגבלה: 7MB לקבלה.
- **מודל:** `GEMINI_MODEL` ב-`functions/.env`.
- **התראות:** כל מכשיר נרשם בהגדרות ← "הפעלת התראות" (נשמר ב-`tokens/{uid}`). הפונקציה `warrantyReminders`
  רצה כל יום ב-09:00 שעון ישראל ושולחת לכל המכשירים תזכורת 30 ו-7 ימים לפני סיום אחריות של כל מוצר, פעם אחת לכל סף
  (מסומן ב-`remindersSent` על הקבלה).
- **מסמכים רפואיים:** מודול נפרד (טאב "רפואי"). אוסף `medical` שנכתב רק דרך ה-Functions (`functions/medical.js`),
  בני משפחה ב-`medicalMembers`, ותיקייה נפרדת בשורש הדרייב בשם **"מסמכים רפואיים"** עם תת-תיקייה לכל בן משפחה.
  הסריקה (`scanMedical`) מחלצת רק פרטי תיוק: סוג, תיאור, רופא/מוסד, תאריך ולמי המסמך שייך, בלי ממצאים או אבחנות.
  בני המשפחה מוגדרים בהגדרות. שינוי בן משפחה במסמך מעביר את הקבצים לתיקייה שלו.
- **כתובות:** האפליקציה מוגשת מ-`https://shopping-fa855.web.app` (Firebase Hosting, הכתובת הראשית) וגם מ-GitHub Pages.

## פריסה ידנית מהמחשב (לא חובה)

```
npm install -g firebase-tools
firebase login
npm ci --prefix functions
firebase deploy --only functions,firestore:rules
```

## פיתוח מקומי

```
cd web
npx serve .
```
