/*
  Proper DA7 configuration is required in order for this controller script to work.

  In the DA7's MIDI remote configuration page, the following CC ids need to be set:

  CC  0 -  7  // faders 1-8
  CC  8 - 15  // faders 9-16
  CC 33 - 40  // mute buttons 1-8
  CC 41 - 47  // mute buttons 9-16 (used as "reset" buttons)
  CC 50 - 57  // solo buttons 1-8

  CC 58       // solo button 9: switches aux mode
*/
loadAPI(18);

const VERSION_INFO = "0.8.0";

host.defineController("Ramsa", "DA7", VERSION_INFO, "c4d73560-7256-11ed-a1eb-0242ac120002");
host.defineMidiPorts(1, 1); // 1 Input, 1 Output
 
var currentDeviceName = "";
var currentPageName = "";

/* ------------------------------------------------------------------ *
 *  Configuration
 * ------------------------------------------------------------------ */

var CONFIG = {
   // 0-15, or -1 to listen on all channels. Output always uses OUT_CHANNEL.
   MIDI_CHANNEL: 0,

   // First CC of each contiguous block of 8 (index = cc - first).
   CC_VOLUME_FIRST: 0,      // faders 1-8
   CC_AUX_FIRST: 8,         // faders 9-16
   CC_TRACK_MUTE_FIRST: 33, // mute buttons 1-8
   CC_AUX_MUTE_FIRST: 41,   // mute buttons 9-16 (used as "reset" buttons)
   CC_SOLO_FIRST: 50,       // solo buttons 1-8

   CC_AUX_MODE_TOGGLE: 58,  // solo button 9: switches aux mode

   // Transport. Set any of these to -1 to disable.
   CC_TRANSPORT_REWIND: 110,
   CC_TRANSPORT_FORWARD: 111,
   CC_TRANSPORT_STOP: 112,
   CC_TRANSPORT_PLAY: 113,
   CC_TRANSPORT_RECORD: 114,

   // Ignore our own echo for this long after the surface moved a control.
   FEEDBACK_BLOCK_MS: 200,

   // Touching a volume fader also makes that track the cursor track.
   // Handy in SENDS mode (faders 10-16 follow the cursor track).
   SELECT_TRACK_ON_FADER_TOUCH: true,

   // Mute and solo buttons report a state: >= 64 is "on", < 64 is "off".
   BUTTON_ON_THRESHOLD: 64,

   // The DA7's buttons latch, so a press alternates between 127 and 0 and both
   // values mean "pressed". Set this to false only if your unit sends 127 on
   // press and 0 on release, otherwise every second press is ignored.
   BUTTONS_ARE_LATCHING: true
};

var NUM_CHANNELS = 8;      // channel strips the script addresses
var NUM_DEVICE_PARAMS = 8; // remote controls per page
var OUT_CHANNEL = CONFIG.MIDI_CHANNEL < 0 ? 0 : CONFIG.MIDI_CHANNEL;

/* Aux fader modes (faders 9-16) */
var AUX_MODE_PAN = 1;   // fader 9+n = pan of track n
var AUX_MODE_SENDS = 2; // fader 9 = pan of cursor track, faders 10-16 = sends 1-7

var auxMode = AUX_MODE_PAN;
var isDeviceMode = false;

/* ------------------------------------------------------------------ *
 *  State
 * ------------------------------------------------------------------ */

var transport, application, cursorTrack, trackBank, cursorDevice, remoteControls;

var tracks = [];        // { track, volume, pan, index }
var sends = [];         // cursorTrack send bank items
var deviceParams = [];  // remote control parameters

var cache = {
   volume: newArray(NUM_CHANNELS, 0),
   pan: newArray(NUM_CHANNELS, 64),
   aux: newArray(NUM_CHANNELS, 64),   // slot 0 = cursor pan, slots 1-7 = sends 1-7
   device: newArray(NUM_DEVICE_PARAMS, 0)
};

var bankScrollPosition = 0;
var cursorTrackPosition = -1;

/* What the surface should be showing, and what we last actually transmitted.
 * Anything queued but held back by the echo window stays queued and is retried
 * on the next flush(), so a suppressed update is never lost. */
var desired = {};
var sent = {};

