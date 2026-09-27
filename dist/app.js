const MODBUS_ADDRESS = 1;
const BAUD_RATE = 115200;
const POLL_INTERVAL_MS = 1000;
const MAX_SAMPLE_AGE_MS = 24 * 60 * 60 * 1000;
const VOLTAGE_SCALE = 100;
const CURRENT_SCALE = 1000;
const POWER_SCALE = 100;

const register = {
  voltageSet: 0x0000,
  currentSet: 0x0001,
  voltageOut: 0x0002,
  currentOut: 0x0003,
  powerOut: 0x0004,
  voltageIn: 0x0005,
  ahLow: 0x0006,
  ahHigh: 0x0007,
  whLow: 0x0008,
  whHigh: 0x0009,
  outputHours: 0x000a,
  outputMinutes: 0x000b,
  outputSeconds: 0x000c,
  internalTemp: 0x000d,
  externalTemp: 0x000e,
  protection: 0x0010,
  cvcc: 0x0011,
  output: 0x0012,
  model: 0x0016,
  version: 0x0017,
  address: 0x0018,
  baud: 0x0019,
  memory: 0x001d,
};

const protectionLabels = [
  'Normal', 'Over-voltage', 'Over-current', 'Over-power', 'Input under-voltage',
  'Capacity limit', 'Time limit', 'Over-temperature', 'Energy limit',
  'Watt-hour limit', 'Input over-current', 'Input over-voltage',
];

const presets = {
  bench: [
    { label: 'Logic', voltage: 3.3, current: 1 },
    { label: 'USB', voltage: 5, current: 2 },
    { label: '9 volt', voltage: 9, current: 1 },
    { label: '12 volt', voltage: 12, current: 2 },
    { label: '15 volt', voltage: 15, current: 2 },
    { label: '24 volt', voltage: 24, current: 1.5 },
  ],
  charge: [
    { label: 'Li-ion 1S', voltage: 4.2, current: 0.5 },
    { label: 'Li-ion 2S', voltage: 8.4, current: 0.5 },
    { label: 'Li-ion 3S', voltage: 12.6, current: 0.5 },
    { label: 'LiFePO₄ 1S', voltage: 3.65, current: 0.5 },
    { label: 'SLA float', voltage: 13.6, current: 0.5 },
    { label: 'NiMH test', voltage: 1.45, current: 0.2 },
  ],
};

const ui = Object.fromEntries(
  [
    'connectionState', 'connectionLabel', 'connectButton', 'voltageReading', 'currentReading',
    'powerReading', 'inputReading', 'voltageSetReadout', 'currentSetReadout', 'modeBadge',
    'outputStateLabel', 'protectionReadout', 'voltageChart', 'currentChart', 'powerChart',
    'chartVoltageNow', 'chartCurrentNow', 'chartPowerNow', 'voltageMin', 'voltageMax',
    'currentMin', 'currentMax', 'powerMin', 'powerMax', 'voltageDial', 'currentDial',
    'voltageDialValue', 'currentDialValue', 'voltageInput', 'currentInput', 'pendingPill',
    'setpointPower', 'envelopeFill', 'envelopeNote', 'applyButton', 'outputButton',
    'presetGrid', 'chargeNote', 'memorySlots', 'recallButton', 'lastSample', 'toastRegion',
  ].map((id) => [id, document.getElementById(id)]),
);

const state = {
  port: null,
  transport: 'serial',
  socket: null,
  bridgeUrl: '',
  bridgeToken: '',
  readOnly: false,
  reader: null,
  readLoop: null,
  rx: [],
  queue: Promise.resolve(),
  connected: false,
  closing: false,
  polling: false,
  pollTimer: null,
  consecutiveErrors: 0,
  device: {
    voltageSet: 0,
    currentSet: 0,
    voltageOut: 0,
    currentOut: 0,
    powerOut: 0,
    voltageIn: 0,
    ah: 0,
    wh: 0,
    outputDurationSeconds: 0,
    internalTemp: null,
    externalTemp: null,
    protection: 0,
    cvcc: 0,
    output: false,
    model: 0,
    version: 0,
    baudCode: 0,
  },
  staged: { voltage: 5, current: 1 },
  dirty: false,
  selectedMemory: 0,
  rangeSeconds: 300,
  samples: [],
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundTo(value, places = 2) {
  const scale = 10 ** places;
  return Math.round((Number(value) + Number.EPSILON) * scale) / scale;
}

function decodeTemperature(raw) {
  if (raw === 0xffff) return null;
  const signed = raw & 0x8000 ? raw - 0x10000 : raw;
  const value = signed / 10;
  return value >= -50 && value <= 200 ? value : null;
}

function crc16(bytes) {
  let crc = 0xffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }
  return crc & 0xffff;
}

