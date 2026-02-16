// =============================================================================
// MPC Signature Engine — Real 2-of-2 ECDSA
// =============================================================================
// Additive key splitting: privKey = serverShard + agentShard (mod n)
// Combined pubKey derived from full key (standard secp256k1)
// To sign: reconstruct privKey from both shards, sign with standard ECDSA
//
// This is "online MPC" — both shards are combined server-side at signing time.
// The agent sends their shard with each payment request. The server holds its
// shard encrypted at rest. Neither party stores the full private key.
//
// For the pilot ($100), this is the right tradeoff: real key splitting,
// real Ethereum addresses, real onchain signatures, without the complexity
// of interactive threshold ECDSA (which requires multiple rounds).
// =============================================================================

import * as secp256k1 from "@noble/secp256k1";
import { createHash, createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { v4 as uuid } from "uuid";
import { mpcQueries } from "../db";
import { logger } from "../utils/logger";
import type { MPCKeyPair } from "../types";

// ---------------------------------------------------------------------------
// Key Generation — Real ECDSA
// ---------------------------------------------------------------------------

/**
 * Generate a 2-of-2 MPC key pair.
 *
 * 1. Generate random full private key
 * 2. Generate random serverShard
 * 3. agentShard = fullKey - serverShard (mod n)
 * 4. Combined public key = point from fullKey (standard secp256k1)
 *
 * The full private key is NEVER stored. Only the shards are kept.
 */
export async function generateMPCKeyPair(encryptionKey: string): Promise<MPCKeyPair & { _ethAddress: string; _publicKeyUncompressed: string }> {
  const n = secp256k1.CURVE.n;

  // Generate the full private key
  const fullKeyBytes = secp256k1.utils.randomPrivateKey();
  const fullKeyBig = bytesToBigInt(fullKeyBytes);

  // Generate random server shard
  const serverShardBytes = secp256k1.utils.randomPrivateKey();
  const serverShardBig = bytesToBigInt(serverShardBytes);

  // Agent shard = fullKey - serverShard (mod n)
  const agentShardBig = mod(fullKeyBig - serverShardBig, n);
  const agentShardHex = bigIntToHex(agentShardBig);

  // Derive public keys
  const publicKeyUncompressed = secp256k1.getPublicKey(fullKeyBytes, false);
  const publicKeyCompressed = secp256k1.getPublicKey(fullKeyBytes, true);

  // Verify: serverShard + agentShard = fullKey (mod n)
  const reconstructed = mod(serverShardBig + agentShardBig, n);
  if (reconstructed !== fullKeyBig) {
    throw new Error("MPC key generation verification failed");
  }

  // Encrypt server shard
  const serverShardEncrypted = encryptShard(
    Buffer.from(serverShardBytes).toString("hex"),
    encryptionKey
  );

  // Derive Ethereum address from uncompressed public key
  const ethAddress = deriveEthAddress(publicKeyUncompressed);

  logger.info("MPC key pair generated", {
    address: ethAddress,
    publicKey: Buffer.from(publicKeyCompressed).toString("hex").slice(0, 16) + "...",
  });

  // Zero out the full private key
  fullKeyBytes.fill(0);

  return {
    publicKey: Buffer.from(publicKeyCompressed).toString("hex"),
    serverShard: serverShardEncrypted,
    agentShard: agentShardHex,
    _ethAddress: ethAddress,
    _publicKeyUncompressed: Buffer.from(publicKeyUncompressed).toString("hex"),
  };
}

// ---------------------------------------------------------------------------
// Signing — Real ECDSA via shard reconstruction
// ---------------------------------------------------------------------------

/**
 * Reconstruct the private key from both shards and sign a message hash.
 *
 * @param messageHash - 32-byte hex hash to sign
 * @param encryptedServerShard - AES-encrypted server shard from DB
 * @param encryptionKey - Key to decrypt server shard
 * @param agentShardHex - Agent's shard (sent with the payment request)
 * @returns Ethereum signature { r, s, v } as hex
 */
export async function signWithMPC(
  messageHash: string,
  encryptedServerShard: string,
  encryptionKey: string,
  agentShardHex: string
): Promise<{ signature: string; r: string; s: string; v: number }> {
  const n = secp256k1.CURVE.n;

  // Decrypt server shard
  const serverShardHex = decryptShard(encryptedServerShard, encryptionKey);
  const serverShardBig = BigInt("0x" + serverShardHex);
  const agentShardBig = BigInt("0x" + agentShardHex);

  // Reconstruct full private key
  const fullKeyBig = mod(serverShardBig + agentShardBig, n);
  const fullKeyBytes = bigIntToBytes(fullKeyBig);

  // Sign with standard ECDSA
  const msgBytes = hexToBytes(messageHash);
  const sig = await secp256k1.signAsync(msgBytes, fullKeyBytes, {
    lowS: true, // EIP-2 compliant
  });

  // Recovery parameter
  const v = 27 + (sig.recovery || 0);

  const rHex = bigIntToHex(sig.r);
  const sHex = bigIntToHex(sig.s);
  const vHex = v.toString(16).padStart(2, "0");
  const fullSigHex = "0x" + rHex + sHex + vHex;

  // Zero out reconstructed key
  fullKeyBytes.fill(0);

  logger.info("MPC signature produced", {
    msgHash: messageHash.slice(0, 16) + "...",
    v,
  });

  return { signature: fullSigHex, r: "0x" + rHex, s: "0x" + sHex, v };
}

/**
 * Full signing flow: record in DB, sign, store result.
 */
export async function signTransaction(
  transactionId: string,
  messageHash: string,
  encryptedServerShard: string,
  encryptionKey: string,
  agentShardHex?: string
): Promise<{
  signatureId: string;
  status: string;
  combinedSignature?: string;
}> {
  const sigId = uuid();
  mpcQueries.create.run(sigId, transactionId, messageHash);

  if (!agentShardHex) {
    mpcQueries.updateServerSig.run("awaiting_agent", sigId);
    return { signatureId: sigId, status: "awaiting_agent_signature" };
  }

  try {
    const { signature } = await signWithMPC(
      messageHash, encryptedServerShard, encryptionKey, agentShardHex
    );
    mpcQueries.updateCombinedSig.run(agentShardHex.slice(0, 16) + "...", signature, sigId);
    return { signatureId: sigId, status: "complete", combinedSignature: signature };
  } catch (error: any) {
    mpcQueries.updateFailed.run(sigId);
    logger.error("MPC signing failed", { sigId, error: error.message });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Ethereum Address Derivation — keccak256
// ---------------------------------------------------------------------------

function deriveEthAddress(uncompressedPubKey: Uint8Array): string {
  const pubKeyNoPrefix = uncompressedPubKey.slice(1); // Remove 0x04 prefix
  let addressHash: Buffer;
  try {
    const { keccak_256 } = require("@noble/hashes/sha3");
    addressHash = Buffer.from(keccak_256(pubKeyNoPrefix));
  } catch {
    // Fallback for dev — produces wrong addresses without @noble/hashes
    logger.warn("Using SHA3-256 fallback — install @noble/hashes for real keccak256");
    addressHash = createHash("sha3-256").update(Buffer.from(pubKeyNoPrefix)).digest();
  }
  return "0x" + addressHash.subarray(12, 32).toString("hex");
}

export function deriveAddressFromPubKey(compressedPubKeyHex: string): string {
  const point = secp256k1.ProjectivePoint.fromHex(compressedPubKeyHex);
  const uncompressed = point.toRawBytes(false);
  return deriveEthAddress(uncompressed);
}

// ---------------------------------------------------------------------------
// Shard Verification
// ---------------------------------------------------------------------------

export function verifyAgentShard(
  agentShardHex: string,
  encryptedServerShard: string,
  encryptionKey: string,
  expectedPubKeyHex: string
): boolean {
  try {
    const n = secp256k1.CURVE.n;
    const serverShardHex = decryptShard(encryptedServerShard, encryptionKey);
    const fullKeyBig = mod(BigInt("0x" + serverShardHex) + BigInt("0x" + agentShardHex), n);
    const fullKeyBytes = bigIntToBytes(fullKeyBig);
    const derivedPubKey = Buffer.from(secp256k1.getPublicKey(fullKeyBytes, true)).toString("hex");
    fullKeyBytes.fill(0);
    return derivedPubKey === expectedPubKeyHex;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

function encryptShard(shard: string, key: string): string {
  const keyHash = createHash("sha256").update(key).digest();
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-cbc", keyHash, iv);
  let encrypted = cipher.update(shard, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decryptShard(encryptedShard: string, key: string): string {
  const [ivHex, encryptedHex] = encryptedShard.split(":");
  const keyHash = createHash("sha256").update(key).digest();
  const iv = Buffer.from(ivHex, "hex");
  const decipher = createDecipheriv("aes-256-cbc", keyHash, iv);
  let decrypted = decipher.update(encryptedHex, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return new Uint8Array(Buffer.from(clean, "hex"));
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt("0x" + Buffer.from(bytes).toString("hex"));
}

function bigIntToHex(n: bigint): string {
  return n.toString(16).padStart(64, "0");
}

function bigIntToBytes(n: bigint): Uint8Array {
  const hex = n.toString(16).padStart(64, "0");
  return new Uint8Array(Buffer.from(hex, "hex"));
}

function mod(a: bigint, b: bigint): bigint {
  const result = a % b;
  return result >= 0n ? result : result + b;
}
