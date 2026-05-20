// controllers/inventoryController.js
import mongoose from "mongoose";
import Product from "../models/Product.js";
import InventoryLog from "../models/InventoryLog.js";
import Purchase from "../models/Purchase.js";
import Settings from "../models/Settings.js";
import { sendLowStockAlert } from "../services/watiService.js";

// ─── Inventory Logs ────────────────────────────────────────────────────────────

/**
 * GET /api/admin/inventory/logs
 * Paginated inventory change history.
 * Query: ?productId=&type=sale|restock|...&dateFrom=&dateTo=&page=1&limit=20
 */
export async function getInventoryLogs(req, res) {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;

    const query = {};
    if (req.query.productId) query.productId = req.query.productId;
    if (req.query.type)      query.type = req.query.type;
    if (req.query.dateFrom || req.query.dateTo) {
      query.createdAt = {};
      if (req.query.dateFrom) query.createdAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) {
        const end = new Date(req.query.dateTo);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    const [logs, total] = await Promise.all([
      InventoryLog.find(query)
        .populate('productId', 'name sku stock')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      InventoryLog.countDocuments(query),
    ]);

    res.json({
      logs,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─── Stock Overview ────────────────────────────────────────────────────────────

/**
 * GET /api/admin/inventory/stock
 * Current stock for all products that have stock tracking enabled.
 * Includes total units sold, restocked, and any pending low-stock flag.
 */
export async function getStockOverview(_req, res) {
  try {
    const settings = await Settings.findById("global").lean();
    const threshold = settings?.lowStockThreshold ?? 5;

    // Aggregate InventoryLog to get totals per product
    const summaryByProduct = await InventoryLog.aggregate([
      {
        $group: {
          _id: '$productId',
          totalSold:        { $sum: { $cond: [{ $eq: ['$type', 'sale'] },    { $abs: '$quantityChange' }, 0] } },
          totalRestocked:   { $sum: { $cond: [{ $eq: ['$type', 'restock'] }, '$quantityChange', 0] } },
          totalDamaged:     { $sum: { $cond: [{ $eq: ['$type', 'damaged'] }, { $abs: '$quantityChange' }, 0] } },
          totalReturned:    { $sum: { $cond: [{ $eq: ['$type', 'return'] },  '$quantityChange', 0] } },
          totalAdjusted:    { $sum: { $cond: [{ $eq: ['$type', 'manual_adjustment'] }, '$quantityChange', 0] } },
          lastMovement:     { $max: '$createdAt' },
        }
      }
    ]);

    const summaryMap = {};
    summaryByProduct.forEach(s => { summaryMap[s._id.toString()] = s; });

    // Only products with stock tracking
    const products = await Product.find({ stock: { $ne: null } })
      .select('name category subCategory stock price imageUrl')
      .sort({ name: 1 })
      .lean();

    const overview = products.map(p => {
      const s = summaryMap[p._id.toString()] || {};
      return {
        _id:           p._id,
        name:          p.name,
        category:      p.category,
        subCategory:   p.subCategory,
        price:         p.price,
        imageUrl:      p.imageUrl,
        currentStock:  p.stock,
        totalSold:     s.totalSold     || 0,
        totalRestocked:s.totalRestocked|| 0,
        totalDamaged:  s.totalDamaged  || 0,
        totalReturned: s.totalReturned || 0,
        lastMovement:  s.lastMovement  || null,
        lowStock:      p.stock <= threshold,
      };
    });

    res.json({ overview });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─── Manual Stock Adjustment ───────────────────────────────────────────────────

/**
 * POST /api/admin/inventory/adjust
 * Manually adjust stock for a product.
 * Body: { productId, quantity, type: 'restock'|'manual_adjustment'|'return'|'damaged', note }
 */
export async function adjustStock(req, res) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { productId, quantity, type, note } = req.body;

    if (!productId || quantity == null || !type) {
      return res.status(400).json({ error: 'productId, quantity, and type are required' });
    }
    if (!['restock', 'manual_adjustment', 'return', 'damaged'].includes(type)) {
      return res.status(400).json({ error: 'type must be restock, manual_adjustment, return, or damaged' });
    }

    const product = await Product.findById(productId).session(session);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const stockBefore = product.stock ?? 0;
    // For restock/return → positive change; damaged → negative change; manual_adjustment → as provided
    let quantityChange;
    if (type === 'damaged') {
      quantityChange = -Math.abs(quantity);
    } else if (type === 'manual_adjustment') {
      quantityChange = quantity; // can be positive or negative
    } else {
      quantityChange = Math.abs(quantity); // restock, return
    }

    const stockAfter = stockBefore + quantityChange;

    product.stock = stockAfter;
    await product.save({ session });

    const log = await InventoryLog.create([{
      productId: product._id,
      sku: product.sku || undefined,
      type,
      quantityChange,
      stockBefore,
      stockAfter,
      note: note || undefined,
    }], { session });

    await session.commitTransaction();
    res.json({ success: true, currentStock: stockAfter, log: log[0] });

    // Send low stock WhatsApp alert (non-blocking, after response)
    try {
      const settings = await Settings.findById("global").lean();
      const threshold = settings?.lowStockThreshold ?? 5;
      const phones = settings?.alertPhones || [];
      if (phones.length > 0 && stockAfter <= threshold) {
        sendLowStockAlert(product.name, stockAfter, phones).catch(() => {});
      }
    } catch { /* non-fatal */ }
  } catch (err) {
    await session.abortTransaction();
    res.status(500).json({ error: err.message });
  } finally {
    session.endSession();
  }
}

// ─── Sales Analytics ───────────────────────────────────────────────────────────

/**
 * GET /api/admin/sales/summary
 * Overall sales totals. Optionally filtered by date range.
 * Query: ?dateFrom=&dateTo=&source=shopify|website
 */
export async function getSalesSummary(req, res) {
  try {
    const match = { status: 'paid' };
    if (req.query.source) match.source = req.query.source;
    if (req.query.dateFrom || req.query.dateTo) {
      match.createdAt = {};
      if (req.query.dateFrom) match.createdAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) {
        const end = new Date(req.query.dateTo);
        end.setHours(23, 59, 59, 999);
        match.createdAt.$lte = end;
      }
    }

    const [result] = await Purchase.aggregate([
      { $match: match },
      { $unwind: '$items' },
      {
        $group: {
          _id: null,
          totalRevenue:  { $sum: '$items.amount' },
          totalOrders:   { $addToSet: '$_id' },
          totalItems:    { $sum: 1 },
        }
      },
      {
        $project: {
          _id: 0,
          totalRevenue: 1,
          totalOrders: { $size: '$totalOrders' },
          totalItems: 1,
        }
      }
    ]);

    res.json(result || { totalRevenue: 0, totalOrders: 0, totalItems: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/admin/sales/timeline
 * Sales grouped by day, month, or year.
 * Query: ?groupBy=day|month|year&dateFrom=&dateTo=&source=
 *
 * Response: [{ period: '2024-03-15', totalRevenue, totalOrders, totalItems }, ...]
 */
export async function getSalesTimeline(req, res) {
  try {
    const groupBy = req.query.groupBy || 'day'; // day | month | year
    const match = { status: 'paid' };
    if (req.query.source) match.source = req.query.source;
    if (req.query.dateFrom || req.query.dateTo) {
      match.createdAt = {};
      if (req.query.dateFrom) match.createdAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) {
        const end = new Date(req.query.dateTo);
        end.setHours(23, 59, 59, 999);
        match.createdAt.$lte = end;
      }
    }

    // Build date grouping expression
    let dateGroup;
    if (groupBy === 'year') {
      dateGroup = { year: { $year: '$createdAt' } };
    } else if (groupBy === 'month') {
      dateGroup = { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } };
    } else {
      dateGroup = { year: { $year: '$createdAt' }, month: { $month: '$createdAt' }, day: { $dayOfMonth: '$createdAt' } };
    }

    const timeline = await Purchase.aggregate([
      { $match: match },
      { $unwind: '$items' },
      {
        $group: {
          _id: { date: dateGroup, orderId: '$_id' },
          revenue:   { $sum: '$items.amount' },
          items:     { $sum: 1 },
        }
      },
      {
        $group: {
          _id: '$_id.date',
          totalRevenue: { $sum: '$revenue' },
          totalOrders:  { $sum: 1 },
          totalItems:   { $sum: '$items' },
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
      {
        $project: {
          _id: 0,
          period: '$_id',
          totalRevenue: 1,
          totalOrders: 1,
          totalItems: 1,
        }
      }
    ]);

    res.json({ groupBy, timeline });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/admin/sales/by-date?date=YYYY-MM-DD
 * Full breakdown for a single day — orders + items sold.
 */
export async function getSalesByDate(req, res) {
  try {
    if (!req.query.date) return res.status(400).json({ error: 'date query param required (YYYY-MM-DD)' });

    const start = new Date(req.query.date);
    start.setHours(0, 0, 0, 0);
    const end = new Date(req.query.date);
    end.setHours(23, 59, 59, 999);

    const purchases = await Purchase.find({
      status: 'paid',
      createdAt: { $gte: start, $lte: end },
    })
      .populate('userId', 'name phoneNumber email')
      .populate('items.productId', 'name price')
      .sort({ createdAt: -1 })
      .lean();

    const totalRevenue = purchases.reduce(
      (sum, p) => sum + p.items.reduce((s, i) => s + (i.amount || 0), 0), 0
    );

    res.json({ date: req.query.date, totalRevenue, totalOrders: purchases.length, purchases });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/admin/sales/top-products
 * Top selling products by revenue and quantity.
 * Query: ?dateFrom=&dateTo=&limit=10&source=
 */
export async function getTopProducts(req, res) {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const match = { status: 'paid' };
    if (req.query.source) match.source = req.query.source;
    if (req.query.dateFrom || req.query.dateTo) {
      match.createdAt = {};
      if (req.query.dateFrom) match.createdAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) {
        const end = new Date(req.query.dateTo);
        end.setHours(23, 59, 59, 999);
        match.createdAt.$lte = end;
      }
    }

    const products = await Purchase.aggregate([
      { $match: match },
      { $unwind: '$items' },
      {
        $group: {
          _id:          '$items.productId',
          name:         { $first: '$items.name' },
          totalRevenue: { $sum: '$items.amount' },
          unitsSold:    { $sum: 1 },
        }
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: limit },
      {
        $lookup: {
          from: 'products',
          localField: '_id',
          foreignField: '_id',
          as: 'productDoc',
        }
      },
      {
        $project: {
          _id: 1,
          name: 1,
          totalRevenue: 1,
          unitsSold: 1,
          currentStock: { $arrayElemAt: ['$productDoc.stock', 0] },
          category:     { $arrayElemAt: ['$productDoc.category', 0] },
        }
      }
    ]);

    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
