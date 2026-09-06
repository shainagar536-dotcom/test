/**
 * Status -> message: the whole policy for what gets sent.
 *
 * Seeded into an empty templates table on first boot and never again, so an
 * edit made through the API survives every later deploy.
 *
 * The statuses are spelled as the CRM stores them — checked against the 42 it
 * actually uses, not transcribed. Matching is normalized anyway (a hyphen and
 * an en dash are the same key, and so are י"כ and י''כ), but storing the
 * CRM's own spelling means the table reads like the CRM.
 *
 * `{total}` is the "סך הכל" amount. A message still carrying an unfilled
 * placeholder is never sent — see SKIP.unfilled in outbox.js. Telling a
 * partner "הוגשו החזרים בסך {total}" is worse than telling them nothing.
 */
export const SEED_TEMPLATES = [
  // --- no contact made
  { status: 'לא ענה',
    message: 'ניסינו ליצור קשר עם הלקוח אין מענה 1' },
  { status: 'לא עונה 2',
    message: 'ניסינו ליצור קשר עם הלקוח אין מענה 2' },
  { status: 'לא עונה 3',
    message: 'ניסינו ליצור קשר עם הלקוח אין מענה 3' },
  { status: 'לא עונה זמן רב',
    message: 'ניסינו ליצור קשר מספר רב של פעמים אין מענה' },

  // --- in conversation
  { status: 'מתלבט לגבי העמלה',
    message: 'מתלבט לגבי העמלה' },
  { status: 'לחזור במועד אחר',
    message: 'נקבע לחזור במועד אחר' },
  { status: 'ממתין לת.ז',
    message: 'ממתין לאמצעי זיהוי מהלקוח' },
  { status: 'רלוונטי ל2026',
    message: 'הלקוח לא רלוונטי לבדיקה כרגע אך רלוונטי לשנת 2026 – ' +
      'ניצור קשר שוב בשנת המס הבאה' },

  // --- in progress
  { status: 'בחתימה',
    message: 'הלקוח נמצא בשלבי חתימה על מסמכים' },
  { status: 'בבדיקה',
    message: 'הלקוח חתם על המסמכים כעת נמצא בשלבי בדיקה' },
  { status: 'ממתין למסמכים מהלקוח',
    message: 'ממתינים שהלקוח יספק מסמכים לסיום הבדיקה' },

  // --- outcomes
  { status: 'הוגש',
    message: 'הלקוח נמצא זכאי ! הוגשו החזרים בסך {total}' },
  { status: 'טיפול הסתיים - שולם לקוח',
    message: 'הלקוח קיבל החזר ממס הכנסה בסך {total}' },

  // --- renewals
  { status: 'חידוש 2026', message: 'הלקוח עבר לבדיקה חוזרת בשנת 2027' },
  { status: 'חידוש 2027', message: 'הלקוח עבר לבדיקה חוזרת בשנת 2028' },
  { status: 'חידוש 2028', message: 'הלקוח עבר לבדיקה חוזרת בשנת 2029' },

  // --- not eligible / stopped
  { status: 'לא רלוונטי לאחר שיחה ראשונית',
    message: 'לאחר שיחה עם הלקוח נמצא שהוא אינו רלוונטי לבדיקת החזרי מס' },
  { status: 'לאחר בדיקה לא זכאי',
    message: 'לאחר בדיקה יסודית לצערנו נמצא שהלקוח לא זכאי להחזר מס' },
  { status: 'לא שלח ת.ז - זמן רב',
    message: 'הטיפול בלקוח נעצר מכיוון שהלקוח לא שולח ת.ז זמן רב ' +
      'לאחר תזכורות רבים' },
  { status: 'לא חותם - זמן רב',
    message: 'הטיפול בלקוח נעצר מכיוון שהלקוח לא חותם על המסמכים זמן רב ' +
      'לאחר תזכורות רבים' },

  // Not among the 42 statuses the CRM currently uses; kept because it was
  // specified, and it simply never fires until such a status exists. The one
  // the CRM does have — י''כ שנפלו — is on the muted list below.
  { status: 'י"פ שנפלו - לא משתף פעולה',
    message: 'ייפוי הכוח בוטל והלקוח לא מוכן לשתף פעולה על מנת לחתום מחדש' },

  { status: 'לא משתף פעולה',
    message: 'הטיפול נעצר הלקוח לא משתף פעולה' },
  { status: 'לא מעוניין',
    message: 'הלקוח לא מעוניין להתקדם' }
];

/**
 * Statuses that must never produce a message.
 *
 * Silence is already the default — a status with no template sends nothing —
 * so this list changes no behaviour on its own. It exists because "we decided
 * not to send for this" and "nobody has written this one yet" look identical
 * in an empty table, and only one of them is safe to fix by adding wording.
 *
 * Several of these differ from a sending status by one word, which is exactly
 * why they are written out rather than left implied:
 *
 *   'חתימה'                      is muted; 'בחתימה'                     sends
 *   'לאחר בדיקה'                 is muted; 'לאחר בדיקה לא זכאי'          sends
 *   'הוגש - ממתין למסמכים מהלקוח' is muted; 'הוגש'                       sends
 *   'טיפול הסתיים - שולם סוכן'    is muted; 'טיפול הסתיים - שולם לקוח'    sends
 */
export const MUTED_STATUSES = [
  'חדש',
  'רלוונטי ל2025',
  'השהיה לי"כ',
  'ממתין לייפוי כוח',
  'ממתין לשליחה',
  'חסר זיהוי',
  'י"כ שנפלו',
  'חסר אישור ייצוג',
  'השהיה',
  'ממתין ל...',
  'לאחר בדיקה',
  'מוכן לסגירה',
  'חתימה',
  'חתום - לא ניתן להגיש',
  'הוגש - ממתין למסמכים מהלקוח',
  'הוגש ממתין ל......',
  'התקבל חלקי',
  'חידוש 2025',
  'התקבל',
  'טיפול הסתיים - שולם סוכן',
  'נסגר',
  'אישור ב"ל'
];
