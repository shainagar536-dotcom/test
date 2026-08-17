/**
 * Entry points and the hourly run algorithm (section 7 of the plan).
 */

/** Called by the hourly trigger. */
function hourlyUpdate() {
  var now = new Date();

  if (!isWithinSchedule_(now)) {
    console.log('Outside the configured window (' +
      Utilities.formatDate(now, CONFIG.timezone, 'EEE HH:mm') + ') — skipping.');
    return;
  }

  runAutomation_({ trigger: 'hourly' });
}

/** Manual run from the editor. Ignores the schedule window. */
function runNow() {
  runAutomation_({ trigger: 'manual' });
}

/**
 * Stage 1 of the rollout: a full scan that reports what would be sent,
 * without sending anything and without advancing any state.
 *
 * Safe to run repeatedly — it restores dryRun afterwards even on failure.
 */
function dryRun() {
  var previous = CONFIG.dryRun;
  CONFIG.dryRun = true;

  try {
    runAutomation_({ trigger: 'dry-run' });
  } finally {
    CONFIG.dryRun = previous;
  }
}

/**
 * One polling pass.
 *
 * A lock guards the whole pass so two runs can never send the same
 * notification concurrently.
 *
 * @param {{trigger: string}} options
 */
function runAutomation_(options) {
  var lock = LockService.getScriptLock();

  if (!lock.tryLock(30 * 1000)) {
    logWarn_('A previous run is still in progress — skipping this tick.', options);
    return;
  }

  var startedAt = new Date();
  var stats = { scanned: 0, sent: 0, skipped: 0, pending: 0, errors: 0 };

  try {
    var since = getWatermark_();
    var leads = fetchLeadsChangedSince_(since).map(normalizeLead_);

    stats.scanned = leads.length;

    if (options.trigger === 'dry-run' && leads.length) {
      // Lets CONFIG.leadFields be verified against a real response.
      logInfo_('Sample lead as parsed.', leads[0]);
    }

    if (!leads.length) {
      setWatermark_(startedAt);
      console.log('No status changes since ' + since.toISOString() + '.');
      return;
    }

    var mapping = loadSourceMapping_();
    var reported = loadReportedStatuses_();
    var queue = buildQueue_(leads, mapping, reported, stats);

    // Flood brake: a bulk status edit in the CRM must not become a mail-out.
    if (queue.length > CONFIG.maxSendsPerRun) {
      var alert = 'Flood brake: ' + queue.length + ' notifications queued in ' +
        'one run, above the limit of ' + CONFIG.maxSendsPerRun +
        '. Nothing was sent.';

      logError_(alert, {
        statuses: queue.map(function (item) { return item.lead.statusName; })
          .filter(unique_)
      });

      alertOperator_('אוטומציית לידים — בלם הצפה נעצר', alert +
        '\n\nהריצה נעצרה ולא נשלחה אף הודעה. יש לבדוק את ה-CRM ולאשר ידנית.');

      // The watermark stays put: after a manual review the same window is
      // re-scanned rather than being silently swallowed.
      return;
    }

    queue.forEach(function (item) {
      try {
        var mail = composeNotification_(item.lead, item.source, item.message);

        if (sendEmail_(item.source.email, mail)) {
          recordReportedStatus_(item.lead.id, item.lead.statusName);
          stats.sent++;
        } else {
          logInfo_('DRY RUN — would notify ' + item.source.email, {
            lead: item.lead.displayId,
            client: item.lead.clientName,
            status: item.lead.statusName,
            message: item.message
          });
        }
      } catch (err) {
        stats.errors++;
        logError_('Failed to notify about lead ' + item.lead.displayId +
          ': ' + err.message);
      }
    });

    setWatermark_(startedAt);

    logInfo_((CONFIG.dryRun ? 'DRY RUN' : 'Run') + ' finished in ' +
      Math.round((new Date() - startedAt) / 1000) + 's.', {
      scanned: stats.scanned,
      sent: stats.sent,
      wouldSend: CONFIG.dryRun ? queue.length : undefined,
      skipped: stats.skipped,
      awaitingContact: stats.pending,
      errors: stats.errors
    });
  } catch (err) {
    // The watermark is deliberately left alone so the next tick re-reads
    // this window instead of losing it.
    logError_('Run failed: ' + err.message, {
      trigger: options.trigger,
      stack: err.stack
    });
    throw err;
  } finally {
    lock.releaseLock();
  }
}

/**
 * Decides which leads warrant a notification, applying the filters of
 * section 7 step 3 in order.
 *
 * @param {Array<Object>} leads
 * @param {Object} mapping
 * @param {Object<string, string>} reported
 * @param {Object} stats  Mutated with skip/pending counts.
 * @return {Array<{lead: Object, source: Object, message: string}>}
 */
function buildQueue_(leads, mapping, reported, stats) {
  var queue = [];
  var unmatched = [];

  leads.forEach(function (lead) {
    // (a) Closed allowlist — an undefined status sends nothing.
    var message = messageForStatus_(lead.statusName);

    if (!message) {
      stats.skipped++;
      return;
    }

    // (b) Already reported at this status.
    if (reported[lead.id] === lead.statusName) {
      stats.skipped++;
      return;
    }

    // (c) Resolve the referring source.
    var source = mapping[normalizeText_(lead.sourceName)];

    if (!source) {
      stats.pending++;
      unmatched.push(lead.sourceName);
      return;
    }

    if (!source.active || !source.email) {
      stats.pending++;
      return;
    }

    queue.push({ lead: lead, source: source, message: message });
  });

  if (unmatched.length) {
    // Categories like "קמפיין" have no recipient by design, so this is a
    // notice rather than an error — but it is also where a renamed source
    // shows up, which is why the names are listed.
    logWarn_(unmatched.length + ' lead(s) had no matching row in the mapping.', {
      sources: unmatched.filter(unique_)
    });
  }

  return queue;
}

function unique_(value, index, array) {
  return array.indexOf(value) === index;
}

/**
 * True when `date` falls on an allowed day and hour, in CONFIG.timezone.
 *
 * @param {Date} date
 * @return {boolean}
 */
function isWithinSchedule_(date) {
  if (CONFIG.activeDays.indexOf(localDayIndex_(date)) === -1) {
    return false;
  }

  if (CONFIG.activeHours === null) {
    return true;
  }

  var hour = Number(Utilities.formatDate(date, CONFIG.timezone, 'H'));
  return CONFIG.activeHours.indexOf(hour) !== -1;
}

/**
 * Day of week in CONFIG.timezone, 0 = Sunday ... 6 = Saturday.
 *
 * Date#getDay() reports the day in the script's own timezone, which is not
 * necessarily the one the schedule is written against.
 *
 * @param {Date} date
 * @return {number}
 */
function localDayIndex_(date) {
  // 'u' is the ISO day number: 1 = Monday ... 7 = Sunday.
  var isoDay = Number(Utilities.formatDate(date, CONFIG.timezone, 'u'));
  return isoDay % 7;
}
