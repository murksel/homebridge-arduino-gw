import { ArduinoResult } from './arduinogateway';

export interface TemperatureSensor {
  temperature: number;
  temperatureRaw: number;
}
export enum HeatingMode {
  cooling,
  reached,
  heating,
}
export interface Heater {
  isMaintenance: boolean;
  maintenanceLevel: number; // in percent 0-100
  level: number; // in percent 0-100
  levelReached: HeatingMode;
  targetLevel: number;
}

export enum Raeume {
  Arbeiten = 'Arbeiten',
  Bad = 'Bad',
  Diele = 'Diele',
  Treppe = 'Treppe',
  WGarten = 'WGarten',
  Wohnen = 'Wohnen',
}
export enum Heaters {
  Arbeiten = 'Arbeiten',
  Bad = 'Bad',
  Diele = 'Diele',
  Treppe = 'Treppe',
  Essen = 'Essen',
  Kueche = 'Kueche',
  WohnenL = 'WohnenL',
  WohnenR = 'WohnenR',
}

export interface IHeatingSystem {
  rooms: {
    [key in Raeume]: TemperatureSensor;
  };
  heaters: {
    [key in Heaters]: Heater;
  };
  distributor: {
    Pumpe: { state: boolean };
    Vorlauf: TemperatureSensor;
    Ruecklauf: TemperatureSensor;
    Mixer: Heater;
  };
  system: {
    Version: string;
    Uptime: string;
    Threads: number;
  };
}

export async function convertToHeatingSystem(
  arduino: Promise<ArduinoResult>,
): Promise<IHeatingSystem> {
  return arduino.then((a) => {
    // console.log(a);
    return {
      rooms: {
        ...Object.values(Raeume).reduce(
          (memo, key) => ({
            ...memo,
            [key]: {
              temperature: parseFloat(a[key]),
              temperatureRaw: parseFloat(a[`tc${key}`]),
            } as TemperatureSensor,
          }),
          {} as IHeatingSystem['rooms'],
        ),
      },
      heaters: {
        ...Object.values(Heaters).reduce(
          (memo, key) => ({
            ...memo,
            [key]: {
              isMaintenance: !a[`mtn${key}`],
              maintenanceLevel: parseFloat(a[`mtnp${key}`]),
              level: parseFloat(a[`akt${key}`]),
              levelReached: parseFloat(a[`rch${key}`]),
              targetLevel: parseFloat(a[`tgt${key}`]),
            } as Heater,
          }),
          {} as IHeatingSystem['heaters'],
        ),
      },
      distributor: {
        Pumpe: { state: !a['sswsPumpe'] },
        Vorlauf: {
          temperature: parseFloat(a['Vorlauf']),
          temperatureRaw: parseFloat(a['tcVorlauf']),
        },
        Ruecklauf: {
          temperature: parseFloat(a['Ruecklauf']),
          temperatureRaw: parseFloat(a['tcRuecklauf']),
        },
        Mixer: {
          isMaintenance: !a[`mtnMixer`],
          maintenanceLevel: parseFloat(a[`mtnpMixer`]),
          level: parseFloat(a[`aktMixer`]),
          levelReached: parseFloat(a[`rchMixer`]),
          targetLevel: parseFloat(a[`tgtMixer`]),
        },
      },
      system: {
        Version: a['version'],
        Uptime: a['uptime'],
        Threads: parseFloat(a['cntThreads']),
      },
    };
  });
}