function withCrc(body) {
  const checksum = crc16(body);
  return Uint8Array.from([...body, checksum & 0xff, (checksum >>> 8) & 0xff]);
}

function verifyFrame(frame) {
  if (frame.length < 5) return false;
  const expected = crc16(frame.slice(0, -2));
  const received = frame.at(-2) | (frame.at(-1) << 8);
  return expected === received;
}

function enqueue(operation) {
  const next = state.queue.then(operation, operation);
  state.queue = next.catch(() => undefined);
  return next;
}

function extractFrame() {
  while (state.rx.length && state.rx[0] !== MODBUS_ADDRESS) state.rx.shift();
  if (state.rx.length < 3) return null;

  const fn = state.rx[1];
  let length;
  if (fn & 0x80) length = 5;
  else if (fn === 0x03) length = 5 + state.rx[2];
  else if (fn === 0x06 || fn === 0x10) length = 8;
  else {
    state.rx.shift();
    return null;
  }

  if (state.rx.length < length) return null;
  return state.rx.splice(0, length);
}

function waitForFrame(timeoutMs = 900) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const check = () => {
      const frame = extractFrame();
      if (frame) {
        if (!verifyFrame(frame)) reject(new Error('The PSU returned a frame with an invalid CRC.'));
        else if (frame[1] & 0x80) reject(new Error(`The PSU returned Modbus exception ${frame[2]}.`));
        else resolve(frame);
        return;
      }
      if (performance.now() - started >= timeoutMs) {
        reject(new Error('The PSU did not respond in time.'));
        return;
      }
      window.setTimeout(check, 5);
    };
    check();
  });
}

async function readSerialLoop() {
  while (state.port?.readable && !state.closing) {
    state.reader = state.port.readable.getReader();
    try {
      while (!state.closing) {
        const { value, done } = await state.reader.read();
        if (done) break;
        if (value?.length) state.rx.push(...value);
      }
    } catch (error) {
      if (!state.closing) console.error('Serial read failed', error);
    } finally {
      state.reader.releaseLock();
      state.reader = null;
    }
  }
}

function normalizeFramePayload(payload) {
  if (payload instanceof Uint8Array) return Array.from(payload);
  if (payload instanceof ArrayBuffer) return Array.from(new Uint8Array(payload));
  if (Array.isArray(payload)) return payload;
  if (payload?.frame && Array.isArray(payload.frame)) return payload.frame;
  throw new Error('The bridge returned an unsupported response format.');
}

function validateResponseFrame(payload) {
  const frame = normalizeFramePayload(payload);
  if (!verifyFrame(frame)) throw new Error('The PSU returned a frame with an invalid CRC.');
  if (frame[1] & 0x80) throw new Error(`The PSU returned Modbus exception ${frame[2]}.`);
  return frame;
}

async function exchangeHttp(request) {
  const endpoint = `${state.bridgeUrl.replace(/\/$/, '')}/api/modbus`;
  const headers = { 'Content-Type': 'application/octet-stream' };
  if (state.bridgeToken) headers.Authorization = `Bearer ${state.bridgeToken}`;
  const response = await fetch(endpoint, { method: 'POST', headers, body: request });
  if (!response.ok) {
    let detail = '';
    try {
      const errorBody = await response.json();
      detail = errorBody.error || '';
      if (errorBody.uart) {
        const received = Number(errorBody.uart.received || 0);
        const bytes = errorBody.uart.bytes ? ` Bytes: ${errorBody.uart.bytes}.` : '';
        detail += received === 0
          ? ' The ESP32 received no serial bytes; check crossed RX/TX wiring and common ground.'
          : ` The ESP32 received ${received} serial byte${received === 1 ? '' : 's'}, but not a valid frame.${bytes}`;
      }
    } catch {
      try { detail = (await response.text()).trim(); } catch { /* Ignore an unreadable error body. */ }
    }
    throw new Error(detail || `ESP32 bridge returned HTTP ${response.status}.`);
  }
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('json')) return normalizeFramePayload(await response.json());
  return normalizeFramePayload(await response.arrayBuffer());
}

function exchangeWebSocket(request) {
  return new Promise((resolve, reject) => {
    const socket = state.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      reject(new Error('The ESP32 WebSocket is not connected.'));
      return;
    }
    const timer = window.setTimeout(() => {
      socket.removeEventListener('message', onMessage);
      reject(new Error('The ESP32 bridge did not respond in time.'));
    }, 1500);
    const onMessage = async (event) => {
      try {
        let payload = event.data;
        if (payload instanceof Blob) payload = await payload.arrayBuffer();
        if (typeof payload === 'string') {
          const parsed = JSON.parse(payload);
          if (!parsed.frame) return;
          payload = parsed;
        }
        window.clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        resolve(normalizeFramePayload(payload));
      } catch (error) {
        window.clearTimeout(timer);
        socket.removeEventListener('message', onMessage);
        reject(error);
      }
    };
    socket.addEventListener('message', onMessage);
    socket.send(request);
  });
}

