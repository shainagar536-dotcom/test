/**
 * רשימת מקורות: איך שזה מופיע בשורנס מול השם הנקי.
 *
 * הסקריפט עובר על עמודת המקור בגיליון, אוסף כל ערך ייחודי,
 * ומוריד ממנו את הקידומת "מטאור -" (או "מטוא -").
 * למשל: "מטאור - יוסי חזוט" -> "יוסי חזוט".
 *
 * התוצאה נכתבת לגיליון חדש בשם "רשימת מקורות" עם שלוש עמודות:
 *   A - איך שזה מופיע בשורנס (הערך המקורי)
 *   B - שם נקי (בלי מטאור)
 *   C - כמות שורות עם המקור הזה
 *
 * הרצה: Apps Script -> לבחור את הפונקציה buildSourcesList -> הפעלה.
 */

const SOURCE_COL = 3;                    // עמודת המקור בגיליון (C=3). לשנות לפי הצורך.
const SOURCE_HEADER_ROWS = 1;            // מספר שורות כותרת בגיליון המקור
const SOURCE_SHEET_NAME = '';            // ריק = הגיליון הפעיל. אחרת שם הגיליון.
const OUTPUT_SHEET_NAME = 'רשימת מקורות';
const PREFIXES = ['מטאור', 'מטוא'];      // קידומות להסרה (הארוכה קודם)

function buildSourcesList() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = SOURCE_SHEET_NAME ? ss.getSheetByName(SOURCE_SHEET_NAME) : ss.getActiveSheet();
  if (!sheet) throw new Error('לא נמצא גיליון בשם: ' + SOURCE_SHEET_NAME);
  if (sheet.getName() === OUTPUT_SHEET_NAME) {
    throw new Error('עבור לגיליון הנתונים לפני ההרצה (לא לגיליון "' + OUTPUT_SHEET_NAME + '").');
  }

  const lastRow = sheet.getLastRow();
  if (lastRow <= SOURCE_HEADER_ROWS) return;

  const values = sheet
    .getRange(SOURCE_HEADER_ROWS + 1, SOURCE_COL, lastRow - SOURCE_HEADER_ROWS, 1)
    .getDisplayValues();

  // ספירת ערכים ייחודיים, לפי סדר הופעה ראשונה
  const counts = {};
  const order = [];
  values.forEach(function (row) {
    const original = String(row[0]).trim();
    if (original === '') return;
    if (!(original in counts)) {
      counts[original] = 0;
      order.push(original);
    }
    counts[original]++;
  });

  const output = order.map(function (original) {
    return [original, cleanSource(original), counts[original]];
  });
  output.sort(function (a, b) {
    return a[1].localeCompare(b[1], 'he');
  });

  let out = ss.getSheetByName(OUTPUT_SHEET_NAME);
  if (out) out.clear();
  else out = ss.insertSheet(OUTPUT_SHEET_NAME);

  out.setRightToLeft(true);
  out.getRange(1, 1, 1, 3)
    .setValues([['איך שזה מופיע בשורנס', 'שם נקי', 'כמות שורות']])
    .setFontWeight('bold');
  if (output.length > 0) out.getRange(2, 1, output.length, 3).setValues(output);
  out.setFrozenRows(1);
  out.autoResizeColumns(1, 3);
}

/**
 * מוריד קידומת "מטאור" / "מטוא" ואחריה מקף (רגיל, ארוך או מקף עברי) ורווחים.
 * "מטאור - יוסי חזוט" -> "יוסי חזוט". ערך בלי קידומת חוזר כמו שהוא.
 */
function cleanSource(value) {
  let s = String(value).trim();
  for (let i = 0; i < PREFIXES.length; i++) {
    const p = PREFIXES[i];
    if (s.indexOf(p) === 0) {
      const rest = s.slice(p.length);
      const m = rest.match(/^\s*[-–—־]\s*/);
      if (m) return rest.slice(m[0].length).trim();
      if (rest.trim() === '') return s; // הערך הוא רק "מטאור" - משאירים
    }
  }
  return s;
}
