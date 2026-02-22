interface MongoModule {
  MongoClient: new (uri: string, options?: Record<string, unknown>) => {
    connect: () => Promise<void>;
    db: (name: string) => {
      collection: (name: string) => {
        createIndex: (key: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
        updateOne: (
          query: Record<string, unknown>,
          update: Record<string, unknown>,
          options?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
    };
  };
}

interface GeoIpLiteModule {
  lookup: (ip: string) => GeoIpLiteLookup | null;
}

interface GeoIpLiteLookup {
  range?: [number, number];
  country?: string;
  region?: string;
  city?: string;
  ll?: [number, number];
  metro?: number;
  area?: number;
  eu?: string;
  timezone?: string;
}

async function importMongoModule(): Promise<MongoModule> {
  const dynamicImport = new Function("moduleName", "return import(moduleName);") as (
    moduleName: string,
  ) => Promise<unknown>;
  return (await dynamicImport("mongodb")) as MongoModule;
}

async function importGeoIpLite(): Promise<GeoIpLiteModule | null> {
  const dynamicImport = new Function("moduleName", "return import(moduleName);") as (
    moduleName: string,
  ) => Promise<unknown>;
  try {
    const mod = (await dynamicImport("geoip-lite")) as { default?: GeoIpLiteModule } & Partial<GeoIpLiteModule>;
    return (mod.default ?? mod) as GeoIpLiteModule;
  } catch {
    return null;
  }
}

export interface ConnectContextPayload {
  sessionId: string;
  ip?: string;
  userAgent?: string;
  browserLocale?: string;
  browserLanguages?: string[];
  timeZone?: string;
  screen?: {
    width?: number;
    height?: number;
    pixelRatio?: number;
  };
}

export class SessionMetaRepository {
  private readonly mongoUri?: string;
  private readonly dbName: string;
  private readonly collectionName: string;
  private readyPromise: Promise<void> | null = null;
  private collection: any = null;
  private geoIpModulePromise: Promise<GeoIpLiteModule | null> | null = null;

  constructor(config: { mongoUri?: string; dbName?: string; collectionName?: string }) {
    this.mongoUri = config.mongoUri?.trim();
    this.dbName = config.dbName?.trim() || "telegram_chat_analyzer";
    this.collectionName = config.collectionName?.trim() || "session_connect_events";
  }

  isEnabled(): boolean {
    return Boolean(this.mongoUri);
  }

  async saveConnectContext(payload: ConnectContextPayload): Promise<void> {
    const collection = await this.ensureCollection();
    const geo = await this.lookupGeo(payload.ip);
    const now = new Date();

    await collection.updateOne(
      { sessionId: payload.sessionId },
      {
        $set: {
          sessionId: payload.sessionId,
          source: "connect_click",
          updatedAt: now,
          ip: payload.ip ?? null,
          userAgent: payload.userAgent ?? null,
          browserLocale: payload.browserLocale ?? null,
          browserLanguages: payload.browserLanguages ?? [],
          timeZone: payload.timeZone ?? null,
          screen: payload.screen ?? null,
          geo,
        },
        $setOnInsert: {
          createdAt: now,
        },
      },
      { upsert: true },
    );
  }

  private async ensureCollection(): Promise<any> {
    const mongoUri = this.mongoUri;
    if (!mongoUri) {
      throw new Error("MongoDB is not configured. Set MONGODB_URI.");
    }

    if (!this.readyPromise) {
      this.readyPromise = (async () => {
        const mongo = await importMongoModule();
        const client = new mongo.MongoClient(mongoUri);
        await client.connect();
        const db = client.db(this.dbName);
        const collection = db.collection(this.collectionName);
        await collection.createIndex({ sessionId: 1 }, { unique: true });
        await collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });
        this.collection = collection;
      })().catch((error) => {
        this.readyPromise = null;
        this.collection = null;
        throw error;
      });
    }

    await this.readyPromise;
    if (!this.collection) {
      throw new Error("Session meta collection is not initialized");
    }
    return this.collection;
  }

  private async lookupGeo(ip?: string): Promise<Record<string, unknown> | null> {
    const normalizedIp = normalizeIp(ip);
    if (!normalizedIp) {
      return null;
    }
    if (!this.geoIpModulePromise) {
      this.geoIpModulePromise = importGeoIpLite();
    }
    const geoIp = await this.geoIpModulePromise;
    if (!geoIp) {
      return {
        provider: "geoip-lite",
        status: "module_missing",
      };
    }

    const hit = geoIp.lookup(normalizedIp) as GeoIpLiteLookup | null;
    if (!hit) {
      return {
        provider: "geoip-lite",
        status: "not_found",
      };
    }

    return {
      provider: "geoip-lite",
      status: "ok",
      country: hit.country ?? null,
      region: hit.region ?? null,
      city: hit.city ?? null,
      timezone: hit.timezone ?? null,
      ll:
        Array.isArray(hit.ll) && hit.ll.length === 2
          ? [roundCoord(hit.ll[0]), roundCoord(hit.ll[1])]
          : null,
      eu: hit.eu ?? null,
    };
  }
}

function roundCoord(value: number): number {
  return Math.round(value * 100) / 100;
}

function normalizeIp(ip?: string): string | null {
  if (!ip) {
    return null;
  }
  const trimmed = ip.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "::1" || trimmed === "127.0.0.1") {
    return null;
  }
  if (trimmed.startsWith("::ffff:")) {
    return trimmed.slice("::ffff:".length);
  }
  return trimmed;
}
