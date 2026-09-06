# שירות סנכרון Surense → Postgres → API

שירות Node.js שמושך לידים מ-Surense CRM, שומר כל שינוי ב-Postgres, וחושף API מאובטח שממנו אפשר למשוך את השינויים ולשלוח הודעות.

**ה-CRM נקרא בלבד.** שלוש קריאות בסך הכול: `POST /oauth/token`, `GET /leads/fields`, `POST /leads/search`. אין `PATCH`, אין `PUT`, אין `DELETE` בשום מקום בקוד.

---

## שני מסלולים, ושניהם נחוצים

המסמך המקורי קבע ש"אין Webhooks ב-Surense". **זה לא נכון** — ל-Surense יש webhooks מלאים דרך Svix.

| מסלול | מה הוא נותן | מה חסר בו |
|---|---|---|
| **Webhook** | שינוי סטטוס **מיידי**, עם `before`/`after` מוכנים | אין בו את המקור המפנה |
| **Polling** | כל שדות הליד, כולל המקור | רץ כל שעה, לא מיידי |

הם משלימים זה את זה: ה-polling מחזיק את נתוני הליד שלמים, וה-webhook הופך את שינוי הסטטוס למיידי. כשדחיפה מגיעה, השירות מוצא את הליד לפי `leadId` ולוקח ממנו את המקור.

### מה Surense שולחת

```json
{
  "eventType": "LeadUpdated",
  "leadId": "f7651ffc-...",
  "leadNumber": 3500,
  "customerName": "רועי סלאח",
  "date": "2026-09-04T13:25:41Z",
  "diff": {
    "statusName": { "before": "חדש", "after": "לא ענה" },
    "statusId":   { "before": "23545862-...", "after": "d2990176-..." },
    "closed":     { "before": true, "after": false }
  }
}
```

השינוי מגיע **מוכן** — אין מה להשוות. חותמת הזמן נלקחת מ-`date` שבאירוע ולא מרגע הקליטה, כך שדחיפה מושהית או שנשלחה מחדש נרשמת בזמן הנכון.

### הגנות בקליטה

**חתימה מאומתת** — Svix חותם את הגוף; דחיפה בלי חתימה תקפה נדחית ב-401.

**מניעת כפילות** — Svix מנסה שוב אחרי כישלון **עם אותו Message ID**. השירות שומר את המזהה ודוחה חזרה שנייה, אחרת אותו שינוי סטטוס היה מייצר שתי הודעות למקור.

**תשובה 200 גם כשלא נרשם כלום** — אירוע שאינו עדכון ליד, או ליד שהסנכרון עוד לא ראה, נשמר ומדווח אבל לא נכשל. 4xx היה גורם ל-Surense לנסות שוב ושוב משהו שלעולם לא יצליח.

`GET /api/webhooks` מציג את כל הדחיפות עם מה יצא מכל אחת. `?pending=true` מציג רק כאלה שנתקעו.

---

## הארכיטקטורה

```
Surense API ──(polling)──┐
                         ├──► sync ──► Postgres ──► REST API ──► אתה / Claude
POST /webhook/:source ───┘              │                          │
                                        └── leads                  ├─ קורא שינויים
                                            changes                ├─ שולח הודעות
                                            cursors                └─ מסמן כנשלח
```

---

## הנתונים

| טבלה | מה יש בה |
|---|---|
| `leads` | המצב הנוכחי, שורה לליד. השדות ב-JSONB — שדה חדש ב-CRM לא דורש migration |
| `changes` | ההיסטוריה, שורה לכל **שדה** שזז: לפני, אחרי, מתי |
| `cursors` | איפה כל צרכן הפסיק לקרוא |
| `sync_runs` | כל ריצה וכל כישלון, עם הסיבה |
| `webhook_events` | דחיפות שהתקבלו, כמו שהן |
| `templates` | סטטוס ← נוסח ההודעה. אתה עורך דרך ה-API, בלי deploy |
| `recipients` | מקור מפנה ← מייל/וואטספ |
| `source_names` | `sourceId` של ה-CRM ← שם המקור. מתמלא לבד מ-`GET /customers/sources` |

