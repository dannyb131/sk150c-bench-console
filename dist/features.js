const api = window.psuConsole;
if (!api) throw new Error('The PSU core is unavailable.');

const $ = (id) => document.getElementById(id);
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value)));
const round = (value, places) => {
  const factor = 10 ** places;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
};
const delay = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
const jsonRead = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const jsonWrite = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const formatDuration = (seconds) => {
  const safe = Math.max(0, Math.floor(seconds || 0));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, '0')).join(':');
};
const finiteTemp = (value) => Number.isFinite(value) ? value : null;

// View navigation
document.querySelectorAll('[data-view-target]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-view-target]').forEach((item) => item.classList.toggle('active', item === button));
    document.querySelectorAll('[data-view]').forEach((view) => view.classList.toggle('active', view.dataset.view === button.dataset.viewTarget));
    if (button.dataset.viewTarget === 'monitor') {
      window.setTimeout(() => { api.drawCharts(); drawTemperatureChart(); }, 0);
    }
  });
});

// Plain-language, contextual help
const helpTopics = [
  {
    id: 'connection',
    selector: '.top-actions',
    title: 'Connecting and stopping the PSU',
    summary: 'Connecting opens the door between this page and the power supply. The emergency Stop output control is kept beside the main setpoint controls.',
    steps: [
      'Plug the USB-to-serial lead into the computer and the PSU.',
      'Select Connect PSU, choose the correct serial device, and wait for Live to appear.',
      'Use Stop output below Apply setpoints whenever you need to turn the PSU output off immediately.',
      'Select Disconnect PSU when you are finished.',
    ],
    tip: 'Connecting by itself does not switch the output on. If the browser loses connection, always check the real PSU screen because the hardware keeps its own state.',
  },
  {
    id: 'measurements',
    selector: '.meter-status .meter-heading',
    title: 'Live measurements',
    summary: 'These four cards are the PSU dashboard: what is really coming out, what you asked for, and whether a safety limit has tripped.',
    steps: [
      'Output voltage is the measured voltage at the terminals.',
      'Output current is what the connected circuit is actually taking, not the maximum you allowed.',
      'Power is voltage multiplied by current. Input is the supply voltage feeding the SK150C.',
      'CV means constant voltage. CC means the current limit is holding the current down.',
    ],
    tip: 'A protection message means the PSU stopped or limited output for safety. Fix the cause before turning the output back on.',
  },
  {
    id: 'session',
    selector: '.session-strip',
    placement: 'float',
    title: 'Session summary',
    summary: 'This is the trip meter for the current connection.',
    steps: [
      'Session is how long the current connection has been running.',
      'Ah tells you how much electric charge has been delivered.',
      'Wh tells you how much energy has been delivered.',
      'Internal and External show the PSU temperature and the optional 10K NTC probe.',
      'Samples counts the readings stored for graphs and export.',
    ],
    tip: 'Ah and Wh are especially useful for battery tests. They do not replace a proper battery capacity tester or BMS.',
  },
  {
    id: 'history',
    selector: '.telemetry-panel .panel-heading',
    title: 'Graphs and data logging',
    summary: 'The graphs are a recording of voltage, current, power, and temperature over time.',
    steps: [
      'Choose 1m, 5m, 15m, 1h, 6h, or 24h to change the visible time window.',
      'Use the live value and the minimum, maximum, average, and peak values to spot changes.',
      'The temperature graph shows the external 10K probe in orange and the PSU internal sensor in purple.',
      'Select Export CSV to save the readings for a spreadsheet.',
      'Clear local history removes only the graph data stored in this browser.',
    ],
    tip: 'Data is stored locally on this device for up to 24 hours. Clearing it does not reset the PSU hardware counters.',
  },
  {
    id: 'setpoints',
    selector: '.control-panel .panel-heading',
    title: 'Voltage, current limit, and output',
    summary: 'Voltage is the pressure you want. Current limit is the maximum flow you will allow.',
    steps: [
      'Set the required voltage with the dial or number box.',
      'Set a safe current limit for the circuit. Start low when you are unsure.',
      'Select Apply setpoints to send both values to the PSU.',
      'Use Stop output directly below Apply setpoints for an immediate output-off command.',
      'Use the large output control to switch power at the terminals on or off.',
    ],
    tip: 'Changing the boxes only stages the values. Nothing is written until Apply setpoints is selected. The 150 W bar warns when voltage × current is too high.',
  },
  {
    id: 'quick-presets',
    selector: '.preset-panel .panel-heading',
    title: 'Quick-select presets',
    summary: 'Presets fill in common voltage and current values so you do not need to type them.',
    steps: [
      'Choose Bench for common circuit voltages or Charge for battery-oriented starting points.',
      'Select a preset to stage its voltage and current.',
      'Check the staged values and power estimate.',
      'Select Apply setpoints when you are happy with them.',
    ],
    tip: 'A preset is a starting point, not a guarantee that it is safe for your circuit or battery.',
  },
  {
    id: 'memory-recall',
    selector: '.memory-panel > div:first-child',
    placement: 'title',
    title: 'Recall PSU memory',
    summary: 'M0 to M10 are small settings drawers stored inside the PSU itself.',
    steps: [
      'Select the memory number you want.',
      'Select Recall to make the PSU load that slot.',
      'Check the set voltage and current on both this page and the PSU display.',
    ],
    tip: 'Recall can change the PSU setpoints immediately. Turn the output off first when you do not know what a slot contains.',
  },
  {
    id: 'sequence',
    selector: '[data-view="automation"] .feature-panel:nth-child(1) .panel-heading',
    title: 'Sequence runner',
    summary: 'A sequence is a timed to-do list for the PSU, such as 5 V for ten seconds, then 12 V, then off.',
    steps: [
      'Choose a ready-made recipe or build a custom list.',
      'For each row, choose Set output or Output off, then enter voltage, current, hold time, and optional ramp time.',
      'Choose how many times the list should repeat.',
      'Keep Output off when finished selected for the safest ending.',
      'Connect the PSU, check every row, and then select Start sequence.',
    ],
    tip: 'Ramp changes the setpoint gradually; Hold keeps the step running. Stop safely cancels the list and switches output off.',
  },
  {
    id: 'battery',
    selector: '[data-view="automation"] .feature-panel:nth-child(2) .panel-heading',
    title: 'Assisted battery session',
    summary: 'This helper calculates charging targets and watches progress, but the bench PSU is not a dedicated battery charger.',
    steps: [
      'Select the exact battery chemistry and number of series cells.',
      'Enter the pack capacity and a conservative charge rate.',
      'Set cutoff current, maximum temperature, timeout, and capacity cutoff.',
      'Check the calculated target voltage and current before connecting the battery.',
      'Use a suitable BMS, connect with output off, verify polarity, then start the session.',
    ],
    tip: 'Never rely on the browser alone for battery safety. Use a BMS, an independent temperature safeguard, supervision, and a fire-safe charging area.',
  },
  {
    id: 'alarms',
    selector: '[data-view="automation"] .feature-panel:nth-child(3) .panel-heading',
    title: 'Alarms and automatic stop',
    summary: 'Alarms watch the readings and tell you when something crosses a limit.',
    steps: [
      'Enter a current warning, minimum input voltage, or temperature warning. A value of zero disables that threshold.',
      'Choose sound and CV/CC change notifications if useful.',
      'Enable desktop notifications if you want alerts outside this page.',
      'Only enable automatic output shutdown after testing the alarm with a safe load.',
    ],
    tip: 'Browser alarms are an extra layer, not a hardware safety system. They cannot act if the page, computer, serial link, or ESP32 connection stops working.',
  },
  {
    id: 'named-presets',
    selector: '[data-view="presets"] .feature-panel:nth-child(1) .panel-heading',
    title: 'Named local presets',
    summary: 'These are your own labelled shortcuts, stored in this browser rather than inside the PSU.',
    steps: [
      'Enter a useful name, voltage, and current limit, then select Save preset.',
      'Select Stage on a saved card to copy its values into Output control.',
      'Review the values and select Apply setpoints on the Monitor page.',
      'Use Export to back up the list and Import to restore it.',
    ],
    tip: 'Deleting a local preset does not change the PSU. Imported JSON should come only from a file you trust and have checked.',
  },
  {
    id: 'hardware-memory',
    selector: '[data-view="presets"] .feature-panel:nth-child(2) .panel-heading',
    title: 'Edit M0–M10 hardware memory',
    summary: 'This editor reads and changes the voltage, current, and protection values saved in a PSU memory slot.',
    steps: [
      'Choose M0 through M10 and select Read slot before editing.',
      'Give it an optional local name and check every electrical limit.',
      'Select Write slot to store the values in that PSU memory slot.',
      'Select Recall slot only when you want the PSU to load it now.',
    ],
    tip: 'Read before writing. Incorrect protection values can allow damage or cause immediate trips. Local names stay in the browser; electrical values stay in the PSU.',
  },
  {
    id: 'calibration-guide',
    selector: '[data-view="calibration"] .calibration-guide-panel .panel-heading',
    title: 'Guided calibration',
    summary: 'This page walks beside you while you use the calibration menu on the physical PSU. It does not secretly change any calibration registers.',
    steps: [
      'Choose Voltage, Current, Zero point, or Temperature.',
      'Gather the equipment listed and read the warning before connecting anything.',
      'Complete each checkbox as you follow the matching menu on the SK150C.',
      'Enter the PSU and reference-meter readings to see the error before and after.',
      'Save the result locally so you can compare it next time.',
    ],
    tip: 'Only calibrate against a trustworthy reference. A poor meter or unsafe current setup can make the PSU less accurate or damage the meter.',
  },
  {
    id: 'protection',
    selector: '[data-view="device"] .feature-panel:nth-child(1) .panel-heading',
    title: 'Protection limits',
    summary: 'Protection limits are fences that make the PSU stop when voltage, current, power, temperature, or input voltage becomes unsafe.',
    steps: [
      'Choose the memory slot whose limits you want to inspect.',
      'Select Read limits so you start with the PSU values.',
      'Adjust only limits you understand and keep them within the load and PSU ratings.',
      'Select Apply limits to write them to that slot.',
    ],
    tip: 'Input under-voltage protects the supply feeding the SK150C. Output over-voltage, over-current, and over-power protect the load. Over-temperature protects against overheating.',
  },
  {
    id: 'health',
    selector: '[data-view="device"] .feature-panel:nth-child(2) .panel-heading',
    title: 'Device health and counters',
    summary: 'This is the PSU information page: temperatures, accumulated output, firmware, connection details, and protection state.',
    steps: [
      'Check internal temperature to see how warm the PSU is.',
      'External probe needs a two-wire 10K NTC sensor; a blank value normally means no probe.',
      'Use Ah, Wh, and duration to understand how much the PSU has delivered.',
      'Use model, firmware, address, and baud details when troubleshooting.',
    ],
    tip: 'A 100K thermistor is not a substitute for the required 10K NTC probe. The displayed hardware counters may cover a different period from the browser session.',
  },
  {
    id: 'transport',
    selector: '[data-view="device"] .feature-panel:nth-child(3) .panel-heading',
    title: 'USB and ESP32 connection settings',
    summary: 'Transport chooses the road used to carry commands: a USB cable now, or your future ESP32 bridge over the network.',
    steps: [
      'Use USB Web Serial for the directly connected PSU.',
      'Use HTTP or WebSocket only after the ESP32 firmware implements the shown Modbus bridge contract.',
      'Enter the bridge address and optional session token, then save settings.',
      'Enable Read-only session when you want monitoring with all write controls locked.',
      'Install app makes the dashboard easier to launch when the browser offers that option.',
    ],
    tip: 'Keep the ESP32 bridge on a trusted network, use authentication, and default it to read-only until you intentionally allow control.',
  },
];

