// controllers/purchaseController.js
import crypto from "crypto"
import Razorpay from "razorpay"
import Product from "../models/Product.js"
import Purchase from "../models/Purchase.js"
import VideoProgress from "../models/VideoProgress.js"
import { recordPurchase, getOrCreateUser } from "../services/accessService.js"

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// 2-minute cache for the public product list (Explore page).
// Every student hitting the page saves a DB query.
let _productsCache = null;
let _productsCacheAt = 0;
const PRODUCTS_TTL = 2 * 60_000;

async function getCachedProducts() {
  if (_productsCache && Date.now() - _productsCacheAt < PRODUCTS_TTL) return _productsCache;
  _productsCache = await Product.find(
    { showInComboStore: true },
    'name description price shopifyPrice comboPrice originalPrice imageUrl category subCategory level isCourse shipToHome stock grants'
  ).sort({ createdAt: -1 }).lean();
  _productsCacheAt = Date.now();
  return _productsCache;
}

/**
 * POST /api/purchase/create-order
 *
 * Creates a Razorpay order for the given products.
 * The user must be logged in (auth middleware).
 *
 * Body: { productIds: string[] }
 * Response: { orderId, amount, currency, key }
 */
export async function createOrder(req, res) {
  try {
    // source: 'website' (course only / book only) or 'combo' (course + book bundle)
    const { productIds, name, phoneNumber, source = 'website' } = req.body;

    if (!productIds || productIds.length === 0) {
      return res.status(400).json({ error: 'productIds is required' });
    }
    if (!phoneNumber) {
      return res.status(400).json({ error: 'phoneNumber is required' });
    }
    if (!['website', 'combo'].includes(source)) {
      return res.status(400).json({ error: 'source must be website or combo' });
    }

    const ids = Array.isArray(productIds) ? productIds : [productIds];

    const products = await Product.find({ _id: { $in: ids } });
    if (products.length === 0) {
      return res.status(404).json({ error: 'No products found' });
    }

    // Use comboPrice for combo orders, otherwise use website price
    const totalAmount = products.reduce((sum, p) => {
      const price = source === 'combo' ? (p.comboPrice ?? p.price ?? 0) : (p.price ?? 0);
      return sum + price;
    }, 0);

    const order = await razorpay.orders.create({
      amount: Math.round(totalAmount * 100), // paise
      currency: 'INR',
      receipt: `receipt_${Date.now()}`,
      notes: {
        productIds: ids.join(','),
        phoneNumber,
        source,
        ...(name && { name }),
      },
    });

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/purchase/verify
 *
 * Verifies the Razorpay payment signature and grants access.
 * The user must be logged in (auth middleware).
 *
 * Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature, productIds, currency }
 */
export async function verifyAndGrantAccess(req, res) {
  try {
    const {
      razorpay_order_id, razorpay_payment_id, razorpay_signature,
      productIds, currency,
      name, phoneNumber, address,
      source = 'website', // 'website' or 'combo'
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !productIds) {
      return res.status(400).json({ error: 'razorpay_order_id, razorpay_payment_id, razorpay_signature and productIds are required' });
    }
    if (!phoneNumber) {
      return res.status(400).json({ error: 'phoneNumber is required' });
    }
    if (!['website', 'combo'].includes(source)) {
      return res.status(400).json({ error: 'source must be website or combo' });
    }

    // Verify HMAC-SHA256 signature
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    const ids = Array.isArray(productIds) ? productIds : [productIds];

    const products = await Product.find({ _id: { $in: ids } });
    if (products.length === 0) {
      return res.status(404).json({ error: 'No products found' });
    }

    // Find or create user from form data
    const user = await getOrCreateUser({ phoneNumber, name });

    // Fetch actual amount paid from Razorpay
    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    const amountPaid = payment.amount / 100; // paise → rupees

    await recordPurchase({
      userId: user._id,
      products: products.map(p => ({
        productId: p._id,
        name: p.name,
        amount: amountPaid / products.length,
        category: p.category,
        subCategory: p.subCategory,
        level: p.level,
        shipToHome: p.shipToHome || false,
      })),
      source,
      orderId: razorpay_order_id,
      currency: currency || 'INR',
      address: address || undefined,
      fulfillmentStatus: 'unfulfilled',
      customerName: name || undefined,
      customerPhone: phoneNumber || undefined,
    });

    const grants = products.flatMap(p => p.grants?.courses ?? []);

    res.json({
      success: true,
      message: 'Payment verified and access granted',
      userId: user._id,
      grants,
    });
    console.log(`✅ Purchase recorded for user ${user._id} with products ${ids.join(',')}`);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * GET /api/purchase/my-purchases
 * Returns all purchases for the logged-in user.
 */
export async function getMyPurchases(req, res) {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const query = { userId: req.user._id };
    const [purchases, total] = await Promise.all([
      Purchase.find(query)
        .populate('items.productId', 'name description price grants')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Purchase.countDocuments(query),
    ]);

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
 * GET /api/purchase/products
 * Public — list all available products.
 */
export async function listProducts(_req, res) {
  try {
    const products = await getCachedProducts();
    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function getCourseByLevel(req, res) {
  try {
    const { level } = req.query;
    if (!level) {
      return res.status(400).json({ error: 'level query parameter is required' });
    }
    const products = await Product.find({ isCourse: true, level });
    res.json({ products });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

export async function getCourseById(req, res) { 
  try {
    const { id } = req.params;
    if (!id) {
      return res.status(400).json({ error: 'id parameter is required' });
    }
    const product = await Product.findById(id);
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json({ product });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
// GET /api/purchase/my-courses  (auth required)
// Two-path lookup so courses always show regardless of grants.courses string mismatch:
//   Path A: user.access.*.courses → Product.grants.courses (handles Shopify/webhook access)
//   Path B: paid purchases → productIds directly (handles admin grants, website purchases)
export async function getMyCourses(req, res) {
  try {
    const user   = req.user
    const access = user.access || {}
    const enrolledCourseNames = [
      ...(access.website?.courses || []),
      ...(access.shopify?.courses || []),
      ...(access.combo?.courses   || []),
    ]

    // Path A: grants string match
    const byGrantsPromise = enrolledCourseNames.length > 0
      ? Product.find({ 'grants.courses': { $in: enrolledCourseNames } }).lean()
      : Promise.resolve([])

    // Path B: direct paid purchase lookup
    const purchases = await Purchase.find({ userId: user._id, status: 'paid' }).select('items source').lean()
    const purchasedIds = [...new Set(purchases.flatMap(p => (p.items || []).map(i => i.productId?.toString()).filter(Boolean)))]
    console.log(`[my-courses] user=${user._id} access=${JSON.stringify(enrolledCourseNames)} purchases=${purchases.length} productIds=${JSON.stringify(purchasedIds)}`)
    const byPurchasePromise = purchasedIds.length > 0
      ? Product.find({ _id: { $in: purchasedIds } }).lean()
      : Promise.resolve([])

    const [byGrants, byPurchase] = await Promise.all([byGrantsPromise, byPurchasePromise])

    // Merge, deduplicate by product ID
    const seen = new Set()
    const allProducts = [...byGrants, ...byPurchase].filter(p => {
      const id = p._id.toString()
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })

    if (allProducts.length === 0) return res.json({ courses: [] })

    const courses = allProducts.map(p => {
      let source = 'website'
      if ((access.shopify?.courses || []).some(c => (p.grants?.courses || []).includes(c))) source = 'shopify'
      else if ((access.combo?.courses || []).some(c => (p.grants?.courses || []).includes(c))) source = 'combo'
      return { product: p, source }
    })

    res.json({ courses })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

// POST /api/purchase/progress  (auth required)
// Body: { contentId, productId, lastPosition, watchedSeconds }
export async function saveProgress(req, res) {
  try {
    const { contentId, productId, lastPosition, watchedSeconds } = req.body
    const userId = req.user._id

    const update = { $max: { watchedSeconds: watchedSeconds || 0 } }
    // Only overwrite lastPosition when caller has actual video currentTime (> 0)
    const setFields = { ...(productId && { productId }) }
    if (lastPosition > 0) setFields.lastPosition = lastPosition
    if (Object.keys(setFields).length) update.$set = setFields

    await VideoProgress.findOneAndUpdate({ userId, contentId }, update, { upsert: true })

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}

// GET /api/purchase/progress?productId=  (auth required)
export async function getProgress(req, res) {
  try {
    const { productId } = req.query
    const filter = { userId: req.user._id }
    if (productId) filter.productId = productId

    const progress = await VideoProgress.find(filter).lean()
    // Return as a map: { [contentId]: { lastPosition, watchedSeconds, completed } }
    const map = {}
    progress.forEach(p => { map[p.contentId.toString()] = p })
    res.json({ progress: map })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
}