/* Per-CC timestamp of the last message received from the surface. */
var lastTouch = {};

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

function newArray(size, fill) {
   var a = [];
   for (var i = 0; i < size; i++) a.push(fill);
   return a;
}

function clamp7(value) {
   var v = Math.round(value);
   if (isNaN(v)) return 0;
   return v < 0 ? 0 : (v > 127 ? 127 : v);
}

function inBlock(cc, first) {
   return first >= 0 && cc >= first && cc < first + NUM_CHANNELS;
}

function isEchoBlocked(cc) {
   return Date.now() - (lastTouch[cc] || 0) < CONFIG.FEEDBACK_BLOCK_MS;
}

/** Transmit the queued value for a CC, if it is allowed and worth sending. */
function transmit(cc, respectEcho, always) {
   if (desired[cc] === undefined) return;
   if (respectEcho && isEchoBlocked(cc)) return; // stays queued for the next flush
   if (!always && sent[cc] === desired[cc]) return;
   sent[cc] = desired[cc];
   sendMidi(0xB0 | OUT_CHANNEL, cc, desired[cc]);
}

/**
 * Queue a fader position. force bypasses both the echo window and the
 * redundancy check, which is what a mode change needs: the fader has to
 * physically move even if the value happens to match what was there before.
 */
function sendFader(cc, value, force) {
   desired[cc] = clamp7(value);
   if (force) lastTouch[cc] = 0;
   transmit(cc, !force, force);
}

/** Queue an LED / button value. Buttons are never echo-blocked. */
function sendCC(cc, value, always) {
   desired[cc] = clamp7(value);
   transmit(cc, false, always);
}

function touched(cc) {
   lastTouch[cc] = Date.now();
}

function isOn(data2) {
   return data2 >= CONFIG.BUTTON_ON_THRESHOLD;
}

/** True when a button message should count as a press. */
function isPress(data2) {
   return CONFIG.BUTTONS_ARE_LATCHING || isOn(data2);
}


/* ------------------------------------------------------------------ *
 *  Init
 * ------------------------------------------------------------------ */
function init() {
   application = host.createApplication();
   transport = host.createTransport();

   host.getMidiInPort(0).setMidiCallback(onMidi);
   host.getMidiInPort(0).setSysexCallback(onSysex);

   transport = host.createTransport();

   cursorTrack = host.createCursorTrack(8,0);

   trackBank = host.createTrackBank(NUM_CHANNELS, 8, 8);
   sceneBank = host.createSceneBank(NUM_CHANNELS);

   trackBank.followCursorTrack(cursorTrack);

   var track = trackBank.getItemAt(0);
   var slots = track.clipLauncherSlotBank();

   slots.setIndication(true);

   trackBank.scrollPosition().addValueObserver(function (position) {
      bankScrollPosition = position;
   });
   cursorTrack.position().addValueObserver(function (position) {
      cursorTrackPosition = position;
   });

   cursorDevice = cursorTrack.createCursorDevice("DA7_DEVICE", "Selected Device", 0, CursorDeviceFollowMode.FOLLOW_SELECTION);
   remoteControls = cursorDevice.createCursorRemoteControlsPage(NUM_DEVICE_PARAMS);

    cursorDevice.name().markInterested();
    remoteControls.getName().markInterested();

   cursorDevice.name().addValueObserver(function (name) {
    println("DEVICE PAGE: " + name);
      currentDeviceName = name;
      host.showPopupNotification(currentDeviceName);
   });
   remoteControls.getName().addValueObserver(function (name) {
    println("DEVICE PAGE: " + name);
      currentPageName = name;
      host.showPopupNotification(currentDeviceName + ": " + currentPageName);
   });

   setupTracks();
   setupSends();
   setupDevice();

   updateIndications();
   refreshSurface(true);
 
   println("Ramsa DA7 controller script initialised");
}