function setupContextHelp() {
  const dialog = document.createElement('dialog');
  dialog.className = 'help-dialog';
  dialog.id = 'featureHelpDialog';
  dialog.setAttribute('aria-labelledby', 'helpDialogTitle');
  dialog.innerHTML = '<div class="help-dialog-card"><div class="help-dialog-heading"><div><span>ELI5 GUIDE</span><h2 id="helpDialogTitle">Feature help</h2></div><button class="help-close" type="button" aria-label="Close help">×</button></div><p class="help-summary" id="helpDialogSummary"></p><section class="help-steps"><h3>How to use it</h3><ol id="helpDialogSteps"></ol></section><aside class="help-tip"><strong>Good to know</strong><p id="helpDialogTip"></p></aside><button class="button button-primary help-done" type="button">Got it</button></div>';
  document.body.append(dialog);

  let returnFocus = null;
  const closeHelp = () => {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  };
  const openHelp = (topic, button) => {
    returnFocus = button;
    $('helpDialogTitle').textContent = topic.title;
    $('helpDialogSummary').textContent = topic.summary;
    const list = $('helpDialogSteps');
    list.replaceChildren(...topic.steps.map((step) => {
      const item = document.createElement('li');
      item.textContent = step;
      return item;
    }));
    $('helpDialogTip').textContent = topic.tip;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  };
  dialog.querySelector('.help-close').addEventListener('click', closeHelp);
  dialog.querySelector('.help-done').addEventListener('click', closeHelp);
  dialog.addEventListener('click', (event) => { if (event.target === dialog) closeHelp(); });
  dialog.addEventListener('close', () => returnFocus?.focus());

  helpTopics.forEach((topic) => {
    const anchor = document.querySelector(topic.selector);
    if (!anchor) return;
    const button = document.createElement('button');
    button.className = 'help-button';
    button.type = 'button';
    button.textContent = '?';
    button.title = 'Help: ' + topic.title;
    button.setAttribute('aria-label', 'Help: ' + topic.title);
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', dialog.id);
    button.dataset.help = topic.id;
    button.addEventListener('click', () => openHelp(topic, button));
    if (topic.placement === 'float') {
      anchor.classList.add('has-context-help');
      button.classList.add('help-button-float');
    } else if (topic.placement === 'title') {
      anchor.classList.add('help-title-line');
    }
    anchor.append(button);
  });
}

setupContextHelp();

// Guided calibration: instructions and local verification only
const calibrationGuides = {
  voltage: {
    title: 'Voltage calibration',
    unit: 'V',
    equipment: ['Trusted digital multimeter', 'Short, secure test leads', 'No load connected'],
    warning: 'Keep the output unloaded. Confirm the meter is in DC volts mode before touching the output terminals.',
    steps: [
      'Switch the PSU output off and disconnect every load from the output terminals.',
      'Connect the trusted multimeter directly across OUT+ and OUT− in DC volts mode.',
      'Allow the PSU and meter a few minutes to settle at normal room temperature.',
      'On the physical SK150C, open the settings menu, find Cal.V, and confirm to start.',
      'At calibration point 1, read the multimeter, enter that measured value on the SK150C, and confirm.',
      'Repeat the measurement and entry when the SK150C presents calibration point 2.',
      'Wait for CALI Success, return to the normal screen, and verify several unloaded voltages.',
    ],
  },
  current: {
    title: 'Current calibration',
    unit: 'A',
    equipment: ['Electronic load rated for the test current', 'Trusted current meter or calibrated shunt', 'Current-rated leads'],
    warning: 'High-current calibration can damage a meter or wiring. Do not put a handheld meter in current mode straight across the output unless its leads, fuse, socket, and range are specifically rated for the test.',
    steps: [
      'Switch the output off and set the electronic load to zero current before wiring it.',
      'Connect the electronic load and reference meter or shunt in the correct current-measurement arrangement.',
      'Check polarity, lead rating, meter socket, meter range, and load power rating one more time.',
      'On the physical SK150C, open the settings menu, find Cal.I, and confirm to start.',
      'At calibration point 1, apply the requested load, read the reference current, enter it on the SK150C, and confirm.',
      'Repeat the measurement and entry when the SK150C presents calibration point 2.',
      'Wait for CALI Success, switch output off, then verify low and medium currents with the electronic load.',
    ],
  },
  zero: {
    title: 'Current zero point',
    unit: 'A',
    equipment: ['Nothing connected to the output', 'Clean, dry output terminals'],
    warning: 'The output must be open-circuit with no load, meter, battery, or loose wire connected.',
    steps: [
      'Switch the PSU output off.',
      'Remove every connection from OUT+ and OUT− so the output is completely open-circuit.',
      'Wait until the displayed current is stable.',
      'On the physical SK150C, open the settings menu and select C.Z.P.',
      'Confirm the zero operation while the output remains disconnected.',
      'Wait for the success message and return to the normal screen.',
      'Verify that the unloaded current reading returns to zero and does not drift.',
    ],
  },
  temperature: {
    title: 'Temperature check',
    unit: '°C',
    equipment: ['Trusted thermometer', 'Stable room or temperature source', '10K NTC probe for external temperature'],
    warning: 'Use a gentle, stable temperature source. Do not place the PSU, probe, or reference thermometer in water unless each item is designed and sealed for it.',
    steps: [
      'Choose whether you are checking the internal sensor or the external 10K NTC probe.',
      'Place the reference thermometer as close as practical to the sensor being checked.',
      'Keep both sensors away from your fingers, direct airflow, sunlight, and active heat sources.',
      'Wait at least ten minutes, or until both readings stop moving.',
      'Record the SK150C temperature and the trusted reference temperature below.',
      'Calculate the correction as reference minus SK150C reading.',
      'Repeat at a second stable temperature before trusting an offset across the full range.',
    ],
  },
};

