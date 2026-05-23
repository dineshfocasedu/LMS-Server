import Subject from '../models/Subject.js'
import Content from '../models/Content.js'

// GET /api/admin/subjects?level=Foundation
export async function listSubjects(req, res) {
  const { level } = req.query
  const filter = {}
  if (level) filter.level = level
  const subjects = await Subject.find(filter).sort({ level: 1, order: 1, name: 1 })
  res.json({ subjects })
}

// POST /api/admin/subjects
export async function createSubject(req, res) {
  const { name, level, description, order } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Name is required' })
  if (!level)        return res.status(400).json({ error: 'Level is required' })

  const valid = ['Foundation', 'Intermediate', 'Final']
  if (!valid.includes(level)) return res.status(400).json({ error: 'Invalid level' })

  try {
    const subject = await Subject.create({
      name: name.trim(),
      level,
      description: description?.trim() || '',
      order: parseInt(order) || 0,
    })
    res.status(201).json({ subject })
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'A subject with this name already exists in this level' })
    throw err
  }
}

// PUT /api/admin/subjects/:id
export async function updateSubject(req, res) {
  const { name, description, order, isActive } = req.body
  const update = {}
  if (name        !== undefined) update.name        = name.trim()
  if (description !== undefined) update.description = description.trim()
  if (order       !== undefined) update.order       = parseInt(order)
  if (isActive    !== undefined) update.isActive    = isActive

  try {
    const subject = await Subject.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true })
    if (!subject) return res.status(404).json({ error: 'Not found' })
    res.json({ subject })
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'A subject with this name already exists in this level' })
    throw err
  }
}

// DELETE /api/admin/subjects/:id
export async function deleteSubject(req, res) {
  const contentCount = await Content.countDocuments({
    $or: [{ subjectId: req.params.id }, { subjectIds: req.params.id }],
  })
  if (contentCount > 0) {
    return res.status(400).json({ error: `Cannot delete — ${contentCount} content item(s) are linked to this subject. Reassign them first.` })
  }
  const subject = await Subject.findByIdAndDelete(req.params.id)
  if (!subject) return res.status(404).json({ error: 'Not found' })
  res.json({ ok: true })
}
