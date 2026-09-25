# bf888-field-programmer
Read and write Baofeng BF-888 channels and settings over USB serial.

## Use

1. Plug the cable into the radio (off), then USB-OTG into the phone.
2. **Connect cable** → pick the serial device → **Read radio**.
3. Edit 16 channels + settings → **Write radio**.
4. Export/Import JSON for backup; Download `.bin` for the raw 992-byte image.

## Safety

- Always **Read first**, backup JSON, then Write.
- BF-888 is UHF 400–490 MHz, 16ch, no keypad — a bad write just needs a re-write.