function setupTracks() {
   for (var i = 0; i < NUM_CHANNELS; i++) {
      (function (index) {
         var track = trackBank.getItemAt(index);
         var volume = track.volume();
         var pan = track.pan();

         volume.markInterested();
         pan.markInterested();
         track.exists().markInterested();

         volume.value().addValueObserver(128, function (value) {
            cache.volume[index] = value;
            sendFader(CONFIG.CC_VOLUME_FIRST + index, value);
         });

         pan.value().addValueObserver(128, function (value) {
            cache.pan[index] = value;
            if (!isDeviceMode && auxMode === AUX_MODE_PAN) {
               sendFader(CONFIG.CC_AUX_FIRST + index, value);
            }
         });

         // DA7 mute LEDs are lit when the channel is *audible*.
         track.mute().addValueObserver(function (isMuted) {
            sendCC(CONFIG.CC_TRACK_MUTE_FIRST + index, isMuted ? 0 : 127);
         });

         track.solo().addValueObserver(function (isSoloed) {
            sendCC(CONFIG.CC_SOLO_FIRST + index, isSoloed ? 127 : 0);
         });

         tracks.push({ track: track, volume: volume, pan: pan });
      })(i);
   }
}

function setupSends() {
   var sendBank = cursorTrack.sendBank();

   cursorTrack.pan().markInterested();
   cursorTrack.pan().value().addValueObserver(128, function (value) {
      cache.aux[0] = value; // fader 9 carries the cursor track's pan
      if (!isDeviceMode && auxMode === AUX_MODE_SENDS) {
         sendFader(CONFIG.CC_AUX_FIRST, value);
      }
   });

   // Faders 10-16 carry sends 1-7, so only the first NUM_CHANNELS - 1 sends fit.
   for (var i = 0; i < NUM_CHANNELS - 1; i++) {
      (function (sendIndex) {
         var send = sendBank.getItemAt(sendIndex);
         var slot = sendIndex + 1; // fader slot within the aux block
         cache.aux[slot] = 0; // move non-mapped send faders to zero

         send.markInterested();
         send.value().addValueObserver(128, function (value) {
            cache.aux[slot] = value;
            if (!isDeviceMode && auxMode === AUX_MODE_SENDS) {
               sendFader(CONFIG.CC_AUX_FIRST + slot, value);
            }
         });

         sends.push(send);
      })(i);
   }
}

function setupDevice() {
   for (var i = 0; i < NUM_DEVICE_PARAMS; i++) {
      (function (index) {
         var parameter = remoteControls.getParameter(index);
         parameter.markInterested();
         parameter.value().addValueObserver(128, function (value) {
            cache.device[index] = value;
            if (isDeviceMode) {
               sendFader(CONFIG.CC_AUX_FIRST + index, value);
            }
         });

         deviceParams.push(parameter);
      })(i);
   }
}

/* ------------------------------------------------------------------ *
 *  Surface refresh
 * ------------------------------------------------------------------ */

/** Push fader positions and mode LEDs to the DA7. */
function refreshSurface(force) {
   sendCC(CONFIG.CC_AUX_MODE_TOGGLE, auxMode === AUX_MODE_SENDS ? 127 : 0, force);

   for (var i = 0; i < NUM_CHANNELS; i++) {
      // Faders 1-8 stay on track volume in both modes.
      sendFader(CONFIG.CC_VOLUME_FIRST + i, cache.volume[i], force);

      var auxValue = isDeviceMode ? cache.device[i]
                   : (auxMode === AUX_MODE_PAN ? cache.pan[i] : cache.aux[i]);
      sendFader(CONFIG.CC_AUX_FIRST + i, auxValue, force);

      // Reset buttons are momentary: keep their LEDs dark.
      sendCC(CONFIG.CC_AUX_MUTE_FIRST + i, 0, true);
   }
}

/** Indications are mode state, not per-message state - set them once per change. */
function updateIndications() {
   var panActive = !isDeviceMode && auxMode === AUX_MODE_PAN;
   var sendsActive = !isDeviceMode && auxMode === AUX_MODE_SENDS;

   for (var i = 0; i < tracks.length; i++) {
      tracks[i].volume.setIndication(!isDeviceMode);
      tracks[i].pan.setIndication(panActive);
   }
   for (var s = 0; s < sends.length; s++) {
      sends[s].setIndication(sendsActive);
   }
   cursorTrack.pan().setIndication(sendsActive);

   for (var d = 0; d < deviceParams.length; d++) {
      deviceParams[d].setIndication(isDeviceMode);
   }
}

