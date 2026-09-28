#include <Arduino.h>
#include <ArduinoOTA.h>
#include <HWCDC.h>
#include <DNSServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <Update.h>
#include <WebServer.h>
#include <WiFi.h>

#include <vector>

#ifndef PSU_UART_RX_PIN
#define PSU_UART_RX_PIN 5
#endif

#ifndef PSU_UART_TX_PIN
#define PSU_UART_TX_PIN 4
#endif

namespace {

constexpr uint32_t kPsuBaud = 115200;
constexpr uint32_t kUsbBaud = 115200;
constexpr uint32_t kWifiConnectTimeoutMs = 20000;
constexpr uint32_t kWifiRetryIntervalMs = 30000;
constexpr uint32_t kPsuReplyTimeoutMs = 700;
constexpr uint32_t kModbusSilentIntervalUs = 1000;
constexpr size_t kMaximumFrameBytes = 255;
constexpr char kHostname[] = "sk150c";
constexpr char kSetupSsid[] = "SK150C-Setup";

HardwareSerial psuSerial(1);
WebServer server(80);
DNSServer dnsServer;
Preferences preferences;

bool setupPortalActive = false;
bool mdnsActive = false;
bool otaEnabled = false;
bool arduinoOtaStarted = false;
uint32_t restartAt = 0;
uint32_t nextWifiRetryAt = 0;
String wifiSsid;
String wifiPassword;
String bridgeToken;
std::vector<uint8_t> modbusRequestBody;
std::vector<uint8_t> lastPsuReply;
bool firmwareUploadAuthorised = false;
bool firmwareUploadSucceeded = false;
String firmwareUploadError;

const char kSetupPage[] PROGMEM = R"HTML(
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SK150C bridge setup</title><style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#071116;color:#e8f2f3}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;box-sizing:border-box}.card{width:min(440px,100%);padding:28px;border:1px solid #1d3941;border-radius:18px;background:#0b1a21;box-shadow:0 20px 60px #0007}p{color:#91a8af;line-height:1.5}label{display:grid;gap:7px;margin:16px 0;font-size:.85rem;color:#b9c9cd}input{border:1px solid #29464e;border-radius:10px;padding:12px;background:#071116;color:#fff;font:inherit}button{width:100%;border:0;border-radius:10px;padding:13px;background:#5ee7d0;color:#041512;font-weight:800;cursor:pointer}.meta{margin-top:18px;padding-top:16px;border-top:1px solid #193039;font-size:.78rem}code{color:#ffb270}</style></head>
<body><main class="card"><h1>SK150C Wi-Fi bridge</h1><p>Enter the Wi-Fi details the bridge should use. They are stored only on this ESP32-C3.</p>
<form method="post" action="/api/wifi"><label>Wi-Fi name<input name="ssid" maxlength="32" required></label><label>Password<input name="password" type="password" maxlength="64"></label><label>Bridge and firmware-update token<input name="token" type="password" minlength="12" maxlength="64" required placeholder="At least 12 characters"></label><button type="submit">Save and restart</button></form>
<p class="meta">PSU UART: <code>RX GPIO5</code> · <code>TX GPIO4</code> · 115200 baud<br>Bridge address after connection: <code>http://sk150c.local</code><br>Recovery firmware updates: <code>/update</code> (also available from setup mode)</p></main></body></html>
)HTML";

const char kUpdatePage[] PROGMEM = R"HTML(
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SK150C firmware update</title><style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif;background:#071116;color:#e8f2f3}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;box-sizing:border-box}.card{width:min(440px,100%);padding:28px;border:1px solid #1d3941;border-radius:18px;background:#0b1a21;box-shadow:0 20px 60px #0007}p{color:#91a8af;line-height:1.5}label{display:grid;gap:7px;margin:16px 0;font-size:.85rem;color:#b9c9cd}input{border:1px solid #29464e;border-radius:10px;padding:12px;background:#071116;color:#fff;font:inherit}button{width:100%;border:0;border-radius:10px;padding:13px;background:#5ee7d0;color:#041512;font-weight:800;cursor:pointer}#status{min-height:24px;color:#ffb270}</style></head>
<body><main class="card"><h1>Firmware update</h1><p>Upload the <strong>firmware.bin</strong> produced for this ESP32-C3. Keep the board powered and do not close this page until the upload completes.</p>
<form id="updateForm"><label>Firmware file<input name="firmware" type="file" accept=".bin,application/octet-stream" required></label><label>Bridge token, if configured<input id="token" type="password" autocomplete="off"></label><button type="submit">Upload and restart</button></form><p id="status"></p></main>
<script>updateForm.onsubmit=async(e)=>{e.preventDefault();const b=e.submitter,s=document.querySelector('#status'),h={};if(token.value)h.Authorization='Bearer '+token.value;b.disabled=true;s.textContent='Uploading…';try{const r=await fetch('/api/update',{method:'POST',headers:h,body:new FormData(updateForm)});s.textContent=await r.text();if(!r.ok)b.disabled=false}catch(x){s.textContent='Upload failed: '+x.message;b.disabled=false}}</script></body></html>
)HTML";