עמודת `changed_at` ב-`leads` היא **מתי השורה באמת השתנתה**, לא מתי הסנכרון רץ. שורה שלא זזה שומרת את החותמת הישנה.

---

## ה-API

כל הנתיבים דורשים `Authorization: Bearer <API_TOKEN>` חוץ מ-`/health`.

### קריאת שינויים — התהליך שאתה רוצה

```bash
# 1. איפה הפסקתי?
curl -H "Authorization: Bearer $TOKEN" $URL/api/cursor/notifier
# → { "name": "notifier", "lastId": 412, "latestChangeId": 480 }

# 2. מה חדש מאז?
curl -H "Authorization: Bearer $TOKEN" "$URL/api/changes?sinceId=412&limit=100"
# → { "count": 68, "nextCursor": 480, "changes": [ ... ] }

# 3. אחרי ששלחת את ההודעות — שמור את המקום
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"lastId": 480}' $URL/api/cursor/notifier
```

**ה-cursor זז רק קדימה.** בקשה מאוחרת שנושאת מיקום ישן לא תחזיר אותו אחורה ולא תגרום לשליחה כפולה.

### חלופה: סימון ברמת השינוי הבודד

```bash
curl -H "Authorization: Bearer $TOKEN" "$URL/api/changes?pending=true"
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"ids":[471,472,473],"via":"whatsapp"}' $URL/api/changes/notified
# → { "requested": 3, "claimed": 3, "alreadyClaimed": [] }
```

`claimed` מחזיר רק את מה ש**באמת** תפסת. שני תהליכים שרצים במקביל יקבלו קבוצות זרות — אף הודעה לא תישלח פעמיים.

### כל הנתיבים

| Method | Path | מה זה עושה |
|---|---|---|
| `GET` | `/health` | ללא אימות. זה מה שה-pinger קורא |
| `GET` | `/api/changes` | `?sinceId=` `?since=` `?pending=true` `?type=` `?limit=` |
| `POST` | `/api/changes/notified` | `{"ids":[...]}` — תופס שינויים כנשלחים |
| `GET` | `/api/cursor/:name` | איפה צרכן הפסיק |
| `PUT` | `/api/cursor/:name` | `{"lastId":N}` — קדימה בלבד |
| `GET` | `/api/cursors` | כל הסמנים |
| `GET` | `/api/leads` | `?changedSince=` `?limit=` `?offset=` |
| `GET` | `/api/leads/:id` | ליד בודד |
| `POST` | `/api/sync` | מתחיל סנכרון ומחזיר `202` מיד. `?wait=true` ממתין לסיום |
| `GET` | `/api/runs` | היסטוריית ריצות |
| `POST` | `/webhook/:source` | קולט דחיפה (דורש `WEBHOOK_SECRET`) |
| `GET` | `/api/webhooks` | דחיפות שהתקבלו |
| `GET` | `/api/outbox` | **מה לשלוח עכשיו** — מורכב ומוכן. `?maxPerRun=` לעקיפת הבלם |
| `GET`/`PUT` | `/api/templates` | סטטוס ← נוסח |
| `DELETE` | `/api/templates/:status` | מחיקת נוסח |
| `GET`/`PUT` | `/api/recipients` | מקור ← מייל |
| `DELETE` | `/api/recipients/:source` | מחיקת נמען |
| `GET` | `/api/sources` | כל המקורות בשימוש, מהעמוס לדל, עם דגל כיסוי |
| `GET`/`PUT` | `/api/source-names` | `sourceId` ← שם. ה-GET מחזיר גם את המזהים שעדיין בלי שם |
| `POST` | `/api/source-names/refresh` | מושך מחדש את כל המקורות מה-CRM בקריאה אחת |
| `DELETE` | `/api/source-names/:id` | מחיקת מיפוי |
| `GET` | `/api/columns` | האם ארבעת שמות העמודות נכונים, ומה להשתמש במקומם |
| `GET` | `/api/diagnostics` | כל מצב המערכת בתשובה אחת, בלי פרטי לקוחות |
| `POST` | `/api/recipients/import` | יבוא CSV. תצוגה מקדימה כברירת מחדל, `?apply=true` כדי לכתוב |

