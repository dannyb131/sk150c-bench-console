# ESP32-C3 SK150C Wi-Fi bridge

This PlatformIO firmware carries the dashboard's binary Modbus RTU requests over Wi-Fi to the SK150C UART. It provides an HTTP bridge, diagnostic status, a setup portal, and password-protected browser/PlatformIO OTA updates.

## Wiring

| ESP32-C3 | SK150C serial |
|---|---|
| GPIO5 (RX) | TX |
| GPIO4 (TX) | RX |
| GND | GND |

Leave the SK150C `+5V` pin disconnected when the ESP32 is powered separately. GPIO0, GPIO1, GPIO2, GPIO10, GPIO20 and GPIO21 are deliberately not used.

> [!CAUTION]
> Confirm the SK150C signal level before direct connection. ESP32-C3 GPIO is not 5 V tolerant; use a level shifter or a suitable divider on the PSU TX to ESP RX path if it measures 5 V.

## Build and first upload

```powershell
pio run
pio run --target upload
pio device monitor --baud 115200
```

The target is `esp32-c3-devkitm-1`. Change `upload_port` on the command line if PlatformIO cannot select the correct serial port automatically.

On first boot:

1. Join the open **SK150C-Setup** Wi-Fi network.
2. Open `http://192.168.4.1`.
3. Enter the normal 2.4 GHz Wi-Fi name and password.
4. Create a bridge/update token of at least 12 characters.
5. Save and allow the board to restart.

The default mDNS address is `http://sk150c.local`.

## Dashboard setup

In the dashboard's **Device** view, select **ESP32 HTTP bridge**, enter `http://sk150c.local` and the same token, save the settings, then connect.

The bridge implements:

- `GET /api/status` — connection, IP, UART pin and OTA status
- `POST /api/modbus` — binary Modbus RTU frame in and binary reply out
- `GET /setup` — replace Wi-Fi credentials and the token
- `GET /update` — browser firmware updater

The UART is 115200 baud, 8-N-1. The HTTP endpoint checks frame length and Modbus CRC before forwarding a request. Error responses include received-byte diagnostics to distinguish wiring failures from corrupt serial replies.

Wi-Fi transmit power is limited with `WiFi.setTxPower(WIFI_POWER_8_5dBm)`.

## OTA updates

Build the firmware, open `http://sk150c.local/update`, choose `.pio/build/esp32-c3/firmware.bin`, enter the token and upload. The bridge validates the image, installs it and restarts.

Arduino/PlatformIO OTA is also available on port 3232. The OTA password is the bridge token. OTA remains disabled until a non-empty token has been configured.

If the saved network is unavailable, the bridge exposes **SK150C-Setup** and continues retrying the station connection every 30 seconds. The token-protected browser updater remains available in recovery mode at `http://192.168.4.1/update`, so a bad Wi-Fi configuration does not require opening the enclosure. The status endpoint includes `setupMode` and the numeric Arduino `wifiStatus` value for diagnostics.

## Security notes

- Wi-Fi credentials and the token are stored in ESP32 Preferences/NVS, not in source code.
- Modbus and firmware-update requests require the bearer token once configured.
- The setup page is intended for a trusted local network. Anyone who can reach it can replace the saved Wi-Fi settings and token; isolate the bridge on an appropriate LAN/VLAN if that matters for your installation.
