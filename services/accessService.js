// services/accessService.js
import User from "../models/User.js"
import Purchase from "../models/Purchase.js"
import Product from "../models/Product.js"
import InventoryLog from "../models/InventoryLog.js"

// Normalize phone to last 10 digits only
export function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, ''); // strip non-digits
  return digits.slice(-10);
}

function normalizeAddress(address) {
  if (!address || typeof address !== 'object') return undefined;

  const pincodeRaw = address.pincode ?? address.zip ?? address.postalCode ?? address.postal_code ?? '';
  const normalizedPincode = String(pincodeRaw).replace(/\D/g, '').slice(0, 6) || undefined;

  return {
    ...(address.line1 ? { line1: String(address.line1).trim() } : {}),
    ...(address.line2 ? { line2: String(address.line2).trim() } : {}),
    ...(address.city ? { city: String(address.city).trim() } : {}),
    ...(address.state ? { state: String(address.state).trim() } : {}),
    ...(normalizedPincode ? { pincode: normalizedPincode } : {}),
    country: address.country ? String(address.country).trim() : 'India',
  };
}

/**
 * Find user by phone or email. Create if not found.
 * @param {Object} params
 * @param {string} [params.phoneNumber]
 * @param {string} [params.email]
 * @param {string} [params.name]
 * @param {string} [params.shopifyId]
 */
export async function getOrCreateUser({ phoneNumber, email, name, shopifyId }) {
  phoneNumber = normalizePhone(phoneNumber);

  // Try to find by shopifyId first, then phone, then email
  let user = null;

  if (shopifyId) {
    user = await User.findOne({ shopifyId });
  }
  if (!user && phoneNumber) {
    user = await User.findOne({ phoneNumber });
  }
  if (!user && email) {
    user = await User.findOne({ email: email.toLowerCase() });
  }

  if (!user) {
    user = await User.create({
      phoneNumber,
      email: email ? email.toLowerCase() : undefined,
      name: name || undefined,
      shopifyId: shopifyId || undefined,
      access: {
        shopify: { courses: [], features: [] },
        website: { courses: [], features: [] },
        combo:   { courses: [], features: [] },
      }
    });
  } else {
    // Update fields if we got new info
    if (shopifyId && !user.shopifyId) user.shopifyId = shopifyId;
    if (name && !user.name) user.name = name;
    if (email && !user.email) user.email = email.toLowerCase();
    if (phoneNumber && !user.phoneNumber) user.phoneNumber = phoneNumber;
    await user.save();
  }

  return user;
}

/**
 * Recalculate and update user.access from all their purchases.
 * Call this after any purchase is recorded.
 */
export async function updateUserAccess(userId) {
  const purchases = await Purchase.find({ userId, status: 'paid' }).populate('items.productId');

  const access = {
    shopify: { courses: new Set(), features: new Set() },
    website: { courses: new Set(), features: new Set() },
    combo:   { courses: new Set(), features: new Set() },
  };

  for (const purchase of purchases) {
    // 'custom' (admin grant) and any unknown source fall into 'website'
    const src = ['shopify', 'website', 'combo'].includes(purchase.source) ? purchase.source : 'website'
    for (const item of purchase.items) {
      const product = item.productId; // populated
      if (!product || !product.grants) continue;
      product.grants.courses.forEach(c => access[src].courses.add(c));
      product.grants.features.forEach(f => access[src].features.add(f));
    }
  }

  await User.findByIdAndUpdate(userId, {
    'access.shopify.courses': [...access.shopify.courses],
    'access.shopify.features': [...access.shopify.features],
    'access.website.courses': [...access.website.courses],
    'access.website.features': [...access.website.features],
    'access.combo.courses':   [...access.combo.courses],
    'access.combo.features':  [...access.combo.features],
  });
}

/**
 * Record one or multiple purchases and update user access.
 * Accepts a single product or an array of products in the same order.
 * Idempotent — safe to call multiple times for the same order+product.
 *
 * @param {Object} params
 * @param {string|string[]} params.productId - single productId or array of productIds
 */
export async function recordPurchase({ userId, products, source, orderId, currency, address, fulfillmentStatus, customerName, customerPhone }) {
  // products: [{ productId, name, amount, shipToHome? }]
  const productList = Array.isArray(products) ? products : [products];
  const items = productList.map(p => ({
    productId: p.productId,
    name: p.name,
    amount: p.amount,
    category: p.category,
    subCategory: p.subCategory,
    level: p.level
  }));

  const hasPhysicalItem = productList.some(p => p.shipToHome === true);
  const normalizedAddress = normalizeAddress(address);

  const setOnInsert = {
    currency: currency || 'INR',
    status: 'paid',
    hasPhysicalItem,
  };

  const setAlways = {
    fulfillmentStatus: fulfillmentStatus || 'unfulfilled',
    ...(normalizedAddress && { address: normalizedAddress }),
    ...(customerName && { customerName }),
    ...(customerPhone && { customerPhone }),
  };

  // Only reduce stock for new purchases (idempotent — skip if order already recorded)
  const existingPurchase = await Purchase.findOne({ userId, orderId, source }).lean();
  const isNew = !existingPurchase;

  // Upsert: one document per order — items only set on insert, never appended on retry
  await Purchase.updateOne(
    { userId, orderId, source },
    {
      $setOnInsert: { ...setOnInsert, items },
      $set: setAlways,
    },
    { upsert: true }
  );

  // Atomically reduce stock for each product that has stock tracking enabled.
  // Uses findOneAndUpdate with $inc so concurrent purchases never double-decrement.
  if (isNew) {
    await Promise.allSettled(
      productList.map(async (p) => {
        // Atomic decrement — always fire for tracked products (stock can go negative)
        const updated = await Product.findOneAndUpdate(
          { _id: p.productId, stock: { $ne: null } },
          { $inc: { stock: -1 } },
          { new: false } // returns the doc *before* the update (stockBefore)
        );

        if (!updated) return; // stock is null → not tracked, skip

        const stockBefore = updated.stock;
        const stockAfter  = stockBefore - 1;

        await InventoryLog.create({
          productId:      updated._id,
          type:           'sale',
          quantityChange: -1,
          stockBefore,
          stockAfter,
          orderId,
          note:           `${source} order`,
        });
      })
    );
  }

  await updateUserAccess(userId);
}
