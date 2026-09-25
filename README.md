# bf888-field-programmer
Read and write Baofeng BF-888 channels and settings over USB serial

## Use

1. Plug the cable into the radio (off), then USB-OTG into the phone
2. Android shows a system **"Choose an app for the USB device"** popup. Always press **Cancel** or tap outside this dialog
3. Tap the **Connect** button → pick the serial device → **Read**
4. Edit 16 channels + settings → **Write**
5. Export/Import JSON for backup

## Safety

- Always **Read first**, backup JSON, then Write
- BF-888 is UHF 400–490 MHz, 16ch, no keypad — a bad write just needs a re-write
