import { Mutex } from "async-mutex";
import {
  API,
  APIEvent,
  CharacteristicGetHandler,
  DynamicPlatformPlugin,
  HAP,
  Logging,
  PlatformAccessory,
  PlatformAccessoryEvent,
  PlatformConfig,
  UnknownContext,
} from "homebridge";
import { IPv4 } from "ip-num";
import { ArduinoGateway } from "./arduinogateway";
import { convertToHeatingSystem, IHeatingSystem } from "./heizung";
import jp from "jsonpath";

const PLUGIN_NAME = "ArduinoPlatform";
const PLATFORM_NAME = "ArduinoPlatform";

/*
 * IMPORTANT NOTICE
 *
 * One thing you need to take care of is, that you never ever ever import anything directly from the "homebridge"
 * module (or the "hap-nodejs" module).
 * The above import block may seem like, that we do exactly that, but actually those imports are only used for types and interfaces
 * and will disappear once the code is compiled to Javascript.
 * In fact you can check that by running `npm run build` and opening the compiled Javascript file in the `dist` folder.
 * You will notice that the file does not contain a `... = require("homebridge");` statement anywhere in the code.
 *
 * The contents of the above import statement MUST ONLY be used for type annotation or accessing things like CONST ENUMS,
 * which is a special case as they get replaced by the actual value and do not remain as a reference in the compiled code.
 * Meaning normal enums are bad, const enums can be used.
 *
 * You MUST NOT import anything else which remains as a reference in the code, as this will result in
 * a `... = require("homebridge");` to be compiled into the final Javascript code.
 * This typically leads to unexpected behavior at runtime, as in many cases it won't be able to find the module
 * or will import another instance of homebridge causing collisions.
 *
 * To mitigate this the {@link API | Homebridge API} exposes the whole suite of HAP-NodeJS inside the `hap` property
 * of the api object, which can be acquired for example in the initializer function. This reference can be stored
 * like this for example and used to access all exported variables and classes from HAP-NodeJS.
 */
let hap: HAP;
let Accessory: typeof PlatformAccessory;

let data: IHeatingSystem | undefined = undefined;
let lastFetch = 0;
let ip: string;
let port: number;
let mutex: Mutex;
let dataCache: IHeatingSystem;

export = (api: API) => {
  hap = api.hap;
  Accessory = api.platformAccessory;

  api.registerPlatform(PLATFORM_NAME, ArduinoPlatform);
};

class ArduinoPlatform implements DynamicPlatformPlugin {
  private readonly log: Logging;
  private readonly api: API;
  private readonly config: PlatformConfig;

  private readonly accessories: PlatformAccessory[] = [];

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log;
    this.api = api;
    this.config = config;

    mutex = new Mutex();

    ip = this.config.ip;
    port = this.config.port;

    // probably parse config or something here

    log.info("Arduino platform finished initializing!");