let activeCalibrationType = 'voltage';
let calibrationJournal = jsonRead('sk150c-calibration-journal', []);

function calibrationInputValue(id) {
  const raw = $(id).value.trim();
  return raw === '' ? null : Number(raw);
}

function measurementError(displayed, reference) {
  if (!Number.isFinite(displayed) || !Number.isFinite(reference)) return null;
  const difference = displayed - reference;
  return {
    difference,
    absolute: Math.abs(difference),
    percent: reference === 0 ? null : difference / Math.abs(reference) * 100,
  };
}

function formatCalibrationError(error, unit) {
  if (!error) return '—';
  const sign = error.difference > 0 ? '+' : '';
  const difference = sign + error.difference.toFixed(unit === 'A' ? 3 : 2) + ' ' + unit;
  return error.percent === null ? difference : difference + ' (' + sign + error.percent.toFixed(2) + '%)';
}

function updateCalibrationProgress() {
  const boxes = [...$('calibrationSteps').querySelectorAll('input[type="checkbox"]')];
  const complete = boxes.filter((box) => box.checked).length;
  $('calibrationProgress').textContent = complete + ' of ' + boxes.length;
  $('calibrationProgress').classList.toggle('is-running', complete === boxes.length && boxes.length > 0);
}

function updateCalibrationCalculator() {
  const guide = calibrationGuides[activeCalibrationType];
  const before = measurementError(calibrationInputValue('calBeforeDisplayed'), calibrationInputValue('calBeforeReference'));
  const after = measurementError(calibrationInputValue('calAfterDisplayed'), calibrationInputValue('calAfterReference'));
  $('calBeforeError').textContent = formatCalibrationError(before, guide.unit);
  $('calAfterError').textContent = formatCalibrationError(after, guide.unit);
  $('calibrationResultStatus').classList.remove('is-running', 'is-alert');

  if (before && after) {
    const improvement = before.absolute - after.absolute;
    const places = guide.unit === 'A' ? 3 : 2;
    if (Math.abs(improvement) < 10 ** -places) {
      $('calImprovement').textContent = 'No meaningful change';
    } else {
      $('calImprovement').textContent = Math.abs(improvement).toFixed(places) + ' ' + guide.unit + (improvement > 0 ? ' smaller' : ' larger');
    }
    $('calibrationResultStatus').textContent = improvement >= 0 ? 'Improved' : 'Check again';
    $('calibrationResultStatus').classList.add(improvement >= 0 ? 'is-running' : 'is-alert');
  } else if (after) {
    $('calImprovement').textContent = 'Add before readings to compare';
    $('calibrationResultStatus').textContent = 'After reading ready';
    $('calibrationResultStatus').classList.add('is-running');
  } else if (before) {
    $('calImprovement').textContent = 'Add after readings to compare';
    $('calibrationResultStatus').textContent = 'Before reading ready';
  } else {
    $('calImprovement').textContent = '—';
    $('calibrationResultStatus').textContent = 'Enter readings';
  }
}

function clearCalibrationMeasurements() {
  ['calBeforeDisplayed', 'calBeforeReference', 'calAfterDisplayed', 'calAfterReference'].forEach((id) => { $(id).value = ''; });
  $('calibrationNotes').value = '';
  updateCalibrationCalculator();
}

function renderCalibrationGuide(resetMeasurements = false) {
  const guide = calibrationGuides[activeCalibrationType];
  $('calibrationGuideTitle').textContent = guide.title;
  $('calibrationWarning').textContent = guide.warning;

  const equipmentTitle = document.createElement('strong');
  equipmentTitle.textContent = 'You will need';
  const equipmentList = document.createElement('ul');
  guide.equipment.forEach((item) => {
    const entry = document.createElement('li');
    entry.textContent = item;
    equipmentList.append(entry);
  });
  $('calibrationEquipment').replaceChildren(equipmentTitle, equipmentList);

  const stepItems = guide.steps.map((step, index) => {
    const item = document.createElement('li');
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    const copy = document.createElement('span');
    const number = document.createElement('strong');
    checkbox.type = 'checkbox';
    number.textContent = 'Step ' + (index + 1);
    copy.append(number, document.createTextNode(step));
    label.append(checkbox, copy);
    item.append(label);
    checkbox.addEventListener('change', updateCalibrationProgress);
    return item;
  });
  $('calibrationSteps').replaceChildren(...stepItems);
  updateCalibrationProgress();
  if (resetMeasurements) clearCalibrationMeasurements();
}

document.querySelectorAll('[data-calibration-type]').forEach((button) => {
  button.addEventListener('click', () => {
    activeCalibrationType = button.dataset.calibrationType;
    document.querySelectorAll('[data-calibration-type]').forEach((item) => {
      const active = item === button;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', String(active));
    });
    renderCalibrationGuide(true);
  });
});

$('resetCalibrationChecklist').addEventListener('click', () => {
  $('calibrationSteps').querySelectorAll('input[type="checkbox"]').forEach((box) => { box.checked = false; });
  updateCalibrationProgress();
});

['calBeforeDisplayed', 'calBeforeReference', 'calAfterDisplayed', 'calAfterReference'].forEach((id) => {
  $(id).addEventListener('input', updateCalibrationCalculator);
});

function renderCalibrationJournal() {
  const container = $('calibrationJournal');
  if (!calibrationJournal.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No calibration results saved yet.';
    container.replaceChildren(empty);
    return;
  }
  const records = calibrationJournal.map((record) => {
    const article = document.createElement('article');
    const header = document.createElement('header');
    const title = document.createElement('strong');
    const time = document.createElement('time');
    const readings = document.createElement('p');
    title.textContent = calibrationGuides[record.type]?.title || record.type;
    time.dateTime = new Date(record.timestamp).toISOString();
    time.textContent = new Date(record.timestamp).toLocaleString();
    const beforeText = formatCalibrationError(measurementError(record.beforeDisplayed, record.beforeReference), record.unit);
    const afterText = formatCalibrationError(measurementError(record.afterDisplayed, record.afterReference), record.unit);
    readings.textContent = 'Before: ' + beforeText + ' · After: ' + afterText;
    header.append(title, time);
    article.append(header, readings);
    if (record.notes) {
      const notes = document.createElement('small');
      notes.textContent = record.notes;
      article.append(notes);
    }
    return article;
  });
  container.replaceChildren(...records);
}

