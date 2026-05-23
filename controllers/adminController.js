// controllers/adminController.js
import crypto from "crypto"
import mongoose from "mongoose"
import Product from "../models/Product.js"
import Purchase from "../models/Purchase.js"
import Payment from "../models/Payment.js"
import User from "../models/User.js"
import InventoryLog from "../models/InventoryLog.js"
import AccountsEntry from "../models/AccountsEntry.js"
import { recordPurchase } from "../services/accessService.js"
import { bustProductsCache } from "./purchaseController.js"
import { clearProductCache } from "./contentController.js"

/**
 * POST /api/admin/products
 * Create a new product.
 *
 * Body:
 * {
 *   name: "CA Inter Group 1",
 *   description: "Full course bundle",
 *   price: 4999,
 *   shopifyProductId: "1234567890",   // optional — link to Shopify product
 *   grants: {
 *     courses: ["ca-inter-g1"],
 *     features: ["videos", "tests", "downloads"]
 *   }
 * }
 */
export async function createProduct(req, res) {
  try {
    const { name, description, price, originalPrice, shopifyPrice, comboPrice, imageUrl, shopifyProductId, category, subCategory, level, weight, shipToHome, isCourse, grants, stock, showInComboStore, isBundle, bundleItems } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    if (shipToHome && (!weight || Number(weight) <= 0)) {
      return res.status(400).json({ error: 'Weight (grams) is required for ShipToHome products' });
    }

    if (isBundle) {
      if (!Array.isArray(bundleItems) || bundleItems.length === 0) {
        return res.status(400).json({ error: 'A bundle must have at least one item' });
      }
      for (const bi of bundleItems) {
        if (!bi.name?.trim()) return res.status(400).json({ error: 'Each bundle item must have a name' });
      }
    }

    const product = await Product.create({
      name,
      description,
      price,
      originalPrice: originalPrice || undefined,
      shopifyPrice:  shopifyPrice  != null ? shopifyPrice  : null,
      comboPrice:    comboPrice    != null ? comboPrice    : null,
      imageUrl: imageUrl || undefined,
      productId: crypto.randomUUID(),
      shopifyProductId: shopifyProductId || undefined,
      category: category || null,
      subCategory: subCategory || null,
      level: level || undefined,
      weight: weight ?? null,
      shipToHome: shipToHome ?? false,
      isCourse: isCourse ?? false,
      grants: {
        courses: grants?.courses || [],
        features: grants?.features || []
      },
      stock: stock != null ? stock : null,
      showInComboStore: showInComboStore ?? false,
      isBundle: isBundle ?? false,
      bundleItems: isBundle ? (bundleItems || []).map(bi => ({
        product_id: bi.product_id || null,
        name:       bi.name.trim(),
        price:      Number(bi.price) || 0,
        isCustom:   bi.isCustom ?? false,
      })) : [],
    });

    // Log initial stock as restock if stock was provided
    if (stock != null && stock > 0) {
      await InventoryLog.create({
        productId:      product._id,
        type:           'restock',
        quantityChange: stock,
        stockBefore:    0,
        stockAfter:     stock,
        note:           'Initial stock on product creation',
      });
    }

    bustProductsCache();
    res.status(201).json({ success: true, product });
  } catch (err) {
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0] || 'field';
      return res.status(400).json({ error: `${field} already exists` });
    }
    res.status(500).json({ error: err.message });
  }
}

/**
 * PUT /api/admin/products/:id
 * Update a product (name, price, grants, shopifyProductId).
 */
