# bf888-field-programmer
Read and write Baofeng BF-888 channels and settings over USB serial

<img width="766" height="522" alt="image" src="https://github.com/user-attachments/assets/57e351c2-fe65-4b52-b7a6-001e90933bb0" />


## Use

1. Plug the cable into the radio (off), then USB-OTG into the phone
2. Android shows a system **"Choose an app for the USB device"** popup. Always press **Cancel** or tap outside this dialog
3. Tap the **Connect** button → pick the serial device → **Read**
4. Edit 16 channels + settings → **Write**
5. Export/Import JSON for backup

## Safety

- Always **Read first**, backup JSON, then Write
- BF-888 is UHF 400–490 MHz, 16ch, no keypad — a bad write just needs a re-write

## Credits

- Android USB support uses a browser port of the Prolific PL2303 user-space driver from [tidepool-org/pl2303](https://github.com/tidepool-org/pl2303) (MIT, fork of andreasgal/usbserial). See `pl2303.js`