---

## שכבת ההודעות — מה נשלח ולמי

השרת לא שולח כלום. הוא **מחליט** ומגיש החלטה מוכנה; הקוד המתוזמן שלך שולח. זה מה שמאפשר לבדוק את כל ההיגיון בלי שרת דואר, ומה שהופך הרצה יבשה לאותו מסלול קוד בדיוק.

### שתי טבלאות שאתה שולט בהן דרך ה-API

**`templates`** — סטטוס ← נוסח. שמונת הסטטוסים שהמסמך שלך נותן להם נוסח נזרעים אוטומטית בהפעלה הראשונה. **סטטוס בלי שורה כאן לא שולח כלום** — הרשימה סגורה, וזה מה שמשאיר את 34 הסטטוסים שטרם הוגדרו שקטים במקום לנחש.

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '[{"status":"נסגר","message":"הטיפול בליד הסתיים"}]' $URL/api/templates
```

הזריעה רצה **רק על טבלה ריקה**. אחרי שתערוך נוסח, deploy הבא לא יחזיר את המקורי.

**`recipients`** — מקור מפנה ← מייל. המפתח נגזר מנרמול השם, לא מתקבל מהקורא, כדי שיתאים בדיוק לאיך ששם מקור מנורמל בזמן השליחה.

```bash
curl -X PUT -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '[{"sourceName":"מטאור - אריאל יואב דביר","email":"ariel@example.com"}]' \
  $URL/api/recipients
```

### יבוא קובץ הנמענים

יש לך כבר קובץ עם המיילים. שמור אותו כ-CSV מאקסל (File → Save As → CSV UTF-8) ו:

```bash
# 1. תצוגה מקדימה — לא כותב כלום
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/csv" \
  --data-binary @recipients.csv $URL/api/recipients/import

# 2. אחרי שבדקת את הדוח
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/csv" \
  --data-binary @recipients.csv "$URL/api/recipients/import?apply=true"
```

**קרא את התצוגה המקדימה לפני שאתה מאשר.** זה מה שהיא מחזירה:

```json
{
  "applied": false,
  "parsed": 47,
  "matchedSources": 41,
  "matchedLeads": 1832,
  "unmatchedFileRows": ["סוכנות ישנה - דוד", "מטאור-צפון"],
  "sourcesWithoutAddress": [
    { "source": "קמפיין", "leads": 485 },
    { "source": "חבר מביא חבר", "leads": 291 }
  ],
  "rejected": [{ "line": 12, "reason": "malformed-email", "detail": "ariel at example.com" }],
  "columnsDetected": { "sourceName": 0, "email": 1, "whatsapp": 2, "active": null }
}
```

| שדה | למה זה חשוב |
|---|---|
| `matchedLeads` | כמה לידים מכוסים בפועל — לא כמה שורות בקובץ |
| `unmatchedFileRows` | שורות שלא תואמות **שום** מקור בלידים. אלה שקטות לנצח — שם שהשתנה או טעות הקלדה |
| `sourcesWithoutAddress` | מקורות עם לידים שאין להם כתובת, מהעמוס לדל |
| `columnsDetected` | איזו עמודה נקראה כמה. ניחוש שגוי כאן בולט מיד |

**כותרות מזוהות אוטומטית**, בעברית ובאנגלית, בכל סדר: `מקור`/`source`, `מייל`/`דוא"ל`/`email`, `וואטספ`/`טלפון`, `פעיל`/`active`. יבוא חוזר **מעדכן** ולא מכפיל.

### מאיפה מתחילים למלא

```bash
curl -H "Authorization: Bearer $TOKEN" $URL/api/sources
```

מחזיר כל מקור שהלידים באמת משתמשים בו, **מהעמוס לדל**, עם דגל אם כבר יש לו כתובת. זה הופך את מילוי הטבלה מניחוש לרשימת עבודה.

### המזהה מול השם — למה צריך `source_names`

