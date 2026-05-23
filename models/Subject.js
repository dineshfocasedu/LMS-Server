import mongoose from 'mongoose'

const CA_LEVELS = ['Foundation', 'Intermediate', 'Final']

const subjectSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  level:       { type: String, enum: CA_LEVELS, required: true },
  description: { type: String, default: '' },
  order:       { type: Number, default: 0 },
  isActive:    { type: Boolean, default: true },
}, { timestamps: true })

subjectSchema.index({ level: 1, order: 1 })
subjectSchema.index({ level: 1, name: 1 }, { unique: true })

export default mongoose.model('Subject', subjectSchema)
