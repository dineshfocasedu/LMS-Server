import mongoose from 'mongoose'

const contentSchema = new mongoose.Schema({
  title:       { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  type:        { type: String, enum: ['video', 'pdf'], required: true },
  subject:     { type: String, required: true, trim: true },
  productId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },  // legacy single-product (kept for existing records)
  productIds:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],  // multi-product assignment
  storagePath: { type: String, required: true },
  url:         { type: String, required: true },
  size:        { type: Number, default: 0 },       // bytes
  order:       { type: Number, default: 0 },
  isActive:         { type: Boolean, default: true },
  faststartApplied: { type: Boolean, default: false },
  hlsPath:          { type: String, default: null },
  bunnyVideoId:     { type: String, default: null },
  status:           { type: String, enum: ['processing', 'ready', 'error'], default: 'ready' },
  uploadedBy:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

contentSchema.index({ subject: 1, order: 1 })
contentSchema.index({ productId: 1 })
contentSchema.index({ productIds: 1 })
contentSchema.index({ type: 1 })

export default mongoose.model('Content', contentSchema)
