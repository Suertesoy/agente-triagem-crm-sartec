import { shadowEntityRevisionKey } from "../crm-shadow-write/revision.js";

export class RedisCrmStore {
  constructor(redis) {
    this.redis = redis;
  }

  async scan(pattern, count = 200) {
    let cursor = "0";
    const keys = [];
    do {
      const [next, batch] = await this.redis.scan(
        cursor,
        "MATCH",
        pattern,
        "COUNT",
        count
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== "0");
    return [...new Set(keys)].sort();
  }

  async readJson(key) {
    const raw = await this.redis.get(key);
    if (raw == null) return { key, exists: false, value: null, error: null };
    try {
      return { key, exists: true, value: JSON.parse(raw), error: null };
    } catch (error) {
      return { key, exists: true, value: null, error: error.message };
    }
  }

  async contactEntries() {
    const keys = await this.scan("sartec:contact:*");
    return Promise.all(keys.map((key) => this.readJson(key)));
  }

  async sessionEntries() {
    const keys = (await this.scan("sartec:*")).filter((key) => /^sartec:\d{10,15}$/.test(key));
    return Promise.all(keys.map((key) => this.readJson(key)));
  }

  async pipelineOrderEntry() {
    return this.readJson("sartec:pipelineOrder");
  }

  async entityRevision(entityType, entityKey) {
    const raw = await this.redis.get(shadowEntityRevisionKey(entityType, entityKey));
    const revision = Number(raw);
    return Number.isSafeInteger(revision) && revision >= 0 ? revision : 0;
  }
}
