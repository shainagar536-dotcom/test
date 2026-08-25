/**
 * שליחת הודעות וואטספ דרך WhatsApp Cloud API הרשמי של Meta.
 *
 * למה Apps Script ולא סביבה אחרת: הקוד רץ בשרתי גוגל, בלי חסימות רשת,
 * עם גישה ישירה לגיליונות. השליחה עצמה היא קריאת HTTPS רגילה.
 *
 * התקנה:
 *   1. מתוך הגיליון -> תוספים -> Apps Script -> להדביק כקובץ חדש.
 *   2. להריץ פעם אחת את setupCredentials() ולמלא את הפרטים בחלונות.
 *   3. להריץ את testSendToMe() כדי לוודא שהכל עובד.
 *
 * הטוקן והמזהים נשמרים ב-Script Properties ולא בקוד -
 * כדי שלא יגיעו לגיט ולא ייחשפו לאף אחד שרואה את הסקריפט.
 */

const WA_API_VERSION = 'v25.0';
const WA_DRY_RUN = true;    // true = לא שולח באמת, רק רושם ביומן מה היה נשלח
const WA_MAX_PER_RUN = 25;  // בלם הצפה: יותר מזה בריצה אחת = עצירה מלאה
const WA_LOG_SHEET = 'לוג וואטספ';

// התבנית המאושרת לעדכוני סטטוס. ארבעה משתנים לפי הסדר:
// {{1}} שם המקור, {{2}} שם הלקוח, {{3}} מספר מזהה, {{4}} נוסח הסטטוס
const WA_STATUS_TEMPLATE = 'lead_status_update';
const WA_STATUS_LANG = 'he';

/**
 * הרצה חד-פעמית: שמירת פרטי החיבור ב-Script Properties.
 */
function setupCredentials() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();

  const token = ui.prompt('טוקן הגישה של Meta', 'מתחיל ב-EAA...', ui.ButtonSet.OK_CANCEL);
  if (token.getSelectedButton() !== ui.Button.OK) return;

  const phoneId = ui.prompt('Phone Number ID', 'מספר ארוך, לא מספר הטלפון עצמו', ui.ButtonSet.OK_CANCEL);
  if (phoneId.getSelectedButton() !== ui.Button.OK) return;

  props.setProperties({
    WA_TOKEN: token.getResponseText().trim(),
    WA_PHONE_ID: phoneId.getResponseText().trim()
  });

  ui.alert('נשמר. עכשיו אפשר להריץ את testSendToMe().');
}

/**
 * נרמול מספר טלפון ישראלי לפורמט שה-API דורש: 972XXXXXXXXX.
 * בלי פלוס, בלי אפס מוביל, בלי מקפים ורווחים.
 *
 * מטפל גם במקרה שהגיליון בלע את האפס המוביל ושמר 547379416 כמספר.
 * מחזיר מחרוזת ריקה אם המספר לא תקין - ואז פשוט לא שולחים.
 */
function normalizeWaPhone(raw) {
  if (raw === null || raw === undefined) return '';

  let digits = String(raw).replace(/[^0-9]/g, '');
  if (digits === '') return '';

  if (digits.indexOf('972') === 0) {
    digits = digits.slice(3).replace(/^0+/, '');
  } else if (digits.indexOf('0') === 0) {
    digits = digits.slice(1);
  }

  // מספר נייד ישראלי אחרי הסרת הקידומת: 9 ספרות שמתחילות ב-5
  if (!/^5\d{8}$/.test(digits)) return '';
  return '972' + digits;
}

/**
 * שליחת הודעת תבנית בודדת.
 * מחזיר {ok, id, error} - לעולם לא זורק, כדי שליד אחד שנכשל
 * לא יפיל את כל הריצה.
 */
function sendWhatsAppTemplate(to, templateName, langCode, bodyParams) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty('WA_TOKEN');
  const phoneId = props.getProperty('WA_PHONE_ID');

  if (!token || !phoneId) {
    return { ok: false, error: 'חסרים פרטי חיבור. הרץ setupCredentials() קודם.' };
  }

  const normalized = normalizeWaPhone(to);
  if (!normalized) {
    return { ok: false, error: 'מספר לא תקין: ' + to };
  }

  const template = {
    name: templateName,
    language: { code: langCode }
  };

  if (bodyParams && bodyParams.length) {
    template.components = [{
      type: 'body',
      parameters: bodyParams.map(function (value) {
        return { type: 'text', text: String(value) };
      })
    }];
  }

  const payload = {
    messaging_product: 'whatsapp',
    to: normalized,
    type: 'template',
    template: template
  };

  if (WA_DRY_RUN) {
    return { ok: true, id: 'DRY_RUN', dryRun: true, payload: payload };
  }

  const url = 'https://graph.facebook.com/' + WA_API_VERSION + '/' + phoneId + '/messages';
  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const code = response.getResponseCode();
  const body = JSON.parse(response.getContentText() || '{}');

  if (code >= 200 && code < 300 && body.messages && body.messages.length) {
    return { ok: true, id: body.messages[0].id };
  }

  const err = body.error || {};
  return {
    ok: false,
    error: '[' + code + '] ' + (err.message || response.getContentText())
  };
}

