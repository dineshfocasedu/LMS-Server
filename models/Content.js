import mongoose from 'mongoose'

const contentSchema = new mongoose.Schema({
  title:       { type: String, required: true, trim: true },
  description: { type: String, default: '' },
  type:        { type: String, enum: ['video', 'pdf'], required: true },
  subject:     { type: String, required: true, trim: true },
  subjectId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', default: null },   // legacy single (kept for existing records)
  subjectIds:  [{ type: mongoose.Schema.Types.ObjectId, ref: 'Subject' }],                // multi-subject assignment
  level:       { type: String, enum: ['Foundation', 'Intermediate', 'Final'], default: null },
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
  // Content categorisation
  category:       { type: String, enum: ['lecture', 'question_bank', 'test_series'], default: 'lecture' },
  folder:         { type: String, default: '', trim: true },   // chapter / segment name (2nd grouping level)
  testSeriesType: { type: String, enum: ['chapter_wise', 'segment_wise', 'full_test'], default: null },
  // Test-series answer PDF (stored alongside question; never sent to students)
  answerStoragePath: { type: String, default: null },
  answerUrl:         { type: String, default: null },
  answerSize:        { type: Number, default: 0 },
}, { timestamps: true })

contentSchema.index({ subject: 1, order: 1 })
contentSchema.index({ subjectId: 1, order: 1 })
contentSchema.index({ subjectIds: 1 })
contentSchema.index({ level: 1 })
contentSchema.index({ productId: 1 })
contentSchema.index({ productIds: 1 })
contentSchema.index({ type: 1 })
// Used in getPublicContent (student hot path) and resumeProcessingPolls
contentSchema.index({ isActive: 1, status: 1 })
contentSchema.index({ bunnyVideoId: 1 }, { sparse: true })
contentSchema.index({ category: 1 })
contentSchema.index({ category: 1, folder: 1 })

export default mongoose.model('Content', contentSchema)