function setAuxMode(mode) {
   if (auxMode === mode) return;
   auxMode = mode;
   updateIndications();
   refreshSurface(true);
   host.showPopupNotification(auxMode === AUX_MODE_PAN ? "Aux: Pan" : "Aux: Pan + Sends");
}

function setDeviceMode(enabled) {
   isDeviceMode = enabled;
   updateIndications();
   refreshSurface(true);
   application.getAction(isDeviceMode ? "focus_or_toggle_device_panel" : "focus_or_toggle_mixer").invoke();
   host.showPopupNotification(isDeviceMode ? "Device Mode" : "Mixer Mode");
}

function selectTrack(index) {
   if (!CONFIG.SELECT_TRACK_ON_FADER_TOUCH) return;
   // Only move the cursor when it is not already on this track, otherwise the
   // bank re-selects on every single fader step.
   if (bankScrollPosition + index === cursorTrackPosition) return;
   tracks[index].track.selectInEditor();
}

/* ------------------------------------------------------------------ *
 *  MIDI input
 * ------------------------------------------------------------------ */

function onMidi(status, data1, data2) {
   if ((status & 0xF0) !== 0xB0) return;

   var channel = status & 0x0F;
   if (CONFIG.MIDI_CHANNEL !== -1 && channel !== CONFIG.MIDI_CHANNEL) return;

   handleCC(data1, data2);
}

function handleCC(cc, value) {
   if (handleTransport(cc, value)) return;

   // Mode switch works in both mixer and device mode.
   if (cc === CONFIG.CC_AUX_MODE_TOGGLE) {
      if (isPress(value)) {
         setAuxMode(auxMode === AUX_MODE_SENDS ? AUX_MODE_PAN : AUX_MODE_SENDS);
      }
      // Keep the LED in sync with our state, not the button's own state.
      sendCC(CONFIG.CC_AUX_MODE_TOGGLE, auxMode === AUX_MODE_SENDS ? 127 : 0, true);

      // if we're toggling AUX mode while in device mode, switch to mixer mode
      if (isDeviceMode)
        setDeviceMode(false);
      return;
   }

   // Mutes and solos stay live in device mode - only the aux faders change job.
   if (inBlock(cc, CONFIG.CC_TRACK_MUTE_FIRST)) {
      var muteIndex = cc - CONFIG.CC_TRACK_MUTE_FIRST;
      tracks[muteIndex].track.mute().set(!isOn(value));
      return;
   }

   if (inBlock(cc, CONFIG.CC_SOLO_FIRST)) {
      var soloIndex = cc - CONFIG.CC_SOLO_FIRST;
      tracks[soloIndex].track.solo().set(isOn(value));
      return;
   }

   if (inBlock(cc, CONFIG.CC_AUX_MUTE_FIRST)) {
      if (isPress(value)) resetAuxParameter(cc - CONFIG.CC_AUX_MUTE_FIRST);
      sendCC(cc, 0, true); // momentary: drop the LED again
      return;
   }

   if (inBlock(cc, CONFIG.CC_VOLUME_FIRST)) {
      var volIndex = cc - CONFIG.CC_VOLUME_FIRST;
      touched(cc);
      selectTrack(volIndex);
      tracks[volIndex].volume.set(value, 128);
      return;
   }

   if (inBlock(cc, CONFIG.CC_AUX_FIRST)) {
      handleAuxFader(cc - CONFIG.CC_AUX_FIRST, cc, value);
   }
}

function handleAuxFader(index, cc, value) {
   touched(cc);

   if (isDeviceMode) {
      deviceParams[index].set(value, 128);
      return;
   }

   if (auxMode === AUX_MODE_PAN) {
      selectTrack(index);
      tracks[index].pan.set(value, 128);
      return;
   }

   // AUX_MODE_SENDS: fader 9 is the cursor track's pan, the rest are sends.
   if (index === 0) {
      cursorTrack.pan().set(value, 128);
   } else if (index - 1 < sends.length) {
      sends[index - 1].set(value, 128);
   }
}

