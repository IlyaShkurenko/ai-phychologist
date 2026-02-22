import type { GaslightingPromptSet, PromptStep, PromptStepState, PromptThemeState, PromptVersion } from "./types.js";

interface PromptVersionDoc {
  _id: unknown;
  theme: "gaslighting";
  step: PromptStep;
  version: number;
  content: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface MongoModule {
  MongoClient: new (uri: string, options?: Record<string, unknown>) => {
    connect: () => Promise<void>;
    db: (name: string) => {
      collection: (name: string) => {
        createIndex: (key: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
        find: (query: Record<string, unknown>) => {
          sort: (sort: Record<string, unknown>) => {
            limit: (value: number) => {
              toArray: () => Promise<PromptVersionDoc[]>;
            };
            toArray: () => Promise<PromptVersionDoc[]>;
          };
          toArray: () => Promise<PromptVersionDoc[]>;
        };
        findOne: (query: Record<string, unknown>) => Promise<PromptVersionDoc | null>;
        countDocuments: (query: Record<string, unknown>) => Promise<number>;
        insertOne: (doc: Omit<PromptVersionDoc, "_id">) => Promise<{ insertedId: unknown }>;
        updateMany: (query: Record<string, unknown>, update: Record<string, unknown>) => Promise<unknown>;
        updateOne: (query: Record<string, unknown>, update: Record<string, unknown>) => Promise<unknown>;
      };
    };
  };
  ObjectId: new (id?: string) => { toHexString: () => string };
}

const GASLIGHTING_STEPS: PromptStep[] = ["step1", "step2", "step3"];

async function importMongoModule(): Promise<MongoModule> {
  const dynamicImport = new Function("moduleName", "return import(moduleName);") as (
    moduleName: string,
  ) => Promise<unknown>;
  try {
    return (await dynamicImport("mongodb")) as MongoModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `MongoDB driver is not available (${message}). Install it with: npm i mongodb --workspace api`,
    );
  }
}

export class PromptRepository {
  private readonly mongoUri: string | undefined;
  private readonly dbName: string;
  private readonly collectionName: string;
  private mongoModule: MongoModule | null = null;
  private collection: any = null;
  private readyPromise: Promise<void> | null = null;

  constructor(config: { mongoUri?: string; dbName?: string; collectionName?: string }) {
    this.mongoUri = config.mongoUri?.trim();
    this.dbName = config.dbName?.trim() || "telegram_chat_analyzer";
    this.collectionName = config.collectionName?.trim() || "prompt_versions";
  }

  isEnabled(): boolean {
    return Boolean(this.mongoUri);
  }

  async getGaslightingThemeState(defaults: GaslightingPromptSet): Promise<PromptThemeState> {
    const collection = await this.ensureCollection();
    await this.ensureSeed(defaults, collection);
    const docs = (await collection
      .find({ theme: "gaslighting" })
      .sort({ step: 1, version: -1 })
      .toArray()) as PromptVersionDoc[];
    const steps = GASLIGHTING_STEPS.map((step) => {
      const stepDocs = docs.filter((item: PromptVersionDoc) => item.step === step);
      const versions = stepDocs.map((item: PromptVersionDoc) => this.mapDoc(item));
      const active = versions.find((item: PromptVersion) => item.isActive);
      return {
        step,
        versions,
        activeVersionId: active?.id,
      } satisfies PromptStepState;
    });
    return {
      theme: "gaslighting",
      steps,
    };
  }

  async createGaslightingVersion(step: PromptStep, content: string, defaults: GaslightingPromptSet): Promise<PromptVersion> {
    const collection = await this.ensureCollection();
    await this.ensureSeed(defaults, collection);
    const latest = (await collection
      .find({ theme: "gaslighting", step })
      .sort({ version: -1 })
      .limit(1)
      .toArray()) as PromptVersionDoc[];
    const latestVersion = latest[0]?.version ?? 0;
    const now = new Date();
    const doc = {
      theme: "gaslighting" as const,
      step,
      version: latestVersion + 1,
      content,
      isActive: false,
      createdAt: now,
      updatedAt: now,
    };
    const inserted = await collection.insertOne(doc);
    return this.mapDoc({
      _id: inserted.insertedId,
      ...doc,
    });
  }

