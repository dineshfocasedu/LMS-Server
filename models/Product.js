// models/Product.js
import mongoose from "mongoose"

const CA_LEVELS = ["Foundation", "Intermediate", "Final"];

const productSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: String,
  price: Number,
  originalPrice: Number, // For discounts
  imageUrl: String,

  shopifyProductId: { type: String, unique: true, sparse: true },

  // Platform-specific prices
  // price         = website standalone price (React site, book-only purchase)
  // shopifyPrice  = price shown/charged on Shopify
  // comboPrice    = price for this item when part of a combo order (course + book)
  shopifyPrice: { type: Number, default: null },
  comboPrice:   { type: Number, default: null },

  productId: { type: String, unique: true, sparse: true },

  category: { type: String, default: null },
  subCategory: { type: String, default: null },

  // CA Level — optional, only set for CA-related products
  level: {
    type: String,
    enum: CA_LEVELS,
    default: null,
  },
 

  // Marks this product as a course (digital learning content)
  isCourse: { type: Boolean, default: false },

  // Weight in grams — used for Delhivery shipment creation
  weight: { type: Number, default: null },

  // If true, a physical shipment will be auto-created in Delhivery when purchased from website
  shipToHome: { type: Boolean, default: false },

  grants: {
    courses: [String],
    features: [String],
  },

  // LMS content access — grants access to entire subjects or levels without per-video assignment
  contentAccess: {
    levels:     { type: [String], enum: CA_LEVELS, default: [] },
    subjectIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Subject' }],
  },

  // Inventory tracking — null means not tracked
  stock: { type: Number, default: null },

  // If true, this product appears in the combo store (React client)
  showInComboStore: { type: Boolean, default: false },

  // Created inline during payment link generation (not a catalog product)
  isCustom: { type: Boolean, default: false },

  // Bundle support — groups multiple products into one purchasable item
  isBundle: { type: Boolean, default: false },
  bundleItems: [{
    product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    name:       { type: String, required: true },
    price:      { type: Number, default: 0 },
    isCustom:   { type: Boolean, default: false },
    _id:        false,
  }],
}, { timestamps: true });

// Used in listProducts countDocuments calls
productSchema.index({ isCustom: 1 });
productSchema.index({ isBundle: 1 });
productSchema.index({ isCourse: 1 });
productSchema.index({ createdAt: -1 });

const Product = mongoose.model('Product', productSchema);
export default Product;