$('saveCalibrationRecord').addEventListener('click', () => {
  const guide = calibrationGuides[activeCalibrationType];
  const record = {
    timestamp: Date.now(),
    type: activeCalibrationType,
    unit: guide.unit,
    beforeDisplayed: calibrationInputValue('calBeforeDisplayed'),
    beforeReference: calibrationInputValue('calBeforeReference'),
    afterDisplayed: calibrationInputValue('calAfterDisplayed'),
    afterReference: calibrationInputValue('calAfterReference'),
    notes: $('calibrationNotes').value.trim(),
  };
  const hasPair = (Number.isFinite(record.beforeDisplayed) && Number.isFinite(record.beforeReference))
    || (Number.isFinite(record.afterDisplayed) && Number.isFinite(record.afterReference));
  if (!hasPair) {
    api.toast('Enter at least one complete PSU/reference reading pair.', true);
    return;
  }
  calibrationJournal.unshift(record);
  calibrationJournal = calibrationJournal.slice(0, 50);
  jsonWrite('sk150c-calibration-journal', calibrationJournal);
  renderCalibrationJournal();
  api.toast('Calibration result saved in this browser.');
});

$('exportCalibrationJournal').addEventListener('click', () => {
  if (!calibrationJournal.length) {
    api.toast('There are no calibration results to export.', true);
    return;
  }
  const escapeCsv = (value) => '"' + String(value ?? '').replaceAll('"', '""') + '"';
  const rows = [['timestamp', 'type', 'unit', 'before_psu', 'before_reference', 'after_psu', 'after_reference', 'notes']];
  calibrationJournal.forEach((record) => rows.push([
    new Date(record.timestamp).toISOString(), record.type, record.unit, record.beforeDisplayed, record.beforeReference,
    record.afterDisplayed, record.afterReference, record.notes,
  ]));
  const csv = rows.map((row) => row.map(escapeCsv).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'sk150c-calibration-journal.csv';
  link.click();
  URL.revokeObjectURL(url);
});

renderCalibrationGuide();
renderCalibrationJournal();
updateCalibrationCalculator();

// Persistent telemetry
const LOG_DB = 'sk150c-console';
const LOG_STORE = 'samples';
let logDbPromise;
function openLogDb() {
  if (!('indexedDB' in window)) return Promise.resolve(null);
  if (logDbPromise) return logDbPromise;
  logDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(LOG_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(LOG_STORE)) db.createObjectStore(LOG_STORE, { keyPath: 'timestamp' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    console.warn('Persistent telemetry is unavailable', error);
    return null;
  });
  return logDbPromise;
}

async function storeSample(sample) {
  const db = await openLogDb();
  if (!db) return;
  const tx = db.transaction(LOG_STORE, 'readwrite');
  tx.objectStore(LOG_STORE).put(sample);
}

async function loadStoredSamples() {
  const db = await openLogDb();
  if (!db) return [];
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return new Promise((resolve) => {
    const tx = db.transaction(LOG_STORE, 'readonly');
    const range = IDBKeyRange.lowerBound(cutoff);
    const request = tx.objectStore(LOG_STORE).getAll(range);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => resolve([]);
  });
}

async function clearStoredSamples() {
  const db = await openLogDb();
  if (!db) return;
  await new Promise((resolve, reject) => {
    const tx = db.transaction(LOG_STORE, 'readwrite');
    const request = tx.objectStore(LOG_STORE).clear();
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}

function downloadBlob(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCsv() {
  if (!api.state.samples.length) {
    api.toast('There are no samples to export.', true);
    return;
  }
  const header = ['timestamp', 'voltage_v', 'current_a', 'power_w', 'input_voltage_v', 'internal_temp_c', 'external_temp_c', 'capacity_ah', 'energy_wh', 'mode', 'output', 'protection'];
  const lines = api.state.samples.map((s) => [
    new Date(s.timestamp).toISOString(), s.voltage, s.current, s.power, s.inputVoltage ?? '',
    s.internalTemp ?? '', s.externalTemp ?? '', s.ah ?? '', s.wh ?? '', s.mode ?? '', s.output ? 1 : 0, s.protection ?? '',
  ].join(','));
  downloadBlob(`sk150c-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`, [header.join(','), ...lines].join('\n'), 'text/csv');
}

$('exportCsvButton').addEventListener('click', exportCsv);
$('clearLogButton').addEventListener('click', async () => {
  if (!window.confirm('Clear the locally stored telemetry history?')) return;
  api.state.samples.length = 0;
  await clearStoredSamples();
  api.drawCharts();
  drawTemperatureChart();
  updateStats();
  api.toast('Local telemetry history cleared.');
});

const session = { start: Date.now(), startAh: null, startWh: null, connected: false };
function updateStats() {
  const now = Date.now();
  const sessionSamples = api.state.samples.filter((sample) => sample.timestamp >= session.start);
  const visibleStart = now - api.state.rangeSeconds * 1000;
  const visible = api.state.samples.filter((sample) => sample.timestamp >= visibleStart);
  const device = api.state.device;
  if (session.startAh === null && sessionSamples.length) {
    session.startAh = sessionSamples[0].ah ?? device.ah;
    session.startWh = sessionSamples[0].wh ?? device.wh;
  }
  const deliveredAh = session.startAh === null ? 0 : Math.max(0, device.ah - session.startAh);
  const deliveredWh = session.startWh === null ? 0 : Math.max(0, device.wh - session.startWh);
  $('sessionDuration').textContent = formatDuration(session.connected ? (now - session.start) / 1000 : 0);
  $('sessionAh').textContent = `${deliveredAh.toFixed(3)} Ah`;
  $('sessionWh').textContent = `${deliveredWh.toFixed(3)} Wh`;
  $('internalTemp').textContent = finiteTemp(device.internalTemp) === null ? '— °C' : `${device.internalTemp.toFixed(1)} °C`;
  $('externalTemp').textContent = finiteTemp(device.externalTemp) === null ? '— °C' : `${device.externalTemp.toFixed(1)} °C`;
  $('sampleCount').textContent = String(sessionSamples.length);

  if (visible.length) {
    const average = (key) => visible.reduce((sum, item) => sum + Number(item[key] || 0), 0) / visible.length;
    const voltages = visible.map((item) => item.voltage);
    $('averageVoltage').textContent = `${average('voltage').toFixed(2)} V`;
    $('averageCurrent').textContent = `${average('current').toFixed(3)} A`;
    $('peakPower').textContent = `${Math.max(...visible.map((item) => item.power)).toFixed(2)} W`;
    $('voltageRange').textContent = `${Math.min(...voltages).toFixed(2)}–${Math.max(...voltages).toFixed(2)} V`;
  } else {
    ['averageVoltage', 'averageCurrent', 'peakPower', 'voltageRange'].forEach((id) => { $(id).textContent = '—'; });
  }

  $('detailInternalTemp').textContent = finiteTemp(device.internalTemp) === null ? '—' : `${device.internalTemp.toFixed(1)} °C`;
  $('detailExternalTemp').textContent = finiteTemp(device.externalTemp) === null ? '—' : `${device.externalTemp.toFixed(1)} °C`;
  $('detailAh').textContent = `${device.ah.toFixed(3)} Ah`;
  $('detailWh').textContent = `${device.wh.toFixed(3)} Wh`;
  $('detailDuration').textContent = formatDuration(device.outputDurationSeconds);
  $('detailFirmware').textContent = device.model ? `${device.model} / ${device.version}` : '—';
  $('detailConnection').textContent = `${MODBUS_ADDRESS_TEXT()} / ${device.baudCode || 6}`;
  $('detailProtection').textContent = api.protectionLabels[device.protection] || `Code ${device.protection}`;
  $('deviceHealth').textContent = device.protection === 0 ? 'Normal' : 'Attention required';
  $('deviceHealth').classList.toggle('is-alert', device.protection !== 0);
}

function MODBUS_ADDRESS_TEXT() { return String(api.constants.MODBUS_ADDRESS); }

function drawTemperatureChart() {
  const canvas = $('temperatureChart');
  if (!canvas) return;
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.strokeStyle = 'rgba(145, 172, 182, .10)';
  for (let row = 1; row < 4; row += 1) {
    context.beginPath(); context.moveTo(0, height / 4 * row); context.lineTo(width, height / 4 * row); context.stroke();
  }
  const start = Date.now() - api.state.rangeSeconds * 1000;
  const source = api.state.samples.filter((sample) => sample.timestamp >= start && (finiteTemp(sample.internalTemp) !== null || finiteTemp(sample.externalTemp) !== null));
  const stride = Math.max(1, Math.ceil(source.length / 1800));
  const samples = source.filter((_, index) => index % stride === 0 || index === source.length - 1);
  if (!samples.length) {
    context.fillStyle = 'rgba(143, 165, 174, .66)'; context.font = '12px Inter, system-ui, sans-serif'; context.textAlign = 'center'; context.fillText('Temperature data will appear here', width / 2, height / 2 + 4);
    $('temperatureMin').textContent = '— °C'; $('temperatureMax').textContent = '— °C'; $('chartTemperatureNow').textContent = '— °C'; $('chartInternalTemperatureNow').textContent = '— °C';
    return;
  }
  const values = samples.flatMap((sample) => [sample.internalTemp, sample.externalTemp]).filter((value) => finiteTemp(value) !== null);
  let min = Math.min(...values); let max = Math.max(...values);
  if (max - min < 4) { const center = (max + min) / 2; min = center - 2; max = center + 2; }
  const xFor = (sample) => (sample.timestamp - start) / (api.state.rangeSeconds * 1000) * width;
  const yFor = (value) => height - (value - min) / (max - min) * (height - 12) - 6;
  const line = (key, color) => {
    context.beginPath(); let began = false;
    samples.forEach((sample) => {
      const value = finiteTemp(sample[key]); if (value === null) return;
      const x = xFor(sample); const y = yFor(value); if (!began) { context.moveTo(x, y); began = true; } else context.lineTo(x, y);
    });
    context.strokeStyle = color; context.lineWidth = 2; context.lineJoin = 'round'; context.stroke();
  };
  line('internalTemp', '#ce98ff'); line('externalTemp', '#ff9f70');
  $('temperatureMin').textContent = `${min.toFixed(1)} °C`; $('temperatureMax').textContent = `${max.toFixed(1)} °C`;
  const latest = samples.at(-1);
  const probeTemp = finiteTemp(latest.externalTemp);
  const internalTemp = finiteTemp(latest.internalTemp);
  $('chartTemperatureNow').textContent = probeTemp === null ? '— °C' : `${probeTemp.toFixed(1)} °C`;
  $('chartInternalTemperatureNow').textContent = internalTemp === null ? '— °C' : `${internalTemp.toFixed(1)} °C`;
}

document.querySelectorAll('[data-range]').forEach((button) => button.addEventListener('click', () => { window.setTimeout(() => { updateStats(); drawTemperatureChart(); }, 0); }));
window.addEventListener('resize', drawTemperatureChart);

// Event log and alarms
const eventEntries = [];
function addEvent(message, alert = false) {
  eventEntries.unshift({ time: new Date(), message, alert });
  eventEntries.splice(50);
  $('eventLog').innerHTML = eventEntries.map((entry) => `<p class="${entry.alert ? 'event-alert' : ''}"><time>${entry.time.toLocaleTimeString()}</time>${entry.message}</p>`).join('') || '<p>No events this session.</p>';
}

const alarmInputIds = ['alarmCurrent', 'alarmInputVoltage', 'alarmTemperature', 'alarmCooldown', 'alarmSound', 'alarmModeTransition', 'alarmAutoDisable'];
const alarmDefaults = { alarmCurrent: 0, alarmInputVoltage: 0, alarmTemperature: 55, alarmCooldown: 30, alarmSound: true, alarmModeTransition: true, alarmAutoDisable: false };
const savedAlarms = { ...alarmDefaults, ...jsonRead('sk150c-alarms', {}) };
alarmInputIds.forEach((id) => {
  const element = $(id);
  if (element.type === 'checkbox') element.checked = Boolean(savedAlarms[id]); else element.value = savedAlarms[id];
  element.addEventListener('change', () => {
    const values = {};
    alarmInputIds.forEach((key) => { values[key] = $(key).type === 'checkbox' ? $(key).checked : Number($(key).value); });
    jsonWrite('sk150c-alarms', values);
  });
});

const alarmLastFired = new Map();
let audioContext;
async function alarm(message, severe = false, key = message) {
  const cooldown = Number($('alarmCooldown').value || 30) * 1000;
  if (Date.now() - (alarmLastFired.get(key) || 0) < cooldown) return;
  alarmLastFired.set(key, Date.now());
  addEvent(message, severe);
  api.toast(message, severe);
  if ($('alarmSound').checked) {
    try {
      audioContext ||= new AudioContext();
      const oscillator = audioContext.createOscillator(); const gain = audioContext.createGain();
      oscillator.frequency.value = severe ? 720 : 520; gain.gain.setValueAtTime(.08, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + .35);
      oscillator.connect(gain).connect(audioContext.destination); oscillator.start(); oscillator.stop(audioContext.currentTime + .36);
    } catch { /* Audio permission is browser-controlled. */ }
  }
  if ('Notification' in window && Notification.permission === 'granted') new Notification('SK150C Bench Console', { body: message });
  if (severe && $('alarmAutoDisable').checked && api.state.device.output && !api.state.readOnly) {
    try { await api.setOutputEnabled(false); addEvent('Output disabled automatically.'); } catch (error) { addEvent(`Automatic stop failed: ${error.message}`, true); }
  }
}

$('enableNotifications').addEventListener('click', async () => {
  if (!('Notification' in window)) { api.toast('Desktop notifications are unavailable in this browser.', true); return; }
  const result = await Notification.requestPermission();
  api.toast(result === 'granted' ? 'Desktop notifications enabled.' : 'Desktop notifications were not enabled.', result !== 'granted');
});
$('testAlarm').addEventListener('click', () => alarm('Test alarm from the SK150C console.', false, `test-${Date.now()}`));

let previousMode = null;
async function checkAlarms(sample, device) {
  if (previousMode && previousMode !== sample.mode && $('alarmModeTransition').checked) await alarm(`Regulation changed from ${previousMode} to ${sample.mode}.`, false, 'mode');
  previousMode = sample.mode;
  const currentLimit = Number($('alarmCurrent').value || 0);
  const inputFloor = Number($('alarmInputVoltage').value || 0);
  const tempLimit = Number($('alarmTemperature').value || 0);
  const hottest = Math.max(...[device.internalTemp, device.externalTemp].filter(Number.isFinite), -Infinity);
  if (currentLimit > 0 && device.currentOut > currentLimit) await alarm(`Current exceeded ${currentLimit.toFixed(3)} A.`, true, 'current');
  if (inputFloor > 0 && device.voltageIn < inputFloor) await alarm(`Input voltage fell below ${inputFloor.toFixed(2)} V.`, true, 'input');
  if (tempLimit > 0 && hottest > tempLimit) await alarm(`Temperature exceeded ${tempLimit.toFixed(1)} °C.`, true, 'temperature');
  if (device.protection !== 0) await alarm(`Protection trip: ${api.protectionLabels[device.protection] || `code ${device.protection}`}.`, true, 'protection');
}

// Sequence runner
let sequenceSteps = jsonRead('sk150c-sequence', [{ action: 'set', voltage: 5, current: 1, duration: 10, ramp: 0 }]);
let sequenceRun = null;
function saveSequence() { jsonWrite('sk150c-sequence', sequenceSteps); }
function renderSequence() {
  const body = $('sequenceBody'); body.replaceChildren();
  sequenceSteps.forEach((step, index) => {
    const row = document.createElement('tr');
    row.innerHTML = `<td><select data-key="action"><option value="set"${step.action === 'set' ? ' selected' : ''}>Set output</option><option value="off"${step.action === 'off' ? ' selected' : ''}>Output off</option></select></td><td><input data-key="voltage" type="number" min="0.5" max="40" step="0.01" value="${step.voltage ?? 5}"></td><td><input data-key="current" type="number" min="0" max="15" step="0.001" value="${step.current ?? 1}"></td><td><input data-key="duration" type="number" min="0.2" max="86400" step="0.1" value="${step.duration ?? 10}"></td><td><input data-key="ramp" type="number" min="0" max="3600" step="0.1" value="${step.ramp ?? 0}"></td><td><button class="row-delete" type="button" aria-label="Delete step">×</button></td>`;
    row.querySelectorAll('[data-key]').forEach((input) => input.addEventListener('change', () => {
      sequenceSteps[index][input.dataset.key] = input.dataset.key === 'action' ? input.value : Number(input.value); saveSequence(); renderSequence();
    }));
    row.querySelector('.row-delete').addEventListener('click', () => { sequenceSteps.splice(index, 1); saveSequence(); renderSequence(); });
    const disabled = step.action === 'off';
    row.querySelector('[data-key="voltage"]').disabled = disabled; row.querySelector('[data-key="current"]').disabled = disabled; row.querySelector('[data-key="ramp"]').disabled = disabled;
    body.append(row);
  });
}

function applyRecipe(name) {
  if (name === 'rails') sequenceSteps = [3.3, 5, 9, 12].map((voltage) => ({ action: 'set', voltage, current: 1, duration: 10, ramp: 0 }));
  if (name === 'burnin') sequenceSteps = [{ action: 'set', voltage: 5, current: 1, duration: 3600, ramp: 2 }];
  if (name === 'cycle') sequenceSteps = [{ action: 'set', voltage: 5, current: 1, duration: 10, ramp: .5 }, { action: 'off', voltage: 5, current: 1, duration: 5, ramp: 0 }];
  saveSequence(); renderSequence();
}

$('sequenceRecipe').addEventListener('change', (event) => { if (event.target.value !== 'custom') applyRecipe(event.target.value); });
$('addSequenceStep').addEventListener('click', () => { sequenceSteps.push({ action: 'set', voltage: 5, current: 1, duration: 10, ramp: 0 }); saveSequence(); renderSequence(); });

async function waitForStep(seconds, label, completed, total) {
  const started = performance.now();
  while (!sequenceRun?.cancelled) {
    const elapsed = (performance.now() - started) / 1000;
    const remaining = Math.max(0, seconds - elapsed);
    $('sequenceProgressLabel').textContent = label;
    $('sequenceCountdown').textContent = `${remaining.toFixed(1)} s`;
    $('sequenceProgressFill').style.width = `${Math.min(100, ((completed + Math.min(1, elapsed / seconds)) / total) * 100)}%`;
    if (remaining <= 0) return;
    await delay(100);
  }
  throw new Error('Sequence stopped.');
}

async function rampSetpoints(targetVoltage, targetCurrent, seconds) {
  const startVoltage = api.state.device.voltageSet;
  const startCurrent = api.state.device.currentSet;
  const steps = Math.max(1, Math.min(100, Math.ceil(seconds * 4)));
  for (let index = 1; index <= steps; index += 1) {
    if (sequenceRun?.cancelled) throw new Error('Sequence stopped.');
    const ratio = index / steps;
    const voltage = startVoltage + (targetVoltage - startVoltage) * ratio;
    const current = startCurrent + (targetCurrent - startCurrent) * ratio;
    await api.enqueue(() => api.writeMultiple(api.register.voltageSet, [Math.round(voltage * api.constants.VOLTAGE_SCALE), Math.round(current * api.constants.CURRENT_SCALE)]));
    await delay(seconds * 1000 / steps);
  }
  await api.enqueue(api.pollDevice);
}

async function runSequence() {
  if (!api.state.connected) throw new Error('Connect the PSU first.');
  if (api.state.readOnly) throw new Error('The connection is read-only.');
  if (!sequenceSteps.length) throw new Error('Add at least one sequence step.');
  sequenceSteps.forEach((step) => {
    if (step.action === 'set' && (step.voltage < .5 || step.voltage > 40 || step.current < 0 || step.current > 15 || step.voltage * step.current > 150)) throw new Error('A sequence step is outside the PSU limits.');
    if (step.duration <= 0) throw new Error('Every sequence step needs a positive hold time.');
  });
  if (!window.confirm('Start this sequence? It can change setpoints and switch the PSU output.')) return;
  sequenceRun = { cancelled: false };
  $('sequenceStatus').textContent = 'Running'; $('sequenceStatus').classList.add('is-running'); $('startSequence').disabled = true; $('stopSequence').disabled = false;
  const cycles = clamp($('sequenceCycles').value, 1, 100);
  const total = sequenceSteps.length * cycles; let completed = 0;
  try {
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      for (let index = 0; index < sequenceSteps.length; index += 1) {
        const step = sequenceSteps[index]; if (sequenceRun.cancelled) throw new Error('Sequence stopped.');
        const label = `Cycle ${cycle + 1}/${cycles} · Step ${index + 1}/${sequenceSteps.length}`;
        if (step.action === 'off') await api.setOutputEnabled(false);
        else {
          if (step.ramp > 0) await rampSetpoints(step.voltage, step.current, step.ramp); else await api.setSetpoints(step.voltage, step.current);
          if (!api.state.device.output) await api.setOutputEnabled(true);
        }
        await waitForStep(step.duration, label, completed, total); completed += 1;
      }
    }
    if ($('sequenceOffAtEnd').checked) await api.setOutputEnabled(false);
    addEvent('Sequence completed.'); api.toast('Sequence completed.');
  } catch (error) {
    addEvent(error.message, error.message !== 'Sequence stopped.');
    if (error.message !== 'Sequence stopped.') api.toast(error.message, true);
  } finally {
    sequenceRun = null; $('sequenceStatus').textContent = 'Idle'; $('sequenceStatus').classList.remove('is-running'); $('stopSequence').disabled = true; $('sequenceProgressLabel').textContent = 'No sequence running'; $('sequenceCountdown').textContent = '—'; syncFeatureActions();
  }
}

$('startSequence').addEventListener('click', () => runSequence().catch((error) => api.toast(error.message, true)));
$('stopSequence').addEventListener('click', async () => { if (sequenceRun) sequenceRun.cancelled = true; try { await api.setOutputEnabled(false); } catch {} });

// Assisted battery session
const chemistryVoltage = { liion: 4.2, lifepo4: 3.65, sla: 2.4, nimh: 1.45 };
let batterySession = null;
function batteryConfig() {
  const chemistry = $('batteryChemistry').value;
  const cells = clamp($('batteryCells').value, 1, 12);
  const capacity = clamp($('batteryCapacity').value, .05, 200);
  const rate = clamp($('batteryRate').value, .05, 2);
  return {
    chemistry, cells, capacity, rate,
    voltage: round(chemistryVoltage[chemistry] * cells, 2),
    current: round(Math.min(15, capacity * rate), 3),
    cutoff: clamp($('batteryCutoff').value, .001, 15),
    maxTemp: clamp($('batteryMaxTemp').value, 20, 100),
    timeoutHours: clamp($('batteryTimeout').value, 1, 48),
    capacityLimit: clamp($('batteryCapacityLimit').value, 0, 300),
  };
}
function updateBatteryTarget() {
  const config = batteryConfig();
  $('batteryTarget').textContent = `${config.voltage.toFixed(2)} V · ${config.current.toFixed(3)} A`;
  const invalid = config.voltage > 40 || config.voltage * config.current > 150;
  $('batteryTarget').classList.toggle('is-alert', invalid);
}
['batteryChemistry', 'batteryCells', 'batteryCapacity', 'batteryRate', 'batteryCutoff', 'batteryMaxTemp', 'batteryTimeout', 'batteryCapacityLimit'].forEach((id) => $(id).addEventListener('input', updateBatteryTarget));

async function startBatterySession() {
  if (!api.state.connected) throw new Error('Connect the PSU first.');
  if (api.state.readOnly) throw new Error('The connection is read-only.');
  const config = batteryConfig();
  if (config.voltage > 40 || config.voltage * config.current > 150) throw new Error('This battery profile exceeds the PSU output envelope.');
  if (!window.confirm(`Start an assisted ${config.chemistry} session at ${config.voltage.toFixed(2)} V / ${config.current.toFixed(3)} A?`)) return;
  await api.setSetpoints(config.voltage, config.current);
  await api.setOutputEnabled(true);
  batterySession = { config, start: Date.now(), startAh: api.state.device.ah, stopping: false };
  $('startBattery').disabled = true; $('stopBattery').disabled = false; $('batteryPhase').textContent = api.state.device.cvcc === 1 ? 'CC' : 'CV';
  addEvent('Assisted battery session started.');
}

async function stopBatterySession(reason = 'Battery session stopped.', automatic = false) {
  if (!batterySession || batterySession.stopping) return;
  batterySession.stopping = true;
  try { if (api.state.connected && !api.state.readOnly) await api.setOutputEnabled(false); } catch (error) { addEvent(`Battery stop failed: ${error.message}`, true); }
  batterySession = null; $('stopBattery').disabled = true; $('batteryPhase').textContent = 'IDLE'; syncFeatureActions();
  addEvent(reason, automatic); api.toast(reason, automatic);
}

async function updateBatterySession(device) {
  if (!batterySession || batterySession.stopping) return;
  const { config, start, startAh } = batterySession;
  const elapsed = (Date.now() - start) / 1000;
  const delivered = Math.max(0, device.ah - startAh);
  const progress = Math.min(100, delivered / config.capacity * 100);
  $('batteryProgress').textContent = `${progress.toFixed(0)}%`; $('batteryProgressRing').style.setProperty('--progress', `${progress * 3.6}deg`);
  $('batteryDelivered').textContent = `${delivered.toFixed(3)} Ah`; $('batteryElapsed').textContent = `${formatDuration(elapsed)} elapsed`; $('batteryPhase').textContent = device.cvcc === 1 ? 'CC' : 'CV';
  const temperatures = [device.internalTemp, device.externalTemp].filter(Number.isFinite);
  const hottest = temperatures.length ? Math.max(...temperatures) : null;
  let reason = '';
  if (device.protection !== 0) reason = `Battery session stopped by ${api.protectionLabels[device.protection] || 'protection'}.`;
  else if (hottest !== null && hottest >= config.maxTemp) reason = `Battery session stopped at ${hottest.toFixed(1)} °C.`;
  else if (elapsed >= config.timeoutHours * 3600) reason = 'Battery session reached its timeout.';
  else if (config.capacityLimit > 0 && delivered >= config.capacity * config.capacityLimit / 100) reason = 'Battery session reached its capacity cutoff.';
  else if (device.cvcc === 0 && elapsed > 60 && device.currentOut <= config.cutoff) reason = 'Battery session reached its CV cutoff current.';
  if (reason) await stopBatterySession(reason, true);
}

$('startBattery').addEventListener('click', () => startBatterySession().catch((error) => api.toast(error.message, true)));
$('stopBattery').addEventListener('click', () => stopBatterySession('Battery session stopped by user.'));

// Local presets
const defaultLocalPresets = [
  { id: crypto.randomUUID(), name: 'ESP32 / USB logic', voltage: 5, current: 1 },
  { id: crypto.randomUUID(), name: '3.3 V logic', voltage: 3.3, current: 1 },
  { id: crypto.randomUUID(), name: '12 V bench', voltage: 12, current: 2 },
];
let localPresets = jsonRead('sk150c-local-presets', defaultLocalPresets);
function saveLocalPresets() { jsonWrite('sk150c-local-presets', localPresets); }
function renderLocalPresets() {
  const grid = $('localPresetGrid'); grid.replaceChildren();
  localPresets.forEach((preset) => {
    const card = document.createElement('article'); card.className = 'library-card';
    const header = document.createElement('header'); const title = document.createElement('strong'); title.textContent = preset.name; header.append(title);
    const values = document.createElement('p'); values.textContent = `${Number(preset.voltage).toFixed(2)} V · ${Number(preset.current).toFixed(3)} A`;
    const footer = document.createElement('footer');
    const load = document.createElement('button'); load.type = 'button'; load.textContent = 'Stage'; load.addEventListener('click', () => { api.stageSetpoint('voltage', preset.voltage); api.stageSetpoint('current', preset.current); document.querySelector('[data-view-target="monitor"]').click(); api.toast(`${preset.name} staged.`); });
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete'; remove.addEventListener('click', () => { if (!window.confirm(`Delete preset “${preset.name}”?`)) return; localPresets = localPresets.filter((item) => item.id !== preset.id); saveLocalPresets(); renderLocalPresets(); });
    footer.append(load, remove); card.append(header, values, footer); grid.append(card);
  });
}
$('presetForm').addEventListener('submit', (event) => {
  event.preventDefault(); const preset = { id: crypto.randomUUID(), name: $('presetName').value.trim(), voltage: clamp($('presetVoltage').value, .5, 40), current: clamp($('presetCurrent').value, 0, 15) };
  if (!preset.name || preset.voltage * preset.current > 150) { api.toast('Enter a valid name and values within 150 W.', true); return; }
  localPresets.push(preset); saveLocalPresets(); renderLocalPresets(); event.target.reset(); $('presetVoltage').value = '5.00'; $('presetCurrent').value = '1.000';
});
$('exportPresets').addEventListener('click', () => downloadBlob('sk150c-presets.json', JSON.stringify({ version: 1, presets: localPresets }, null, 2), 'application/json'));
$('importPresets').addEventListener('click', () => $('presetFile').click());
$('presetFile').addEventListener('change', async (event) => {
  try {
    const parsed = JSON.parse(await event.target.files[0].text()); const incoming = Array.isArray(parsed) ? parsed : parsed.presets;
    if (!Array.isArray(incoming)) throw new Error('No presets were found.');
    localPresets = incoming.map((item) => ({ id: crypto.randomUUID(), name: String(item.name).slice(0, 32), voltage: clamp(item.voltage, .5, 40), current: clamp(item.current, 0, 15) })).filter((item) => item.name && item.voltage * item.current <= 150);
    saveLocalPresets(); renderLocalPresets(); api.toast(`${localPresets.length} presets imported.`);
  } catch (error) { api.toast(`Preset import failed: ${error.message}`, true); } finally { event.target.value = ''; }
});

// Hardware memory and protection limits
let selectedMemoryEditor = 0;
const memoryNames = jsonRead('sk150c-memory-names', {});
function memoryBase(slot) { return 0x0050 + slot * 0x0010; }
function renderEditorSlots() {
  $('memoryEditorSlots').replaceChildren();
  for (let slot = 0; slot <= 10; slot += 1) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `memory-slot${slot === selectedMemoryEditor ? ' active' : ''}`; button.textContent = `M${slot}`;
    button.addEventListener('click', () => { selectedMemoryEditor = slot; renderEditorSlots(); $('memoryName').value = memoryNames[slot] || ''; $('memoryEditorStatus').textContent = `M${slot} selected`; }); $('memoryEditorSlots').append(button);
  }
}
function fillMemoryForm(values, slot = selectedMemoryEditor) {
  $('memoryName').value = memoryNames[slot] || ''; $('memoryVoltage').value = (values[0] / 100).toFixed(2); $('memoryCurrent').value = (values[1] / 1000).toFixed(3); $('memoryLvp').value = (values[2] / 100).toFixed(2); $('memoryOvp').value = (values[3] / 100).toFixed(2); $('memoryOcp').value = (values[4] / 1000).toFixed(3); $('memoryOpp').value = (values[5] / 10).toFixed(1); $('memoryOtp').value = (values[12] / 10).toFixed(1);
}
async function readMemorySlot(slot) {
  if (!api.state.connected) throw new Error('Connect the PSU first.');
  const values = await api.enqueue(() => api.readRegisters(memoryBase(slot), 13));
  return values;
}
async function writeMemoryValues(slot, values) {
  if (!api.state.connected) throw new Error('Connect the PSU first.'); if (api.state.readOnly) throw new Error('The connection is read-only.');
  const base = memoryBase(slot);
  for (const [offset, value] of values) await api.enqueue(() => api.writeSingle(base + offset, value));
}
$('loadMemoryEditor').addEventListener('click', async () => { try { fillMemoryForm(await readMemorySlot(selectedMemoryEditor)); $('memoryEditorStatus').textContent = `M${selectedMemoryEditor} loaded`; } catch (error) { api.toast(error.message, true); } });
$('saveMemoryEditor').addEventListener('click', async () => {
  if (!window.confirm(`Write the edited values to hardware memory M${selectedMemoryEditor}?`)) return;
  try {
    const values = [[0, Math.round(Number($('memoryVoltage').value) * 100)], [1, Math.round(Number($('memoryCurrent').value) * 1000)], [2, Math.round(Number($('memoryLvp').value) * 100)], [3, Math.round(Number($('memoryOvp').value) * 100)], [4, Math.round(Number($('memoryOcp').value) * 1000)], [5, Math.round(Number($('memoryOpp').value) * 10)], [12, Math.round(Number($('memoryOtp').value) * 10)]];
    const voltage = values[0][1] / 100; const current = values[1][1] / 1000; if (voltage * current > 150) throw new Error('The setpoint combination exceeds 150 W.');
    await writeMemoryValues(selectedMemoryEditor, values); memoryNames[selectedMemoryEditor] = $('memoryName').value.trim(); jsonWrite('sk150c-memory-names', memoryNames); $('memoryEditorStatus').textContent = `M${selectedMemoryEditor} saved`; api.toast(`Hardware memory M${selectedMemoryEditor} updated.`);
  } catch (error) { api.toast(error.message, true); }
});
$('recallMemoryEditor').addEventListener('click', async () => { try { await api.enqueue(() => api.writeSingle(api.register.memory, selectedMemoryEditor)); await delay(150); await api.enqueue(api.pollDevice); api.toast(`M${selectedMemoryEditor} recalled.`); } catch (error) { api.toast(error.message, true); } });

for (let slot = 0; slot <= 10; slot += 1) { const option = document.createElement('option'); option.value = String(slot); option.textContent = `M${slot}${memoryNames[slot] ? ` · ${memoryNames[slot]}` : ''}`; $('protectionSlot').append(option); }
function fillProtection(values) { $('protectionLvp').value = (values[2] / 100).toFixed(2); $('protectionOvp').value = (values[3] / 100).toFixed(2); $('protectionOcp').value = (values[4] / 1000).toFixed(3); $('protectionOpp').value = (values[5] / 10).toFixed(1); $('protectionOtp').value = (values[12] / 10).toFixed(1); }
$('readProtection').addEventListener('click', async () => { try { fillProtection(await readMemorySlot(Number($('protectionSlot').value))); } catch (error) { api.toast(error.message, true); } });
$('writeProtection').addEventListener('click', async () => {
  const slot = Number($('protectionSlot').value); if (!window.confirm(`Apply these protection limits to M${slot}?`)) return;
  try { await writeMemoryValues(slot, [[2, Math.round(Number($('protectionLvp').value) * 100)], [3, Math.round(Number($('protectionOvp').value) * 100)], [4, Math.round(Number($('protectionOcp').value) * 1000)], [5, Math.round(Number($('protectionOpp').value) * 10)], [12, Math.round(Number($('protectionOtp').value) * 10)]]); api.toast(`Protection limits written to M${slot}.`); } catch (error) { api.toast(error.message, true); }
});

// Connection settings and PWA
const connectionSettings = { transport: 'serial', bridgeUrl: 'http://sk150c.local', readOnly: false, ...jsonRead('sk150c-connection', {}) };
$('transportSelect').value = connectionSettings.transport; $('bridgeUrl').value = connectionSettings.bridgeUrl; $('readOnlyMode').checked = connectionSettings.readOnly; $('bridgeToken').value = sessionStorage.getItem('sk150c-bridge-token') || '';
function updateTransportFooter() {
  const type = $('transportSelect').value; const labels = { serial: 'Local Web Serial · 115200 baud · Modbus RTU · address 1', http: 'ESP32 HTTP bridge · binary Modbus frames', websocket: 'ESP32 WebSocket bridge · binary Modbus frames' };
  $('transportFooter').textContent = labels[type]; $('bridgeUrl').disabled = type === 'serial'; $('bridgeToken').disabled = type === 'serial';
}
$('transportSelect').addEventListener('change', updateTransportFooter); updateTransportFooter();
$('saveConnectionSettings').addEventListener('click', () => { jsonWrite('sk150c-connection', { transport: $('transportSelect').value, bridgeUrl: $('bridgeUrl').value.trim(), readOnly: $('readOnlyMode').checked }); sessionStorage.setItem('sk150c-bridge-token', $('bridgeToken').value); api.toast('Connection settings saved for the next connection.'); updateTransportFooter(); });

let installPrompt = null;
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt = event; $('installApp').disabled = false; });
$('installApp').addEventListener('click', async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('installApp').disabled = true; });
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === '127.0.0.1' || location.hostname === 'localhost')) navigator.serviceWorker.register('./service-worker.js').catch((error) => console.warn('Offline app registration failed', error));

