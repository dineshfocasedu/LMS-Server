// models/Purchase.js
import mongoose from "mongoose"

const purchaseSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

  // Customer details captured at time of purchase
  customerName: { type: String, default: null },
  customerPhone: { type: String, default: null },

  // Where the purchase came from
  // 'shopify' = purchased on Shopify (book only)
  // 'website' = purchased on React site (course only or book only)
  // 'combo'   = purchased on React site as course + book bundle
  // 'custom'  = created via Razorpay payment link by admin
  source: { type: String, enum: ['shopify', 'website', 'combo', 'custom'], required: true },

  // External order reference
  orderId: { type: String, required: true },

  // All products in this order
  items: [
    {
      productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
      name: String,
      amount: Number,
      category: String,
      subCategory: String,
      level: String
    }
  ],

  currency: { type: String, default: 'INR' },

  address: {
    line1: String,
    line2: String,
    city: String,
    state: String,
    pincode: String,
    country: { type: String, default: 'India' },
  },

  // True if at least one item in this order needs physical delivery
  hasPhysicalItem: { type: Boolean, default: false },

  status: { type: String, enum: ['paid', 'refunded', 'pending'], default: 'paid' },

  // Shopify fulfillment state
  fulfillmentStatus: {
    type: String,
    enum: ['unfulfilled', 'partial', 'fulfilled', 'restocked'],
    default: 'unfulfilled'
  },

  // Admin notes for this order
  notes: { type: String, default: '' },

  // Refunds initiated by admin
  refunds: [
    {
      amount:      { type: Number, required: true },
      notes:       { type: String, required: true },
      imageUrl:    { type: String, required: true },
      initiatedAt: { type: Date,   default: Date.now },
      _id: false,
    }
  ],

  // Delhivery shipment info (set after shipment is created)
  shipment: {
    awb: String,                  // Delhivery waybill number
    sortCode: String,
    trackingStatus: String,       // latest status from Delhivery
    trackingLocation: String,
    lastStatusAt: Date,
    createdAt: Date,
    // Full history of all status changes pushed by Delhivery webhook
    statusHistory: [
      {
        status:    { type: String },
        location:  { type: String },
        timestamp: { type: Date },
      }
    ],
  }
}, { timestamps: true });

// One document per order per user
purchaseSchema.index({ userId: 1, orderId: 1, source: 1 }, { unique: true });

const Purchase = mongoose.model('Purchase', purchaseSchema);
export default Purchase;
