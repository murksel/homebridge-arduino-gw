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
} from "homebridge";
import { IPv4 } from "ip-num";
import { ArduinoGateway } from "./arduinogateway";
import { convertToHeatingSystem, IHeatingSystem } from "./heizung";

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
const lastFetch: Date = new Date(0);
let ip: string;
let port: number;

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
      Object.keys(data.rooms).forEach((room) => {
        const uuid = this.api.hap.uuid.generate(room);

        const existingAccessory = this.accessories.find(
          (accessory) => accessory.UUID === uuid
        );

        if (!existingAccessory) {
          this.addAccessory(room);
        }
      });
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

    accessory
      .getService(hap.Service.TemperatureSensor)!
      .getCharacteristic(hap.Characteristic.CurrentTemperature)
      .onGet(this.handleCurrentTemperatureGet(accessory.displayName));

    this.accessories.push(accessory);
  }

  // --------------------------- CUSTOM METHODS ---------------------------

  addAccessory(name: string) {
    this.log.info("Adding new accessory with name %s", name);

    // uuid must be generated from a unique but not changing data source, name should not be used in the most cases.
    // But works in this specific example
    const uuid = hap.uuid.generate(name);
    const accessory = new Accessory(name, uuid);

    accessory.addService(hap.Service.TemperatureSensor, name);

    this.configureAccessory(accessory); // abusing the configureAccessory here

    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
      accessory,
    ]);
  }

  // ----------------------------------------------------------------------

  handleCurrentTemperatureGet(name: string): CharacteristicGetHandler {
    return async () => {
      return this.fetchData().then((d) => {
        const _data = d.rooms[name].temperature;
        return _data ? _data : data?.rooms[name].temperature;
      });
    };
  }

  async fetchData(): Promise<IHeatingSystem> {
    const client = new ArduinoGateway(new IPv4(ip), port);
    this.log.info("Start fetching data");
    return convertToHeatingSystem(client.getStatus());
  }
}
