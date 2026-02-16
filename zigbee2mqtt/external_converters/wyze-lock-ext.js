const fz = require("zigbee-herdsman-converters/converters/fromZigbee");
const tz = require("zigbee-herdsman-converters/converters/toZigbee");
const exposes = require("zigbee-herdsman-converters/lib/exposes");
const reporting = require("zigbee-herdsman-converters/lib/reporting");
const logger = require("zigbee-herdsman-converters/lib/logger");

const e = exposes.presets;

// =============================================================================
// PAYLOAD REFERENCE (80-byte raw buffer from manuSpecificAssaDoorLock / 0xFC00)
//
//  data[3]  — Per-session sequence counter (wraps 0–255, resets on reconnect)
//             Used by ZHA quirk as args[8] = data[13] offset (ZHA strips 5-byte
//             ZCL header).  NOT used for deduplication here — see data[13].
//
//  data[5]  — Message format indicator (observed values):
//             0x4F (79)  — standard format; most lock events
//             0x75 (117) — alternate format; observed on some unlock events
//             NOTE: the ZHA quirk filters to 79-only, silently dropping 117
//             messages. We process both since 117 carries legitimate events.
//
//  data[13] — Global lifetime counter (monotonically increasing, survives
//             session reconnects unlike data[3]). Used for deduplication.
//             Confirmed values: 49→72 across an entire test session.
//
//  data[57] — Event Type (what triggered the message)
//  ┌─────┬─────────────────────────────────────────────────────────────────────┐
//  │  19 │ Manual     — thumbturn physically turned                           │
//  │   5 │ Auto-Lock  — internal timer fired                                  │
//  │  12 │ App/Remote — Zigbee or Bluetooth command                           │
//  │ 242 │ Door       — accelerometer only (unconfirmed, not yet observed)    │
//  └─────┴─────────────────────────────────────────────────────────────────────┘
//
//  data[46] — Unified State (single composite value encoding lock + door)
//
//  IMPORTANT: data[46] is NOT two independent lookups. All events observed so
//  far arrive as data[57]=19 regardless of trigger (thumbturn, accelerometer,
//  vibration). The EVT_DOOR=242 event type has NOT been observed in hardware.
//
//  ┌─────┬────────────┬─────────────┬──────────────────────────────────────────┐
//  │   0 │ LOCKED     │ (no update) │ accelerometer movement while locked;     │
//  │     │            │             │ door didn't meaningfully open/close      │
//  │  96 │ LOCKED     │ (no update) │ thumbturn locked; door position unknown  │
//  │ 103 │ UNLOCKED   │ (no update) │ door position unreliable — observed when │
//  │     │            │             │ door was both open and closed            │
//  │ 115 │ UNLOCKED   │ OPEN        │ confirmed: door open/ajar at event time  │
//  │ 112 │ UNLOCKED   │ (no update) │ unconfirmed, included defensively        │
//  └─────┴────────────┴─────────────┴──────────────────────────────────────────┘
//
//  door: null = do not overwrite the last known door state in z2m.
//
//  NOTE ON STALENESS: The coordinator never ACKs these frames, so the lock
//  queues and retransmits them indefinitely. data[13] ordering prevents
//  same-event retransmissions and old-seq delayed messages from being
//  processed, but cannot detect a genuinely new seq that was generated
//  before the current physical state changed. Handle staleness in HA
//  automations if needed.
// =============================================================================

// --- Byte indices ---
const IDX_SEQ        = 13; // global lifetime counter — more robust than data[3]
const IDX_EVENT_TYPE = 57;
const IDX_STATE      = 46;

// --- Event type values ---
const EVT_MANUAL     = 19;
const EVT_AUTO       = 5;
const EVT_APP        = 12;
const EVT_DOOR       = 242; // retained defensively — not yet observed in hardware logs
const LOCK_EVT_TYPES = new Set([EVT_MANUAL, EVT_AUTO, EVT_APP]);

// --- Unified state map ---
// door: null = do not publish door_state or contact for this event.
const STATE_MAP = {
    0:   { locked: true,  door: null,   confirmed: true,  note: 'locked, accelerometer movement' },
    96:  { locked: true,  door: null,   confirmed: true,  note: 'locked' },
    103: { locked: false, door: null,   confirmed: true,  note: 'unlocked, door position unreliable' },
    115: { locked: false, door: 'open', confirmed: true,  note: 'unlocked, door open/ajar' },
    112: { locked: false, door: null,   confirmed: false, note: 'unlocked (unconfirmed state)' },
};

// =============================================================================
// Deduplication — monotonic sequence number (high-water mark)
//
// Uses data[IDX_SEQ] = data[13], a global lifetime counter that is more stable
// than data[3] which can reset on device reconnect.
// (Cross-referenced against ZHA quirk by mariusmuja which uses the equivalent
// byte — their args[8] = our data[13] after stripping the 5-byte ZCL header.)
//
// CIRCULAR ARITHMETIC:
//   The counter wraps at 255→0. A half-window of 128 correctly distinguishes
//   "behind" from "genuinely ahead after a wrap":
//
//     diff = (highWater - incoming + 256) % 256
//     diff < 128  → same-as or behind highWater → DROP
//     diff ≥ 128  → ahead (new event or wrap)   → KEEP
//
//   Examples:
//     incoming=68, highWater=72  → diff=4   (<128) → DROP  ✓ delayed message
//     incoming=72, highWater=72  → diff=0   (<128) → DROP  ✓ same-burst retry
//     incoming=73, highWater=72  → diff=255 (≥128) → KEEP  ✓ new event
//     incoming=5,  highWater=200 → diff=61  (<128) → DROP  ✗ wrap — increase
//                                                            window if needed
// =============================================================================
const _seqHighWater = new Map(); // ieeeAddr → highest data[13] seen (0–255)

