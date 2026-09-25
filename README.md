# bf888-field-programmer
Read and write Baofeng BF-888 channels and settings over USB serial.

## Use

1. Plug the cable into the radio (off), then USB-OTG into the phone.
2. Android shows a system **"Choose an app for the USB device"** popup — this PWA can never appear there (Android only lists native apps). Always press **Cancel**.
3. In the PWA tap **Connect cable** → pick the serial device → **Read radio**.
4. Edit 16 channels + settings → **Write radio**.
5. Export/Import JSON for backup; Download `.bin` for the raw 992-byte image.

## Phone: empty serial list?

Expected on most Android phones. `navigator.serial.requestPort()` is Bluetooth-only on Android except Chrome 148+ with the new Android Serial API (limited devices, 2026+). USB UART bridges in Baofeng cables (`CH340` `1A86:7523`, `PL2303` `067B:2303` clones, `CP2102` `10C4:EA60`, `FTDI` `0403:6001`) usually do **not** appear.

Debug:

1. Press **Cancel** on the system USB popup (picking another app blocks Chrome).
2. In the PWA tap **Diagnose USB** — it lists WebUSB-visible devices as `VID:PID`. Nothing picked = Chrome cannot claim that chip / OTG / power issue.
3. Open `chrome://device-log` in Chrome to confirm plug events.
4. Identify the cable chip with a native app (e.g. Serial USB Terminal). `PL2303` clones are the most common failure.
5. Requirements: Chrome/Edge, HTTPS or localhost, OTG adapter, radio off when plugging.

Fallback (README hint in app): native serial app, or ESP32 USB-serial bridge, or a genuine FTDI/CP2102 cable. Laptop/desktop Chrome remains the reliable path.

## Safety

- Always **Read first**, backup JSON, then Write.
- BF-888 is UHF 400–490 MHz, 16ch, no keypad — a bad write just needs a re-write.