export async function updateProduct(req, res) {
  try {
    const { name, description, price, originalPrice, shopifyPrice, comboPrice, imageUrl, shopifyProductId, category, subCategory, level, weight, shipToHome, isCourse, grants, stock, stockNote, showInComboStore, isBundle, bundleItems } = req.body;
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (description !== undefined) updates.description = description;
    if (price !== undefined) updates.price = price;
    if (originalPrice !== undefined) updates.originalPrice = originalPrice;
    if (shopifyPrice !== undefined) updates.shopifyPrice = shopifyPrice;
    if (comboPrice !== undefined) updates.comboPrice = comboPrice;
    if (imageUrl !== undefined) updates.imageUrl = imageUrl;
    if (shopifyProductId !== undefined) updates.shopifyProductId = shopifyProductId || undefined;
    if (category !== undefined) updates.category = category;
    if (subCategory !== undefined) updates.subCategory = subCategory;
    if (level !== undefined) updates.level = level;
    if (weight !== undefined) updates.weight = weight;
    if (shipToHome !== undefined) updates.shipToHome = shipToHome;
    if (isCourse !== undefined) updates.isCourse = isCourse;
    if (showInComboStore !== undefined) updates.showInComboStore = showInComboStore;
    if (grants !== undefined) updates.grants = {
      courses: grants.courses || [],
      features: grants.features || [],
    };
    if (isBundle !== undefined) {
      if (isBundle && Array.isArray(bundleItems)) {
        for (const bi of bundleItems) {
          if (!bi.name?.trim()) return res.status(400).json({ error: 'Each bundle item must have a name' });
        }
      }
      updates.isBundle = isBundle;
      updates.bundleItems = isBundle ? (bundleItems || []).map(bi => ({
        product_id: bi.product_id || null,
        name:       bi.name.trim(),
        price:      Number(bi.price) || 0,
        isCustom:   bi.isCustom ?? false,
      })) : [];
    }

    // Fetch current product for stock tracking and shipToHome/weight validation
    const current = await Product.findById(req.params.id).select('stock weight shipToHome').lean();
    if (!current) return res.status(404).json({ error: 'Product not found' });

    const effectiveShipToHome = shipToHome !== undefined ? shipToHome : current.shipToHome;
    const effectiveWeight     = weight     !== undefined ? Number(weight) : current.weight;
    if (effectiveShipToHome && (!effectiveWeight || effectiveWeight <= 0)) {
      return res.status(400).json({ error: 'Weight (grams) is required for ShipToHome products' });
    }

    let stockBefore = null;
    if (stock !== undefined) {
      stockBefore = current?.stock ?? 0;
      updates.stock = stock;
    }

    const product = await Product.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true }
    );

    if (!product) return res.status(404).json({ error: 'Product not found' });

    // Log stock change — only when stock is a valid number (null means tracking disabled)
    if (stock !== undefined && stock !== null && stock !== stockBefore) {
      const quantityChange = stock - (stockBefore ?? 0);
      await InventoryLog.create({
        productId:      product._id,
        type:           quantityChange > 0 ? 'restock' : 'manual_adjustment',
        quantityChange,
        stockBefore,
        stockAfter:     stock,
        note:           stockNote || 'Admin stock update',
      });
    }

    bustProductsCache();
    res.json({ success: true, product });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * DELETE /api/admin/products/:id
 */