// Shared live events
window.addEventListener('psu:sample', async (event) => {
  const { sample, device } = event.detail;
  void storeSample(sample);
  updateStats(); drawTemperatureChart(); await checkAlarms(sample, device); await updateBatterySession(device);
});

let wasConnected = false;
function syncFeatureActions() {
  const disconnected = !api.state.connected;
  const writeLocked = disconnected || api.state.readOnly;
  $('emergencyStop').disabled = writeLocked;
  $('startSequence').disabled = writeLocked || Boolean(sequenceRun);
  $('startBattery').disabled = writeLocked || Boolean(batterySession);
  $('loadMemoryEditor').disabled = disconnected;
  $('saveMemoryEditor').disabled = writeLocked;
  $('recallMemoryEditor').disabled = writeLocked;
  $('readProtection').disabled = disconnected;
  $('writeProtection').disabled = writeLocked;
}
window.addEventListener('psu:connection', (event) => {
  const connected = event.detail.connected;
  syncFeatureActions();
  if (connected && !wasConnected) { session.start = Date.now(); session.startAh = null; session.startWh = null; session.connected = true; addEvent(`Connected over ${event.detail.transport}.`); }
  if (!connected && wasConnected) { session.connected = false; addEvent('PSU disconnected.', true); void alarm('PSU disconnected.', true, 'disconnect'); if (sequenceRun) sequenceRun.cancelled = true; batterySession = null; }
  wasConnected = connected;
  syncFeatureActions();
});