async function sendRequest(body) {
  if (!state.connected) throw new Error('Connect the PSU first.');
  if (state.readOnly && body[1] !== 0x03) throw new Error('This connection is in read-only mode.');
  const request = withCrc(body);

  if (state.transport === 'http') return validateResponseFrame(await exchangeHttp(request));
  if (state.transport === 'websocket') return validateResponseFrame(await exchangeWebSocket(request));
  if (!state.port?.writable) throw new Error('The serial port is not available.');

  const writer = state.port.writable.getWriter();
  state.rx.length = 0;
  try {
    await writer.write(request);
  } finally {
    writer.releaseLock();
  }
  return waitForFrame();
}

async function readRegisters(start, count) {
  const body = [
    MODBUS_ADDRESS, 0x03,
    (start >>> 8) & 0xff, start & 0xff,
    (count >>> 8) & 0xff, count & 0xff,
  ];
  const frame = await sendRequest(body);
  if (frame[1] !== 0x03 || frame[2] !== count * 2) throw new Error('The PSU returned an unexpected register response.');
  const values = [];
  for (let index = 0; index < count; index += 1) {
    values.push((frame[3 + index * 2] << 8) | frame[4 + index * 2]);
  }
  return values;
}

async function writeSingle(address, value) {
  const body = [
    MODBUS_ADDRESS, 0x06,
    (address >>> 8) & 0xff, address & 0xff,
    (value >>> 8) & 0xff, value & 0xff,
  ];
  const frame = await sendRequest(body);
  if (frame[1] !== 0x06) throw new Error('The PSU did not confirm the setting change.');
}

async function writeMultiple(start, values) {
  const data = values.flatMap((value) => [(value >>> 8) & 0xff, value & 0xff]);
  const count = values.length;
  const body = [
    MODBUS_ADDRESS, 0x10,
    (start >>> 8) & 0xff, start & 0xff,
    (count >>> 8) & 0xff, count & 0xff,
    data.length,
    ...data,
  ];
  const frame = await sendRequest(body);
  if (frame[1] !== 0x10) throw new Error('The PSU did not confirm the setpoints.');
}

async function choosePort() {
  const approved = await navigator.serial.getPorts();
  if (approved.length === 1) return approved[0];
  return navigator.serial.requestPort();
}

async function connect() {
  try {
    setConnectionUi('connecting');
    const saved = JSON.parse(localStorage.getItem('sk150c-connection') || '{}');
    state.transport = document.getElementById('transportSelect')?.value || saved.transport || 'serial';
    state.bridgeUrl = document.getElementById('bridgeUrl')?.value.trim() || saved.bridgeUrl || 'http://sk150c.local';
    state.bridgeToken = document.getElementById('bridgeToken')?.value || '';
    state.readOnly = Boolean(document.getElementById('readOnlyMode')?.checked ?? saved.readOnly);
    state.closing = false;

    if (state.transport === 'serial') {
      if (!('serial' in navigator)) throw new Error('Web Serial is unavailable here. Open this page in current Chrome or Edge.');
      state.port = await choosePort();
      await state.port.open({ baudRate: BAUD_RATE, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 255 });
      state.readLoop = readSerialLoop();
    } else if (state.transport === 'websocket') {
      const url = new URL(state.bridgeUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.pathname = '/ws';
      state.socket = new WebSocket(url);
      state.socket.binaryType = 'arraybuffer';
      await new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('Could not reach the ESP32 WebSocket bridge.')), 3000);
        state.socket.addEventListener('open', () => { window.clearTimeout(timer); resolve(); }, { once: true });
        state.socket.addEventListener('error', () => { window.clearTimeout(timer); reject(new Error('Could not reach the ESP32 WebSocket bridge.')); }, { once: true });
      });
      if (state.bridgeToken) state.socket.send(JSON.stringify({ type: 'auth', token: state.bridgeToken }));
    }

    state.connected = true;
    setConnectionUi('online');
    await enqueue(readIdentity);
    await enqueue(pollDevice);
    state.pollTimer = window.setInterval(() => enqueue(pollDevice), POLL_INTERVAL_MS);
    const labels = { serial: 'USB serial', http: 'ESP32 HTTP', websocket: 'ESP32 WebSocket' };
    toast(`SK150C connected over ${labels[state.transport]}.`);
  } catch (error) {
    await disconnect(false);
    setConnectionUi('offline');
    if (error?.name !== 'NotFoundError') toast(error.message || 'Could not connect to the PSU.', true);
  }
}