export async function deleteProduct(req, res) {
  try {
    const product = await Product.findByIdAndDelete(req.params.id);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    bustProductsCache();
    res.json({ success: true, message: 'Product deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/admin/products
 * List products with pagination.
 * Query: ?page=1&limit=20&filter=all|catalog|custom
 */
export async function listProducts(req, res) {
  try {
    const page   = parseInt(req.query.page)   || 1;
    const limit  = parseInt(req.query.limit)  || 20;
    const skip   = (page - 1) * limit;
    const filter = req.query.filter || 'all';

    const query = {};
    if (filter === 'catalog') { query.isCustom = { $ne: true }; query.isBundle = { $ne: true }; }
    if (filter === 'custom')  query.isCustom = true;
    if (filter === 'bundle')  query.isBundle = true;

    // One aggregation for all counts instead of 4 separate countDocuments calls
    const [products, [counts]] = await Promise.all([
      Product.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Product.aggregate([{ $group: {
        _id: null,
        total:    { $sum: 1 },
        catalog:  { $sum: { $cond: [{ $and: [{ $ne: ['$isCustom', true] }, { $ne: ['$isBundle', true] }] }, 1, 0] } },
        custom:   { $sum: { $cond: ['$isCustom', 1, 0] } },
        bundle:   { $sum: { $cond: ['$isBundle',  1, 0] } },
      }}]),
    ]);
    const total        = filter === 'all' ? (counts?.total   || 0) : await Product.countDocuments(query);
    const catalogCount = counts?.catalog || 0;
    const customCount  = counts?.custom  || 0;
    const bundleCount  = counts?.bundle  || 0;

    res.json({
      products,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
      counts: { catalog: catalogCount, custom: customCount, bundle: bundleCount },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/admin/users
 * List users with pagination and optional search.
 * Query: ?page=1&limit=20&search=
 */
export async function listUsers(req, res) {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;

    const query = {};
    if (req.query.search) {
      const re = { $regex: req.query.search, $options: 'i' };
      query.$or = [{ name: re }, { phoneNumber: re }, { email: re }];
    }

    const [users, total] = await Promise.all([
      User.find(query, '-otp -otpExpires').sort({ createdAt: -1 }).skip(skip).limit(limit),
      User.countDocuments(query),
    ]);

    res.json({
      users,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/admin/purchases
 * List all purchases across all users with pagination.
 * Query: ?page=1&limit=10
 */
export async function listPurchases(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const query = {};
    if (req.query.source)             query.source = req.query.source;
    if (req.query.hasPhysicalItem)    query.hasPhysicalItem = true;
    if (req.query.fulfillmentStatus)  query.fulfillmentStatus = req.query.fulfillmentStatus;

    // Delivery sync status filter
    if (req.query.awbStatus === 'synced')   query['shipment.awb'] = { $exists: true, $nin: [null, ''] };
    if (req.query.awbStatus === 'unsynced') query['shipment.awb'] = { $in: [null, '', undefined] };

    // Global search — orderId and phone match across ALL pages (pagination applied after)
    if (req.query.orderId) query.orderId = { $regex: req.query.orderId, $options: 'i' };
    if (req.query.phone) {
      // Match on customerPhone (stored on purchase) OR on the linked user's phoneNumber
      const matchedUsers = await User.find(
        { phoneNumber: { $regex: req.query.phone } },
        '_id'
      ).lean();
      const userIds = matchedUsers.map((u) => u._id);
      query.$or = [
        { customerPhone: { $regex: req.query.phone } },
        ...(userIds.length ? [{ userId: { $in: userIds } }] : []),
      ];
    }

    if (req.query.dateFrom || req.query.dateTo) {
      query.createdAt = {};
      if (req.query.dateFrom) query.createdAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) {
        const end = new Date(req.query.dateTo);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    let [purchases, total] = await Promise.all([
      Purchase.find(query)
        .populate('userId', 'name phoneNumber email')
        .populate('items.productId', 'name price shipToHome weight stock')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('-shipment.statusHistory') // keep list response lean
        .lean(),
      Purchase.countDocuments(query),
    ]);

    // For custom (Razorpay payment-link) purchases, attach show_sync from the
    // linked Payment so the frontend can gate the Sync button correctly.
    // orderId is either a Mongo ObjectId hex (old orders) or a Razorpay
    // order_xxx string (new orders after the orderId format change).
    const customPurchases = purchases.filter((p) => p.source === 'custom' && p.orderId);

    if (customPurchases.length) {
      const objectIds       = [];
      const razorpayOrderIds = [];

      customPurchases.forEach((p) => {
        if (/^[0-9a-f]{24}$/i.test(p.orderId)) {
          try { objectIds.push(new mongoose.Types.ObjectId(p.orderId)); } catch {}
        } else {
          razorpayOrderIds.push(p.orderId);
        }
      });

      const [byId, byRzpId] = await Promise.all([
        objectIds.length
          ? Payment.find({ _id: { $in: objectIds } }).select('emi_paid sync_show_after shipToHome').lean()
          : [],
        razorpayOrderIds.length
          ? Payment.find({ razorpay_order_id: { $in: razorpayOrderIds } }).select('emi_paid sync_show_after shipToHome razorpay_order_id').lean()
          : [],
      ]);

      const pmtMap = {};
      byId.forEach((p)    => { pmtMap[p._id.toString()]    = p; });
      byRzpId.forEach((p) => { pmtMap[p.razorpay_order_id] = p; });

      purchases = purchases.map((p) => {
        if (p.source !== 'custom' || !p.orderId) return p;
        const pmt = pmtMap[p.orderId];
        if (!pmt) return p;
        return { ...p, show_sync: pmt.emi_paid >= pmt.sync_show_after };
      });
    }

    res.json({
      purchases,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/admin/purchases/:id
 * Full details for a single purchase.
 */
export async function getPurchase(req, res) {
  try {
    const purchase = await Purchase.findById(req.params.id)
      .populate('userId', 'name phoneNumber email')
      .populate('items.productId', 'name price shipToHome weight imageUrl stock')
      .lean();
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    res.json({ purchase });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/admin/purchases/:id/refund
 * Initiate a refund for an order.
 * Body: { amount: number, notes: string, imageUrl: string }
 */
export async function initiateRefund(req, res) {
  try {
    const { amount, notes, imageUrl } = req.body;

    if (!amount || Number(amount) <= 0)
      return res.status(400).json({ error: 'amount is required and must be positive' });
    if (!notes?.trim())
      return res.status(400).json({ error: 'notes is required' });
    if (!imageUrl?.trim())
      return res.status(400).json({ error: 'imageUrl is required' });

    const purchase = await Purchase.findById(req.params.id);
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });

    const refundEntry = {
      amount:      Math.round(Number(amount)),
      notes:       notes.trim(),
      imageUrl:    imageUrl.trim(),
      initiatedAt: new Date(),
    };

    purchase.refunds = purchase.refunds || [];
    purchase.refunds.push(refundEntry);
    await purchase.save();

    await AccountsEntry.create({
      purchaseId:  purchase._id,
      userId:      purchase.userId || null,
      type:        'refund',
      amount:      refundEntry.amount,
      description: `Refund: ${purchase.orderId || purchase._id}`,
    });

    res.json({ success: true, refund: refundEntry });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * PATCH /api/admin/purchases/:id/notes
 * Update the admin notes for an order.
 * Body: { notes: string }
 */
export async function updatePurchaseNotes(req, res) {
  try {
    const { notes } = req.body;
    if (notes === undefined) return res.status(400).json({ error: 'notes is required' });
    const purchase = await Purchase.findByIdAndUpdate(
      req.params.id,
      { $set: { notes } },
      { new: true }
    ).lean();
    if (!purchase) return res.status(404).json({ error: 'Purchase not found' });
    res.json({ success: true, notes: purchase.notes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/admin/users/:id/grant-access
 * Manually grant product access to a user (creates a free custom purchase).
 * Body: { productIds: string[] }
 */
export async function grantUserAccess(req, res) {
  try {
    const user = await User.findById(req.params.id)
    if (!user) return res.status(404).json({ error: 'User not found' })

    const { productIds } = req.body
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ error: 'productIds array is required' })
    }

    const products = await Product.find({ _id: { $in: productIds } })
    if (products.length === 0) return res.status(404).json({ error: 'No products found' })

    await recordPurchase({
      userId:           user._id,
      products:         products.map(p => ({
        productId:    p._id,
        name:         p.name,
        amount:       0,
        category:     p.category,
        subCategory:  p.subCategory,
        level:        p.level,
        shipToHome:   false,
      })),
      source:           'custom',
      orderId:          `ADMIN-GRANT-${Date.now()}`,
      currency:         'INR',
      fulfillmentStatus: 'fulfilled',
      customerPhone:    user.phoneNumber,
      customerName:     user.name,
    })

    const updated = await User.findById(user._id).lean()
    res.json({ ok: true, user: updated })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

/**
 * GET /api/admin/users/:id
 * Get a single user with their purchase summary.
 */
export async function getUser(req, res) {
  try {
    const [user, purchases] = await Promise.all([
      User.findById(req.params.id).lean(),
      Purchase.find({ userId: req.params.id }).sort({ createdAt: -1 }).lean(),
    ])
    if (!user) return res.status(404).json({ error: 'User not found' })
    res.json({ user, purchases })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

/**
 * GET /api/admin/students/:id/progress
 * Admin view of a student's video watch progress.
 */
/**
 * PUT /api/admin/products/:id/content-access
 * Set which CA levels and subjects this product grants access to.
 */
const CA_LEVELS_VALID = ['Foundation', 'Intermediate', 'Final']
export async function updateProductContentAccess(req, res) {
  const { levels = [], subjectIds = [] } = req.body
  const validLevels     = levels.filter(l => CA_LEVELS_VALID.includes(l))
  const validSubjectIds = subjectIds.filter(id => mongoose.Types.ObjectId.isValid(id))

  const product = await Product.findByIdAndUpdate(
    req.params.id,
    { contentAccess: { levels: validLevels, subjectIds: validSubjectIds } },
    { new: true }
  )
  if (!product) return res.status(404).json({ error: 'Not found' })
  clearProductCache(req.params.id)
  res.json({ ok: true, contentAccess: product.contentAccess })
}

export async function getStudentProgress(req, res) {
  try {
    const VideoProgress = (await import('../models/VideoProgress.js')).default
    const progress = await VideoProgress.find({ userId: req.params.id })
      .populate('contentId', 'title type subject')
      .populate('productId', 'name')
      .sort({ updatedAt: -1 })
      .lean()

    const totalSeconds = progress.reduce((sum, p) => sum + (p.watchedSeconds || 0), 0)
    res.json({ progress, totalSeconds })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
