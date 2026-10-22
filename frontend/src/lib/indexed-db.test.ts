import { describe, expect, it } from "vitest";
import { poolConfigFromEnv } from "./indexed-db";

const DATABASE_URL = "postgresql://prism:prism@db.example.com:5432/prism";

describe("poolConfigFromEnv", () => {
  it("keeps pg's defaults when nothing is configured", () => {
    expect(poolConfigFromEnv({ DATABASE_URL })).toEqual({
      connectionString: DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 10_000,
      ssl: undefined,
    });
  });

  it("reads the pool size and idle timeout", () => {
    const config = poolConfigFromEnv({
      DATABASE_URL,
      DATABASE_POOL_MAX: "25",
      DATABASE_IDLE_TIMEOUT_MS: "5000",
    });
    expect(config.max).toBe(25);
    expect(config.idleTimeoutMillis).toBe(5000);
  });

  it("ignores surrounding whitespace and empty values", () => {
    const config = poolConfigFromEnv({
      DATABASE_URL,
      DATABASE_POOL_MAX: " 25 ",
      DATABASE_IDLE_TIMEOUT_MS: "",
    });
    expect(config.max).toBe(25);
    expect(config.idleTimeoutMillis).toBe(10_000);
  });

  it("enables TLS with certificate verification for DATABASE_SSL=true", () => {
    expect(poolConfigFromEnv({ DATABASE_URL, DATABASE_SSL: "true" }).ssl).toBe(true);
  });

  it("encrypts without verification for DATABASE_SSL=no-verify", () => {
    expect(poolConfigFromEnv({ DATABASE_URL, DATABASE_SSL: "no-verify" }).ssl).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("leaves TLS off for DATABASE_SSL=false", () => {
    expect(poolConfigFromEnv({ DATABASE_URL, DATABASE_SSL: "false" }).ssl).toBeUndefined();
  });

  it("rejects values that would silently change behaviour", () => {
    expect(() => poolConfigFromEnv({ DATABASE_POOL_MAX: "ten" })).toThrow(/DATABASE_POOL_MAX/);
    expect(() => poolConfigFromEnv({ DATABASE_POOL_MAX: "0" })).toThrow(/DATABASE_POOL_MAX/);
    expect(() => poolConfigFromEnv({ DATABASE_IDLE_TIMEOUT_MS: "-1" })).toThrow(
      /DATABASE_IDLE_TIMEOUT_MS/
    );
    expect(() => poolConfigFromEnv({ DATABASE_SSL: "yes" })).toThrow(/DATABASE_SSL/);
  });
});
