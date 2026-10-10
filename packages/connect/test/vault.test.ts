import { describe, expect, it } from "vitest";
import { localKeyProvider } from "@aaply/connect";
import { createVault, type WrappedDataKey } from "../src/vault.js";

function memoryKeys() {
  const keys = new Map<string, WrappedDataKey>();
  let created = 0;
  return {
    created: () => created,
    async currentDataKey(tenantId: string, create: () => Promise<WrappedDataKey>) {
      let k = keys.get(tenantId);
      if (!k) {
        k = await create();
        created++;
        keys.set(tenantId, k);
      }
      return k;
    },
    get: (tenantId: string) => keys.get(tenantId)!,
  };
}

describe("the vault", () => {
  const provider = localKeyProvider({ keyId: "local-1", key: new Uint8Array(32).fill(7) });

  it("seals and opens a secret, one data key per tenant", async () => {
    const store = memoryKeys();
    const vault = createVault({ keys: provider, store });
    const sealed = await vault.seal("t1", "conn_a", 1, { accessToken: "secret-token" });
    expect(Buffer.from(sealed.sealed).toString("utf8")).not.toContain("secret-token");
    expect(await vault.open("t1", "conn_a", sealed, store.get("t1"))).toEqual({ accessToken: "secret-token" });
    await vault.seal("t1", "conn_b", 1, { accessToken: "x" });
    await vault.seal("t2", "conn_c", 1, { accessToken: "x" });
    expect(store.created()).toBe(2);
  });

  it("does not open a secret under another tenant, connection or version", async () => {
    const store = memoryKeys();
    const vault = createVault({ keys: provider, store });
    const sealed = await vault.seal("t1", "conn_a", 3, { k: "v" });
    const key = store.get("t1");
    await expect(vault.open("t1", "conn_b", sealed, key)).rejects.toThrow();
    await expect(vault.open("t1", "conn_a", { ...sealed, version: 4 }, key)).rejects.toThrow();
    await expect(vault.open("t2", "conn_a", sealed, key)).rejects.toThrow();
  });

  it("does not unwrap a data key for another tenant or under another wrapping key", async () => {
    const wrapped = await provider.wrap(new Uint8Array(32).fill(1), { tenantId: "t1", dataKeyId: "dk1" });
    await expect(provider.unwrap(wrapped, { tenantId: "t2", dataKeyId: "dk1", keyId: "local-1" })).rejects.toThrow();
    await expect(provider.unwrap(wrapped, { tenantId: "t1", dataKeyId: "dk2", keyId: "local-1" })).rejects.toThrow();
    await expect(provider.unwrap(wrapped, { tenantId: "t1", dataKeyId: "dk1", keyId: "other" })).rejects.toThrow(/no wrapping key/);
    expect(await provider.unwrap(wrapped, { tenantId: "t1", dataKeyId: "dk1", keyId: "local-1" })).toEqual(new Uint8Array(32).fill(1));
    expect(() => localKeyProvider({ keyId: "k", key: new Uint8Array(16) })).toThrow(/32 bytes/);
  });

  it("unwraps a data key once for concurrent first calls", async () => {
    let unwraps = 0;
    const counting = { keyId: provider.keyId, wrap: provider.wrap, unwrap: async (w: Uint8Array, c: { tenantId: string; dataKeyId: string; keyId: string }) => (unwraps++, provider.unwrap(w, c)) };
    const store = memoryKeys();
    const sealed = await createVault({ keys: provider, store }).seal("t1", "c", 1, { a: "b" });
    const vault = createVault({ keys: counting, store });
    await Promise.all(Array.from({ length: 10 }, () => vault.open("t1", "c", sealed, store.get("t1"))));
    expect(unwraps).toBe(1);
  });

  it("keeps unwrapped data keys for at most five minutes", async () => {
    let unwraps = 0;
    const counting = { ...provider, keyId: provider.keyId, wrap: provider.wrap, unwrap: async (w: Uint8Array, c: { tenantId: string; dataKeyId: string; keyId: string }) => (unwraps++, provider.unwrap(w, c)) };
    let now = 0;
    const store = memoryKeys();
    const vault = createVault({ keys: counting, store, now: () => now });
    const sealed = await vault.seal("t1", "c", 1, { a: "b" });
    unwraps = 0;
    await vault.open("t1", "c", sealed, store.get("t1"));
    expect(unwraps).toBe(0);
    now += 5 * 60_000 + 1;
    await vault.open("t1", "c", sealed, store.get("t1"));
    expect(unwraps).toBe(1);
  });
});
