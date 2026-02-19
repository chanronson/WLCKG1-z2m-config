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
//  │ 233 │ Door       — accelerometer event (0xE9, confirmed from hardware)   │
//  └─────┴─────────────────────────────────────────────────────────────────────┘
//
//  data[46] — Unified State (single composite value encoding lock + door)
//
//  IMPORTANT: data[46] is NOT two independent lookups. All events observed so
//  far arrive as data[57]=19 regardless of trigger (thumbturn, accelerometer,
//  vibration). EVT_DOOR=233 fires from the accelerometer independently of thumbturn events.
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
//  processed. Additionally, wall-clock time tracking detects stale events:
//  if the time delta between events is disproportionate to the counter delta
//  (e.g., counter increments by 3 but 5 minutes elapsed), the event is dropped
//  as stale. Pattern detection also flags messages arriving at :23 or :53
//  past the hour as likely stale auto-lock events.
// =============================================================================

// --- Byte indices ---
const IDX_SEQ        = 13; // global lifetime counter — more robust than data[3]
const IDX_EVENT_TYPE = 57;
const IDX_STATE      = 46;

// --- Event type values ---
const EVT_MANUAL     = 19;
const EVT_AUTO       = 5;
const EVT_APP        = 12;  // 0x0C — app-triggered (original)
const EVT_APP2       = 23;  // 0x17 — app-triggered (alternate, observed 2026-02-17)
const EVT_DOOR       = 233; // 0xE9 — confirmed from hardware (Gemini reported 242, incorrect)
const LOCK_EVT_TYPES = new Set([EVT_MANUAL, EVT_AUTO, EVT_APP, EVT_APP2]);

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
// Deduplication & Staleness Detection
//
// DEDUPLICATION (high-water mark):
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
//
// STALENESS DETECTION (time delta analysis):
// Tracks wall-clock timestamps alongside counter values. Detects stale events
// by comparing time elapsed vs counter increment:
//   - Each event takes ~10-15s to transmit (3 retries + delays)
//   - If counter Δ=3 but time Δ=300s, the events were generated 5 min ago → STALE
//   - Pattern detection: messages at :23 or :53 past the hour with >2min gaps
//     are flagged as stale auto-lock events (30-minute timer)
//
// This catches genuinely new sequence numbers that represent old physical state.
// =============================================================================
const _seqHighWater = new Map(); // ieeeAddr → highest data[13] seen (0–255)
const _lastEventTime = new Map(); // ieeeAddr → { counter: N, timestamp: ms }
//
// IMPORTANT: _lastEventTime is intentionally NOT updated inside isOldOrDuplicate.
// It must only be written via markEventProcessed(), which is called after BOTH
// isOldOrDuplicate() AND isStale() have passed. If we wrote it inside
// isOldOrDuplicate, isStale() would always see counterDelta=0 / timeDelta=0
// and would never be able to detect staleness.