    /*
     * When this event is fired, homebridge restored all cached accessories from disk and did call their respective
     * `configureAccessory` method for all of them. Dynamic Platform plugins should only register new accessories
     * after this event was fired, in order to ensure they weren't added to homebridge already.
     * This event can also be used to start discovery of new accessories.
     */
    api.on(APIEvent.DID_FINISH_LAUNCHING, async () => {
      log.info("Arduino platform 'didFinishLaunching'");
      if (!data) {
        data = await this.fetchData();
      }

      // Add all sensors from room
      Object.keys(data.rooms).forEach((room) => {
        this.addTemperaturSensorIfNotExist(room, "$.rooms." + room);
      });

      Object.keys(data.heaters).forEach((heater) => {
        this.addThermostatIfNotExist(`hk_${heater}`, "$.heaters." + heater);
      });

      // add vorlauf, ruecklauf
      this.addTemperaturSensorIfNotExist("Vorlauf", "$.distributor.Vorlauf");
      this.addTemperaturSensorIfNotExist(
        "Ruecklauf",
        "$.distributor.Ruecklauf"
      );

      this.addSwitchIfNotExist("Pumpe", "$.distributor.Pumpe");

      this.addThermostatIfNotExist("Mixer", "$.distributor.Mixer");
    });
  }

  /*
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to setup event handlers for characteristics and update respective values.
   */
  configureAccessory(accessory: PlatformAccessory): void {
    this.log("Configuring accessory %s", accessory.displayName);

    accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      this.log("%s identified!", accessory.displayName);
    });

    accessory.services.forEach((service) => {
      service.characteristics.forEach((characteristic) => {
        if (characteristic instanceof hap.Characteristic.CurrentTemperature) {
          characteristic.onGet(
            this.handleCurrentTemperatureGet({
              name: accessory.displayName,
              context: accessory.context,
            })
          );
        }

        if (
          characteristic instanceof
          hap.Characteristic.CurrentHeatingCoolingState
        ) {
          characteristic.onGet(
            this.handleCurrentHeatingCoolingStateGet({
              name: accessory.displayName,
              context: accessory.context,
            })
          );
        }

        if (characteristic instanceof hap.Characteristic.On) {
          characteristic.onGet(
            this.handleSwitchGet({
              name: accessory.displayName,
              context: accessory.context,
            })
          );
          //            .onSet();
        }
      });
    });

    this.accessories.push(accessory);
  }

  // --------------------------- CUSTOM METHODS ---------------------------

  addSwitchIfNotExist(name: string, path: string) {
    this.log.info("Adding new switch with name %s", name);

    // uuid must be generated from a unique but not changing data source, name should not be used in the most cases.
    // But works in this specific example
    const uuid = hap.uuid.generate(name);
    if (this.accessories.find((accessory) => accessory.UUID === uuid)) {
      return;
    }

    const accessory = new Accessory(name, uuid);

    accessory.context.path = path;

    accessory.addService(hap.Service.Switch, name);

    this.configureAccessory(accessory); // abusing the configureAccessory here

    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
      accessory,
    ]);
  }

  addTemperaturSensorIfNotExist(name: string, path: string) {
    this.log.info("Adding new temperatur sensor with name %s", name);

    // uuid must be generated from a unique but not changing data source, name should not be used in the most cases.
    // But works in this specific example
    const uuid = hap.uuid.generate(name);
    if (this.accessories.find((accessory) => accessory.UUID === uuid)) {
      return;
    }

    const accessory = new Accessory(name, uuid);

    accessory.context.path = path;

    accessory.addService(hap.Service.TemperatureSensor, name);

    this.configureAccessory(accessory); // abusing the configureAccessory here

    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
      accessory,
    ]);
  }

  addThermostatIfNotExist(name: string, path: string) {
    this.log.info("Adding new thermostat  with name %s", name);

    // uuid must be generated from a unique but not changing data source, name should not be used in the most cases.
    // But works in this specific example
    const uuid = hap.uuid.generate(name);
    if (this.accessories.find((accessory) => accessory.UUID === uuid)) {
      return;
    }

    const accessory = new Accessory(name, uuid);

    accessory.context.path = path;

    accessory.addService(hap.Service.Thermostat, name);

    this.configureAccessory(accessory); // abusing the configureAccessory here

    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
      accessory,
    ]);
  }
  // ----------------------------------------------------------------------

  handleCurrentTemperatureGet(ctx: {
    name: string;
    context?: UnknownContext;
  }): CharacteristicGetHandler {
    return async () => {
      return this.fetchData()
        .then((d) => {
          console.log(`[handleCurrentTemperatureGet] ${ctx.name}`);
          const path = (
            ctx.context?.path ? ctx.context.path : "$.rooms." + ctx.name
          ) as string;
          const sensor = jp.value(d, path);
          if (path.startsWith("$.rooms.")) {
            return sensor.temperature ? sensor.temperature : NaN;
          } else if (path.startsWith("$.heaters.")) {
            return sensor.level ? sensor.level : NaN;
          } else if (path.startsWith("$.distributor.Vorlauf")) {
            return sensor.temperature ? sensor.temperature : NaN;
          } else if (path.startsWith("$.distributor.Ruecklauf")) {
            return sensor.temperature ? sensor.temperature : NaN;
          } else if (path.startsWith("$.distributor.Mixer")) {
            return sensor.level ? sensor.level : NaN;
          } else {
            return NaN;
          }
        })
        .catch(() => NaN);
    };
  }

  handleCurrentHeatingCoolingStateGet(ctx: {
    name: string;
    context?: UnknownContext;
  }): CharacteristicGetHandler {
    return async () => {
      return this.fetchData()
        .then((d) => {
          console.log(`[handleCurrentHeatingCoolingStateGet] ${ctx.name}`);
          const sensor = jp.value(d, ctx.context?.path);

          return sensor.levelReached === 1
            ? hap.Characteristic.CurrentHeatingCoolingState.OFF
            : hap.Characteristic.CurrentHeatingCoolingState.HEAT;
        })
        .catch(() => NaN);
    };
  }

  handleSwitchGet(ctx: {
    name: string;
    context?: UnknownContext;
  }): CharacteristicGetHandler {
    return async () => {
      return this.fetchData()
        .then((d) => {
          console.log(`[handleSwitchGet] ${ctx.name}`);
          const path = ctx.context?.path ? ctx.context.path : "undefined";
          const sensor = jp.value(d, path);
          return sensor.stage ? sensor.state : NaN;
        })
        .catch(() => NaN);
    };
  }

  async fetchData(): Promise<IHeatingSystem> {
    const sleep = (milliseconds: number | undefined) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds));

    return mutex
      .runExclusive(async () => {
        if (Date.now() - lastFetch > 60000) {
          const client = new ArduinoGateway(new IPv4(ip), port);
          console.log(`${Date.now()} [fetchData] Start fetching data`);
          const result = await convertToHeatingSystem(client.getStatus());
          console.log(
            `${Date.now()} [fetchData] result: ${JSON.stringify(
              result?.system.Uptime
            )}`
          );
          await sleep(200);
          if (result) {
            console.log(
              `[fetchData] update cache ${JSON.stringify(result.system.Uptime)}`
            );
            dataCache = result;
            lastFetch = Date.now();
          }
        } else {
          console.log(
            `[fetchData] use cache ${JSON.stringify(dataCache.system.Uptime)}`
          );
        }
      })
      .then(() => {
        return dataCache;
      });
  }
}