/** The mute buttons under faders 9-16 reset whatever that fader controls. */
function resetAuxParameter(index) {
   var cc = CONFIG.CC_AUX_FIRST + index;

   if (isDeviceMode) {
      deviceParams[index].reset();
   } else if (auxMode === AUX_MODE_PAN) {
      tracks[index].pan.reset();
   } else if (index === 0) {
      cursorTrack.pan().reset();
   } else if (index - 1 < sends.length) {
      sends[index - 1].reset();
   }

   // Let the resulting value observer drive the fader back, but clear the echo
   // block first so it is not swallowed.
   lastTouch[cc] = 0;
}

function handleTransport(cc, value) {
   if (!isOn(value)) {
      // Still consume transport CCs on release so they do not fall through.
      return cc === CONFIG.CC_TRANSPORT_REWIND || cc === CONFIG.CC_TRANSPORT_FORWARD ||
             cc === CONFIG.CC_TRANSPORT_STOP   || cc === CONFIG.CC_TRANSPORT_PLAY ||
             cc === CONFIG.CC_TRANSPORT_RECORD;
   }

   switch (cc) {
      case CONFIG.CC_TRANSPORT_REWIND:  transport.rewind();      return true;
      case CONFIG.CC_TRANSPORT_FORWARD: transport.fastForward(); return true;
      case CONFIG.CC_TRANSPORT_STOP:    transport.stop();        return true;
      case CONFIG.CC_TRANSPORT_PLAY:    transport.play();        return true;
      case CONFIG.CC_TRANSPORT_RECORD:  transport.record();      return true;
   }
   return false;
}

/* ------------------------------------------------------------------ *
 *  Sysex (MMC-style navigation)
 * ------------------------------------------------------------------ */
 
function onSysex(data) {
   var lcData = ("" + data).toLowerCase().replace(/[^0-9a-f]/g, "");
   // Toggle between Device Mode and Mixer Mode
  const SYSEX_TOGGLE_MODE = "f07f000606f7";
  // Arrow left
  const SYSEX_ARROW_LEFT = "f07f000605f7";
  // Arrow up
  const SYSEX_ARROW_UP = "f07f000603f7";
  // Arrow right
  const SYSEX_ARROW_RIGHT = "f07f000604f7";
  // Arrow down
  const SYSEX_ARROW_DOWN = "f07f000601f7";
  const SYSEX_ARROW_DOWN2 = "f07f000609f7";
 
   switch (lcData) {
      case SYSEX_TOGGLE_MODE:
         setDeviceMode(!isDeviceMode);
         break;
 
      case SYSEX_ARROW_LEFT:
         if (isDeviceMode) {
            cursorDevice.selectPrevious();
         } else {
            cursorTrack.selectPrevious();
            host.showPopupNotification("Previous Track");
         }
         break;
 
      case SYSEX_ARROW_RIGHT:
         if (isDeviceMode) {
            cursorDevice.selectNext();
         } else {
            cursorTrack.selectNext();
            host.showPopupNotification("Next Track");
         }
         break;
 
      case SYSEX_ARROW_UP:
         if (isDeviceMode) {
            remoteControls.selectPreviousPage(true);
         } else {
            trackBank.scrollPageBackwards();
            host.showPopupNotification("Previous Track Bank");
         }
         break;
 
      case SYSEX_ARROW_DOWN:
      case SYSEX_ARROW_DOWN2:
         if (isDeviceMode) {
            remoteControls.selectNextPage(true);
         } else {
            trackBank.scrollPageForwards();
            host.showPopupNotification("Next Track Bank");
         }
         break;
 
      default:
         return;
   }
 
  refreshSurface(true);
}

/* ------------------------------------------------------------------ *
 *  Flush / exit
 * ------------------------------------------------------------------ */

function flush() {
   // Values are pushed from observers. Anything that was held back by the echo
   // window is still queued here, so this is where it finally goes out.
   for (var cc in desired) {
      if (desired.hasOwnProperty(cc)) transmit(parseInt(cc, 10), true, false);
   }
}

function exit() {
   for (var i = 0; i < NUM_CHANNELS; i++) {
      sendCC(CONFIG.CC_TRACK_MUTE_FIRST + i, 0, true);
      sendCC(CONFIG.CC_AUX_MUTE_FIRST + i, 0, true);
      sendCC(CONFIG.CC_SOLO_FIRST + i, 0, true);
   }
   sendCC(CONFIG.CC_AUX_MODE_TOGGLE, 0, true);
   println("Ramsa DA7 controller script exited");
}