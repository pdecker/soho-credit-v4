import { migrate, merchantQueries, vaultQueries } from "./index";
import { registerAgent } from "../core/agent";
import { processDeposit } from "../vault";
import { v4 as uuid } from "uuid";

async function seed() {
  migrate();
  console.log("Seeding test data...\n");

  // Register test merchants
  const merchants = [
    { name: "OpenAI API", wallet: "0x1111111111111111111111111111111111111111", category: "ai-services" },
    { name: "AWS Cloud", wallet: "0x2222222222222222222222222222222222222222", category: "cloud-infra" },
    { name: "Stripe Payments", wallet: "0x3333333333333333333333333333333333333333", category: "payments" },
    { name: "Pinecone Vector DB", wallet: "0x4444444444444444444444444444444444444444", category: "databases" },
  ];

  for (const m of merchants) {
    const id = uuid();
    merchantQueries.create.run(id, m.wallet, m.name, m.category, 150);
    console.log(`  Merchant: ${m.name} (${id})`);
  }

  // Register test agent
  const agentResult = await registerAgent(
    "TestAgent-GPT",
    "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    5000
  );
  console.log(`\n  Agent: ${agentResult.agent.name}`);
  console.log(`  Agent ID: ${agentResult.agent.id}`);
  console.log(`  API Key: ${agentResult.apiKey}`);
  console.log(`  MPC Shard: ${agentResult.mpcAgentShard.substring(0, 16)}...`);
  console.log(`  Wallet: ${agentResult.agent.walletAddress}`);

  // Seed vault with lender deposits
  const lenders = [
    { address: "0xLENDER1111111111111111111111111111111111", amount: 50000, txHash: "0x" + "a".repeat(64) },
    { address: "0xLENDER2222222222222222222222222222222222", amount: 25000, txHash: "0x" + "b".repeat(64) },
    { address: "0xLENDER3333333333333333333333333333333333", amount: 25000, txHash: "0x" + "c".repeat(64) },
  ];

  console.log("\n  Vault deposits:");
  for (const l of lenders) {
    const pos = processDeposit(l.address, l.amount, l.txHash);
    console.log(`    ${l.address.substring(0, 12)}... deposited $${l.amount} → ${pos.sharesOwned.toFixed(2)} shares`);
  }

  console.log("\nSeed complete. Total vault: $100,000 USDC");
  process.exit(0);
}

seed().catch(console.error);