function isOldOrDuplicate(msg) {
    const incoming  = msg.data[IDX_SEQ];
    const id        = msg.device.ieeeAddr;
    const highWater = _seqHighWater.get(id);

    if (highWater === undefined) {
        _seqHighWater.set(id, incoming);
        return false;
    }

    const diff = (highWater - incoming + 256) % 256;
    if (diff < 128) {
        logger.logger.debug(
            `[wyze-lock] Dropping ${diff === 0 ? 'duplicate' : 'delayed'} frame ` +
            `from ${id} (counter=${incoming}, highWater=${highWater})`
        );
        return true;
    }

    _seqHighWater.set(id, incoming);
    return false;
}

// =============================================================================
// fromZigbee converter
// =============================================================================
const fzLocal = {
    wyze_lock_event: {
        cluster: 'manuSpecificAssaDoorLock',
        type: ['raw'],
        convert: (model, msg, publish, options, meta) => {
            if (msg.data.length < 70 || msg.data.length > 90) return;
            if (isOldOrDuplicate(msg)) return;

            const eventType  = msg.data[IDX_EVENT_TYPE];
            const eventState = msg.data[IDX_STATE];
            const counterStr = `counter=${msg.data[IDX_SEQ]}`;
            const result     = {};

            // --- Lock events (manual / auto / app) ---
            if (LOCK_EVT_TYPES.has(eventType)) {
                const stateInfo = STATE_MAP[eventState];

                if (!stateInfo) {
                    logger.logger.warning(
                        `[wyze-lock] Unknown state byte ${eventState} ` +
                        `(0x${eventState.toString(16)}) at ${counterStr}, type=${eventType} — ` +
                        `ignoring. Please report this value.`
                    );
                    return;
                }

                if (!stateInfo.confirmed) {
                    logger.logger.warning(
                        `[wyze-lock] Unconfirmed state byte ${eventState} at ${counterStr} — ` +
                        `publishing best-guess (${stateInfo.note}).`
                    );
                }

                const action = eventType === EVT_MANUAL ? 'manual'
                             : eventType === EVT_AUTO   ? 'auto'
                             :                            'app';

                result.state      = stateInfo.locked ? 'LOCK'   : 'UNLOCK';
                result.lock_state = stateInfo.locked ? 'locked' : 'unlocked';
                result.action     = action;

                if (stateInfo.door !== null) {
                    result.door_state = stateInfo.door;
                    result.contact    = (stateInfo.door === 'closed');
                }

                logger.logger.debug(
                    `[wyze-lock] ${result.lock_state} via ${action}` +
                    `${stateInfo.door ? `, door ${stateInfo.door}` : ''} ` +
                    `(${counterStr}, type=${eventType}, state=${eventState}) — ${stateInfo.note}`
                );
            }

            // --- Door-only events (accelerometer, not yet confirmed on hardware) ---
            if (eventType === EVT_DOOR) {
                const closed = [96, 112].includes(eventState);
                const open   = [103, 115].includes(eventState);

                if (closed || open) {
                    result.door_state = closed ? 'closed' : 'open';
                    result.contact    = closed;
                    logger.logger.debug(
                        `[wyze-lock] door-only event: ${result.door_state} ` +
                        `(${counterStr}, state=${eventState})`
                    );
                } else {
                    logger.logger.warning(
                        `[wyze-lock] Unknown door-only state byte ${eventState} ` +
                        `(0x${eventState.toString(16)}) at ${counterStr} — ignoring.`
                    );
                    return;
                }
            }

            return result;
        },
    },
};

// =============================================================================
// Device definition
// =============================================================================
const definition = {
    zigbeeModel: ['Ford'],
    model: 'WLCKG1',
    vendor: 'Wyze',
    description: 'Wyze Lock',
    fromZigbee: [fz.lock, fz.lock_operation_event, fzLocal.wyze_lock_event, fz.battery],
    toZigbee: [tz.lock],
    configure: async (device, coordinatorEndpoint) => {
        const endpoint = device.endpoints[0];
        await reporting.bind(endpoint, coordinatorEndpoint, [
            'closuresDoorLock',
            'genPowerCfg',
            'manuSpecificAssaDoorLock',
        ]);
        await reporting.lockState(endpoint);
        await reporting.batteryPercentageRemaining(endpoint);
    },
    exposes: [
        e.lock(),
        e.battery(),
        exposes
            .enum('door_state', exposes.access.STATE, ['open', 'closed'])
            .withDescription('Door position — only updated when hardware explicitly reports it (state=115)'),
        exposes
            .binary('contact', exposes.access.STATE, true, false)
            .withDescription('Door contact state — true = closed'),
        exposes
            .enum('action', exposes.access.STATE, ['manual', 'auto', 'app'])
            .withDescription('Source of the last lock/unlock operation'),
    ],
};

module.exports = definition;
