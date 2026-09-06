/**
 * Hebrew labels and display formatting for the CRM's own field keys.
 *
 * The mirror stores every field under the key the CRM uses, which is English
 * and abbreviated — `statusName`, `assigneeName`, `cellNumber`. That is right
 * for storage: a field renamed in Surense must not need a migration here. It
 * is wrong for a screen somebody reads, so the translation lives here, at the
 * edge, rather than in the data.
 *
 * A key with no entry falls back to the key itself. That is deliberate: a
 * field added in the CRM shows up on the dashboard immediately, untranslated
 * and visible, instead of vanishing until someone adds a label.
 */

/** CRM field key -> Hebrew label. */
export const LABELS = {
  // --- identity
  id: 'מזהה ליד',
  number: 'מספר ליד',
  version: 'גרסה',
  tenantId: 'מזהה ארגון',
  agencyId: 'מזהה סוכנות',

  // --- the customer
  fullName: 'שם הלקוח',
  fullNameReverse: 'שם הלקוח (הפוך)',
  firstName: 'שם פרטי',
  lastName: 'שם משפחה',
  customerFullName: 'שם הלקוח בכרטיס',
  customerFullNameReverse: 'שם הלקוח בכרטיס (הפוך)',
  customerId: 'מזהה לקוח',
  birthDate: 'תאריך לידה',
  idNumber: 'מספר זהות',
  idType: 'סוג מסמך זיהוי',
  idCardIssueDate: 'תאריך הנפקת ת.ז',
  age: 'גיל',
  monthlyIncome: 'הכנסה חודשית',
  street: 'כתובת',

  // --- contact
  cellNumber: 'טלפון נייד',
  phoneNumber: 'טלפון נוסף',
  phoneNumber1: 'טלפון 1',
  phoneNumber2: 'טלפון 2',
  email: 'דוא"ל',
  appMailAddress: 'כתובת דואר במערכת',
  contactPointCount: 'מספר אנשי קשר',

  // --- status
  statusName: 'סטטוס',
  statusId: 'מזהה סטטוס',
  statusDate: 'תאריך סטטוס',
  statusClosed: 'סטטוס סגור',
  statusSuccess: 'סטטוס מוצלח',
  customerStatusId: 'מזהה סטטוס לקוח',
  lastStatusUpdateBy: 'סטטוס עודכן על ידי',
  closedDate: 'תאריך סגירה',
  closedReason: 'סיבת סגירה',
  successDate: 'תאריך הצלחה',

  // --- the referring source
  sourceId: 'מזהה מקור מפנה',

  // --- who handles it
  ownerName: 'בעלים',
  ownerId: 'מזהה בעלים',
  assigneeName: 'מטפל',
  assigneeId: 'מזהה מטפל',
  assignedUserName: 'משויך למשתמש',
  assignedUserId: 'מזהה משתמש משויך',
  assignedAt: 'תאריך שיוך',
  assignedBy: 'שויך על ידי',
  creatorName: 'נוצר על ידי',
  createdBy: 'מזהה יוצר',
  createdDate: 'תאריך יצירה',
  customerManagerId: 'מזהה מנהל לקוח',
  customerManagers: 'מנהלי לקוח',
  lastModifiedBy: 'שונה לאחרונה על ידי',
  lastModifiedDate: 'תאריך שינוי אחרון',
  lastActivityBy: 'פעילות אחרונה על ידי',
  lastActivityDate: 'תאריך פעילות אחרונה',

  // --- the product
  interestName: 'תחום עניין',
  interestId: 'מזהה תחום עניין',
  typeId: 'מזהה סוג ליד',

  // --- meetings
  meetingDate: 'תאריך פגישה',
  meetingCoordinatedByName: 'פגישה תואמה על ידי',
  meetingCoordinatedById: 'מזהה מתאם פגישה',
  meetingCoordinatedDate: 'תאריך תיאום פגישה',
  meetingFirstScheduledByName: 'פגישה ראשונה נקבעה על ידי',
  meetingFirstScheduledById: 'מזהה קובע פגישה ראשונה',
  meetingFirstScheduledDate: 'תאריך קביעת פגישה ראשונה',

  // --- workflow
  dueAt: 'תאריך יעד',
  dueDate: 'תאריך יעד (יום)',
  dueAtTimeSet: 'נקבעה שעה ליעד',
  overduePeriod: 'פיגור',
  priority: 'עדיפות',
  unseen: 'לא נצפה',
  sharable: 'ניתן לשיתוף',
  existingLead: 'ליד קיים',
  documentCount: 'מספר מסמכים',
  checkLists: 'רשימות משימות',
  notes: 'הערות',
  tags: 'תגיות',
  customFields: 'שדות מותאמים',
  mailingStatus: 'סטטוס דיוור'
};

