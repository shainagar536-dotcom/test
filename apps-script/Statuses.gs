/**
 * The status -> message table from section 5 of the plan.
 *
 * This is the whole policy surface: adding a status means adding one line
 * here, and nothing else in the project changes.
 */

/**
 * Statuses that trigger a message to the referring source, mapped to the
 * exact wording sent for each one.
 */
var SEND_ON_STATUS = {
  'לא ענה':            'ניסינו ליצור קשר עם הלקוח אין מענה 1',
  'לא עונה 2':         'ניסינו ליצור קשר עם הלקוח אין מענה 2',
  'לא עונה 3':         'ניסינו ליצור קשר עם הלקוח אין מענה 3',
  'לא עונה זמן רב':    'ניסינו ליצור קשר מספר רב של פעמים אין מענה',
  'מתלבט לגבי העמלה':  'מתלבט לגבי העמלה',
  'לחזור במועד אחר':   'נקבע לחזור במועד אחר',
  'ממתין לת.ז':        'ממתין לת.ז',
  'רלוונטי ל2026':     'הלקוח לא רלוונטי לבדיקה כרגע אך רלוונטי לשנת 2026'
};

/**
 * Returns the message for a status, or null when nothing should be sent.
 *
 * The allowlist is closed by design: a status missing from SEND_ON_STATUS
 * sends nothing. That is the plan's binding default and it is what keeps the
 * 34 not-yet-defined statuses silent while the table is being filled in.
 *
 * @param {string} statusName
 * @return {?string}
 */
function messageForStatus_(statusName) {
  var key = normalizeText_(statusName);

  for (var status in SEND_ON_STATUS) {
    if (normalizeText_(status) === key) {
      return SEND_ON_STATUS[status];
    }
  }

  return null;
}

/**
 * Normalizes a string for comparison.
 *
 * Section 6 calls name matching the number-one failure point: a doubled space
 * or a typographic quote is enough to lose a row. Both sides of every
 * comparison — status names and source names — go through this.
 *
 * @param {*} value
 * @return {string}
 */
function normalizeText_(value) {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value)
    .replace(/[‘’׳ʼ]/g, "'")   // ’ ‘ ׳ ʼ  -> '
    .replace(/[“”״]/g, '"')          // “ ” ״    -> "
    .replace(/[​-‏‪-‮﻿]/g, '')  // zero-width / bidi marks
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
