/**
 * The starting status -> message table, from section 5 of the automation plan.
 *
 * Written into an empty templates table on first boot and never again, so
 * edits made through the API survive later deploys.
 *
 * The eight statuses here are the ones the plan gives wording for. The other
 * thirty-four it lists are deliberately absent: a status with no row sends
 * nothing, which is what keeps them silent until someone writes their text.
 */
export const SEED_TEMPLATES = [
  { status: 'לא ענה',            message: 'ניסינו ליצור קשר עם הלקוח אין מענה 1' },
  { status: 'לא עונה 2',         message: 'ניסינו ליצור קשר עם הלקוח אין מענה 2' },
  { status: 'לא עונה 3',         message: 'ניסינו ליצור קשר עם הלקוח אין מענה 3' },
  { status: 'לא עונה זמן רב',    message: 'ניסינו ליצור קשר מספר רב של פעמים אין מענה' },
  { status: 'מתלבט לגבי העמלה',  message: 'מתלבט לגבי העמלה' },
  { status: 'לחזור במועד אחר',   message: 'נקבע לחזור במועד אחר' },
  { status: 'ממתין לת.ז',        message: 'ממתין לת.ז' },
  { status: 'רלוונטי ל2026',     message: 'הלקוח לא רלוונטי לבדיקה כרגע אך רלוונטי לשנת 2026' }
];
