// models/InventoryLog.js
import mongoose from "mongoose";

const InventoryLogSchema = new mongoose.Schema({
  productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  sku: String,
  type: {
    type: String,
    enum: ['sale', 'restock', 'manual_adjustment', 'return', 'damaged'],
    required: true
  },
  quantityChange: { type: Number, required: true }, // negative for sale/damaged, positive for restock/return
  stockBefore: { type: Number, required: true },
  stockAfter: { type: Number, required: true },
  orderId: String,   // linked order if type='sale'
  note: String,
}, { timestamps: true });

InventoryLogSchema.index({ productId: 1, createdAt: -1 });
InventoryLogSchema.index({ type: 1, createdAt: -1 });

const InventoryLog = mongoose.model('InventoryLog', InventoryLogSchema);
export default InventoryLog;
