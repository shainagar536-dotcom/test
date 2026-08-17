/**
 * Message composition and delivery.
 *
 * Section 3 of the plan specifies Outlook as the sending mailbox. Apps Script
 * cannot send through Outlook directly — sendEmail_ is the single seam where
 * that transport gets swapped in once the mailbox is decided (see
 * sendViaGraph_ below). Everything above it is transport-agnostic.
 */

/** Signature appended to every message. Pending approval (section 12). */
var EMAIL_SIGNATURE = 'בברכה,';

/**
 * Builds the notification for one lead.
 *
 * @param {Object} lead      Normalized lead.
 * @param {Object} source    Mapping row for the referring source.
 * @param {string} message   Wording for the lead's status.
 * @return {{subject: string, body: string}}
 */
function composeNotification_(lead, source, message) {
  var subject = 'עדכון סטטוס ליד — ' + lead.clientName;

  var body = [
    'שלום ' + source.source + ',',
    '',
    'עדכון בליד שהפנית:',
    '',
    'לקוח: ' + lead.clientName,
    'מספר מזהה: ' + lead.displayId,
    'סטטוס: ' + message,
    '',
    EMAIL_SIGNATURE
  ].join('\n');

  return { subject: subject, body: body };
}

/**
 * Sends one notification, or records what would have been sent when the
 * automation is in dry-run mode.
 *
 * @param {string} to
 * @param {{subject: string, body: string}} mail
 * @return {boolean} true when a message actually went out
 */
function sendEmail_(to, mail) {
  if (CONFIG.dryRun) {
    return false;
  }

  MailApp.sendEmail({
    to: to,
    subject: mail.subject,
    body: mail.body
  });

  return true;
}

/**
 * Outlook transport, for when the sending mailbox is connected.
 *
 * Requires a Microsoft Graph token in the MS_GRAPH_TOKEN script property and
 * the sending address in SENDER_MAILBOX. Left unwired deliberately: the
 * mailbox is still an open question in section 12, and picking one here would
 * be guessing. To switch over, call this from sendEmail_ instead of MailApp.
 *
 * @param {string} to
 * @param {{subject: string, body: string}} mail
 */
function sendViaGraph_(to, mail) {
  var mailbox = secret_('SENDER_MAILBOX');

  var response = UrlFetchApp.fetch(
    'https://graph.microsoft.com/v1.0/users/' +
    encodeURIComponent(mailbox) + '/sendMail', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + secret_('MS_GRAPH_TOKEN') },
      payload: JSON.stringify({
        message: {
          subject: mail.subject,
          body: { contentType: 'Text', content: mail.body },
          toRecipients: [{ emailAddress: { address: to } }]
        },
        saveToSentItems: true
      }),
      muteHttpExceptions: true
    });

  if (response.getResponseCode() >= 300) {
    throw new Error('Graph sendMail failed (HTTP ' +
      response.getResponseCode() + '): ' + response.getContentText());
  }
}

/**
 * Alerts the operator. Used by the flood brake and by run failures — never
 * sent to a referring source.
 *
 * @param {string} subject
 * @param {string} body
 */
function alertOperator_(subject, body) {
  if (!CONFIG.operatorEmail) {
    logWarn_('No operatorEmail configured — alert not delivered.',
      { subject: subject });
    return;
  }

  MailApp.sendEmail({
    to: CONFIG.operatorEmail,
    subject: subject,
    body: body
  });
}