$('emergencyStop').addEventListener('click', async () => {
  if (sequenceRun) sequenceRun.cancelled = true;
  if (batterySession) batterySession.stopping = true;
  try { await api.setOutputEnabled(false); batterySession = null; $('stopBattery').disabled = true; $('batteryPhase').textContent = 'IDLE'; syncFeatureActions(); addEvent('Emergency output stop applied.', true); api.toast('Output disabled.', true); } catch (error) { api.toast(error.message, true); }
});

window.setInterval(updateStats, 1000);

// Add read-only WebMCP session summary.
try {
  if (document.modelContext?.registerTool) {
    void Promise.resolve(document.modelContext.registerTool({
      name: 'read_psu_session_summary', title: 'Read PSU session summary', description: 'Read accumulated session time, delivered charge and energy, temperatures, and sample count without changing the PSU.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute() { return { connected: api.state.connected, durationSeconds: session.connected ? Math.floor((Date.now() - session.start) / 1000) : 0, deliveredAh: Number($('sessionAh').textContent.split(' ')[0]), deliveredWh: Number($('sessionWh').textContent.split(' ')[0]), internalTemp: api.state.device.internalTemp, externalTemp: api.state.device.externalTemp, samples: api.state.samples.length }; },
    })).catch(() => {});
  }
} catch { /* WebMCP is optional. */ }

renderSequence(); renderLocalPresets(); renderEditorSlots(); updateBatteryTarget(); updateStats(); drawTemperatureChart(); syncFeatureActions();
void loadStoredSamples().then((stored) => {
  if (!stored.length) return;
  const current = new Map(api.state.samples.map((sample) => [sample.timestamp, sample])); stored.forEach((sample) => current.set(sample.timestamp, sample));
  api.state.samples.splice(0, api.state.samples.length, ...[...current.values()].sort((a, b) => a.timestamp - b.timestamp)); api.drawCharts(); drawTemperatureChart(); updateStats();
});