function isOldOrDuplicate(msg) {
    const incoming  = msg.data[IDX_SEQ];
    const id        = msg.device.ieeeAddr;
    const highWater = _seqHighWater.get(id);

    if (highWater === undefined) {
        _seqHighWater.set(id, incoming);
        // _lastEventTime intentionally not set here — markEventProcessed() will do it
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
    // _lastEventTime intentionally not set here — markEventProcessed() will do it
    return false;
}

function isStale(msg, eventState) {
    // Only apply staleness detection to unlock events (state=103).
    // Lock events (state=96) and door events are never the stale phantom problem.
    if (eventState !== 103) return false;

    const incoming = msg.data[IDX_SEQ];
    const id       = msg.device.ieeeAddr;
    const now      = Date.now();
    const last     = _lastEventTime.get(id);

    if (!last) return false; // no prior processed event to compare against

    const counterDelta = (incoming - last.counter + 256) % 256;
    const timeDeltaMs  = now - last.timestamp;
    const timeDeltaSec = Math.floor(timeDeltaMs / 1000);

    // Safety valve: after 2 hours of idle the stale queue is long gone.
    // Treat the device as waking from rest and process the event fresh.
    // (Prevents false positives when counter wraps overnight.)
    if (timeDeltaSec > 7200) return false;

    // Each event takes ~9-10 seconds per retry cycle. Allow 60s per counter step
    // (very generous) to avoid false positives on real events a minute or two apart.
    // Require a hard minimum of 300s (5 min) to never false-positive on normal use.
    const expectedMaxSec = counterDelta * 60;
    if (timeDeltaSec > expectedMaxSec && timeDeltaSec > 300) {
        logger.logger.warning(
            `[wyze-lock] Dropping stale unlock from ${id} ` +
            `(counter=${incoming}, Δcounter=${counterDelta}, ` +
            `Δtime=${timeDeltaSec}s, expected≤${expectedMaxSec}s) — ` +
            `event queued ~${Math.round(timeDeltaSec/60)} min ago`
        );
        return true;
    }

    return false;
}

function markEventProcessed(msg) {
    const id = msg.device.ieeeAddr;
    _lastEventTime.set(id, { counter: msg.data[IDX_SEQ], timestamp: Date.now() });
}

// =============================================================================
// fromZigbee converter
// =============================================================================
const fzLocal = {
    wyze_lock_event: {
        cluster: 'manuSpecificAssaDoorLock',
        type: ['raw'],
        convert: (model, msg, publish, options, meta) => {
            // INLINE CLUSTER PATCH: Run once on first message to add command 0x00 to
            // manuSpecificAssaDoorLock.commandsResponse so zh can parse frames without throwing.
            if (!fzLocal._clusterPatched) {
                try {
                    // Access zigbee-herdsman's live cluster registry through z2m's Zcl export.
                    // This runs from within z2m's context so module resolution works.
                    const zhc = require('zigbee-herdsman-converters');
                    const Zcl = zhc.Zcl || (zhc.default && zhc.default.Zcl);
                    
                    if (Zcl && Zcl.Clusters && Zcl.Clusters.manuSpecificAssaDoorLock) {
                        const cluster = Zcl.Clusters.manuSpecificAssaDoorLock;
                        if (!cluster.commandsResponse) cluster.commandsResponse = {};
                        
                        // Only patch if not already present (idempotent)
                        const hasCmd0 = Object.values(cluster.commandsResponse)
                            .some(cmd => cmd.ID === 0x00);
                        
                        if (!hasCmd0) {
                            cluster.commandsResponse.wyzeEvent = { ID: 0x00, parameters: [] };
                            logger.logger.info(
                                '[wyze-lock] Patched manuSpecificAssaDoorLock cluster: ' +
                                'added wyzeEvent(0x00) to commandsResponse. ' +
                                'zh will no longer throw "has no command 0" errors.'
                            );
                        } else {
                            logger.logger.debug('[wyze-lock] Cluster already patched, skipping.');
                        }
                    } else {
                        logger.logger.warning(
                            '[wyze-lock] Could not locate Zcl.Clusters for patching. ' +
                            'Retransmissions may continue.'
                        );
                    }
                } catch (e) {
                    logger.logger.warning(
                        `[wyze-lock] Cluster patch failed: ${e.message}. Retransmissions may continue.`
                    );
                }
                fzLocal._clusterPatched = true; // flag to ensure this runs only once
            }

            if (msg.data.length < 70 || msg.data.length > 90) return;
            if (isOldOrDuplicate(msg)) return;

            const eventType  = msg.data[IDX_EVENT_TYPE];
            const eventState = msg.data[IDX_STATE];

            // isStale must run AFTER eventState is read, and markEventProcessed
            // must run AFTER isStale so the timestamp reflects only genuinely
            // processed events — not stale ones that would poison future checks.
            if (isStale(msg, eventState)) return;
            markEventProcessed(msg);
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
                             : eventType === EVT_APP2   ? 'app'
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

            // --- Door-only events (accelerometer, data[57]=233) ---
            if (eventType === EVT_DOOR) {
                if ([96, 112].includes(eventState)) {
                    // Door closed — confirmed from hardware (state=112 at counter=78)
                    result.door_state = 'closed';
                    result.contact    = true;
                    logger.logger.debug(
                        `[wyze-lock] door closed (accelerometer) (${counterStr}, state=${eventState})`
                    );
                } else if ([103, 115].includes(eventState)) {
                    // Door open/ajar — confirmed from hardware (state=115)
                    // state=115 encodes UNLOCKED+OPEN, so also correct lock_state here.
                    // This serves as a safety net: if the unlock event (state=103) was
                    // blocked by staleness detection but was actually real, the door-open
                    // event (which fires within 1 second) will still report the correct state.
                    result.door_state = 'open';
                    result.contact    = false;
                    if (eventState === 115) {
                        result.lock_state = 'unlocked';
                    }
                    logger.logger.debug(
                        `[wyze-lock] door open (accelerometer) (${counterStr}, state=${eventState})`
                    );
                } else if (eventState === 0) {
                    // Door movement while locked — no meaningful position change, don't update
                    logger.logger.debug(
                        `[wyze-lock] door movement while locked, no state update (${counterStr}, state=${eventState})`
                    );
                } else {
                    logger.logger.warning(
                        `[wyze-lock] Unknown door event state byte ${eventState} ` +
                        `(0x${eventState.toString(16)}) at ${counterStr} — ignoring. Please report.`
                    );
                    return;
                }
            }

            // --- Unknown event type catch-all ---
            if (!LOCK_EVT_TYPES.has(eventType) && eventType !== EVT_DOOR) {
                logger.logger.warning(
                    `[wyze-lock] Unknown event type ${eventType} (0x${eventType.toString(16)}) ` +
                    `at ${counterStr}, state=${eventState} — ignoring. Please report.`
                );
                return;
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