/**
 * שליחת עדכון סטטוס יחיד למקור המפנה.
 */
function sendStatusUpdate(phone, sourceName, clientName, leadId, statusText) {
  return sendWhatsAppTemplate(phone, WA_STATUS_TEMPLATE, WA_STATUS_LANG, [
    sourceName, clientName, leadId, statusText
  ]);
}

/**
 * שליחה מרוכזת עם בלם ההצפה.
 *
 * items: [{phone, sourceName, clientName, leadId, statusText}]
 *
 * אם יש יותר מ-WA_MAX_PER_RUN פריטים - לא נשלח כלום. זה מכוון:
 * עדכון סטטוס המוני ב-CRM לא אמור לשגר מאות הודעות ללקוחות אמיתיים
 * בלי שאדם אישר את זה.
 */
function sendStatusUpdatesBatch(items) {
  const report = { attempted: 0, sent: 0, failed: 0, blocked: false, errors: [] };

  if (!items || !items.length) return report;

  if (items.length > WA_MAX_PER_RUN) {
    report.blocked = true;
    report.errors.push(
      'בלם הצפה: ' + items.length + ' הודעות בריצה אחת (המקסימום ' +
      WA_MAX_PER_RUN + '). לא נשלח כלום - נדרש אישור ידני.'
    );
    logWhatsApp('-', '-', 'BLOCKED', report.errors[0]);
    return report;
  }

  items.forEach(function (item) {
    report.attempted++;
    const result = sendStatusUpdate(
      item.phone, item.sourceName, item.clientName, item.leadId, item.statusText
    );

    if (result.ok) {
      report.sent++;
      logWhatsApp(item.phone, item.leadId, result.dryRun ? 'DRY_RUN' : 'SENT', result.id);
    } else {
      report.failed++;
      report.errors.push(item.leadId + ': ' + result.error);
      logWhatsApp(item.phone, item.leadId, 'FAILED', result.error);
    }
  });

  return report;
}

/**
 * רישום ביומן. שורה לכל ניסיון שליחה, כולל כשלונות -
 * בלי זה אין דרך לדעת מה באמת יצא.
 */
function logWhatsApp(phone, leadId, status, detail) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(WA_LOG_SHEET);

  if (!sheet) {
    sheet = ss.insertSheet(WA_LOG_SHEET);
    sheet.appendRow(['תאריך', 'טלפון', 'מספר ליד', 'סטטוס', 'פרטים']);
    sheet.setFrozenRows(1);
  }

  sheet.appendRow([new Date(), String(phone), String(leadId), status, String(detail)]);
}

/**
 * בדיקה: שולח hello_world למספר שתזין.
 * התבנית הזו קיימת תמיד ולא דורשת פרמטרים, אז היא הבדיקה הנקייה ביותר.
 *
 * שים לב: אם WA_DRY_RUN הוא true לא תישלח הודעה אמיתית.
 */
function testSendToMe() {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.prompt('בדיקת שליחה', 'מספר הטלפון שלך (למשל 0547379416)', ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK) return;

  const result = sendWhatsAppTemplate(answer.getResponseText(), 'hello_world', 'en_US', null);

  if (result.ok && result.dryRun) {
    ui.alert('מצב הרצה יבשה\n\nלא נשלחה הודעה. זה מה שהיה נשלח:\n\n' +
             JSON.stringify(result.payload, null, 2));
  } else if (result.ok) {
    ui.alert('נשלח בהצלחה\n\nמזהה ההודעה:\n' + result.id);
  } else {
    ui.alert('השליחה נכשלה\n\n' + result.error);
  }
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('וואטספ')
    .addItem('הגדרת פרטי חיבור', 'setupCredentials')
    .addItem('שליחת הודעת בדיקה', 'testSendToMe')
    .addToUi();
}
