import { readWorkspaceFile, writeWorkspaceFile } from "./api";

export type WeatherKind = "sunny" | "overcast" | "rain" | "snow";

export const WEATHER_LABELS: Record<WeatherKind, string> = {
  sunny: "晴",
  overcast: "阴",
  rain: "雨",
  snow: "雪"
};

const FILE = "/data/storage/schedule-block/weather.json";

interface WeatherPayload {
  version: number;
  updated: string;
  days: Record<string, WeatherKind>;
}

function isWeatherKind(value: unknown): value is WeatherKind {
  return value === "sunny" || value === "overcast" || value === "rain" || value === "snow";
}

export class WeatherStore {
  days: Record<string, WeatherKind> = {};
  onRemoteChange?: () => void;
  private channel: BroadcastChannel | null = null;
  private persistLock: Promise<void> = Promise.resolve();

  constructor() {
    try {
      this.channel = new BroadcastChannel("schedule-block-weather");
      this.channel.onmessage = async () => {
        try {
          await this.load();
          this.onRemoteChange?.();
        } catch {
          // 天气状态是辅助信息，远端同步失败不影响日程显示
        }
      };
    } catch {
      this.channel = null;
    }
  }

  async load(): Promise<void> {
    const text = await readWorkspaceFile(FILE);
    if (!text) {
      this.days = {};
      return;
    }
    const parsed = JSON.parse(text) as Partial<WeatherPayload>;
    const next: Record<string, WeatherKind> = {};
    if (parsed.days && typeof parsed.days === "object") {
      for (const [date, kind] of Object.entries(parsed.days)) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(date) && isWeatherKind(kind)) {
          next[date] = kind;
        }
      }
    }
    this.days = next;
  }

  get(date: string): WeatherKind | undefined {
    return this.days[date];
  }

  async set(date: string, kind: WeatherKind | ""): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return;
    }
    if (kind) {
      this.days[date] = kind;
    } else {
      delete this.days[date];
    }
    await this.persist();
  }

  private async persist(): Promise<void> {
    const run = async () => {
      const payload: WeatherPayload = {
        version: 1,
        updated: new Date().toISOString(),
        days: this.days
      };
      await writeWorkspaceFile(FILE, JSON.stringify(payload, null, 2));
    };
    const task = this.persistLock.then(run, run);
    this.persistLock = task.then(
      () => undefined,
      () => undefined
    );
    await task;
    this.channel?.postMessage("changed");
  }
}
