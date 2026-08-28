/**
 * בניית טבלה מקוצרת: עמודת "מקור" + עמודת מייל/וואטסאפ, בלי כפילויות.
 *
 * בכל שורה בגיליון המקור יש רק דרך התקשרות אחת - או מייל או וואטסאפ.
 * הסקריפט עובר על כל השורות, לוקח לכל "מקור" את הערך שנמצא,
 * ומייצר גיליון חדש שבו כל מקור מופיע פעם אחת בלבד.
 *
 * התקנה: מתוך הגיליון -> תוספים -> Apps Script -> להדביק -> לשמור.
 * הרצה: מתפריט "כלים שלי" -> "בנה טבלת מקור + איש קשר",
 *       או להריץ ידנית את buildSourceContactTable מהעורך.
 */

const SRC_SHEET_NAME = '';                    // ריק = הגיליון הפעיל. אחרת שם הגיליון.
const OUT_SHEET_NAME = 'מקור ואיש קשר';       // שם גיליון הפלט (נוצר/נדרס בכל הרצה)
const SRC_HEADER_ROWS = 1;                    // מספר שורות כותרת בגיליון המקור
const SOURCE_COL_FALLBACK = 3;                // אם לא נמצאה כותרת "מקור" - עמודה C

// כותרות שמזהות את עמודת המקור
const SOURCE_HINTS = ['מקור'];

// כותרות שמזהות עמודות של דרכי התקשרות (מייל / וואטסאפ / טלפון)
const CONTACT_HINTS = [
  'מייל', 'אימייל', 'דואל', 'דוא"ל', 'email', 'e-mail', 'mail',
  'וואטסאפ', 'ווטסאפ', 'וואצאפ', 'ואטסאפ', 'whatsapp', 'wa',
  'טלפון', 'נייד', 'פלאפון', 'phone', 'mobile'
];

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('כלים שלי')
    .addItem('בנה טבלת מקור + איש קשר', 'buildSourceContactTable')
    .addToUi();
}

function buildSourceContactTable() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = SRC_SHEET_NAME ? ss.getSheetByName(SRC_SHEET_NAME) : ss.getActiveSheet();
  if (!sheet) throw new Error('לא נמצא גיליון בשם "' + SRC_SHEET_NAME + '".');

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow <= SRC_HEADER_ROWS) throw new Error('אין שורות נתונים בגיליון "' + sheet.getName() + '".');

  const headers = sheet.getRange(SRC_HEADER_ROWS, 1, 1, lastCol).getDisplayValues()[0];
  const sourceCol = findSourceColumn(headers);
  const contactCols = findContactColumns(headers, sourceCol);
  if (contactCols.length === 0) {
    throw new Error(
      'לא נמצאה עמודת מייל/וואטסאפ לפי הכותרות. הכותרות שנמצאו: ' + headers.join(' | ')
    );
  }

  const numRows = lastRow - SRC_HEADER_ROWS;
  const values = sheet.getRange(SRC_HEADER_ROWS + 1, 1, numRows, lastCol).getDisplayValues();

  const order = [];   // שמירה על סדר ההופעה המקורי
  const byKey = {};   // key -> {source, contact, type, extras:[]}

  for (let i = 0; i < numRows; i++) {
    const row = values[i];
    const source = String(row[sourceCol - 1] == null ? '' : row[sourceCol - 1]).trim();
    if (source === '') continue;

    const key = source.toLowerCase();
    if (!(key in byKey)) {
      byKey[key] = { source: source, contact: '', type: '', extras: [] };
      order.push(key);
    }
    const entry = byKey[key];

    // בכל שורה אמור להיות ערך אחד בלבד - לוקחים את הראשון שאינו ריק
    for (let c = 0; c < contactCols.length; c++) {
      const contact = normalizeContact(row[contactCols[c] - 1]);
      if (contact === '') continue;

      if (entry.contact === '') {
        entry.contact = contact;
        entry.type = contactType(contact);
      } else if (entry.contact !== contact && entry.extras.indexOf(contact) === -1) {
        entry.extras.push(contact);
      }
      break;
    }
  }

  const out = [['מקור', 'מייל / וואטסאפ', 'סוג', 'ערכים נוספים שנמצאו']];
  for (let i = 0; i < order.length; i++) {
    const e = byKey[order[i]];
    out.push([e.source, e.contact, e.type, e.extras.join(', ')]);
  }

  writeOutput(ss, out);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'נוצרו ' + (out.length - 1) + ' שורות בגיליון "' + OUT_SHEET_NAME + '".'
  );
}

/** איתור עמודת "מקור" לפי הכותרת, עם נפילה לעמודה C. */
function findSourceColumn(headers) {
  const col = matchHeader(headers, SOURCE_HINTS);
  return col || SOURCE_COL_FALLBACK;
}

/** כל העמודות שנראות כמו דרך התקשרות, לפי סדר העמודות בגיליון. */
function findContactColumns(headers, sourceCol) {
  const cols = [];
  for (let i = 0; i < headers.length; i++) {
    if (i + 1 === sourceCol) continue;
    if (headerMatches(headers[i], CONTACT_HINTS)) cols.push(i + 1);
  }
  return cols;
}

function matchHeader(headers, hints) {
  for (let i = 0; i < headers.length; i++) {
    if (headerMatches(headers[i], hints)) return i + 1;
  }
  return 0;
}

function headerMatches(header, hints) {
  const h = String(header == null ? '' : header).trim().toLowerCase();
  if (h === '') return false;
  for (let i = 0; i < hints.length; i++) {
    if (h.indexOf(String(hints[i]).toLowerCase()) !== -1) return true;
  }
  return false;
}

/**
 * ניקוי ערך ההתקשרות. מספרי טלפון שנשמרו כמספר מאבדים את ה-0 המוביל,
 * ולכן מחזירים אותו כשמזהים מספר ישראלי בלי אפס בהתחלה.
 */
function normalizeContact(value) {
  let s = String(value == null ? '' : value).trim();
  if (s === '') return '';
  if (s.indexOf('@') !== -1) return s;

  const digits = s.replace(/[^0-9+]/g, '');
  if (digits === '') return s;
  if (/^5\d{8}$/.test(digits)) return '0' + digits;
  return digits;
}

function contactType(contact) {
  if (contact === '') return '';
  return contact.indexOf('@') !== -1 ? 'מייל' : 'וואטסאפ';
}

function writeOutput(ss, rows) {
  let out = ss.getSheetByName(OUT_SHEET_NAME);
  if (out) {
    out.clear();
  } else {
    out = ss.insertSheet(OUT_SHEET_NAME);
  }

  out.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  out.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
  out.setFrozenRows(1);
  out.autoResizeColumns(1, rows[0].length);
}
