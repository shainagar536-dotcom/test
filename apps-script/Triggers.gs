/**
 * Trigger management. Run the installers once, from the Apps Script editor,
 * to put the automations on their schedule.
 *
 * There are two independent automations sharing this project:
 *   hourlyMirror  — copies the CRM into the spreadsheet
 *   hourlyUpdate  — emails referring sources when a lead's status changes
 *
 * They can be enabled separately; neither depends on the other.
 */

var HANDLERS = { mirror: 'hourlyMirror', notifier: 'hourlyUpdate' };

/** Installs the hourly CRM-to-sheet mirror. */
function installMirrorTrigger() {
  installHourly_(HANDLERS.mirror);
}

/** Installs the hourly status-change notifier. */
function installNotifierTrigger() {
  installHourly_(HANDLERS.notifier);
}

/**
 * Creates an hourly trigger for one handler, replacing any earlier copy.
 *
 * Apps Script has no weekday filter for hourly triggers — the trigger fires
 * every hour, every day, and the handler drops the ticks that fall outside
 * CONFIG.activeDays and CONFIG.activeHours.
 *
 * @param {string} handler
 */
function installHourly_(handler) {
  removeTrigger_(handler);

  ScriptApp.newTrigger(handler).timeBased().everyHours(1).create();

  var days = CONFIG.activeDays.map(function (day) {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day];
  }).join(', ');

  var message = handler + ' installed hourly. Active days: ' + days +
    ' (' + CONFIG.timezone + ').';

  console.log(message);
  logInfo_(message);
}

/** Removes every trigger this project owns. Stops both automations. */
function removeTriggers() {
  var removed = ScriptApp.getProjectTriggers().length;

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    ScriptApp.deleteTrigger(trigger);
  });

  console.log('Removed ' + removed + ' trigger(s).');
}

/**
 * @param {string} handler
 */
function removeTrigger_(handler) {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === handler) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}

/** Lists the installed triggers — a quick check that a schedule is live. */
function listTriggers() {
  var triggers = ScriptApp.getProjectTriggers();

  if (!triggers.length) {
    console.log('No triggers installed.');
    return;
  }

  triggers.forEach(function (trigger) {
    console.log(trigger.getHandlerFunction() + ' — ' + trigger.getEventType());
  });
}

/**
 * Clears the notifier's watermark so its next run re-scans the last
 * CONFIG.firstRunLookbackHours instead of continuing from where it stopped.
 */
function resetWatermark() {
  PropertiesService.getScriptProperties().deleteProperty('LAST_RUN_AT');
  logWarn_('Watermark cleared — the next run re-scans the lookback window.');
}

/**
 * One-time check that everything the automations depend on is in place.
 * Run this before installing any trigger.
 *
 * @return {Array<string>} problems found
 */
function checkSetup() {
  var problems = [];

  ['SURENSE_CLIENT_ID', 'SURENSE_CLIENT_SECRET'].forEach(function (name) {
    if (!secret_(name, false)) {
      problems.push('Missing script property: ' + name);
    }
  });

  try {
    getAccessToken_();
    console.log('✓ Surense authentication succeeded.');
  } catch (err) {
    problems.push('Surense authentication failed: ' + err.message);
  }

  try {
    var sheet = mirrorSheet_();
    console.log('✓ Mirror tab resolved: "' + sheet.getName() + '".');
  } catch (err) {
    problems.push('Mirror tab unreachable: ' + err.message);
  }

  // The notifier needs more than the mirror does; report but do not fail on it.
  if (!CONFIG.operatorEmail) {
    problems.push('Notifier: CONFIG.operatorEmail is empty — flood-brake ' +
      'alerts have nowhere to go.');
  }

  try {
    var mapping = loadSourceMapping_();
    var withEmail = Object.keys(mapping).filter(function (key) {
      return mapping[key].email;
    });

    if (!withEmail.length) {
      problems.push('Notifier: the mapping tab has no email addresses yet — ' +
        'nothing can be sent. (The mirror does not need this.)');
    } else {
      console.log('✓ ' + withEmail.length + ' source(s) have an email address.');
    }
  } catch (err) {
    problems.push('Notifier: mapping tab unreadable: ' + err.message);
  }

  if (problems.length) {
    console.warn('Setup is incomplete:\n - ' + problems.join('\n - '));
  } else {
    console.log('Setup looks complete. Run previewApi() next.');
  }

  return problems;
}