/**
 * Columns shown before the reader picks anything.
 *
 * Seventy-eight columns at once is not a table anybody reads. These are the
 * ones that answer "who is this, where did they come from, who handles them,
 * and what happened" — the rest stay one click away.
 */
export const DEFAULT_COLUMNS = [
  'number', 'fullName', 'statusName', 'statusDate',
  'assigneeName', 'interestName', 'cellNumber'
];

/** Keys that are internal plumbing rather than anything to read. */
export const TECHNICAL = new Set([
  'tenantId', 'agencyId', 'customerStatusId', 'sharable', 'unseen',
  'appMailAddress', 'fullNameReverse', 'customerFullNameReverse', 'version'
]);

const DATE_KEY = /(date|dueat|assignedat)$/i;

/**
 * @param {string} key
 * @returns {string}
 */
export function labelFor(key) {
  return LABELS[key] ?? key;
}

/**
 * Renders one stored value for display.
 *
 * The mirror flattens everything to a scalar for storage, which leaves a few
 * shapes that are correct but unreadable: a JSON blob carrying a code and its
 * description, a phone number with the apostrophe that stops a spreadsheet
 * treating +972 as a formula, an ISO duration. Each is unwrapped here rather
 * than in the data, so the stored value stays exactly what the CRM sent.
 *
 * @param {string} key
 * @param {unknown} value
 * @returns {string}
 */
export function formatValue(key, value) {
  if (value === null || value === undefined || value === '') return '';

  if (typeof value === 'boolean') return value ? 'כן' : 'לא';

  const text = String(value);

  // The mirror prefixes a leading = + - @ with an apostrophe so a spreadsheet
  // keeps it as text. On screen that apostrophe is noise.
  const unescaped = text.startsWith("'") ? text.slice(1) : text;

  if (unescaped === 'true') return 'כן';
  if (unescaped === 'false') return 'לא';

  // {"code":1,"description":"ת.ז"} — the description is the whole point.
  if (unescaped.startsWith('{')) {
    try {
      const parsed = JSON.parse(unescaped);
      if (parsed?.description) return String(parsed.description);
    } catch {
      // Not JSON after all; fall through and show it as it is.
    }
  }

  // ISO 8601 duration, negative when overdue: P-26D is 26 days late.
  const overdue = /^P(-?\d+)D$/.exec(unescaped);
  if (overdue) {
    const days = Number(overdue[1]);
    return days < 0 ? `באיחור ${Math.abs(days)} ימים` : `בעוד ${days} ימים`;
  }

  if (DATE_KEY.test(key)) return formatDate(unescaped);

  return unescaped;
}

/**
 * Formats a stored timestamp for a Hebrew reader, in Israel time.
 *
 * The stored value is UTC. Rendering it raw would show a status set at 17:05
 * local as 14:05, which reads as the CRM being wrong rather than the display.
 *
 * @param {string} value
 * @param {string} [timeZone]
 * @returns {string}
 */
export function formatDate(value, timeZone = 'Asia/Jerusalem') {
  const text = String(value).trim();
  if (!text) return '';

  // A plain date carries no time; showing one would invent precision, and
  // shifting it by a zone could move it a day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split('-');
    return `${day}/${month}/${year}`;
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return text;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(date).reduce((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});

  return `${parts.day}/${parts.month}/${parts.year} ${parts.hour}:${parts.minute}`;
}

/**
 * Hebrew for each delivery state and skip reason.
 *
 * The reasons are the outbox's own strings, so the dashboard cannot drift
 * from what the sender actually decided — it is translating that decision,
 * not re-deriving it.
 */
