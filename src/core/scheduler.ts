// =============================================================================
// Scheduled Jobs - Repayment Enforcement, Risk Scoring, Vault Maintenance
// =============================================================================

import cron from "node-cron";
import { db, agentQueries, txQueries, repaymentQueries } from "../db";
import { calculateRiskScore } from "../compliance";
import { config } from "../config";
import { logger } from "../utils/logger";

export function startScheduledJobs(): void {
  // Every day at midnight UTC - check for delinquent agents
  cron.schedule("0 0 * * *", () => {
    logger.info("Running delinquency check...");
    checkDelinquencies();
  });

  // Every 6 hours - recalculate risk scores
  cron.schedule("0 */6 * * *", () => {
    logger.info("Running risk score recalculation...");
    recalculateRiskScores();
  });

  // Every Sunday at 00:00 UTC - generate repayment invoices
  cron.schedule("0 0 * * 0", () => {
    logger.info("Generating weekly repayment invoices...");
    generateRepaymentInvoices();
  });

  logger.info("Scheduled jobs started");
}

function checkDelinquencies(): void {
  const agents = db.prepare(`
    SELECT a.*, 
      (SELECT MAX(created_at) FROM repayments WHERE agent_id = a.id AND status = 'confirmed') as last_repayment
    FROM agents a 
    WHERE a.used_credit_usdc > 0 AND a.status = 'active'
  `).all() as any[];

  const now = new Date();
  const gracePeriodMs = config.REPAYMENT_PERIOD_DAYS * 24 * 60 * 60 * 1000 * 1.5; // 1.5x period

  for (const agent of agents) {
    const lastRepayment = agent.last_repayment ? new Date(agent.last_repayment) : new Date(agent.created_at);
    const daysSinceRepayment = (now.getTime() - lastRepayment.getTime()) / (24 * 60 * 60 * 1000);

    if (daysSinceRepayment > config.REPAYMENT_PERIOD_DAYS * 1.5) {
      agentQueries.updateStatus.run("delinquent", agent.id);
      logger.warn(`Agent ${agent.id} marked delinquent`, { daysSinceRepayment, balance: agent.used_credit_usdc });
    }
  }
}

function recalculateRiskScores(): void {
  const agents = db.prepare(`SELECT * FROM agents WHERE status != 'closed'`).all() as any[];

  for (const agent of agents) {
    const txCount = (db.prepare(`SELECT COUNT(*) as c FROM transactions WHERE agent_id = ?`).get(agent.id) as any).c;
    const repayments = db.prepare(`SELECT COALESCE(SUM(amount_usdc), 0) as total FROM repayments WHERE agent_id = ? AND status = 'confirmed'`).get(agent.id) as any;
    const borrowed = db.prepare(`SELECT COALESCE(SUM(amount_usdc), 0) as total FROM transactions WHERE agent_id = ? AND status = 'confirmed' AND type != 'repayment'`).get(agent.id) as any;
    const delinquentCount = (db.prepare(`SELECT COUNT(*) as c FROM repayments WHERE agent_id = ? AND status = 'failed'`).get(agent.id) as any).c;
    const ageDays = (Date.now() - new Date(agent.created_at).getTime()) / (24 * 60 * 60 * 1000);

    const newScore = calculateRiskScore(txCount, repayments.total, borrowed.total, delinquentCount, ageDays);
    agentQueries.updateRiskScore.run(newScore, agent.id);
  }
}

function generateRepaymentInvoices(): void {
  const agents = db.prepare(`
    SELECT * FROM agents WHERE used_credit_usdc > 0 AND status IN ('active', 'delinquent')
  `).all() as any[];

  const now = new Date();
  const periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  for (const agent of agents) {
    logger.info(`Repayment invoice generated for agent ${agent.id}`, {
      balance: agent.used_credit_usdc,
      dueDate: new Date(now.getTime() + config.REPAYMENT_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    });
    // In production: send webhook/notification to agent's owner
  }
}
