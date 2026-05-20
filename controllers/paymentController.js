// controllers/paymentController.js
import crypto from "crypto";
import Payment from "../models/Payment.js";
import Product from "../models/Product.js";
import User from "../models/User.js";
import Purchase from "../models/Purchase.js";
import InventoryLog from "../models/InventoryLog.js";
import AccountsEntry from "../models/AccountsEntry.js";
import Settings from "../models/Settings.js";
import { sendLowStockAlert } from "../services/watiService.js";
import { normalizePhone } from "../services/accessService.js";

const KEY_ID         = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET     = process.env.RAZORPAY_KEY_SECRET;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcEmiAmounts(total, count) {
  const base = Math.floor(total / count);
  const rem  = total - base * count;
  const arr  = Array(count).fill(base);
  arr[count - 1] += rem;
  return arr;
}

async function createRazorpayLink(payload) {
  const creds = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString("base64");
  const res   = await fetch("https://api.razorpay.com/v1/payment_links", {
    method:  "POST",
    headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.description || "Razorpay error");
  return data;
}

// Create user if not found, then apply grant courses/features to website access.
// Grants are always applied immediately (on first payment / first EMI).
async function createUserAndApplyGrants(phone, name, grantCourses, grantFeatures) {
  const normalised = normalizePhone(phone);

  let user = await User.findOne({ phoneNumber: normalised });
  if (!user) {
    user = await User.create({
      phoneNumber: normalised,
      name:        name?.trim() || undefined,
      access: {
        website: { courses: [], features: [] },
        shopify: { courses: [], features: [] },
        combo:   { courses: [], features: [] },
      },
    });
  }

  if (grantCourses?.length || grantFeatures?.length) {
    await User.findByIdAndUpdate(user._id, {
      $addToSet: {
        "access.website.courses":  { $each: grantCourses  || [] },
        "access.website.features": { $each: grantFeatures || [] },
      },
    });
  }

  return user;
}

// 5-minute cache for the global settings singleton — avoids a DB hit on every webhook.
let _settingsCache = null;
let _settingsCacheAt = 0;
const SETTINGS_TTL = 5 * 60_000;

async function getSettings() {
  if (_settingsCache && Date.now() - _settingsCacheAt < SETTINGS_TTL) return _settingsCache;
  _settingsCache = await Settings.findById("global").lean().catch(() => null);
  _settingsCacheAt = Date.now();
  return _settingsCache;
}

// Decrement stock for each product that has inventory tracking enabled.
async function decrementInventory(products, orderId) {
  const settings = await getSettings();
  const threshold = settings?.lowStockThreshold ?? 5;
  const alertPhones = settings?.alertPhones || [];

  for (const item of products) {
    if (!item.product_id) continue;

    const product = await Product.findById(item.product_id);
    if (!product || product.stock == null) continue; // not tracked

    const stockBefore = product.stock;
    const stockAfter  = stockBefore - 1;

    await Product.findByIdAndUpdate(item.product_id, { $set: { stock: stockAfter } });

    await InventoryLog.create({
      productId:      item.product_id,
      sku:            product.productId || null,
      type:           "sale",
      quantityChange: -1,
      stockBefore,
      stockAfter,
      orderId:        orderId.toString(),
      note:           "Custom payment link sale",
    });

    // Send low stock WhatsApp alert (non-blocking)
    if (alertPhones.length > 0 && stockAfter <= threshold) {
      sendLowStockAlert(product.name, stockAfter, alertPhones).catch(() => {});
    }
  }
}

// Create a Purchase record (source='custom') so this sale appears in sales/orders views.
// Idempotent: skips silently if the record already exists.
async function createCustomPurchase(userId, payment) {
  try {
    const items = payment.products.map((p) => ({
      productId: p.product_id || undefined,
      name:      p.name,
      amount:    p.price,
    }));

    const purchaseData = {
      userId,
      customerName:    payment.name,
      customerPhone:   payment.phone,
      source:          "custom",
      orderId:         payment.razorpay_order_id || payment._id.toString(),
      items,
      hasPhysicalItem: payment.shipToHome || false,
      status:          "paid",
    };

    if (payment.shipToHome && payment.address?.line1) {
      purchaseData.address = {
        line1:   payment.address.line1,
        line2:   payment.address.line2 || null,
        city:    payment.address.city,
        state:   payment.address.state,
        pincode: payment.address.pincode,
        country: payment.address.country || 'India',
      };
    }

    await Purchase.create(purchaseData);
  } catch (err) {
    // Duplicate key = already recorded; ignore
    if (err.code !== 11000) {
      console.error("[createCustomPurchase] Failed (non-fatal):", err.message);
    }
  }
}

// Record accounting entries for a payment event.
async function recordAccountingEntries(payment, userId, paidInstalmentAmount, isFirstPayment, isFullyPaid) {
  const entries = [];

  if (isFirstPayment) {
    // Book the full sale value the moment first money arrives
    entries.push({
      paymentId:   payment._id,
      userId:      userId || null,
      type:        "sale",
      amount:      payment.full_amount,
      emi_index:   1,
      description: `Sale: ${payment.product_name}`,
    });

    const isEmi = payment.emi_total != null && payment.emi_total > 1;
    if (isEmi && !isFullyPaid) {
      // Outstanding balance = total - first EMI
      const outstanding = payment.full_amount - paidInstalmentAmount;
      if (outstanding > 0) {
        entries.push({
          paymentId:   payment._id,
          userId:      userId || null,
          type:        "receivable_created",
          amount:      outstanding,
          emi_index:   1,
          description: `Receivable: ${payment.product_name} (${payment.emi_total - 1} EMI(s) pending)`,
        });
      }
    }
  } else {
    // Subsequent EMI — reduce receivable only if a receivable_created entry exists
    const hasReceivable = await AccountsEntry.exists({
      paymentId: payment._id,
      type:      "receivable_created",
    });
    if (hasReceivable) {
      entries.push({
        paymentId:   payment._id,
        userId:      userId || null,
        type:        "receivable_payment",
        amount:      paidInstalmentAmount,
        emi_index:   payment.emi_paid,
        description: `EMI ${payment.emi_paid}/${payment.emi_total} received: ${payment.product_name}`,
      });
    }
  }

  if (entries.length) {
    await AccountsEntry.insertMany(entries).catch((err) =>
      console.error("[recordAccountingEntries] Failed (non-fatal):", err.message)
    );
  }
}

// ─── GET /api/payment ─────────────────────────────────────────────────────────
// Query params: phone, status, dateFrom, dateTo, page (default 1), limit (default 20)
// Response includes paginated payments + global status counts (for stats cards)
export async function listPayments(req, res) {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip  = (page - 1) * limit;

    const query = {};
    if (req.query.status) query.status = req.query.status;
    if (req.query.phone)  query.phone  = { $regex: req.query.phone };
    if (req.query.dateFrom || req.query.dateTo) {
      query.createdAt = {};
      if (req.query.dateFrom) query.createdAt.$gte = new Date(req.query.dateFrom);
      if (req.query.dateTo) {
        const end = new Date(req.query.dateTo);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }

    const [payments, total, globalAgg] = await Promise.all([
      Payment.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Payment.countDocuments(query),
      // Global counts (unfiltered) for stats cards
      Payment.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    ]);

    const globalStats = { total: 0, paid: 0, partially_paid: 0, created: 0 };
    globalAgg.forEach((s) => {
      if (s._id) globalStats[s._id] = s.count;
      globalStats.total += s.count;
    });

    const result = payments.map((p) => ({
      ...p,
      show_sync: p.shipToHome && p.emi_paid >= p.sync_show_after,
    }));

    res.json({
      payments: result,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
      stats: globalStats,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─── GET /api/payment/:id ─────────────────────────────────────────────────────
export async function getPayment(req, res) {
  try {
    const payment = await Payment.findById(req.params.id).lean();
    if (!payment) return res.status(404).json({ error: "Payment not found" });
    res.json({
      payment: {
        ...payment,
        show_sync: payment.shipToHome && payment.emi_paid >= payment.sync_show_after,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─── POST /api/payment/create ─────────────────────────────────────────────────
// Body:
// {
//   name:            string   (required)
//   phone:           string   (required)
//   items:           Array<{  (required, at least one)
//     product_id?:   string   (existing product ObjectId, optional)
//     name:          string
//     price:         number   (rupees — may differ from catalog price)
//     isCustom?:     boolean  (true → create a new Product with isCustom flag)
//   }>
//   note:            string   (optional)
//   emi_count:       number   (optional: 2 or 3; omit for full payment)
//   shipToHome:      boolean  (optional, default false)
//   sync_show_after: number   (optional: 1/2/3, default 1)
//   grant_courses:   string[] (optional — merged with product grants on payment)
//   grant_features:  string[] (optional — merged with product grants on payment)
// }
export async function createPaymentLink(req, res) {
  const {
    name,
    phone,
    items,
    note,
    emi_count,
    discount_amount = 0,
    shipToHome      = false,
    address,
    sync_show_after,
    grant_courses   = [],
    grant_features  = [],
  } = req.body;

  // ── Validation ──────────────────────────────────────────────────────────────
  if (!name?.trim())  return res.status(400).json({ error: "name is required" });
  if (!phone?.trim()) return res.status(400).json({ error: "phone is required" });
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ error: "items array is required with at least one product" });

  if (shipToHome) {
    if (!address?.line1?.trim()) return res.status(400).json({ error: "Address Line 1 is required for Ship to Home" });
    if (!address?.city?.trim())  return res.status(400).json({ error: "City is required for Ship to Home" });
    if (!address?.pincode?.trim()) return res.status(400).json({ error: "Pincode is required for Ship to Home" });
    if (!address?.state?.trim()) return res.status(400).json({ error: "State is required for Ship to Home" });
  }

  for (const item of items) {
    if (!item.name?.trim()) return res.status(400).json({ error: "Each item must have a name" });
    if (!item.price || item.price < 1)
      return res.status(400).json({ error: `Item "${item.name}" must have a positive price` });
  }

  const discAmt = Math.round(Number(discount_amount) || 0);
  if (discAmt < 0)
    return res.status(400).json({ error: "discount_amount must be a non-negative number" });

  const isEmi = emi_count === 2 || emi_count === 3;
  if (emi_count != null && !isEmi)
    return res.status(400).json({ error: "emi_count must be 2 or 3 (or omit for full payment)" });

  const maxSync   = isEmi ? emi_count : 1;
  const syncAfter = sync_show_after != null ? Number(sync_show_after) : 1;
  if (!Number.isInteger(syncAfter) || syncAfter < 1 || syncAfter > maxSync)
    return res.status(400).json({
      error: `sync_show_after must be between 1 and ${maxSync} for this payment type`,
    });

  const customer = {
    name:    name.trim(),
    contact: phone.replace(/\s/g, ""),
  };

  try {
    // ── Step 1: Resolve / create products ──────────────────────────────────────
    const resolvedItems = [];
    const autoGrantCourses  = [...(Array.isArray(grant_courses)  ? grant_courses  : [])];
    const autoGrantFeatures = [...(Array.isArray(grant_features) ? grant_features : [])];
    let   hasWeightForDelivery = false;

    for (const item of items) {
      if (item.isCustom) {
        const w = item.weight ? Number(item.weight) : null;
        if ((w || 0) > 0) hasWeightForDelivery = true;
        const newProduct = await Product.create({
          name:       item.name.trim(),
          price:      item.price,
          category:   "Custom",
          isCustom:   true,
          productId:  crypto.randomUUID(),
          weight:     w,
          shipToHome: shipToHome || false,
        });
        resolvedItems.push({
          product_id: newProduct._id,
          name:       newProduct.name,
          price:      item.price,
        });
      } else if (item.product_id) {
        const prod = await Product.findById(item.product_id).lean();
        if (!prod) return res.status(400).json({ error: `Product not found: ${item.product_id}` });
        if ((prod.weight || 0) > 0) hasWeightForDelivery = true;
        resolvedItems.push({
          product_id: prod._id,
          name:       prod.name,
          price:      item.price,
        });
        for (const c of (prod.grants?.courses  || [])) if (!autoGrantCourses.includes(c))  autoGrantCourses.push(c);
        for (const f of (prod.grants?.features || [])) if (!autoGrantFeatures.includes(f)) autoGrantFeatures.push(f);
      } else {
        resolvedItems.push({ product_id: null, name: item.name.trim(), price: item.price });
      }
    }

    // For Ship to Home orders, at least one product must have a weight set
    if (shipToHome && !hasWeightForDelivery)
      return res.status(400).json({ error: "Ship to Home requires at least one product with weight set. Please update a product's weight before creating this link." });

    const subtotal = resolvedItems.reduce((sum, i) => sum + i.price, 0);
    if (discAmt > subtotal)
      return res.status(400).json({ error: "discount_amount cannot exceed the order total" });
    const amount = subtotal - discAmt;
    const product_name = resolvedItems.map((i) => i.name).join(", ");

    // ── Step 2: Build Razorpay links ────────────────────────────────────────────
    let instalments = [];

    if (isEmi) {
      const emiAmounts = calcEmiAmounts(amount, emi_count);
      for (let i = 0; i < emiAmounts.length; i++) {
        const instalment = emiAmounts[i];
        const data = await createRazorpayLink({
          amount:         Math.round(instalment * 100),
          currency:       "INR",
          accept_partial: false,
          description:    `${product_name} | EMI ${i + 1} of ${emi_count} (₹${instalment} of ₹${amount} total)`,
          customer,
        });
        instalments.push({
          payment_link_id: data.id,
          short_url:       data.short_url,
          amount:          instalment,
          emi_index:       i + 1,
          status:          "created",
        });
      }
    } else {
      const data = await createRazorpayLink({
        amount:         Math.round(amount * 100),
        currency:       "INR",
        accept_partial: false,
        description:    product_name,
        customer,
      });
      instalments.push({
        payment_link_id: data.id,
        short_url:       data.short_url,
        amount,
        emi_index:       null,
        status:          "created",
      });
    }

    // ── Step 3: Save payment record ────────────────────────────────────────────
    const payment = await Payment.create({
      name:             name.trim(),
      phone:            phone.replace(/\s/g, ""),
      product_name:     product_name,
      products:         resolvedItems,
      note:             note?.trim() || null,
      full_amount:      amount,           // after discount — this is what goes into the ledger
      original_amount:  discAmt > 0 ? subtotal : null,
      discount_amount:  discAmt,
      emi_total:        isEmi ? emi_count : null,
      emi_paid:        0,
      status:          "created",
      instalments,
      shipToHome,
      address: shipToHome && address ? {
        line1:   address.line1?.trim(),
        line2:   address.line2?.trim() || null,
        city:    address.city?.trim(),
        state:   address.state?.trim(),
        pincode: address.pincode?.trim(),
        country: address.country || 'India',
      } : undefined,
      sync_show_after: syncAfter,
      grant_courses:   autoGrantCourses.filter(Boolean),
      grant_features:  autoGrantFeatures.filter(Boolean),
    });

    res.status(201).json({
      id:               payment._id,
      emi:              isEmi,
      emi_count:        isEmi ? emi_count : null,
      full_amount:      amount,
      original_amount:  discAmt > 0 ? subtotal : null,
      discount_amount:  discAmt,
      product_name,
      products:         resolvedItems,
      shipToHome:      payment.shipToHome,
      sync_show_after: payment.sync_show_after,
      grant_courses:   payment.grant_courses,
      grant_features:  payment.grant_features,
      links: instalments.map((ins) => ({
        id:        ins.payment_link_id,
        link:      ins.short_url,
        emi_index: ins.emi_index,
        amount:    ins.amount,
      })),
    });
  } catch (err) {
    console.error("[createPaymentLink]", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
}

// ─── POST /api/payment/webhook/razorpay ───────────────────────────────────────
export async function razorpayWebhook(req, res) {
  const signature = req.headers["x-razorpay-signature"];
  const rawBody   = req.rawBody;

  const expectedSig = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex");

  if (signature !== expectedSig)
    return res.status(400).json({ error: "Invalid webhook signature" });

  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch {
    return res.status(400).json({ error: "Invalid JSON payload" });
  }

  if (event.event === "payment_link.paid") {
    const { id: payment_link_id }                          = event.payload.payment_link.entity;
    const { id: razorpay_payment_id, order_id: razorpay_order_id } = event.payload.payment.entity;

    try {
      const updated = await Payment.findOneAndUpdate(
        {
          "instalments.payment_link_id": payment_link_id,
          "instalments.status": "created",
        },
        {
          $set: {
            "instalments.$.status":              "paid",
            "instalments.$.razorpay_payment_id": razorpay_payment_id,
            "instalments.$.paid_at":             new Date(),
            ...(razorpay_order_id ? { razorpay_order_id } : {}),
          },
          $inc: { emi_paid: 1 },
        },
        { new: true }
      );

      if (!updated) {
        console.warn(`[webhook] No pending instalment found for link: ${payment_link_id}`);
        return res.json({ received: true });
      }

      // Find the instalment that was just paid to know its amount
      const paidInstalment = updated.instalments.find(
        (ins) => ins.payment_link_id === payment_link_id
      );
      const paidAmount = paidInstalment?.amount ?? 0;

      const isFirstPayment = updated.emi_paid === 1;
      const isFullyPaid =
        updated.emi_total != null
          ? updated.emi_paid >= updated.emi_total
          : updated.emi_paid >= 1;

      const newStatus = isFullyPaid ? "paid" : "partially_paid";
      const statusUpdate = {
        status: newStatus,
        ...(isFullyPaid ? { paid_at: new Date() } : {}),
      };

      let userId = updated.user_id;

      // ── First payment: create/find user, grant access, record purchase ────────
      if (isFirstPayment && !updated.user_created) {
        try {
          // Grant access immediately on first EMI (not deferred to full payment)
          const user = await createUserAndApplyGrants(
            updated.phone,
            updated.name,
            updated.grant_courses,
            updated.grant_features,
          );
          userId = user._id;
          statusUpdate.user_id      = user._id;
          statusUpdate.user_created = true;
          console.log(`[webhook] ✅ User created/found + grants applied: ${user._id} (payment ${updated._id})`);

          // Create Purchase record so this sale appears in orders/sales views
          await createCustomPurchase(user._id, updated);

          // Decrement stock for inventory-tracked products
          await decrementInventory(updated.products, updated._id);
        } catch (userErr) {
          console.error("[webhook] User/purchase setup failed (non-fatal):", userErr);
        }
      }

      // ── On full payment when user was already created (EMI case) ─────────────
      // Grants already applied on first EMI; nothing extra needed here.

      // ── Record accounting entries ─────────────────────────────────────────────
      await recordAccountingEntries(updated, userId, paidAmount, isFirstPayment, isFullyPaid);

      await Payment.findByIdAndUpdate(updated._id, { $set: statusUpdate });
      console.log(`[webhook] [${newStatus}] emi_paid=${updated.emi_paid}/${updated.emi_total ?? 1} link: ${payment_link_id}`);
    } catch (err) {
      console.error("[webhook] Update failed:", err);
    }
  }

  res.json({ received: true });
}