לליד ב-Surense **אין שם מקור**. מתוך 79 השדות שהוא מחזיר, מה שיש הוא `sourceId` — UUID. קובץ הנמענים לעומת זאת בנוי לפי **שמות** של שותפים. בלי גשר בין השניים אף הודעה לא תישלח אף פעם: המקור של כל ליד הוא UUID שלא תואם לשום שורה ב-`recipients`.

`source_names` הוא הגשר, והוא **מתמלא לבד**. `GET /customers/sources` מחזיר את כל המקורות בקריאה אחת, והסנכרון קורא לה בכל ריצה. אין מה למלא ידנית.

שני דברים שנמצאו רק מול תשובה אמיתית, ובלעדיהם זה לא עובד:

**השם יושב תחת `title`**, לא `name`. חיפוש של `name` מחזיר ריק.

**הקריאה דורשת scope בשם `customers:read`**, ובלעדיו היא נכשלת עם **400 ולא 403** — מה שקל מאוד לקרוא בטעות כבקשה שגויה ולחפש את הבאג במקום הלא נכון.

אימות מול נתונים אמיתיים: הליד של אלון ברמן נושא `sourceId = 40db82e8-…`, והרשומה שחזרה היא `title = "סו״ב רועי כץ"` — בדיוק מה שמסך ה-CRM מציג בשדה "מקור".

```bash
# רענון מיידי, בלי לחכות לסנכרון
curl -X POST -H "Authorization: Bearer $TOKEN" $URL/api/source-names/refresh

# מה עוד חסר, מהעמוס לדל
curl -H "Authorization: Bearer $TOKEN" $URL/api/source-names

# תיקון ידני של שם בודד, אם צריך
curl -X PUT -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '[{"sourceId":"2f3a9c1e-...","sourceName":"מטאור - אריאל יואב דביר"}]' \
  $URL/api/source-names
```

**רענון המקורות לא מפיל את הסנכרון.** אם ההרשאה תישלל מחר, המראה תמשיך לעבוד כרגיל, המיפוי הקיים יישאר במקומו, והריצה תדווח `sourcesError` עם הסיבה.

מזהה שאין לו שם **לא נשלח** ומדווח כ-`source-id-not-mapped` — סיבה נפרדת מ-`source-not-in-recipients`. לשתיהן תיקון אחר: אחת דורשת שורה ב-`source_names`, השנייה שורה בקובץ הנמענים, וערבוב ביניהן שולח את מי שממלא אותן לטבלה הלא נכונה.

אם ב-CRM אחר העמודה כבר מכילה שם ולא מזהה — לא צריך למלא כלום. המיפוי נכנס לפעולה רק כשהערך נראה כמו UUID.

### ה-outbox — מה שהקוד המתוזמן קורא

```bash
curl -H "Authorization: Bearer $TOKEN" $URL/api/outbox
```

```json
{
  "pendingChanges": 47,
  "readyToSend": 3,
  "floodBrake": null,
  "skipped": {
    "no-template":            { "count": 31, "examples": [] },
    "source-not-in-recipients": { "count": 13, "examples": ["קמפיין", "חבר מביא חבר"] }
  },
  "messages": [
    {
      "changeId": 812,
      "to": "ariel@example.com",
      "subject": "עדכון סטטוס ליד — דנה כהן",
      "body": "שלום אריאל,\n\nעדכון בליד שהפנית:\n\nלקוח: דנה כהן\n...",
      "status": "לא עונה 3",
      "statusBefore": "לא עונה 2"
    }
  ]
}
```

ההודעה כבר מורכבת. הקוד שלך שולח אותה, ואז:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"ids":[812],"via":"email"}' $URL/api/changes/notified
```

`skipped` מקובץ לפי סיבה ולא שורה-לכל-דילוג — 31 סטטוסים בלי נוסח זו שורה אחת, לא 31.

### בלם ההצפה

יותר מ-`MAX_SENDS_PER_RUN` הודעות בריצה אחת, וה-outbox מחזיר **`messages: []`** ומסביר למה:

```json
{ "readyToSend": 0,
  "floodBrake": { "blocked": 212, "limit": 25, "statuses": ["לא עונה זמן רב"] } }