export const DELIVERY_LABELS = {
  sent: 'נשלח',
  pending: 'ממתין לשליחה',
  blocked: 'לא יישלח',
  none: 'אין שינוי סטטוס',

  'no-template': 'אין נוסח לסטטוס הזה',
  'template-inactive': 'הנוסח מושבת',
  'lead-has-no-source': 'לליד אין מקור מפנה',
  'source-id-not-mapped': 'מזהה המקור לא ממופה לשם',
  'source-not-in-recipients': 'המקור לא נמצא בטבלת הנמענים',
  'source-not-looked-up-yet': 'המקור עוד לא נבדק מול ה-CRM',
  'message-has-an-unfilled-value': 'חסר ערך בנוסח (סך הכל) — לא נשלח',
  'recipient-inactive': 'הנמען מושבת',
  'recipient-has-no-address': 'לנמען אין כתובת'
};

/** @param {string} reason */
export function deliveryLabel(reason) {
  return DELIVERY_LABELS[reason] ?? reason;
}


/**
 * Column headings for the status-change log.
 *
 * The log holds only what a notification needs, so this list is short by
 * design — that is the point of the table, not a gap in it.
 */
export const EVENT_LABELS = {
  occurred_at: 'מתי',
  customer_name: 'שם הלקוח',
  lead_number: 'מספר ליד',
  status_before: 'מסטטוס',
  status_after: 'לסטטוס',
  assignee_name: 'מטפל',
  source_name: 'מקור מפנה',
  channel: 'ערוץ',
  handled: 'טופל'
};

/** How a message went out. */
export const CHANNEL_LABELS = { email: 'מייל', whatsapp: 'וואטסאפ' };

/** How a source lookup ended up, in Hebrew. */
export const SOURCE_STATE_LABELS = {
  pending: 'בבדיקה',
  resolved: 'נמצא',
  absent: 'אין מקור לליד',
  failed: 'החיפוש נכשל'
};

/**
 * Renders one event row for the screen.
 *
 * The delivery verdict is passed in rather than worked out here: it comes
 * from the same buildEventOutbox the sender runs, so the badge on the row and
 * what actually goes out cannot drift apart.
 *
 * @param {object} event
 * @param {Set<number>} sendable
 * @param {Map<number, string>} reasons
 * @returns {object}
 */
export function describeEvent(event, sendable, reasons) {
  const id = Number(event.id);

  const handled = event.notified_at
    ? {
      state: 'sent',
      label: DELIVERY_LABELS.sent,
      reason: null,
      at: formatDate(event.notified_at),
      via: event.notified_via
        ? (CHANNEL_LABELS[event.notified_via] ?? event.notified_via) : null,
      to: event.notified_to || null
    }
    : sendable.has(id)
      ? { state: 'pending', label: DELIVERY_LABELS.pending, reason: null, at: null, via: null }
      : {
        state: reasons.get(id) === 'source-not-looked-up-yet' ? 'waiting' : 'blocked',
        label: reasons.get(id) === 'source-not-looked-up-yet'
          ? 'ממתין לזיהוי המקור'
          : DELIVERY_LABELS.blocked,
        reason: deliveryLabel(reasons.get(id) ?? ''),
        at: null,
        via: null
      };

  return {
    id,
    leadId: event.lead_id,
    display: {
      occurred_at: formatDate(event.occurred_at),
      customer_name: event.customer_name || '',
      lead_number: event.lead_number || '',
      status_before: event.status_before || '',
      status_after: event.status_after || '',
      assignee_name: event.assignee_name || '',
      source_name: event.source_name ||
        SOURCE_STATE_LABELS[event.source_state] || '',

      // What it actually went out on, which is only known once it has.
      channel: event.notified_via
        ? (CHANNEL_LABELS[event.notified_via] ?? event.notified_via)
        : ''
    },
    sourceState: event.source_state,
    sourceStateLabel: SOURCE_STATE_LABELS[event.source_state] ?? event.source_state,
    sourceId: event.source_id || '',
    sourceError: event.source_error || '',
    recordedAt: formatDate(event.recorded_at),
    handled
  };
}
