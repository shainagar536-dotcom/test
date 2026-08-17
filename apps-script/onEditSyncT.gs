/**
 * מילוי אוטומטי של עמודה T לפי ערך משותף בעמודה C.
 *
 * כשממלאים תא בעמודה T, הסקריפט מוצא את כל השורות שיש להן
 * אותו ערך בעמודה C, ומעתיק אליהן את אותו ערך ל-T.
 *
 * התקנה: מתוך הגיליון -> תוספים -> Apps Script -> להדביק -> לשמור.
 * אין צורך ללחוץ "הפעלה" - הטריגר onEdit רץ לבד בעריכת תא.
 */

const T_COL = 20;        // עמודה T
const C_COL = 3;         // עמודה C
const HEADER_ROWS = 1;   // מספר שורות כותרת
const SHEET_NAME = '';   // ריק = כל הגיליונות. אחרת שם הגיליון בלבד.
const OVERWRITE = true;  // true = לדרוס ערכי T קיימים, false = למלא רק תאים ריקים

function onEdit(e) {
  // הגנה: אם מריצים ידנית מהעורך אין אובייקט אירוע
  if (!e || !e.range) {
    SpreadsheetApp.getUi().alert(
      'אין להריץ את onEdit ידנית. שמור את הקוד וערוך תא בעמודה T בגיליון.'
    );
    return;
  }

  const range = e.range;
  const sheet = range.getSheet();
  if (SHEET_NAME && sheet.getName() !== SHEET_NAME) return;

  // רק עריכה בתוך עמודה T (תא בודד או כמה שורות בהדבקה)
  if (range.getColumn() !== T_COL || range.getLastColumn() !== T_COL) return;

  const firstRow = Math.max(range.getRow(), HEADER_ROWS + 1);
  const lastEditedRow = range.getLastRow();
  if (lastEditedRow < firstRow) return;

  const lastRow = sheet.getLastRow();
  if (lastRow <= HEADER_ROWS) return;

  const numRows = lastRow - HEADER_ROWS;
  const cValues = sheet.getRange(HEADER_ROWS + 1, C_COL, numRows, 1).getValues();
  const tRange = sheet.getRange(HEADER_ROWS + 1, T_COL, numRows, 1);
  const tValues = tRange.getValues();

  let changed = false;

  for (let editedRow = firstRow; editedRow <= lastEditedRow; editedRow++) {
    const idx = editedRow - HEADER_ROWS - 1;
    if (idx < 0 || idx >= numRows) continue;

    const newValue = tValues[idx][0];
    if (newValue === '' || newValue === null) continue;

    const key = normalizeKey(cValues[idx][0]);
    if (key === '') continue;

    for (let i = 0; i < numRows; i++) {
      if (i === idx) continue;
      if (normalizeKey(cValues[i][0]) !== key) continue;
      if (!OVERWRITE && tValues[i][0] !== '' && tValues[i][0] !== null) continue;
      if (String(tValues[i][0]) === String(newValue)) continue;
      tValues[i][0] = newValue;
      changed = true;
    }
  }

  if (changed) tRange.setValues(tValues);
}

/**
 * השוואה סלחנית: מתעלמת מרווחים מיותרים ומאותיות גדולות/קטנות,
 * ומטפלת נכון בתאריכים (אובייקטי Date אף פעם לא שווים ב-===).
 */
function normalizeKey(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return 'D' + value.getTime();
  return String(value).trim().toLowerCase();
}

/**
 * הרצה חד-פעמית על כל הגיליון: משלימה T חסר לפי שורות
 * אחרות באותה קבוצת C. את זו כן אפשר להריץ מהעורך.
 */
function syncAllRows() {
  const sheet = SHEET_NAME
    ? SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME)
    : SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

  const lastRow = sheet.getLastRow();
  if (lastRow <= HEADER_ROWS) return;

  const numRows = lastRow - HEADER_ROWS;
  const cValues = sheet.getRange(HEADER_ROWS + 1, C_COL, numRows, 1).getValues();
  const tRange = sheet.getRange(HEADER_ROWS + 1, T_COL, numRows, 1);
  const tValues = tRange.getValues();

  const byKey = {};
  for (let i = 0; i < numRows; i++) {
    const key = normalizeKey(cValues[i][0]);
    const val = tValues[i][0];
    if (key !== '' && val !== '' && val !== null) byKey[key] = val;
  }

  let changed = false;
  for (let i = 0; i < numRows; i++) {
    const key = normalizeKey(cValues[i][0]);
    if (key === '' || !(key in byKey)) continue;
    if (!OVERWRITE && tValues[i][0] !== '' && tValues[i][0] !== null) continue;
    if (String(tValues[i][0]) === String(byKey[key])) continue;
    tValues[i][0] = byKey[key];
    changed = true;
  }

  if (changed) tRange.setValues(tValues);
}