```

עדכון סטטוס המוני ב-CRM היה משגר 212 הודעות ללקוחות אמיתיים תוך דקה, ואי אפשר לבטל אף אחת. אחרי שבדקת ואתה רוצה לשחרר בכל זאת:

```bash
curl -H "Authorization: Bearer $TOKEN" "$URL/api/outbox?maxPerRun=300"
```

### מצב פיילוט — רשת ביטחון

```
REDIRECT_ALL_TO=shai@example.com
```

כל עוד יש כאן כתובת, **כל הודעה מנותבת אליה** במקום למקור המפנה. לידים אמיתיים, סטטוסים אמיתיים, נוסח אמיתי — ואף אחד בחוץ לא יכול לקבל הודעה בטעות.

- הנושא מקבל תווית `[פיילוט → ariel@example.com]` כדי שאי אפשר יהיה לבלבל בין הודעת פיילוט לאמיתית
- **הגוף נשאר בדיוק כמו שייצא באמת**, אז אתה בודק את הנוסח האמיתי
- `GET /api/outbox` מחזיר `redirectAllTo` בכל תשובה, כך שהפניה שנשארה דלוקה בטעות בולטת מיד — וכזו שכבויה לפני עלייה לאוויר בולטת גם

**מחיקת המשתנה הזה היא הפעולה המכוונת שמעלה את המערכת לאוויר.**

### הרצה יבשה

`GET /api/outbox` **הוא** ההרצה היבשה — הוא לא שולח, רק מראה. תריץ אותו, תסתכל על `messages`, ורק כשהנוסח נראה נכון תחבר את השליחה.

---

## פריסה ב-Render

`render.yaml` בתיקייה. Render → New → Blueprint → בחר את ה-repo.

**עלות אמיתית: $6 לחודש.**

| רכיב | תוכנית | למה |
|---|---|---|
| Web service | **חינם** | 750 שעות בחודש. נרדם אחרי 15 דק' — ראה למטה |
| Postgres | **basic-256mb, $6** | ה[חינמי נמחק אחרי 30 יום](https://render.com/changelog/free-postgresql-instances-now-expire-after-30-days-previously-90) |
| Cron job | לא בשימוש | $1/חודש, אין tier חינמי — נחסך |

**SQLite לא אופציה כאן.** [הדיסק בשירות החינמי נמחק](https://render.com/docs/free) בכל deploy, restart או הירדמות — הקובץ פשוט ייעלם ואיתו כל ההיסטוריה.

### הסנכרון רץ ברקע

קריאה מלאה של כמה אלפי לידים לוקחת כדקה — 66 קריאות עוקבות ל-Surense. בקשת HTTP שנמשכת כל כך הרבה **נכשלת בכל מקום שחשוב**: לקוח שורת פקודה מוותר, הפלטפורמה סוגרת את החיבור, מתזמן חיצוני עושה timeout — והריצה נשארת תקועה באמצע בלי שנרשם למה.

לכן `POST /api/sync` מחזיר **`202` מיד** ועובד ברקע:

```json
{ "started": true, "note": "Running in the background — poll GET /api/runs" }
```

התוצאה מגיעה ל-`GET /api/runs`. שורה עם `finished: false` היא ריצה שלא הגיעה לסופה — תהליך שהופעל מחדש או בקשה שננטשה — וזה **לא** אותו דבר כמו ריצה שנכשלה. `outcome` אומר את זה במפורש.

`?wait=true` שומר על ההתנהגות הישנה למי שיכול להמתין.

### התזמון

השירות החינמי נרדם, אז טיימר פנימי לא אמין. הטיימר קיים כגיבוי, אבל **הטריגר האמיתי הוא קריאה חיצונית**:

```
POST https://your-app.onrender.com/api/sync
Authorization: Bearer <API_TOKEN>
```

תזמן את זה בשירות חינמי כמו cron-job.org כל שעה. הקריאה גם מעירה את השירות וגם מריצה את הסנכרון — שני דברים במכה אחת, ובלי ה-$1 של Render.

### משתני סביבה

`render.yaml` מייצר את `API_TOKEN` ו-`WEBHOOK_SECRET` לבד ומחבר את `DATABASE_URL`. שניים בלבד ידניים ב-Dashboard:

```
SURENSE_CLIENT_ID
SURENSE_CLIENT_SECRET      ← אחרי סיבוב
```

הרשימה המלאה ב-`.env.example`.

---

## אבטחה

**ה-API לא פתוח לכולם, ובכוונה.** הוא מגיש שמות לקוחות, טלפונים וסטטוסים. endpoint לא מאומת בכתובת ציבורית הוא דליפת מידע. לכן `API_TOKEN` נדרש בכל נתיב חוץ מ-`/health`, וההשוואה היא `timingSafeEqual`.

אם אתה צריך גישה מוגבלת יותר לצד שלישי, זו הרחבה של שכבת האימות — לא ביטול שלה.

**עוד שתי נקודות:**

- ה-`WEBHOOK_SECRET` נפרד מה-`API_TOKEN`, כדי שאפשר יהיה לבטל שולח בלי לנתק את כל הקוראים.
- האישורים שלך ב-Surense נושאים `leads:update` — הרשאת כתיבה שהקוד הזה לא משתמש בה. אם Surense מאפשרת client עם `leads:read` בלבד, כדאי. אז "לא נוגעים ב-CRM" הופך לתכונה של האישור, לא הבטחה של הקוד.

---

## שלושה מצבים שבהם הסנכרון מסרב לכתוב

זה מה שמונע נזק בלתי הפיך, והכול מכוסה בבדיקות:

| מצב | למה מסרב |
|---|---|
| הקריאה נקטעה באמצע | כל ליד שלא נקרא היה נרשם כ"נעלם מה-CRM" ומייצר התראה |
| ה-CRM החזיר אפס לידים | תקלה סבירה הרבה יותר מ-CRM ריק |
| נעלמו יותר מ-50% מהלידים | שינוי הרשאה או פילטר נראה בדיוק כמו מחיקה המונית |

הסף האחרון נשלט ב-`SHRINK_GUARD`. בכל שלושת המקרים כלום לא נכתב, והסיבה נרשמת ב-`sync_runs`.

---

## הרצה מקומית ובדיקות

```bash
cd node
npm install
cp .env.example .env      # מלא את הפרטים
npm start
```

```bash
createdb surense_test
TEST_DATABASE_URL=postgresql://localhost/surense_test npm test
```

**119 בדיקות אינטגרציה** מול Postgres אמיתי — רק ה-CRM מדומה. מסד הנתונים, הסנכרון, שרת ה-HTTP והניתוב הם האמיתיים, אז מה שעובר כאן הוא מה שרץ ב-Render.

מכוסים: ריצת בסיס, זיהוי שינוי ברמת השדה, שימור חותמות, ליד חדש, ליד שנעלם (וסימון שלא חוזר על עצמו), שלושת מקרי הסירוב, אימות ב-API, תפיסת שינויים פעם אחת בלבד, cursor שלא זז אחורה, דפדוף ב-`sinceId`, קליטת webhook, הרשימה הסגורה של הנוסחים, נרמול שמות מקורות, בלם ההצפה על שני צדי הגבול, וזריעה שלא דורסת עריכות.

> הבדיקות רצות טורית (`--test-concurrency=1`). שני קבצי הבדיקה מנקים את אותן טבלאות, ובמקביל הם מוחקים אחד לשני את הנתונים באמצע הריצה.

### שני באגים שהבדיקות תפסו

לא הייתי מוצא אותם בקריאה:

1. **`RETURNING` לא יכול לפנות ל-`EXCLUDED` או לערך שלפני העדכון** — Postgres מחזיר `errorMissingRTE`. כל כתיבת cursor נכשלה בשקט והמיקום נשאר 0.
2. **דף שמצהיר `hasNextPage: true` אבל מחזיר אפס שורות** נספר כקריאה שלמה. קריאה חלקית הייתה מיושמת כאילו היא כל ה-CRM — וכל ליד שלא נקרא היה מסומן כנעלם. עכשיו סתירה כזו נחשבת לקריאה לא שלמה.
