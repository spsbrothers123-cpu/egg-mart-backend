// src/routes/purchase.routes.js
// Express router – mount at /api/purchases in app.js / server.js

const express = require("express");
const router = express.Router();
const Purchase = require("../models/Purchase");

// ── GET  /api/purchases  →  paginated list ────────────────────────────────────
router.get("/", async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    const filter = {};
    if (req.query.supplier)  filter.supplier = new RegExp(req.query.supplier, "i");
    if (req.query.status)    filter.status   = req.query.status;
    if (req.query.dateFrom || req.query.dateTo) {
      filter.purchaseDate = {};
      if (req.query.dateFrom) filter.purchaseDate.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo)   filter.purchaseDate.$lte = new Date(req.query.dateTo);
    }

    const [purchases, total] = await Promise.all([
      Purchase.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Purchase.countDocuments(filter),
    ]);

    res.json({ success: true, page, limit, total, data: purchases });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET  /api/purchases/:id  →  single purchase ───────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const purchase = await Purchase.findById(req.params.id);
    if (!purchase) return res.status(404).json({ success: false, message: "Purchase not found" });
    res.json({ success: true, data: purchase });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /api/purchases  →  create purchase ───────────────────────────────────
router.post("/", async (req, res) => {
  try {
    const { invoiceNo, supplier, purchaseDate, items, notes, createdBy } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: "At least one item is required" });
    }

    const purchase = new Purchase({ invoiceNo, supplier, purchaseDate, items, notes, createdBy });
    await purchase.save();

    res.status(201).json({ success: true, data: purchase });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ── PATCH /api/purchases/:id  →  update status / details ─────────────────────
router.patch("/:id", async (req, res) => {
  try {
    const allowed = ["status", "notes", "supplier", "invoiceNo", "purchaseDate", "items"];
    const update  = {};
    allowed.forEach((key) => { if (req.body[key] !== undefined) update[key] = req.body[key]; });

    const purchase = await Purchase.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
    if (!purchase) return res.status(404).json({ success: false, message: "Purchase not found" });

    // Recompute subtotal after update
    await purchase.save();
    res.json({ success: true, data: purchase });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ── DELETE /api/purchases/:id  →  cancel / delete ────────────────────────────
router.delete("/:id", async (req, res) => {
  try {
    const purchase = await Purchase.findByIdAndDelete(req.params.id);
    if (!purchase) return res.status(404).json({ success: false, message: "Purchase not found" });
    res.json({ success: true, message: "Purchase deleted" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /api/purchases/stats/summary  →  dashboard totals ─────────────────────
router.get("/stats/summary", async (req, res) => {
  try {
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);

    const [allTime, thisMonth, pending] = await Promise.all([
      Purchase.aggregate([{ $group: { _id: null, total: { $sum: "$subtotal" }, count: { $sum: 1 } } }]),
      Purchase.aggregate([
        { $match: { purchaseDate: { $gte: startOfMonth }, status: { $ne: "cancelled" } } },
        { $group: { _id: null, total: { $sum: "$subtotal" }, count: { $sum: 1 } } },
      ]),
      Purchase.countDocuments({ status: "pending" }),
    ]);

    res.json({
      success: true,
      data: {
        allTime:   { total: allTime[0]?.total   || 0, count: allTime[0]?.count   || 0 },
        thisMonth: { total: thisMonth[0]?.total  || 0, count: thisMonth[0]?.count || 0 },
        pendingCount: pending,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