uint16_t modbusCrc(const uint8_t* bytes, size_t length) {
  uint16_t crc = 0xffff;
  for (size_t index = 0; index < length; ++index) {
    crc ^= bytes[index];
    for (uint8_t bit = 0; bit < 8; ++bit) {
      crc = (crc & 1U) ? static_cast<uint16_t>((crc >> 1U) ^ 0xa001U) : static_cast<uint16_t>(crc >> 1U);
    }
  }
  return crc;
}

bool hasValidCrc(const uint8_t* frame, size_t length) {
  if (length < 4) return false;
  const uint16_t expected = modbusCrc(frame, length - 2);
  return frame[length - 2] == static_cast<uint8_t>(expected & 0xffU) &&
         frame[length - 1] == static_cast<uint8_t>((expected >> 8U) & 0xffU);
}

void addCorsHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  server.sendHeader("Access-Control-Allow-Private-Network", "true");
  server.sendHeader("Access-Control-Max-Age", "600");
}

void sendText(int status, const String& contentType, const String& body) {
  addCorsHeaders();
  server.send(status, contentType, body);
}

bool requestIsAuthorised() {
  if (bridgeToken.isEmpty()) return true;
  return server.header("Authorization") == String("Bearer ") + bridgeToken;
}

bool updateRequestIsAuthorised() {
  return !bridgeToken.isEmpty() && server.header("Authorization") == String("Bearer ") + bridgeToken;
}

size_t expectedReplyLength(const std::vector<uint8_t>& reply) {
  if (reply.size() < 2) return 0;
  if ((reply[1] & 0x80U) != 0) return 5;
  if (reply[1] == 0x03U) return reply.size() >= 3 ? static_cast<size_t>(reply[2]) + 5U : 0;
  if (reply[1] == 0x06U || reply[1] == 0x10U) return 8;
  return 0;
}

bool exchangeWithPsu(const uint8_t* request, size_t requestLength, std::vector<uint8_t>& reply) {
  while (psuSerial.available() > 0) psuSerial.read();
  // Modbus RTU requires a silent bus interval of at least 3.5 characters
  // between frames. One millisecond is comfortably above that at 115200 baud.
  delayMicroseconds(kModbusSilentIntervalUs);
  psuSerial.write(request, requestLength);
  psuSerial.flush();

  reply.clear();
  reply.reserve(kMaximumFrameBytes);
  const uint32_t started = millis();
  while (millis() - started < kPsuReplyTimeoutMs) {
    while (psuSerial.available() > 0 && reply.size() < kMaximumFrameBytes) {
      reply.push_back(static_cast<uint8_t>(psuSerial.read()));
    }
    const size_t expected = expectedReplyLength(reply);
    if (expected > 0 && reply.size() >= expected) {
      reply.resize(expected);
      return hasValidCrc(reply.data(), reply.size());
    }
    delay(1);
  }
  lastPsuReply = reply;
  return false;
}

String bytesAsHex(const std::vector<uint8_t>& bytes) {
  static constexpr char digits[] = "0123456789ABCDEF";
  String result;
  result.reserve(bytes.size() * 2U);
  for (const uint8_t byte : bytes) {
    result += digits[byte >> 4U];
    result += digits[byte & 0x0fU];
  }
  return result;
}

void handleModbusOptions() {
  addCorsHeaders();
  server.send(204, "text/plain", "");
}

void collectModbusBody() {
  HTTPRaw& raw = server.raw();
  if (raw.status == RAW_START) {
    modbusRequestBody.clear();
    modbusRequestBody.reserve(kMaximumFrameBytes);
    return;
  }
  if (raw.status == RAW_WRITE) {
    if (modbusRequestBody.size() + raw.currentSize > kMaximumFrameBytes) {
      modbusRequestBody.clear();
      return;
    }
    modbusRequestBody.insert(modbusRequestBody.end(), raw.buf, raw.buf + raw.currentSize);
    return;
  }
  if (raw.status == RAW_ABORTED) modbusRequestBody.clear();
}