async function disconnect(showToast = true) {
  window.clearInterval(state.pollTimer);
  state.pollTimer = null;
  state.connected = false;
  state.closing = true;
  state.rx.length = 0;
  try {
    if (state.reader) await state.reader.cancel();
    if (state.readLoop) await state.readLoop;
    if (state.port?.readable || state.port?.writable) await state.port.close();
    if (state.socket && state.socket.readyState < WebSocket.CLOSING) state.socket.close();
  } catch (error) {
    console.warn('Serial close warning', error);
  }
  state.port = null;
  state.socket = null;
  state.readLoop = null;
  state.closing = false;
  setConnectionUi('offline');
  updateActionStates();
  if (showToast) toast('PSU disconnected.');
}

async function readIdentity() {
  const values = await readRegisters(register.model, 4);
  state.device.model = values[0];
  state.device.version = values[1];
  state.device.baudCode = values[3];
  if (values[2] !== MODBUS_ADDRESS) throw new Error(`The PSU answered with unexpected address ${values[2]}.`);
  ui.connectionLabel.textContent = `Connected · FW ${values[1]}`;
}

async function pollDevice() {
  if (!state.connected || state.polling) return;
  state.polling = true;
  try {
    const live = await readRegisters(register.voltageSet, 6);
    const totals = await readRegisters(register.ahLow, 9);
    const status = await readRegisters(register.protection, 3);
    const ahRaw = totals[1] * 65536 + totals[0];
    const whRaw = totals[3] * 65536 + totals[2];
    Object.assign(state.device, {
      voltageSet: live[0] / VOLTAGE_SCALE,
      currentSet: live[1] / CURRENT_SCALE,
      voltageOut: live[2] / VOLTAGE_SCALE,
      currentOut: live[3] / CURRENT_SCALE,
      powerOut: live[4] / POWER_SCALE,
      voltageIn: live[5] / 100,
      ah: ahRaw / 1000,
      wh: whRaw / 1000,
      outputDurationSeconds: totals[4] * 3600 + totals[5] * 60 + totals[6],
      internalTemp: decodeTemperature(totals[7]),
      externalTemp: decodeTemperature(totals[8]),
      protection: status[0],
      cvcc: status[1],
      output: status[2] === 1,
    });
    state.consecutiveErrors = 0;
    if (!state.dirty) syncStagedToDevice();
    addSample();
    renderTelemetry();
  } catch (error) {
    state.consecutiveErrors += 1;
    if (state.consecutiveErrors === 1) toast('Telemetry paused while the PSU connection recovers.', true);
    if (state.consecutiveErrors >= 3) {
      toast('The PSU stopped responding. Check the cable and reconnect.', true);
      await disconnect(false);
    }
    throw error;
  } finally {
    state.polling = false;
  }
}

function setConnectionUi(mode) {
  const online = mode === 'online';
  ui.connectionState.classList.toggle('is-online', online);
  ui.connectionState.classList.toggle('is-offline', !online);
  document.querySelectorAll('.live-tag').forEach((tag) => { tag.textContent = online ? 'LIVE' : 'READY'; });
  ui.connectionLabel.textContent = mode === 'connecting' ? 'Connecting…' : online ? 'Connected' : 'Not connected';
  ui.connectButton.innerHTML = online
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 12h8M5 5a10 10 0 1 0 14 14A10 10 0 0 0 5 5Z" /></svg>Disconnect'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 12h8m-4-4v8M5 5a10 10 0 1 0 14 14A10 10 0 0 0 5 5Z" /></svg>Connect PSU';
  ui.connectButton.disabled = mode === 'connecting';
  if (!online) {
    ui.modeBadge.textContent = '—';
    ui.outputStateLabel.textContent = mode === 'connecting' ? 'Connecting' : 'Awaiting PSU';
    ui.protectionReadout.textContent = '—';
    ui.outputButton.classList.remove('is-on');
    ui.outputButton.setAttribute('aria-pressed', 'false');
    ui.outputButton.querySelector('strong').textContent = 'Output unavailable';
    ui.outputButton.querySelector('small').textContent = 'Connect to control';
  }
  updateActionStates();
  window.dispatchEvent(new CustomEvent('psu:connection', { detail: { mode, connected: online, transport: state.transport } }));
}

