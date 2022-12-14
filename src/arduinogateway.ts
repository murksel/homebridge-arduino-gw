import { IPv4 } from "ip-num";
import { Socket } from "net";
import { v4 as uuidv4 } from "uuid";

type ArduinoValue = { key: string; value: string };

export interface ArduinoResult {
  [index: string]: string;
}

const maximumUpdateIntervallMillis = 2000;

export class ArduinoGateway {
  private _host: IPv4;
  private _port: number;
  private _status: ArduinoResult;
  public get status(): ArduinoResult {
    return this._status;
  }

  private _lastUpdate = new Date(0);
  private _client: Socket | undefined = undefined;
  private _updateList: ArduinoValue[];
  private _streamStarter: string | undefined;
  private waitForStream = false;
  private _promise: Promise<ArduinoResult> | undefined;

  constructor(host: IPv4, port: number) {
    this._host = host;
    this._port = port;
    this._status = {};
    this._updateList = [];
    this._streamStarter = undefined;
    this._promise = undefined;
  }

  private async runGetAndSet(): Promise<ArduinoResult> {
    return this.setAndGetArduino().then((r) => r);
  }

  public getStatus(): Promise<ArduinoResult> {
    console.log("getStatus");
    return this.runGetAndSet();
  }

  public update(value: ArduinoValue): Promise<ArduinoResult> {
    console.log("update", value);
    this._updateList.push(value);
    return this.runGetAndSet();
  }

  public sync(value: string): Promise<ArduinoResult> {
    console.log("sync", value);
    if (
      this._updateList.length > 0 &&
      this._updateList[this._updateList.length - 1].key === "Sync" &&
      this._updateList[this._updateList.length - 1].value === value
    ) {
      return this.runGetAndSet();
    }
    return this.update({ key: "Sync", value: value });
  }

  private updateVariable(arduinoVar: ArduinoValue): void {
    console.log(`update. ${arduinoVar.key}=${arduinoVar.value}`);
    if (!this._client?.write(`#${arduinoVar.key}=${arduinoVar.value}#`)) {
      console.log(`update: write not fullfilled`);
    }
  }

  public setAndGetArduino(): Promise<ArduinoResult> {
    // console.log('setAndGetArduino started');
    const uuid = uuidv4();

    if (this._promise) {
      console.log(Date.now(), uuid, "reuse promise");
      return this._promise;
    }
    console.log(uuid, "new promise");
    this._promise = new Promise<ArduinoResult>((resolve, reject) => {
      // console.log('setAndGetArduino promise started');
      // console.log(Date.now(), uuid, `state: ${this._client?.readyState}`);
      let leftRounds = 1;
      if (
        Date.now() - this._lastUpdate.getTime() >
          maximumUpdateIntervallMillis ||
        this._updateList.length > 0
      ) {
        this._client = new Socket();
        this._client
          .setTimeout(5000)
          .connect(this._port, this._host.toString())
          .on("connect", () => {
            console.log(uuid, `connected`);
            this.waitForStream = true;
            this._client?.write("\n");
          })
          .on("data", (data: Buffer) => {
            // console.log(uuid, `Socket data: ${data}`);
            data
              .toString("ascii")
              .split("#")
              .forEach((d) => {
                const r = d.split("=");
                if (r[0] === "") {
                  return;
                }

                // Wieder am anfang und es war die letzte Runden.
                if (leftRounds === 0 && r[0] === this._streamStarter) {
                  console.log(uuid, `all jobs finished. destroy`);
                  this._client?.destroy();
                  return;
                }

                if (this._updateList.length > 0) {
                  this.updateVariable(this._updateList.splice(0, 1)[0]);
                  leftRounds = 2;
                }

                if (r[0] === this._streamStarter) {
                  console.log(uuid, "saw streamstarter");
                  leftRounds--;
                }

                this._status[r[0]] = r[1];
                if (r[0] === "tgtMixer") {
                  console.log(uuid, "saw tgtMixer");
                }

                if (this._streamStarter === undefined) {
                  console.log(uuid, `set streamstarter to ${r[0]}`);
                  this._streamStarter = r[0];
                }
              });
          })
          .on("drain", () => {
            console.log(uuid, "Socket drain");
          })
          .on("error", (err: Error) => {
            console.log(uuid, "Socket error");
            this._promise = undefined;
            reject(err);
          })
          .on("timeout", () => {
            console.log(uuid, "Socket timed out");
            this._client?.destroy();
          })
          .on("close", () => {
            // console.log('setAndGetArduino promise resolved');
            this._lastUpdate = new Date();
            this._promise = undefined;
            resolve(this._status);
            console.log(uuid, "Socket closed");
          });
        console.log("setAndGetArduino promise finished");
      } else {
        console.log(Date.now(), uuid, "reuse status");
        resolve(this._status);
        const f = async (): Promise<void> => {
          console.log(Date.now(), uuid, "remove promise");
          this._promise = undefined;
        };
        f();
      }
    });
    return this._promise;
  }

  public get host(): IPv4 {
    return this._host;
  }

  public set host(value: IPv4) {
    this.host = value;
  }
}