void handleModbus() {
  if (!requestIsAuthorised()) {
    sendText(401, "application/json", "{\"error\":\"Invalid bridge token\"}");
    return;
  }

  if (modbusRequestBody.size() < 4 || modbusRequestBody.size() > kMaximumFrameBytes) {
    sendText(400, "application/json", "{\"error\":\"Invalid Modbus frame length\"}");
    return;
  }

  if (!hasValidCrc(modbusRequestBody.data(), modbusRequestBody.size())) {
    sendText(400, "application/json", "{\"error\":\"Invalid Modbus CRC\"}");
    return;
  }

  std::vector<uint8_t> reply;
  if (!exchangeWithPsu(modbusRequestBody.data(), modbusRequestBody.size(), reply)) {
    String body = "{\"error\":\"The PSU did not return a valid reply\",\"uart\":{\"received\":";
    body += String(lastPsuReply.size());
    body += ",\"bytes\":\"";
    body += bytesAsHex(lastPsuReply);
    body += "\"}}";
    sendText(504, "application/json", body);
    return;
  }

  String payload;
  payload.reserve(reply.size());
  for (const uint8_t byte : reply) payload.concat(static_cast<char>(byte));
  addCorsHeaders();
  server.send(200, "application/octet-stream", payload);
}

void handleStatus() {
  String body = "{\"device\":\"ESP32-C3\",\"hostname\":\"sk150c.local\",\"connected\":";
  body += WiFi.status() == WL_CONNECTED ? "true" : "false";
  body += ",\"ip\":\"";
  body += WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : WiFi.softAPIP().toString();
  body += "\",\"setupMode\":";
  body += setupPortalActive ? "true" : "false";
  body += ",\"wifiStatus\":" + String(static_cast<int>(WiFi.status()));
  body += ",\"uart\":{\"rx\":" + String(PSU_UART_RX_PIN) + ",\"tx\":" + String(PSU_UART_TX_PIN) + ",\"baud\":115200},\"wifiPowerDbm\":19.5,\"ota\":";
  body += otaEnabled ? "true" : "false";
  body += ",\"updatePath\":\"/update\"}";
  sendText(200, "application/json", body);
}

void handleFirmwareUpload() {
  HTTPUpload& upload = server.upload();
  if (upload.status == UPLOAD_FILE_START) {
    firmwareUploadAuthorised = updateRequestIsAuthorised();
    firmwareUploadSucceeded = false;
    firmwareUploadError = "";
    if (!firmwareUploadAuthorised) return;
    if (!Update.begin(UPDATE_SIZE_UNKNOWN, U_FLASH)) firmwareUploadError = Update.errorString();
    return;
  }
  if (!firmwareUploadAuthorised || !firmwareUploadError.isEmpty()) return;
  if (upload.status == UPLOAD_FILE_WRITE) {
    if (Update.write(upload.buf, upload.currentSize) != upload.currentSize) firmwareUploadError = Update.errorString();
    return;
  }
  if (upload.status == UPLOAD_FILE_END) {
    if (!Update.end(true)) firmwareUploadError = Update.errorString();
    else firmwareUploadSucceeded = true;
    return;
  }
  if (upload.status == UPLOAD_FILE_ABORTED) {
    Update.abort();
    firmwareUploadError = "Upload aborted";
  }
}

void handleFirmwareUpdateResult() {
  if (!firmwareUploadAuthorised) {
    sendText(401, "text/plain", "Invalid bridge token.");
    return;
  }
  if (!firmwareUploadSucceeded) {
    sendText(500, "text/plain", firmwareUploadError.isEmpty() ? "Firmware update failed." : firmwareUploadError);
    return;
  }
  sendText(200, "text/plain", "Firmware installed successfully. The bridge is restarting…");
  restartAt = millis() + 1500;
}

void handleSaveWifi() {
  const String ssid = server.arg("ssid");
  const String token = server.arg("token");
  if (ssid.isEmpty() || token.length() < 12) {
    sendText(400, "text/plain", "Wi-Fi name and a bridge token of at least 12 characters are required.");
    return;
  }
  preferences.begin("sk150c", false);
  preferences.putString("ssid", ssid);
  preferences.putString("password", server.arg("password"));
  preferences.putString("token", token);
  preferences.end();
  sendText(200, "text/html", "<!doctype html><meta name=viewport content='width=device-width'><body style='font-family:system-ui;background:#071116;color:#e8f2f3;padding:30px'><h1>Saved</h1><p>The bridge is restarting and will join your Wi-Fi.</p></body>");
  restartAt = millis() + 1200;
}

