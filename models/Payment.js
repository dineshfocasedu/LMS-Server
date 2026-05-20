// models/Payment.js
import mongoose from "mongoose";

// ── Instalment sub-document (one per EMI link) ────────────────────────────────
const instalmentSchema = new mongoose.Schema(
  {
    payment_link_id:     { type: String, required: true },
    short_url:           { type: String },
    amount:              { type: Number, required: true }, // rupees
    emi_index:           { type: Number, default: null },  // 1-based; null = full payment
    status: {
      type: String,
      enum: ["created", "paid", "cancelled", "expired"],
      default: "created",
    },
    razorpay_payment_id: { type: String, default: null },
    paid_at:             { type: Date,   default: null },
  },
  { _id: false }
);

// ── Payment (one document per payment link, regardless of EMI count) ───────────
const paymentSchema = new mongoose.Schema(
  {
    // Customer info (required at link creation)
    name:         { type: String, required: true },
    phone:        { type: String, required: true },
    product_name: { type: String, required: true }, // derived: joined item names
    note:         { type: String, default: null },

    // Products included in this payment link (one or many)
    products: [{
      product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
      name:       { type: String, required: true },
      price:      { type: Number, required: true },
      _id: false,
    }],

    full_amount:      { type: Number, required: true }, // discounted total (what customer pays)
    original_amount:  { type: Number, default: null },  // pre-discount total, for reference
    discount_amount:  { type: Number, default: 0 },     // fixed rupee discount; 0 means no discount

    // EMI tracking (null when full payment, 2 or 3 for EMI)
    emi_total: { type: Number, default: null },
    emi_paid:  { type: Number, default: 0 },

    // Overall payment status
    status: {
      type: String,
      enum: ["created", "partially_paid", "paid", "cancelled", "expired"],
      default: "created",
    },

    instalments: [instalmentSchema], // 1 entry for full payment, N for EMI

    // ── Access grants applied to user on full payment ─────────────────────────
    grant_courses:  { type: [String], default: [] }, // e.g. ["ca-inter-g1"]
    grant_features: { type: [String], default: [] }, // e.g. ["videos", "tests"]

    // ── Delivery address (set when shipToHome is true) ────────────────────────
    address: {
      line1:   { type: String, default: null },
      line2:   { type: String, default: null },
      city:    { type: String, default: null },
      state:   { type: String, default: null },
      pincode: { type: String, default: null },
      country: { type: String, default: 'India' },
    },

    // ── Admin-configurable per-link settings ──────────────────────────────────
    // Whether physical delivery is needed
    shipToHome: { type: Boolean, default: false },

    // Show sync button when emi_paid >= sync_show_after
    // For full payment: always 1. For 2-EMI: 1 or 2. For 3-EMI: 1, 2, or 3.
    sync_show_after: { type: Number, default: 1 },

    // ── User linkage ──────────────────────────────────────────────────────────
    // Set after the first instalment is paid and user record is created/found
    user_id:      { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    user_created: { type: Boolean, default: false }, // true once user record is ensured

    paid_at:            { type: Date,   default: null }, // set when all instalments are paid
    razorpay_order_id:  { type: String, default: null }, // order_xxx from first payment webhook
  },
  { timestamps: true }
);

export default mongoose.model("Payment", paymentSchema);
