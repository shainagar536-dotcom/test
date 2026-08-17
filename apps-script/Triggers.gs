/**
 * Trigger management. Run installHourlyTrigger() once, from the Apps Script
 * editor, to put the automation on its schedule.
 */

var TRIGGER_HANDLER = 'hourlyUpdate';

/**
 * Installs the hourly time-driven trigger, replacing any earlier copy.
 *
 * Apps Script has no weekday filter for hourly triggers — the trigger fires
 * every hour, every day, and hourlyUpdate() drops the ticks that fall outside
 * CONFIG.activeDays and CONFIG.activeHours.
 */
function installHourlyTrigger() {
  removeTriggers();

  ScriptApp.newTrigger(TRIGGER_HANDLER)
    .timeBased()
    .everyHours(1)
    .create();

  var days = CONFIG.activeDays.map(function (d) {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d];
  }).join(', ');

  var message = 'Hourly trigger installed. Active days: ' + days +
    ' (' + CONFIG.timezone + ').';

  console.log(message);
  logInfo_(message, {
    activeHours: CONFIG.activeHours === null ? 'all' : CONFIG.activeHours
  });
}

/** Removes every trigger this script owns. Use it to pause the automation. */
function removeTriggers() {
  var removed = 0;

  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === TRIGGER_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
      removed++;
    }
  });

  if (removed) {
    console.log('Removed ' + removed + ' existing trigger(s).');
  }
}

/** Lists the installed triggers — a quick check that the schedule is live. */
function listTriggers() {
  var triggers = ScriptApp.getProjectTriggers();

  if (!triggers.length) {
    console.log('No triggers installed. Run installHourlyTrigger().');
    return;
  }

  triggers.forEach(function (trigger) {
    console.log(trigger.getHandlerFunction() + ' — ' +
      trigger.getEventType() + ' / ' + trigger.getTriggerSource());
  });
}

/**
 * Clears the run watermark so the next run re-scans the last
 * CONFIG.firstRunLookbackHours instead of continuing from where it stopped.
 */
function resetWatermark() {
  PropertiesService.getScriptProperties().deleteProperty('LAST_RUN_AT');
  logWarn_('Watermark cleared — the next run re-scans the lookback window.');
}

/**
 * One-time check that everything the automation depends on is in place.
 * Run this before installing the trigger.
 */
function checkSetup() {
  var problems = [];

  ['SURENSE_CLIENT_ID', 'SURENSE_CLIENT_SECRET'].forEach(function (name) {
    if (!secret_(name, false)) {
      problems.push('Missing script property: ' + name);
    }
  });

  if (!CONFIG.operatorEmail) {
    problems.push('CONFIG.operatorEmail is empty — flood-brake alerts have ' +
      'nowhere to go.');
  }

  try {
    var mapping = loadSourceMapping_();
    var withEmail = Object.keys(mapping).filter(function (key) {
      return mapping[key].email;
    });

    if (!withEmail.length) {
      problems.push('The mapping tab has no rows with an email address — ' +
        'nothing can be sent yet.');
    } else {
      console.log(withEmail.length + ' source(s) have an email address.');
    }
  } catch (err) {
    problems.push('Mapping tab unreadable: ' + err.message);
  }

  try {
    getAccessToken_();
    console.log('Surense authentication succeeded.');
  } catch (err) {
    problems.push('Surense authentication failed: ' + err.message);
  }

  if (problems.length) {
    console.warn('Setup is incomplete:\n - ' + problems.join('\n - '));
  } else {
    console.log('Setup looks complete. Run dryRun() next.');
  }

  return problems;
}
