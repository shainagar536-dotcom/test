/**
 * מילוי אוטומטי של עמודות T ו-U לפי ערך משותף בעמודה C.
 *
 * כשממלאים תא באחת מעמודות היעד, הסקריפט מוצא את כל השורות
 * שיש להן אותו ערך בעמודה C, ומעתיק אליהן את אותו ערך -
 * לאותה עמודה שנערכה. T ו-U עובדות בנפרד ולא משפיעות זו על זו.
 *
 * התקנה: מתוך הגיליון -> תוספים -> Apps Script -> להדביק -> לשמור.
 * אין צורך ללחוץ "הפעלה" - הטריגר onEdit רץ לבד בעריכת תא.
 */

const SYNC_COLS = [20, 21]; // עמודות היעד: T=20, U=21. אפשר להוסיף עוד.
const C_COL = 3;            // עמודה C - המפתח לקיבוץ
const HEADER_ROWS = 1;      // מספר שורות כותרת
const SHEET_NAME = '';      // ריק = כל הגיליונות. אחרת שם הגיליון בלבד.
const OVERWRITE = true;     // true = לדרוס ערכים קיימים, false = למלא רק תאים ריקים

function onEdit(e) {
  // הגנה: אם מריצים ידנית מהעורך אין אובייקט אירוע
  if (!e || !e.range) {
    SpreadsheetApp.getUi().alert(
      'אין להריץ את onEdit ידנית. שמור את הקוד וערוך תא בעמודה T או U בגיליון.'
    );
    return;
  }

  const range = e.range;
  const sheet = range.getSheet();
  if (SHEET_NAME && sheet.getName() !== SHEET_NAME) return;

  // אילו מעמודות היעד נכללות בעריכה (תומך גם בהדבקה על פני T ו-U יחד)
  const firstCol = range.getColumn();
  const lastCol = range.getLastColumn();
  const touchedCols = SYNC_COLS.filter(function (col) {
    return col >= firstCol && col <= lastCol;
  });
  if (touchedCols.length === 0) return;

  const firstRow = Math.max(range.getRow(), HEADER_ROWS + 1);
  const lastEditedRow = range.getLastRow();
  if (lastEditedRow < firstRow) return;

  const lastRow = sheet.getLastRow();
  if (lastRow <= HEADER_ROWS) return;

  const numRows = lastRow - HEADER_ROWS;
  const cValues = sheet.getRange(HEADER_ROWS + 1, C_COL, numRows, 1).getValues();

  touchedCols.forEach(function (targetCol) {
    propagateColumn(sheet, targetCol, cValues, numRows, firstRow, lastEditedRow);
  });
}

/**
 * מפיץ את הערכים של העמודה שנערכה לכל השורות עם אותו מפתח ב-C.
 */
function propagateColumn(sheet, targetCol, cValues, numRows, firstRow, lastEditedRow) {
  const targetRange = sheet.getRange(HEADER_ROWS + 1, targetCol, numRows, 1);
  const values = targetRange.getValues();
  let changed = false;

  for (let editedRow = firstRow; editedRow <= lastEditedRow; editedRow++) {
    const idx = editedRow - HEADER_ROWS - 1;
    if (idx < 0 || idx >= numRows) continue;

    const newValue = values[idx][0];
    if (newValue === '' || newValue === null) continue;

    const key = normalizeKey(cValues[idx][0]);
    if (key === '') continue;

    for (let i = 0; i < numRows; i++) {
      if (i === idx) continue;
      if (normalizeKey(cValues[i][0]) !== key) continue;
      if (!OVERWRITE && values[i][0] !== '' && values[i][0] !== null) continue;
      if (String(values[i][0]) === String(newValue)) continue;
      values[i][0] = newValue;
      changed = true;
    }
  }

  if (changed) targetRange.setValues(values);
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
 * הרצה חד-פעמית על כל הגיליון: משלימה ערכים חסרים בעמודות היעד
 * לפי שורות אחרות באותה קבוצת C. את זו כן אפשר להריץ מהעורך.
 */
function syncAllRows() {
  const sheet = SHEET_NAME
    ? SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME)
    : SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();

  const lastRow = sheet.getLastRow();
  if (lastRow <= HEADER_ROWS) return;

  const numRows = lastRow - HEADER_ROWS;
  const cValues = sheet.getRange(HEADER_ROWS + 1, C_COL, numRows, 1).getValues();

  SYNC_COLS.forEach(function (targetCol) {
    const targetRange = sheet.getRange(HEADER_ROWS + 1, targetCol, numRows, 1);
    const values = targetRange.getValues();

    const byKey = {};
    for (let i = 0; i < numRows; i++) {
      const key = normalizeKey(cValues[i][0]);
      const val = values[i][0];
      if (key !== '' && val !== '' && val !== null) byKey[key] = val;
    }

    let changed = false;
    for (let i = 0; i < numRows; i++) {
      const key = normalizeKey(cValues[i][0]);
      if (key === '' || !(key in byKey)) continue;
      if (!OVERWRITE && values[i][0] !== '' && values[i][0] !== null) continue;
      if (String(values[i][0]) === String(byKey[key])) continue;
      values[i][0] = byKey[key];
      changed = true;
    }

    if (changed) targetRange.setValues(values);
  });
}