void startSetupPortal() {
  WiFi.mode(WIFI_AP_STA);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);
  WiFi.softAP(kSetupSsid);
  dnsServer.start(53, "*", WiFi.softAPIP());
  setupPortalActive = true;
  nextWifiRetryAt = millis() + kWifiRetryIntervalMs;
  Serial.printf("Setup Wi-Fi: connect to %s and open http://%s\n", kSetupSsid, WiFi.softAPIP().toString().c_str());
}

void startConnectedServices() {
  if (setupPortalActive) {
    dnsServer.stop();
    WiFi.softAPdisconnect(true);
    setupPortalActive = false;
  }
  WiFi.setTxPower(WIFI_POWER_19_5dBm);
  if (!mdnsActive) {
    mdnsActive = MDNS.begin(kHostname);
    if (mdnsActive) MDNS.addService("http", "tcp", 80);
  }
  if (otaEnabled && !arduinoOtaStarted) {
    ArduinoOTA.setHostname(kHostname);
    ArduinoOTA.setPassword(bridgeToken.c_str());
    ArduinoOTA.begin();
    arduinoOtaStarted = true;
  }
  Serial.printf("Bridge ready: http://%s.local (%s)\n", kHostname, WiFi.localIP().toString().c_str());
}

void retryWifiIfNeeded() {
  if (!setupPortalActive) return;
  if (WiFi.status() == WL_CONNECTED) {
    startConnectedServices();
    return;
  }
  if (wifiSsid.isEmpty() || static_cast<int32_t>(millis() - nextWifiRetryAt) < 0) return;
  Serial.printf("Retrying Wi-Fi connection to %s\n", wifiSsid.c_str());
  WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
  nextWifiRetryAt = millis() + kWifiRetryIntervalMs;
}

void configureWebServer() {
  const char* headers[] = {"Authorization"};
  server.collectHeaders(headers, 1);
  server.on("/", HTTP_GET, [] { server.send_P(200, "text/html", kSetupPage); });
  server.on("/update", HTTP_GET, [] {
    if (!otaEnabled) {
      sendText(403, "text/plain", "Firmware updates are disabled until a bridge token is configured at /setup.");
      return;
    }
    server.send_P(200, "text/html", kUpdatePage);
  });
  server.on("/setup", HTTP_GET, [] { server.send_P(200, "text/html", kSetupPage); });
  server.on("/api/status", HTTP_GET, handleStatus);
  server.on("/api/wifi", HTTP_POST, handleSaveWifi);
  server.on("/api/update", HTTP_POST, handleFirmwareUpdateResult, handleFirmwareUpload);
  server.on("/api/modbus", HTTP_OPTIONS, handleModbusOptions);
  server.on("/api/modbus", HTTP_POST, handleModbus, collectModbusBody);
  server.onNotFound([] {
    if (setupPortalActive) {
      server.sendHeader("Location", "/", true);
      server.send(302, "text/plain", "");
      return;
    }
    sendText(404, "application/json", "{\"error\":\"Not found\"}");
  });
  server.begin();
}

void connectWifi() {
  preferences.begin("sk150c", false);
  wifiSsid = preferences.isKey("ssid") ? preferences.getString("ssid") : String();
  wifiPassword = preferences.isKey("password") ? preferences.getString("password") : String();
  bridgeToken = preferences.isKey("token") ? preferences.getString("token") : String();
  preferences.end();
  otaEnabled = !bridgeToken.isEmpty();

  WiFi.mode(WIFI_STA);
  WiFi.setHostname(kHostname);
  WiFi.setTxPower(WIFI_POWER_19_5dBm);
  WiFi.setAutoReconnect(true);
  if (!wifiSsid.isEmpty()) {
    WiFi.begin(wifiSsid.c_str(), wifiPassword.c_str());
    const uint32_t started = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - started < kWifiConnectTimeoutMs) delay(100);
  }

  if (WiFi.status() == WL_CONNECTED) {
    startConnectedServices();
  } else {
    startSetupPortal();
  }
}

}  // namespace

void setup() {
  Serial.begin(kUsbBaud);
  delay(300);
  Serial.printf("SK150C bridge starting; PSU RX=GPIO%d, TX=GPIO%d\n", PSU_UART_RX_PIN, PSU_UART_TX_PIN);
  psuSerial.begin(kPsuBaud, SERIAL_8N1, PSU_UART_RX_PIN, PSU_UART_TX_PIN);
  connectWifi();
  configureWebServer();
}

void loop() {
  if (setupPortalActive) dnsServer.processNextRequest();
  retryWifiIfNeeded();
  if (arduinoOtaStarted && WiFi.status() == WL_CONNECTED) ArduinoOTA.handle();
  server.handleClient();
  if (restartAt != 0 && static_cast<int32_t>(millis() - restartAt) >= 0) ESP.restart();
  delay(1);
}