  async activateGaslightingVersion(step: PromptStep, versionId: string, defaults: GaslightingPromptSet): Promise<void> {
    const collection = await this.ensureCollection();
    await this.ensureSeed(defaults, collection);
    const mongo = await this.ensureMongoModule();
    let objectId: InstanceType<MongoModule["ObjectId"]>;
    try {
      objectId = new mongo.ObjectId(versionId);
    } catch {
      throw new Error("Invalid prompt version id");
    }

    const target = await collection.findOne({
      _id: objectId,
      theme: "gaslighting",
      step,
    });
    if (!target) {
      throw new Error("Prompt version not found");
    }

    const now = new Date();
    await collection.updateMany(
      { theme: "gaslighting", step, isActive: true },
      { $set: { isActive: false, updatedAt: now } },
    );
    await collection.updateOne({ _id: objectId }, { $set: { isActive: true, updatedAt: now } });
  }

  async getActiveGaslightingPromptSet(defaults: GaslightingPromptSet): Promise<GaslightingPromptSet> {
    const collection = await this.ensureCollection();
    await this.ensureSeed(defaults, collection);
    const docs = (await collection
      .find({ theme: "gaslighting" })
      .sort({ step: 1, version: -1 })
      .toArray()) as PromptVersionDoc[];
    const result: GaslightingPromptSet = { ...defaults };
    for (const step of GASLIGHTING_STEPS) {
      const stepDocs = docs.filter((item: PromptVersionDoc) => item.step === step);
      const active = stepDocs.find((item: PromptVersionDoc) => item.isActive) ?? stepDocs[0];
      if (active?.content) {
        result[step] = active.content;
      }
    }
    return result;
  }

  private async ensureSeed(
    defaults: GaslightingPromptSet,
    collection: any,
  ): Promise<void> {
    for (const step of GASLIGHTING_STEPS) {
      const count = await collection.countDocuments({ theme: "gaslighting", step });
      if (count === 0) {
        const now = new Date();
        await collection.insertOne({
          theme: "gaslighting",
          step,
          version: 1,
          content: defaults[step],
          isActive: true,
          createdAt: now,
          updatedAt: now,
        });
        continue;
      }
      const active = await collection.findOne({ theme: "gaslighting", step, isActive: true });
      if (!active) {
        const latest = (await collection
          .find({ theme: "gaslighting", step })
          .sort({ version: -1 })
          .limit(1)
          .toArray()) as PromptVersionDoc[];
        const latestDoc = latest[0];
        if (latestDoc?._id) {
          await collection.updateOne({ _id: latestDoc._id }, { $set: { isActive: true, updatedAt: new Date() } });
        }
      }
    }
  }

  private async ensureCollection(): Promise<any> {
    if (!this.isEnabled()) {
      throw new Error("MongoDB is not configured. Set MONGODB_URI.");
    }
    if (!this.readyPromise) {
      this.readyPromise = this.initialize().catch((error) => {
        // Allow retry on next request after transient TLS/network failures.
        this.readyPromise = null;
        this.collection = null;
        throw error;
      });
    }
    await this.readyPromise;
    if (!this.collection) {
      throw new Error("MongoDB prompt collection is not initialized");
    }
    return this.collection;
  }

  private async ensureMongoModule(): Promise<MongoModule> {
    if (!this.mongoModule) {
      this.mongoModule = await importMongoModule();
    }
    return this.mongoModule;
  }

  private async initialize(): Promise<void> {
    const mongo = await this.ensureMongoModule();
    const client = new mongo.MongoClient(this.mongoUri as string);
    await client.connect();
    const db = client.db(this.dbName);
    const collection = db.collection(this.collectionName);
    await Promise.all([
      collection.createIndex({ theme: 1, step: 1, version: 1 }, { unique: true }),
      collection.createIndex({ theme: 1, step: 1, isActive: 1 }),
      collection.createIndex({ theme: 1, step: 1, createdAt: -1 }),
    ]);
    this.collection = collection;
  }

  private mapDoc(doc: PromptVersionDoc): PromptVersion {
    const mongoId = doc._id as { toHexString?: () => string } | string;
    const id = typeof mongoId === "string" ? mongoId : mongoId.toHexString?.() ?? String(mongoId);
    return {
      id,
      theme: doc.theme,
      step: doc.step,
      version: doc.version,
      content: doc.content,
      isActive: doc.isActive,
      createdAt: new Date(doc.createdAt).toISOString(),
      updatedAt: new Date(doc.updatedAt).toISOString(),
    };
  }
}
