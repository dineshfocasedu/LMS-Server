// controllers/accountsController.js
import AccountsEntry from "../models/AccountsEntry.js";

// 60-second in-memory cache for the summary aggregation (avoids repeated heavy queries)
let summaryCache = null;
let summaryCacheAt = 0;
const SUMMARY_TTL = 60_000; // ms

// ─── GET /api/accounts/summary ────────────────────────────────────────────────
// Aggregates per-payment first so a receivable_payment can never make the
// outstanding balance negative (guards against orphan entries from old data).
export async function getAccountsSummary(_req, res) {
  try {
    if (summaryCache && Date.now() - summaryCacheAt < SUMMARY_TTL) {
      return res.json(summaryCache);
    }
    const [salesAgg, refundAgg] = await Promise.all([
      AccountsEntry.aggregate([
        { $match: { type: { $in: ["sale", "receivable_created", "receivable_payment"] } } },
        {
          $group: {
            _id: "$paymentId",
            total_sale:          { $sum: { $cond: [{ $eq: ["$type", "sale"] },                "$amount", 0] } },
            receivable_created:  { $sum: { $cond: [{ $eq: ["$type", "receivable_created"] },  "$amount", 0] } },
            receivable_payments: { $sum: { $cond: [{ $eq: ["$type", "receivable_payment"] }, "$amount", 0] } },
          },
        },
        {
          $project: {
            total_sale:  1,
            outstanding: { $max: [0, { $subtract: ["$receivable_created", "$receivable_payments"] }] },
          },
        },
        {
          $group: {
            _id:               null,
            total_sales:       { $sum: "$total_sale" },
            total_receivables: { $sum: "$outstanding" },
          },
        },
      ]),
      AccountsEntry.aggregate([
        { $match: { type: "refund" } },
        { $group: { _id: null, total_refunds: { $sum: "$amount" } } },
      ]),
    ]);

    const totals  = salesAgg[0]  ?? { total_sales: 0, total_receivables: 0 };
    const refunds = refundAgg[0] ?? { total_refunds: 0 };

    summaryCache = {
      total_sales:       totals.total_sales,
      total_receivables: totals.total_receivables,
      total_refunds:     refunds.total_refunds,
      total_collected:   totals.total_sales - totals.total_receivables - refunds.total_refunds,
    };
    summaryCacheAt = Date.now();
    res.json(summaryCache);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/accounts/entries ────────────────────────────────────────────────
// Query params: type, page (1-based), limit (default 50)
export async function listAccountsEntries(req, res) {
  try {
    const { type, page = 1, limit = 50 } = req.query;
    const filter = type ? { type } : {};

    const [entries, total] = await Promise.all([
      AccountsEntry.find(filter)
        .sort({ createdAt: -1, _id: 1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .populate("paymentId",  "name phone product_name full_amount emi_total emi_paid")
        .populate("purchaseId", "orderId customerName customerPhone")
        .lean(),
      AccountsEntry.countDocuments(filter),
    ]);

    res.json({ entries, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/accounts/receivables ───────────────────────────────────────────
// Per-payment receivable status. Only shows payments with outstanding > 0.
export async function listReceivables(_req, res) {
  try {
    const rows = await AccountsEntry.aggregate([
      {
        $group: {
          _id:      "$paymentId",
          created:  { $sum: { $cond: [{ $eq: ["$type", "receivable_created"] }, "$amount", 0] } },
          received: { $sum: { $cond: [{ $eq: ["$type", "receivable_payment"] }, "$amount", 0] } },
        },
      },
      // Only payments that ever had a receivable_created entry
      { $match: { created: { $gt: 0 } } },
      {
        $lookup: {
          from:         "payments",
          localField:   "_id",
          foreignField: "_id",
          as:           "payment",
        },
      },
      { $unwind: "$payment" },
      {
        $project: {
          paymentId:   "$_id",
          name:        "$payment.name",
          phone:       "$payment.phone",
          product:     "$payment.product_name",
          full_amount: "$payment.full_amount",
          emi_total:   "$payment.emi_total",
          emi_paid:    "$payment.emi_paid",
          // Clamp to 0 — can't owe negative money
          outstanding: { $max: [0, { $subtract: ["$created", "$received"] }] },
        },
      },
      // Only rows still owed something
      { $match: { outstanding: { $gt: 0 } } },
      { $sort: { outstanding: -1 } },
    ]);

    res.json({ receivables: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
