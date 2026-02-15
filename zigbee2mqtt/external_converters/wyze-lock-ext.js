const fz = require("zigbee-herdsman-converters/converters/fromZigbee");
const tz = require("zigbee-herdsman-converters/converters/toZigbee");
const exposes = require("zigbee-herdsman-converters/lib/exposes");
const reporting = require("zigbee-herdsman-converters/lib/reporting");
const logger = require("zigbee-herdsman-converters/lib/logger");

const e = exposes.presets;

const fzLocal = {
  wyze_lock_event: {
    cluster: "manuSpecificAssaDoorLock",
    type: ["raw"],
    convert: async (model, msg, publish, options, meta) => {
      if (msg.data.length < 70) return;

      const eventType = msg.data[57];
      const eventState = msg.data[46];
      const result = {};

      // Handle Lock/Unlock Events
      if ([19, 5, 12].includes(eventType)) {
        const locked = (eventState === (options.lock_locked || 96));
        result.state = locked ? "LOCK" : "UNLOCK";
        result.lock_state = locked ? "locked" : "unlocked";
        
        const actionMap = { 19: 'manual', 5: 'auto', 12: 'app' };
        result.action = actionMap[eventType];
        logger.logger.warning(`WYZE_DEBUG: Lock ${result.lock_state} via ${result.action}`);
      }

      // Handle Door Contact Events
      if (eventType === 242) {
        const closed = (eventState === 96 || eventState === 112);
        result.door_state = closed ? "closed" : "open";
        result.contact = closed; 
        logger.logger.warning(`WYZE_DEBUG: Door is ${result.door_state} (${eventState})`);
      }

      return result;
    },
  },
};

const tzLocal = {
  wyze_lock_control: {
    key: ['state'],
    convertSet: async (entity, key, value, meta) => {
      const isLock = value.toLowerCase() === 'lock';
      // Command 0x00 is Lock, 0x01 is Unlock for the Wyze manufacturer cluster
      const cmd = isLock ? 0x00 : 0x01;
      await entity.command('manuSpecificAssaDoorLock', cmd, {}, {mfgCode: 0x61dc});
      return {state: {state: isLock ? 'LOCK' : 'UNLOCK'}};
    },
  },
};

const definition = {
  zigbeeModel: ["Ford"],
  model: "WLCKG1",
  vendor: "Wyze",
  description: "Wyze Lock (Customized)",
  fromZigbee: [fz.lock, fzLocal.wyze_lock_event, fz.battery],
  toZigbee: [tzLocal.wyze_lock_control, tz.lock], // Uses our local control first
  configure: async (device, coordinatorEndpoint) => {
    const endpoint = device.endpoints[0];
    await reporting.bind(endpoint, coordinatorEndpoint, ["closuresDoorLock", "genPowerCfg", "manuSpecificAssaDoorLock"]);
    await reporting.lockState(endpoint);
    await reporting.batteryPercentageRemaining(endpoint);
  },
  exposes: [
    e.lock(), 
    e.battery(),
    exposes.enum("door_state", exposes.access.STATE, ["open", "closed"]).withDescription("Current state of the door"),
    exposes.binary("contact", exposes.access.STATE, true, false).withDescription("Door contact state"),
  ],
};

module.exports = definition;
