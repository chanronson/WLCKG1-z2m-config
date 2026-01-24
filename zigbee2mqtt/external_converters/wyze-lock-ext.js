const fz = require("zigbee-herdsman-converters/converters/fromZigbee");
const tz = require("zigbee-herdsman-converters/converters/toZigbee");
const exposes = require("zigbee-herdsman-converters/lib/exposes");
const reporting = require("zigbee-herdsman-converters/lib/reporting");
const logger = require("zigbee-herdsman-converters/lib/logger");

// User-configurable byte positions
// Offset Position of the event type.
// See SourceMessage for values found.
const EVENT_TYPE = 57;

// Offset Position of the event state.
// For doors, it's either "open" or "closed" (see DoorState),
// For locks, it's either "locked" or "unlocked" (see LockState).
const EVENT_STATE = 46;

const e = exposes.presets;

const fzLocal = {
  c4_lock_operation_event: {
    cluster: "manuSpecificAssaDoorLock",
    type: ["raw"],
    convert: async (model, msg, publish, options, meta) => {
      const result = {};
      if (msg.data.length < 70 || msg.data.length > 90) {
        return result;
      }

      // Get configurable event type values
      const SourceMessage = {
        DOOR: options.source_door || 242,
        MANUAL: options.source_manual || 8,
        AUTO: options.source_auto || 5,
        APP: options.source_app || 12,
      };

      // Get configurable door state values
      const DoorState = {
        OPEN: options.door_open || 91,
        CLOSED: options.door_closed || 88,
      };

      // Get configurable lock state values
      const LockState = {
        LOCKED: options.lock_locked || 72,
        UNLOCKED: options.lock_unlocked || 79,
      };

      const eventType = msg.data[EVENT_TYPE];
      const eventState = msg.data[EVENT_STATE];

      // Lock/Unlock events
      if (eventType == SourceMessage.APP && eventState == LockState.UNLOCKED) {
        logger.logger.warning("the lock is unlocked via the app");
        result.state = "UNLOCK";
        result.lock_state = "unlocked";
      } else if (
        eventType == SourceMessage.APP &&
        eventState == LockState.LOCKED
      ) {
        logger.logger.warning("the lock is locked via the app");
        result.state = "LOCK";
        result.lock_state = "locked";
      } else if (
        eventType == SourceMessage.MANUAL &&
        eventState == LockState.UNLOCKED
      ) {
        logger.logger.warning("the lock is unlocked manually");
        result.state = "UNLOCK";
        result.lock_state = "unlocked";
      } else if (
        eventType == SourceMessage.MANUAL &&
        eventState == LockState.LOCKED
      ) {
        logger.logger.warning("the lock is locked manually");
        result.state = "LOCK";
        result.lock_state = "locked";
      } else if (
        eventType == SourceMessage.AUTO &&
        eventState == LockState.LOCKED
      ) {
        logger.logger.warning("the lock is locked via auto lock");
        result.state = "LOCK";
        result.lock_state = "locked";
      }

      // Door open/closed events
      if (eventType == SourceMessage.DOOR && eventState == DoorState.OPEN) {
        logger.logger.warning("the door is open");
        result.door_state = "open";
      } else if (
        eventType == SourceMessage.DOOR &&
        eventState == DoorState.CLOSED
      ) {
        logger.logger.warning("the door is closed");
        result.door_state = "closed";
      }

      return result;
    },
  },
};

const definition = {
  zigbeeModel: ["Ford"],
  model: "WLCKG1",
  vendor: "Wyze",
  description: "wyzeee Lock",
  fromZigbee: [
    fz.lock,
    fz.lock_operation_event,
    fzLocal.c4_lock_operation_event,
    fz.battery,
  ],
  toZigbee: [tz.lock],
  configure: async (device, coordinatorEndpoint) => {
    const endpoint = device.endpoints[0];
    await reporting.bind(endpoint, coordinatorEndpoint, [
      "closuresDoorLock",
      "genPowerCfg",
      "manuSpecificAssaDoorLock",
    ]);
    await reporting.lockState(endpoint);
    await reporting.batteryPercentageRemaining(endpoint);
  },
  exposes: [
    e.lock(),
    e.battery(),
    exposes
      .enum("door_state", exposes.access.STATE, ["open", "closed"])
      .withDescription("State of the door"),
  ],
  options: [
    exposes
      .numeric("source_door", exposes.access.SET)
      .withDescription("Event type value for door events")
      .withValueMin(0)
      .withValueMax(255),
    exposes
      .numeric("source_manual", exposes.access.SET)
      .withDescription("Event type value for manual lock/unlock")
      .withValueMin(0)
      .withValueMax(255),
    exposes
      .numeric("source_auto", exposes.access.SET)
      .withDescription("Event type value for auto lock")
      .withValueMin(0)
      .withValueMax(255),
    exposes
      .numeric("source_app", exposes.access.SET)
      .withDescription("Event type value for app lock/unlock")
      .withValueMin(0)
      .withValueMax(255),
    exposes
      .numeric("door_open", exposes.access.SET)
      .withDescription("State value when door is open")
      .withValueMin(0)
      .withValueMax(255),
    exposes
      .numeric("door_closed", exposes.access.SET)
      .withDescription("State value when door is closed")
      .withValueMin(0)
      .withValueMax(255),
    exposes
      .numeric("lock_locked", exposes.access.SET)
      .withDescription("State value when lock is locked")
      .withValueMin(0)
      .withValueMax(255),
    exposes
      .numeric("lock_unlocked", exposes.access.SET)
      .withDescription("State value when lock is unlocked")
      .withValueMin(0)
      .withValueMax(255),
  ],
};

module.exports = definition;
