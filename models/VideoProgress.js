import mongoose from 'mongoose'

const schema = new mongoose.Schema({
  userId:         { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },
  contentId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Content', required: true },
  productId:      { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  lastPosition:   { type: Number, default: 0 },   // seconds — resume point
  watchedSeconds: { type: Number, default: 0 },   // cumulative unique seconds watched
  completed:      { type: Boolean, default: false },
}, { timestamps: true })

schema.index({ userId: 1, contentId: 1 }, { unique: true })
schema.index({ userId: 1, productId: 1 })

export default mongoose.model('VideoProgress', schema)