function renderTelemetry() {
  const d = state.device;
  ui.voltageReading.textContent = d.voltageOut.toFixed(2);
  ui.currentReading.textContent = d.currentOut.toFixed(3);
  ui.powerReading.textContent = d.powerOut.toFixed(2);
  ui.inputReading.textContent = `${d.voltageIn.toFixed(2)} V`;
  ui.voltageSetReadout.textContent = `${d.voltageSet.toFixed(2)} V`;
  ui.currentSetReadout.textContent = `${d.currentSet.toFixed(3)} A`;
  ui.chartVoltageNow.textContent = `${d.voltageOut.toFixed(2)} V`;
  ui.chartCurrentNow.textContent = `${d.currentOut.toFixed(3)} A`;
  ui.chartPowerNow.textContent = `${d.powerOut.toFixed(2)} W`;
  ui.modeBadge.textContent = d.cvcc === 1 ? 'CC' : 'CV';
  ui.outputStateLabel.textContent = d.output ? 'Output on' : 'Output off';
  ui.protectionReadout.textContent = protectionLabels[d.protection] || `Code ${d.protection}`;
  ui.protectionReadout.classList.toggle('is-alert', d.protection !== 0);
  updateOutputButton();
  ui.lastSample.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  drawCharts();
}

function syncStagedToDevice() {
  state.staged.voltage = state.device.voltageSet;
  state.staged.current = state.device.currentSet;
  state.dirty = false;
  renderSetpoints();
}

function stageSetpoint(kind, rawValue) {
  const limits = kind === 'voltage' ? [0.5, 40] : [0, 15];
  const places = kind === 'voltage' ? 2 : 3;
  const value = roundTo(clamp(Number(rawValue) || 0, ...limits), places);
  state.staged[kind] = value;
  state.dirty = Math.abs(state.staged.voltage - state.device.voltageSet) >= 0.005
    || Math.abs(state.staged.current - state.device.currentSet) >= 0.0005;
  renderSetpoints();
}

function renderSetpoints() {
  const { voltage, current } = state.staged;
  ui.voltageInput.value = voltage.toFixed(2);
  ui.currentInput.value = current.toFixed(3);
  ui.voltageDialValue.textContent = voltage.toFixed(2);
  ui.currentDialValue.textContent = current.toFixed(3);
  ui.voltageDial.setAttribute('aria-valuenow', voltage.toFixed(2));
  ui.currentDial.setAttribute('aria-valuenow', current.toFixed(3));
  const voltageArc = (voltage - 0.5) / 39.5 * 270;
  const currentArc = current / 15 * 270;
  ui.voltageDial.style.setProperty('--angle', `${-135 + voltageArc}deg`);
  ui.currentDial.style.setProperty('--angle', `${-135 + currentArc}deg`);
  ui.voltageDial.style.setProperty('--arc', `${voltageArc}deg`);
  ui.currentDial.style.setProperty('--arc', `${currentArc}deg`);
  const envelope = voltage * current;
  const overLimit = envelope > 150;
  ui.setpointPower.textContent = `${envelope.toFixed(1)} W`;
  ui.envelopeFill.style.width = `${Math.min(100, envelope / 150 * 100)}%`;
  ui.envelopeFill.style.background = overLimit ? 'var(--red)' : '';
  ui.envelopeNote.textContent = overLimit
    ? 'This combination exceeds the 150 W rated envelope.'
    : 'Within the 150 W rated envelope.';
  ui.envelopeNote.classList.toggle('is-alert', overLimit);
  ui.pendingPill.textContent = state.dirty ? 'Pending changes' : state.connected ? 'Synced' : 'Local values';
  ui.pendingPill.classList.toggle('is-pending', state.dirty);
  updateActionStates();
}

function updateActionStates() {
  const overLimit = state.staged.voltage * state.staged.current > 150;
  ui.applyButton.disabled = !state.connected || state.readOnly || !state.dirty || overLimit;
  ui.outputButton.disabled = !state.connected || state.readOnly;
  ui.recallButton.disabled = !state.connected || state.readOnly;
}

function updateOutputButton() {
  const on = state.device.output;
  ui.outputButton.classList.toggle('is-on', on);
  ui.outputButton.setAttribute('aria-pressed', String(on));
  ui.outputButton.querySelector('strong').textContent = on ? 'Output enabled' : 'Output disabled';
  ui.outputButton.querySelector('small').textContent = on ? 'Hold to switch off' : 'Hold to switch on';
}

function addSample() {
  const timestamp = Date.now();
  const sample = {
    timestamp,
    voltage: state.device.voltageOut,
    current: state.device.currentOut,
    power: state.device.powerOut,
    inputVoltage: state.device.voltageIn,
    internalTemp: state.device.internalTemp,
    externalTemp: state.device.externalTemp,
    ah: state.device.ah,
    wh: state.device.wh,
    mode: state.device.cvcc === 1 ? 'CC' : 'CV',
    output: state.device.output,
    protection: state.device.protection,
  };
  state.samples.push(sample);
  const cutoff = timestamp - MAX_SAMPLE_AGE_MS - 5000;
  while (state.samples[0]?.timestamp < cutoff) state.samples.shift();
  window.dispatchEvent(new CustomEvent('psu:sample', { detail: { sample, device: { ...state.device } } }));
}

