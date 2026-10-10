import { describe, expect, it } from "vitest";
import { ED25519_PROOF_ALG, approvedActionSigningBytes, ed25519ActionSigner, ed25519ActionVerifier, fromBase64Url, generateEd25519KeyPair, hmacActionSigner, isOperationContract, operationDigest, sha256Digest, signApprovedAction, toBase64Url, verifyApprovedAction, type ApprovedAction, type OperationContract } from "../src/index.js";
import { CONFORMANCE_AUDIENCE, draftApprovedAction } from "../src/api/conformance.js";

const NOW = 1_800_000_000_000;
const draft = (): Omit<ApprovedAction, "proof"> => {
  const { proof: _proof, ...unsigned } = draftApprovedAction({ action: "notes.get", effect: "read", input: { id: "n1" }, now: NOW });
  return unsigned;
};

describe("Ed25519 proofs", () => {
  it("sign with the engine's private key and verify with only the public key", async () => {
    const pair = await generateEd25519KeyPair();
    const signed = await signApprovedAction<ApprovedAction>(draft(), ed25519ActionSigner({ keyId: "engine-2026-10", privateKey: pair.privateKey }));
    expect(signed.proof.alg).toBe(ED25519_PROOF_ALG);
    expect(signed.proof.keyId).toBe("engine-2026-10");
    const verifier = ed25519ActionVerifier({ "engine-2026-10": pair.publicKey });
    const verified = await verifyApprovedAction(signed, { now: NOW, audience: CONFORMANCE_AUDIENCE, verifier });
    expect(verified.ok).toBe(true);
  });

  it("refuse a changed envelope, another key, another key id, another algorithm and a malformed signature", async () => {
    const pair = await generateEd25519KeyPair();
    const other = await generateEd25519KeyPair();
    const signed = await signApprovedAction<ApprovedAction>(draft(), ed25519ActionSigner({ keyId: "k1", privateKey: pair.privateKey }));
    const bytes = approvedActionSigningBytes(signed);
    const ctx = { audience: signed.audience, scope: signed.scope };
    const verifier = ed25519ActionVerifier({ k1: pair.publicKey, k2: other.publicKey });
    expect(await verifier.verify(bytes, signed.proof, ctx)).toBe(true);
    expect(await verifier.verify(approvedActionSigningBytes({ ...signed, input: { id: "n2" } }), signed.proof, ctx)).toBe(false);
    expect(await verifier.verify(bytes, { ...signed.proof, keyId: "k2" }, ctx)).toBe(false);
    expect(await verifier.verify(bytes, { ...signed.proof, keyId: "k3" }, ctx)).toBe(false);
    expect(await verifier.verify(bytes, { ...signed.proof, keyId: "toString" }, ctx)).toBe(false);
    expect(await verifier.verify(bytes, { ...signed.proof, alg: "HS256" }, ctx)).toBe(false);
    expect(await verifier.verify(bytes, { ...signed.proof, sig: "not base64url!" }, ctx)).toBe(false);
    expect(await verifier.verify(bytes, { ...signed.proof, sig: signed.proof.sig.slice(0, 40) }, ctx)).toBe(false);
    // An HMAC proof under the same key id is not an Ed25519 proof.
    const hmac = hmacActionSigner({ keyId: "k1", secret: "a-shared-secret-that-is-long-enough-0123456789" }).sign(bytes);
    expect(await verifier.verify(bytes, hmac, ctx)).toBe(false);
  });

  it("stop accepting a key after its notAfter", async () => {
    const pair = await generateEd25519KeyPair();
    let now = NOW;
    const signed = await signApprovedAction<ApprovedAction>(draft(), ed25519ActionSigner({ keyId: "old", privateKey: pair.privateKey }));
    const verifier = ed25519ActionVerifier({ old: { key: pair.publicKey, notAfter: NOW + 1000 } }, { now: () => now });
    const ctx = { audience: signed.audience, scope: signed.scope };
    expect(await verifier.verify(approvedActionSigningBytes(signed), signed.proof, ctx)).toBe(true);
    now = NOW + 1001;
    expect(await verifier.verify(approvedActionSigningBytes(signed), signed.proof, ctx)).toBe(false);
  });

  it("refuse malformed keys when they are set up", async () => {
    expect(() => ed25519ActionVerifier({ k: toBase64Url(new Uint8Array(31)) })).toThrow(/32 bytes/);
    expect(() => ed25519ActionVerifier({ "": toBase64Url(new Uint8Array(32)) })).toThrow(/keyId/);
    const signer = ed25519ActionSigner({ keyId: "k", privateKey: toBase64Url(new Uint8Array(10)) });
    await expect(signer.sign(new Uint8Array(1), { audience: "a", scope: draft().scope })).rejects.toThrow();
    expect(() => ed25519ActionVerifier({ k: { key: new ArrayBuffer(32) as unknown as Uint8Array } })).toThrow(/must be a string/);
    const good = (await generateEd25519KeyPair()).publicKey;
    expect(() => ed25519ActionVerifier({ k: { key: good, notAfter: null as unknown as number } })).toThrow(/notAfter/);
    expect(() => ed25519ActionVerifier({ k: { key: good, notAfter: Number.POSITIVE_INFINITY } })).toThrow(/notAfter/);
  });

  it("refuse keys of small order and non-canonical keys, under which anyone could forge a proof", () => {
    const hex = (h: string) => new Uint8Array(h.match(/../g)!.map((b) => Number.parseInt(b, 16)));
    const weak = [
      "0100000000000000000000000000000000000000000000000000000000000000",
      "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "0000000000000000000000000000000000000000000000000000000000000000",
      "0000000000000000000000000000000000000000000000000000000000000080",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
      "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
      "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
      // y = p and y = p + 1: non-canonical encodings of the points above.
      "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
      "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
    ];
    for (const key of weak) expect(() => ed25519ActionVerifier({ k: hex(key) }), key).toThrow(/small-order or non-canonical/);
  });
});

describe("fromBase64Url", () => {
  it("reverses toBase64Url and accepts nothing else", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n) & 255);
      expect(fromBase64Url(toBase64Url(bytes))).toEqual(bytes);
    }
    for (const bad of ["a", "ab==", "a+b/", "abc$", "AB"]) expect(() => fromBase64Url(bad), bad).toThrow();
  });
});

describe("an operation contract's implementation digest", () => {
  const contract: OperationContract = { effect: "read", idempotent: true, irreversible: false, riskFloor: "none", input: { type: "object" }, output: {} };
  it("changes the pinned digest only when present", () => {
    const implementation = sha256Digest({ sql: "select 1" });
    const withIt = { ...contract, implementation };
    expect(isOperationContract(withIt)).toBe(true);
    expect(operationDigest(withIt)).not.toBe(operationDigest(contract));
    expect(operationDigest({ ...contract, implementation: sha256Digest({ sql: "select 2" }) })).not.toBe(operationDigest(withIt));
    expect(isOperationContract({ ...contract, implementation: "md5:abc" })).toBe(false);
  });
});
