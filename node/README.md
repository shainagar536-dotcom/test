# שירות סנכרון Surense → Postgres → API

שירות Node.js שמושך לידים מ-Surense CRM, שומר כל שינוי ב-Postgres, וחושף API מאובטח שממנו אפשר למשוך את השינויים ולשלוח הודעות.

**ה-CRM נקרא בלבד.** שלוש קריאות בסך הכול: `POST /oauth/token`, `GET /leads/fields`, `POST /leads/search`. אין `PATCH`, אין `PUT`, אין `DELETE` בשום מקום בקוד.

---

## למה זה לא webhook מ-Surense

המסמך שלך, סעיף 3, אילוץ 1 קובע: **אין Webhooks ב-Surense**. Webhook עובד רק אם המקור דוחף אליך, ו-Surense לא דוחפת — שרת שמחכה לה יחכה לנצח.

לכן:

- **המנוע הוא polling** — השירות מושך מ-Surense לפי לוח זמנים.
- **ה-endpoint של ה-webhook קיים בכל זאת** (`POST /webhook/:source`) ושומר כל דחיפה כמו שהיא בטבלה `webhook_events`. אם Surense תוסיף webhooks, או שמערכת אחרת תרצה לדחוף — זה כבר עובד, ושום דבר לא ילך לאיבוד בזמן שנכתוב את הטיפול.

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
| `POST` | `/api/sync` | מריץ סנכרון עכשיו |
| `GET` | `/api/runs` | היסטוריית ריצות |
| `POST` | `/webhook/:source` | קולט דחיפה (דורש `WEBHOOK_SECRET`) |
| `GET` | `/api/webhooks` | דחיפות שהתקבלו |

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

**21 בדיקות אינטגרציה** מול Postgres אמיתי — רק ה-CRM מדומה. מסד הנתונים, הסנכרון, שרת ה-HTTP והניתוב הם האמיתיים, אז מה שעובר כאן הוא מה שרץ ב-Render.

מכוסים: ריצת בסיס, זיהוי שינוי ברמת השדה, שימור חותמות, ליד חדש, ליד שנעלם (וסימון שלא חוזר על עצמו), שלושת מקרי הסירוב, אימות ב-API, תפיסת שינויים פעם אחת בלבד, cursor שלא זז אחורה, דפדוף ב-`sinceId`, וקליטת webhook.

### שני באגים שהבדיקות תפסו

לא הייתי מוצא אותם בקריאה:

1. **`RETURNING` לא יכול לפנות ל-`EXCLUDED` או לערך שלפני העדכון** — Postgres מחזיר `errorMissingRTE`. כל כתיבת cursor נכשלה בשקט והמיקום נשאר 0.
2. **דף שמצהיר `hasNextPage: true` אבל מחזיר אפס שורות** נספר כקריאה שלמה. קריאה חלקית הייתה מיושמת כאילו היא כל ה-CRM — וכל ליד שלא נקרא היה מסומן כנעלם. עכשיו סתירה כזו נחשבת לקריאה לא שלמה.