function drawGrid(context, width, height) {
  context.strokeStyle = 'rgba(145, 172, 182, .10)';
  context.lineWidth = 1;
  for (let row = 1; row < 4; row += 1) {
    const y = (height / 4) * row;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
  for (let column = 1; column < 6; column += 1) {
    const x = (width / 6) * column;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
}

function drawChart(canvas, key, color, unit, decimals, minimumSpan, minLabel, maxLabel) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
  }
  const context = canvas.getContext('2d');
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  drawGrid(context, width, height);

  const now = Date.now();
  const start = now - state.rangeSeconds * 1000;
  const visible = state.samples.filter((sample) => sample.timestamp >= start);
  if (!visible.length) {
    context.fillStyle = 'rgba(143, 165, 174, .66)';
    context.font = '12px Inter, system-ui, sans-serif';
    context.textAlign = 'center';
    context.fillText('Connect to begin recording', width / 2, height / 2 + 4);
    minLabel.textContent = `— ${unit}`;
    maxLabel.textContent = `— ${unit}`;
    return;
  }

  const values = visible.map((sample) => sample[key]);
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (max - min < minimumSpan) {
    const center = (max + min) / 2;
    min = Math.max(0, center - minimumSpan / 2);
    max = center + minimumSpan / 2;
  } else {
    const padding = (max - min) * 0.12;
    min = Math.max(0, min - padding);
    max += padding;
  }
  minLabel.textContent = `${min.toFixed(decimals)} ${unit}`;
  maxLabel.textContent = `${max.toFixed(decimals)} ${unit}`;

  const xFor = (sample) => ((sample.timestamp - start) / (state.rangeSeconds * 1000)) * width;
  const yFor = (value) => height - ((value - min) / (max - min || 1)) * (height - 12) - 6;
  const gradient = context.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, `${color}35`);
  gradient.addColorStop(1, `${color}00`);

  context.beginPath();
  visible.forEach((sample, index) => {
    const x = xFor(sample);
    const y = yFor(sample[key]);
    if (index === 0) context.moveTo(x, y);
    else context.lineTo(x, y);
  });
  if (visible.length === 1) {
    const point = visible[0];
    context.lineTo(xFor(point) + 1, yFor(point[key]));
  }
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.shadowColor = `${color}55`;
  context.shadowBlur = 8;
  context.stroke();
  context.shadowBlur = 0;

  const finalPoint = visible.at(-1);
  context.lineTo(xFor(finalPoint), height);
  context.lineTo(xFor(visible[0]), height);
  context.closePath();
  context.fillStyle = gradient;
  context.fill();
}

function drawCharts() {
  drawChart(ui.voltageChart, 'voltage', '#5ee7d0', 'V', 2, 0.2, ui.voltageMin, ui.voltageMax);
  drawChart(ui.currentChart, 'current', '#70c8ff', 'A', 3, 0.01, ui.currentMin, ui.currentMax);
  drawChart(ui.powerChart, 'power', '#f5b95f', 'W', 2, 0.1, ui.powerMin, ui.powerMax);
}

function toast(message, error = false) {
  const item = document.createElement('div');
  item.className = `toast${error ? ' is-error' : ''}`;
  item.textContent = message;
  ui.toastRegion.append(item);
  window.setTimeout(() => item.remove(), 4400);
}

function renderPresets(category = 'bench') {
  ui.presetGrid.replaceChildren();
  presets[category].forEach((preset) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preset-button';
    button.innerHTML = `<strong>${preset.label}</strong><small>${preset.voltage.toFixed(2)} V · ${preset.current.toFixed(3)} A</small>`;
    button.addEventListener('click', () => {
      stageSetpoint('voltage', preset.voltage);
      stageSetpoint('current', preset.current);
      toast(`${preset.label} loaded. Review the values, then apply.`);
    });
    ui.presetGrid.append(button);
  });
  ui.chargeNote.classList.toggle('hidden', category !== 'charge');
}

function buildMemorySlots() {
  ui.memorySlots.replaceChildren();
  for (let index = 0; index <= 10; index += 1) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `memory-slot${index === state.selectedMemory ? ' active' : ''}`;
    button.textContent = `M${index}`;
    button.addEventListener('click', () => {
      state.selectedMemory = index;
      buildMemorySlots();
    });
    ui.memorySlots.append(button);
  }
}

function bindDial(element, input, kind, min, max, fineStep) {
  let dragStartY = 0;
  let dragStartValue = 0;
  const adjust = (delta) => stageSetpoint(kind, clamp(state.staged[kind] + delta, min, max));

  element.addEventListener('pointerdown', (event) => {
    dragStartY = event.clientY;
    dragStartValue = state.staged[kind];
    element.setPointerCapture(event.pointerId);
  });
  element.addEventListener('pointermove', (event) => {
    if (!element.hasPointerCapture(event.pointerId)) return;
    const scale = event.shiftKey ? 0.1 : 1;
    const delta = ((dragStartY - event.clientY) / 160) * (max - min) * scale;
    stageSetpoint(kind, dragStartValue + delta);
  });
  element.addEventListener('wheel', (event) => {
    event.preventDefault();
    const multiplier = event.shiftKey ? 1 : 5;
    adjust((event.deltaY < 0 ? 1 : -1) * fineStep * multiplier);
  }, { passive: false });
  element.addEventListener('keydown', (event) => {
    if (!['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') stageSetpoint(kind, min);
    else if (event.key === 'End') stageSetpoint(kind, max);
    else adjust((['ArrowUp', 'ArrowRight'].includes(event.key) ? 1 : -1) * fineStep * (event.shiftKey ? 10 : 1));
  });
  input.addEventListener('change', () => stageSetpoint(kind, input.value));
}

let holdTimer = null;
function beginOutputHold() {
  if (!state.connected || holdTimer) return;
  ui.outputButton.classList.add('is-holding');
  holdTimer = window.setTimeout(async () => {
    holdTimer = null;
    ui.outputButton.classList.remove('is-holding');
    const next = state.device.output ? 0 : 1;
    try {
      await enqueue(() => writeSingle(register.output, next));
      await enqueue(pollDevice);
      toast(`Output switched ${next ? 'on' : 'off'}.`);
    } catch (error) {
      toast(error.message, true);
    }
  }, 900);
}

function cancelOutputHold() {
  window.clearTimeout(holdTimer);
  holdTimer = null;
  ui.outputButton.classList.remove('is-holding');
}

async function applyStagedSetpoints() {
  return setSetpoints(state.staged.voltage, state.staged.current);
}

async function setSetpoints(voltageValue, currentValue) {
  const voltageNumber = roundTo(Number(voltageValue), 2);
  const currentNumber = roundTo(Number(currentValue), 3);
  if (voltageNumber < 0.5 || voltageNumber > 40 || currentNumber < 0 || currentNumber > 15) throw new Error('Setpoints are outside the supported range.');
  const voltage = Math.round(voltageNumber * VOLTAGE_SCALE);
  const current = Math.round(currentNumber * CURRENT_SCALE);
  if (!state.connected) throw new Error('Connect the PSU before applying setpoints.');
  if (voltageNumber * currentNumber > 150) throw new Error('The requested values exceed the 150 W rated envelope.');
  ui.applyButton.disabled = true;
  await enqueue(() => writeMultiple(register.voltageSet, [voltage, current]));
  state.staged.voltage = voltageNumber;
  state.staged.current = currentNumber;
  state.dirty = false;
  await enqueue(pollDevice);
  renderSetpoints();
  return { voltage: state.device.voltageSet, current: state.device.currentSet };
}

async function setOutputEnabled(enabled) {
  if (!state.connected) throw new Error('Connect the PSU before switching its output.');
  await enqueue(() => writeSingle(register.output, enabled ? 1 : 0));
  await enqueue(pollDevice);
  return { enabled: state.device.output };
}

function registerWebMcpTools() {
  const context = document.modelContext;
  if (!context?.registerTool) return;
  const registerTool = (tool) => {
    try {
      void Promise.resolve(context.registerTool(tool)).catch((error) => console.warn('WebMCP registration failed', error));
    } catch (error) {
      console.warn('WebMCP registration failed', error);
    }
  };

  registerTool({
    name: 'read_psu_status',
    title: 'Read PSU status',
    description: 'Read the current connection, output measurements, setpoints, mode, and protection state without changing the PSU.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute() {
      if (!state.connected) {
        return {
          connected: false,
          stagedVoltage: state.staged.voltage,
          stagedCurrent: state.staged.current,
        };
      }
      return {
        connected: state.connected,
        voltageOut: state.device.voltageOut,
        currentOut: state.device.currentOut,
        powerOut: state.device.powerOut,
        inputVoltage: state.device.voltageIn,
        voltageSet: state.device.voltageSet,
        currentSet: state.device.currentSet,
        mode: state.device.cvcc === 1 ? 'CC' : 'CV',
        outputEnabled: state.device.output,
        protection: protectionLabels[state.device.protection] || `Code ${state.device.protection}`,
      };
    },
  });

  registerTool({
    name: 'stage_psu_setpoints',
    title: 'Stage PSU setpoints',
    description: 'Stage voltage and current values in the visible interface for review. This does not write to the PSU.',
    inputSchema: {
      type: 'object',
      properties: {
        voltage: { type: 'number', minimum: 0.5, maximum: 40 },
        current: { type: 'number', minimum: 0, maximum: 15 },
      },
      required: ['voltage', 'current'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute(input) {
      if (!input || !Number.isFinite(input.voltage) || !Number.isFinite(input.current)) throw new Error('Voltage and current must be numbers.');
      if (input.voltage < 0.5 || input.voltage > 40 || input.current < 0 || input.current > 15) throw new Error('Setpoints are outside the supported range.');
      if (input.voltage * input.current > 150) throw new Error('The requested combination exceeds the 150 W rated envelope.');
      stageSetpoint('voltage', input.voltage);
      stageSetpoint('current', input.current);
      return { staged: true, voltage: state.staged.voltage, current: state.staged.current };
    },
  });

  registerTool({
    name: 'apply_psu_setpoints',
    title: 'Apply staged PSU setpoints',
    description: 'Write the currently staged voltage and current values to the connected PSU.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute() {
      return applyStagedSetpoints();
    },
  });

  registerTool({
    name: 'set_psu_output',
    title: 'Set PSU output state',
    description: 'Explicitly enable or disable the connected PSU output.',
    inputSchema: {
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    async execute(input) {
      if (!input || typeof input.enabled !== 'boolean') throw new Error('enabled must be true or false.');
      return setOutputEnabled(input.enabled);
    },
  });
}

ui.connectButton.addEventListener('click', () => state.connected ? disconnect() : connect());

ui.applyButton.addEventListener('click', async () => {
  try {
    await applyStagedSetpoints();
    toast(`Setpoints applied: ${state.staged.voltage.toFixed(2)} V / ${state.staged.current.toFixed(3)} A.`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    renderSetpoints();
  }
});

ui.outputButton.addEventListener('pointerdown', beginOutputHold);
['pointerup', 'pointercancel', 'pointerleave'].forEach((eventName) => ui.outputButton.addEventListener(eventName, cancelOutputHold));
ui.outputButton.addEventListener('keydown', (event) => {
  if (event.key === ' ' || event.key === 'Enter') beginOutputHold();
});
ui.outputButton.addEventListener('keyup', cancelOutputHold);

ui.recallButton.addEventListener('click', async () => {
  if (state.device.output && !window.confirm(`Output is currently enabled. Recall device memory M${state.selectedMemory}?`)) return;
  try {
    await enqueue(() => writeSingle(register.memory, state.selectedMemory));
    state.dirty = false;
    await new Promise((resolve) => window.setTimeout(resolve, 120));
    await enqueue(pollDevice);
    toast(`Device memory M${state.selectedMemory} recalled.`);
  } catch (error) {
    toast(error.message, true);
  }
});

document.querySelectorAll('[data-range]').forEach((button) => {
  button.addEventListener('click', () => {
    state.rangeSeconds = Number(button.dataset.range);
    document.querySelectorAll('[data-range]').forEach((item) => item.classList.toggle('active', item === button));
    drawCharts();
  });
});

document.querySelectorAll('[data-preset-tab]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-preset-tab]').forEach((item) => item.classList.toggle('active', item === button));
    renderPresets(button.dataset.presetTab);
  });
});

bindDial(ui.voltageDial, ui.voltageInput, 'voltage', 0.5, 40, 0.01);
bindDial(ui.currentDial, ui.currentInput, 'current', 0, 15, 0.001);
window.addEventListener('resize', drawCharts);
if ('serial' in navigator) {
  navigator.serial.addEventListener('disconnect', (event) => {
    if (event.target === state.port) {
      disconnect(false);
      toast('The serial device was unplugged.', true);
    }
  });
}

renderPresets();
buildMemorySlots();
renderSetpoints();
drawCharts();
setConnectionUi('offline');
registerWebMcpTools();

window.psuConsole = {
  state,
  register,
  protectionLabels,
  constants: { MODBUS_ADDRESS, BAUD_RATE, VOLTAGE_SCALE, CURRENT_SCALE },
  enqueue,
  readRegisters,
  writeSingle,
  writeMultiple,
  pollDevice,
  drawCharts,
  stageSetpoint,
  setSetpoints,
  setOutputEnabled,
  toast,
  disconnect,
};

void import('./features.js').catch((error) => {
  console.error('Extended console features failed to load', error);
  toast('Some extended controls could not be loaded.', true);
});
