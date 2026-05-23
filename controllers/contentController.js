import fs from 'fs'
import path from 'path'
import https from 'https'
import crypto from 'crypto'
import { spawn } from 'child_process'
import axios from 'axios'
import ffmpegPath from 'ffmpeg-static'
import mongoose from 'mongoose'
import jwt from 'jsonwebtoken'
import Content from '../models/Content.js'
import Subject from '../models/Subject.js'
import Product from '../models/Product.js'
import Purchase from '../models/Purchase.js'

const JWT_SECRET = process.env.JWT_SECRET;

function enrolledCourses(user) {
  const a = user?.access || {}
  return [
    ...(a.website?.courses || []),
    ...(a.shopify?.courses || []),
    ...(a.combo?.courses   || []),
  ]
}

const BUNNY_API_KEY   = process.env.BUNNY_API_KEY
const BUNNY_ZONE      = process.env.BUNNY_STORAGE_ZONE
const BUNNY_ENDPOINT  = process.env.BUNNY_STORAGE_ENDPOINT || 'https://sg.storage.bunnycdn.com'
const BUNNY_CDN_URL   = process.env.BUNNY_CDN_URL

// Bunny Stream
const BUNNY_STREAM_API_KEY      = process.env.BUNNY_STREAM_API_KEY
const BUNNY_STREAM_LIBRARY_ID   = process.env.BUNNY_STREAM_LIBRARY_ID
const BUNNY_STREAM_TOKEN_KEY    = process.env.BUNNY_STREAM_TOKEN_KEY

// Auto-fetched and cached on first use if not set in env


function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

function fmtSize(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${(bytes / 1e3).toFixed(0)} KB`
}

// Move the moov atom to the start of the MP4 so browsers can play immediately
// without downloading the full file first. Uses copy mode (no re-encoding).
function applyFaststart(inputPath) {
  const outputPath = inputPath + '_fs.mp4'
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-i', inputPath, '-c', 'copy', '-movflags', '+faststart', '-y', outputPath
    ])
    proc.on('close', code => code === 0 ? resolve(outputPath) : reject(new Error(`ffmpeg exit ${code}`)))
    proc.on('error', reject)
  })
}

// Split MP4 into 6-second HLS segments using copy mode (no re-encoding = fast)
function generateHLS(inputPath, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true })
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-i', inputPath,
      '-c', 'copy',
      '-hls_time', '6',
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', path.join(outputDir, 'seg%04d.ts'),
      '-y',
      path.join(outputDir, 'playlist.m3u8'),
    ])
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg HLS exit ${code}`)))
    proc.on('error', reject)
  })
}

// Upload every file in dir to Bunny Storage with 8 parallel PUT requests
async function uploadDirToBunny(dir, bunnyBasePath) {
  const files = fs.readdirSync(dir)
  const BATCH = 8
  for (let i = 0; i < files.length; i += BATCH) {
    await Promise.all(
      files.slice(i, i + BATCH).map(filename => {
        const localPath = path.join(dir, filename)
        const uploadUrl = `${BUNNY_ENDPOINT}/${BUNNY_ZONE}/${bunnyBasePath}/${filename}`
        const size      = fs.statSync(localPath).size
        const parsed    = new URL(uploadUrl)
        return new Promise((resolve, reject) => {
          const req = https.request({
            hostname: parsed.hostname, port: 443, path: parsed.pathname, method: 'PUT',
            headers: { AccessKey: BUNNY_API_KEY, 'Content-Type': 'application/octet-stream', 'Content-Length': size },
          }, (res) => {
            res.resume()
            res.on('end', () => res.statusCode < 300 ? resolve() : reject(new Error(`Bunny ${res.statusCode} ${filename}`)))
          })
          req.on('error', reject)
          fs.createReadStream(localPath).pipe(req)
        })
      })
    )
  }
}

// Uploads a single file to Bunny Storage via HTTPS PUT
function bunnyPut(localPath, uploadUrl, fileSize) {
  const parsed = new URL(uploadUrl)
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: parsed.hostname, port: 443, path: parsed.pathname, method: 'PUT',
      headers: { AccessKey: BUNNY_API_KEY, 'Content-Type': 'application/octet-stream', 'Content-Length': fileSize },
    }, (res) => {
      let body = ''; res.setEncoding('utf8')
      res.on('data', d => { body += d })
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(res.statusCode)
        else { const e = new Error(body || `HTTP ${res.statusCode}`); e.status = res.statusCode; reject(e) }
      })
    })
    req.on('error', reject)
    fs.createReadStream(localPath).on('error', reject).pipe(req)
  })
}

// Upload video to Bunny Stream using native https (avoids axios SSL issues with large streams).
async function uploadToBunnyStreamBg(contentId, filePath, bunnyVideoId) {
  try {
    const fileSize = fs.statSync(filePath).size
    const uploadUrl = `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos/${bunnyVideoId}`
    const parsed = new URL(uploadUrl)

    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname,
        method: 'PUT',
        headers: {
          AccessKey: BUNNY_STREAM_API_KEY,
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileSize,
        },
      }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', d => { body += d })
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve()
          else reject(new Error(`HTTP ${res.statusCode}: ${body}`))
        })
      })
      req.on('error', reject)
      // Allow up to 30 minutes for very large files
      req.setTimeout(30 * 60 * 1000, () => req.destroy(new Error('Upload timeout')))
      fs.createReadStream(filePath).on('error', reject).pipe(req)
    })

    console.log(`✅ Bunny Stream upload done: ${bunnyVideoId}`)
    await Content.findByIdAndUpdate(contentId, { size: fileSize })
    pollBunnyStreamStatus(contentId, bunnyVideoId)
  } catch (e) {
    console.error('❌ Bunny Stream upload failed:', e.message)
    await Content.findByIdAndUpdate(contentId, { status: 'error' }).catch(() => {})
  } finally {
    fs.unlink(filePath, () => {})
  }
}

// Poll Bunny Stream until transcoding is done (status 4) or errored (5/6).
// Interval: 30s for first 60 attempts (30 min), then 60s after that.
// Max: 60 attempts × 30s + 660 attempts × 60s = 30 min + 11 hr = ~12 hrs total.
async function pollBunnyStreamStatus(contentId, bunnyVideoId, attempt = 0) {
  if (attempt > 720) {
    await Content.findByIdAndUpdate(contentId, { status: 'error' }).catch(() => {})
    console.error(`❌ Bunny polling timed out after 12 hrs: ${bunnyVideoId}`)
    return
  }
  const interval = attempt < 60 ? 30_000 : 60_000
  setTimeout(async () => {
    try {
      const { data } = await axios.get(
        `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos/${bunnyVideoId}`,
        { headers: { AccessKey: BUNNY_STREAM_API_KEY } }
      )
      // Bunny status: 0=Created 1=Uploaded 2=Processing 3=Transcoding 4=Finished 5=Error 6=UploadFailed
      if (data.status === 4) {
        await Content.findByIdAndUpdate(contentId, { status: 'ready', size: data.storageSize || 0 })
        console.log(`✅ Bunny Stream ready: ${bunnyVideoId}`)
      } else if (data.status === 5 || data.status === 6) {
        await Content.findByIdAndUpdate(contentId, { status: 'error' })
        console.error(`❌ Bunny Stream error: ${bunnyVideoId}`)
      } else {
        pollBunnyStreamStatus(contentId, bunnyVideoId, attempt + 1)
      }
    } catch {
      pollBunnyStreamStatus(contentId, bunnyVideoId, attempt + 1)
    }
  }, interval)
}

// Called on server startup — resumes polling for any video stuck in "processing"
// (handles browser disconnects, crashes, or failed upload-complete calls).
export async function resumeProcessingPolls() {
  try {
    const stuck = await Content.find({
      status: 'processing',
      bunnyVideoId: { $exists: true, $ne: null },
    }).select('bunnyVideoId').lean()
    if (stuck.length === 0) return
    console.log(`🔄 Resuming polling for ${stuck.length} processing video(s)`)
    for (const c of stuck) {
      pollBunnyStreamStatus(c._id.toString(), c.bunnyVideoId)
    }
  } catch (err) {
    console.error('resumeProcessingPolls error:', err.message)
  }
}

// Full pipeline: faststart → Bunny upload → HLS → HLS upload. Runs after response is sent.
async function processVideoBackground(contentId, tmpPath, uploadUrl, subjSlug) {
  let faststartPath = null
  let uploadFilePath = tmpPath
  let faststartApplied = false

  console.log(`⏳ Processing video ${contentId}`)
  try {
    // Step A: faststart (copy mode — fast, just moves moov atom)
    try {
      faststartPath = await applyFaststart(tmpPath)
      uploadFilePath = faststartPath
      faststartApplied = true
      console.log(`  ✅ faststart done`)
    } catch (e) {
      console.warn(`  ⚠️  faststart skipped: ${e.message}`)
    }

    const fileSize = fs.statSync(uploadFilePath).size

    // Step B: Upload MP4 to Bunny
    await bunnyPut(uploadFilePath, uploadUrl, fileSize)
    console.log(`  ✅ Bunny MP4 uploaded`)

    await Content.findByIdAndUpdate(contentId, { size: fileSize, faststartApplied })

    // Step C: Generate and upload HLS segments
    const hlsDir = uploadFilePath + '_hls'
    let hlsPath = null
    try {
      await generateHLS(uploadFilePath, hlsDir)
      hlsPath = `hls/${subjSlug}/${contentId}`
      await uploadDirToBunny(hlsDir, hlsPath)
      console.log(`  ✅ HLS uploaded: ${hlsPath}`)
    } catch (e) {
      console.warn(`  ⚠️  HLS skipped: ${e.message}`)
    } finally {
      fs.rmSync(hlsDir, { recursive: true, force: true })
    }

    await Content.findByIdAndUpdate(contentId, { status: 'ready', hlsPath })
    console.log(`✅ Video processing complete: ${contentId}`)
  } catch (e) {
    console.error(`❌ Video processing failed ${contentId}:`, e.message)
    await Content.findByIdAndUpdate(contentId, { status: 'error' }).catch(() => {})
  } finally {
    fs.unlink(tmpPath, () => {})
    if (faststartPath) fs.unlink(faststartPath, () => {})
  }
}

function parseProductIds(val) {
  if (!val) return []
  if (Array.isArray(val)) return val.filter(Boolean)
  if (typeof val === 'string') return val.split(',').map(s => s.trim()).filter(Boolean)
  return []
}

function parseSubjectIds(val) {
  if (!val) return []
  if (Array.isArray(val)) return val.filter(Boolean)
  if (typeof val === 'string') return val.split(',').map(s => s.trim()).filter(Boolean)
  return []
}

// Resolve an array of subjectIds → { subjectIds, subjectId, subject, level }
// subject and level are taken from the first subject (primary).
async function resolveSubjects(ids) {
  if (!ids || ids.length === 0) return { subjectIds: [], subjectId: null, subject: '', level: null }
  const docs = await Subject.find({ _id: { $in: ids } }).select('name level').lean()
  if (docs.length === 0) return null // invalid ids
  const primary = docs[0]
  return {
    subjectIds: docs.map(d => d._id),
    subjectId:  primary._id,
    subject:    primary.name,
    level:      primary.level,
  }
}

// POST /api/admin/content/prepare-upload
// Creates Bunny Stream video + Content record, returns TUS credentials for direct browser upload.
export async function prepareUpload(req, res) {
  const { title, subject, subjectIds: rawSIds, productIds, productId, description, order, fileSize } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })
  if (!BUNNY_STREAM_API_KEY || !BUNNY_STREAM_LIBRARY_ID) {
    return res.status(503).json({ error: 'Bunny Stream not configured' })
  }

  // Resolve subjects from subjectIds array
  const subjectIdList = parseSubjectIds(rawSIds)
  let resolvedSubject = subject?.trim() || ''
  let resolvedLevel   = null
  let resolvedSubjectId = null
  let resolvedSubjectIds = []
  if (subjectIdList.length > 0) {
    const resolved = await resolveSubjects(subjectIdList)
    if (!resolved) return res.status(400).json({ error: 'One or more invalid subjectIds' })
    resolvedSubject    = resolved.subject
    resolvedLevel      = resolved.level
    resolvedSubjectId  = resolved.subjectId
    resolvedSubjectIds = resolved.subjectIds
  }
  if (!resolvedSubject) return res.status(400).json({ error: 'At least one subject is required' })

  const resolvedProductIds = parseProductIds(productIds).length
    ? parseProductIds(productIds)
    : (productId ? [productId] : [])

  // Create video entry in Bunny Stream
  let bunnyVideoId
  try {
    const { data } = await axios.post(
      `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos`,
      { title: title.trim() },
      { headers: { AccessKey: BUNNY_STREAM_API_KEY, 'Content-Type': 'application/json' } }
    )
    bunnyVideoId = data.guid
  } catch (err) {
    return res.status(502).json({ error: `Bunny Stream create failed: ${err.message}` })
  }

  // Generate TUS upload signature (valid for 6 hours)
  const expireTime = Math.floor(Date.now() / 1000) + 6 * 3600
  const signature = crypto
    .createHash('sha256')
    .update(BUNNY_STREAM_LIBRARY_ID + BUNNY_STREAM_API_KEY + expireTime + bunnyVideoId)
    .digest('hex')

  // Create Content record immediately so it appears in the list as "processing"
  const content = await Content.create({
    title: title.trim(),
    description: description?.trim() || '',
    type: 'video',
    subject: resolvedSubject,
    subjectId: resolvedSubjectId,
    subjectIds: resolvedSubjectIds,
    level: resolvedLevel,
    productIds: resolvedProductIds,
    productId: null,
    storagePath: `stream/${bunnyVideoId}`,
    url: `https://iframe.mediadelivery.net/embed/${BUNNY_STREAM_LIBRARY_ID}/${bunnyVideoId}`,
    bunnyVideoId,
    size: parseInt(fileSize) || 0,
    order: parseInt(order) || 0,
    uploadedBy: req.user?._id,
    status: 'processing',
  })

  res.json({
    content,
    tusEndpoint: 'https://video.bunnycdn.com/tusupload',
    tusHeaders: {
      AuthorizationSignature: signature,
      AuthorizationExpire:    String(expireTime),
      VideoId:                bunnyVideoId,
      LibraryId:              String(BUNNY_STREAM_LIBRARY_ID),
    },
  })
}

// POST /api/admin/content/:id/upload-complete
// Called by the browser after TUS upload finishes — starts transcoding status polling.
export async function markUploadComplete(req, res) {
  const content = await Content.findById(req.params.id).select('bunnyVideoId')
  if (!content) return res.status(404).json({ error: 'Not found' })
  res.json({ ok: true })
  pollBunnyStreamStatus(content._id.toString(), content.bunnyVideoId)
}

// POST /api/admin/content/upload  (multipart)
export async function uploadContent(req, res) {
  if (!req.file) return res.status(400).json({ error: 'No file provided' })

  const { title, subject, subjectIds: rawSIds, productIds: rawPIds, productId, description, order } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'Title is required' })

  // Resolve subjects from subjectIds array
  const subjectIdList = parseSubjectIds(rawSIds)
  let resolvedSubject    = subject?.trim() || ''
  let resolvedLevel      = null
  let resolvedSubjectId  = null
  let resolvedSubjectIds = []
  if (subjectIdList.length > 0) {
    const resolved = await resolveSubjects(subjectIdList)
    if (!resolved) return res.status(400).json({ error: 'One or more invalid subjectIds' })
    resolvedSubject    = resolved.subject
    resolvedLevel      = resolved.level
    resolvedSubjectId  = resolved.subjectId
    resolvedSubjectIds = resolved.subjectIds
  }
  if (!resolvedSubject) return res.status(400).json({ error: 'At least one subject is required' })

  const resolvedProductIds = parseProductIds(rawPIds).length
    ? parseProductIds(rawPIds)
    : (productId ? [productId] : [])

  const mime = req.file.mimetype
  const type = mime.startsWith('video/') ? 'video'
             : mime === 'application/pdf' ? 'pdf'
             : null

  if (!type) {
    fs.unlink(req.file.path, () => {})
    return res.status(400).json({ error: 'Only video and PDF files are allowed' })
  }

  const folder      = type === 'video' ? 'videos' : 'docs'
  const subjSlug    = slugify(resolvedSubject)
  const safeName    = path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_')
  const storagePath = `${folder}/${subjSlug}/${Date.now()}_${safeName}`
  const uploadUrl   = `${BUNNY_ENDPOINT}/${BUNNY_ZONE}/${storagePath}`

  if (type === 'pdf') {
    // PDFs are small — upload synchronously, no processing needed
    try {
      const fileSize = fs.statSync(req.file.path).size
      await bunnyPut(req.file.path, uploadUrl, fileSize)
    } catch (err) {
      fs.unlink(req.file.path, () => {})
      const status = err.status
      if (status === 401) return res.status(502).json({ error: 'Bunny.net: Invalid API key (401).' })
      return res.status(502).json({ error: `Bunny upload failed (${status || 'network error'}): ${err.message}` })
    } finally {
      fs.unlink(req.file.path, () => {})
    }

    const content = await Content.create({
      title: title.trim(), description: description?.trim() || '',
      type, subject: resolvedSubject, subjectId: resolvedSubjectId, subjectIds: resolvedSubjectIds, level: resolvedLevel,
      productIds: resolvedProductIds, productId: null,
      storagePath, url: `${BUNNY_CDN_URL}/${storagePath}`,
      size: req.file.size, order: parseInt(order) || 0,
      uploadedBy: req.user?.id, status: 'ready',
    })
    return res.status(201).json({ content })
  }

  // For videos: use Bunny Stream if configured, otherwise fall back to Bunny Storage + HLS
  const useStream = !!(BUNNY_STREAM_API_KEY && BUNNY_STREAM_LIBRARY_ID)

  if (useStream) {
    let bunnyVideoId
    try {
      const { data } = await axios.post(
        `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos`,
        { title: title.trim() },
        { headers: { AccessKey: BUNNY_STREAM_API_KEY, 'Content-Type': 'application/json' } }
      )
      bunnyVideoId = data.guid
    } catch (err) {
      fs.unlink(req.file.path, () => {})
      return res.status(502).json({ error: `Bunny Stream error: ${err.message}` })
    }

    const content = await Content.create({
      title: title.trim(), description: description?.trim() || '',
      type, subject: resolvedSubject, subjectId: resolvedSubjectId, subjectIds: resolvedSubjectIds, level: resolvedLevel,
      productIds: resolvedProductIds, productId: null,
      storagePath: `stream/${bunnyVideoId}`,
      url: `https://iframe.mediadelivery.net/embed/${BUNNY_STREAM_LIBRARY_ID}/${bunnyVideoId}`,
      bunnyVideoId,
      size: req.file.size, order: parseInt(order) || 0,
      uploadedBy: req.user?.id, status: 'processing',
    })

    res.status(201).json({ content })
    uploadToBunnyStreamBg(content._id.toString(), req.file.path, bunnyVideoId).catch(() => {})
    return
  }

  // Fallback: Bunny Storage + ffmpeg HLS
  const content = await Content.create({
    title: title.trim(), description: description?.trim() || '',
    type, subject: resolvedSubject, subjectId: resolvedSubjectId, subjectIds: resolvedSubjectIds, level: resolvedLevel,
    productIds: resolvedProductIds, productId: null,
    storagePath, url: `${BUNNY_CDN_URL}/${storagePath}`,
    size: req.file.size, order: parseInt(order) || 0,
    uploadedBy: req.user?.id, status: 'processing',
  })

  // Respond immediately — browser gets success right away
  res.status(201).json({ content })

  // Process in background (does NOT block the HTTP response)
  processVideoBackground(content._id.toString(), req.file.path, uploadUrl, subjSlug).catch(() => {})
}

// GET /api/admin/content?subject=&subjectId=&level=&productId=&type=&page=&limit=
export async function listContent(req, res) {
  const { subject, subjectId, level, productId, type, search, page = 1, limit = 20 } = req.query

  // Build filter using $and so each clause is independent (avoids $or conflicts)
  const and = []

  if (subjectId) {
    and.push({ $or: [{ subjectIds: subjectId }, { subjectId: subjectId }] })
  } else if (subject) {
    and.push({ subject: { $regex: subject, $options: 'i' } })
  }

  if (level) {
    // Find every subject belonging to this level, then match content that has ANY of them.
    // This is correct when one video is assigned to subjects across multiple levels.
    const levelSubjectIds = await Subject.find({ level }).select('_id').lean().then(s => s.map(x => x._id))
    and.push({ $or: [
      { subjectIds: { $in: levelSubjectIds } },
      { subjectId:  { $in: levelSubjectIds } },
      { level },   // fallback for old records that only have the denormalised level string
    ]})
  }

  if (productId) {
    and.push({ $or: [{ productIds: productId }, { productId: productId }] })
  }
  if (type && ['video','pdf'].includes(type)) and.push({ type })
  if (search) and.push({ title: { $regex: search, $options: 'i' } })

  const filter = and.length ? { $and: and } : {}

  const [items, total] = await Promise.all([
    Content.find(filter)
      .sort({ level: 1, subject: 1, order: 1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(+limit)
      .populate('subjectIds', 'name level order')
      .populate('subjectId',  'name level order')
      .populate('productIds', 'name level')
      .populate('productId',  'name level'),
    Content.countDocuments(filter),
  ])

  const data = items.map(c => {
    const obj = c.toObject()
    // merge legacy productId into productIds
    const legacyProduct = obj.productId ? [obj.productId] : []
    const mergedProducts = [...(obj.productIds || []), ...legacyProduct].filter((p, _, arr) => {
      const key = String(p._id || p)
      return arr.findIndex(x => String(x._id || x) === key) === arr.indexOf(p)
    })
    // merge legacy subjectId into subjectIds
    const legacySubject = obj.subjectId && !obj.subjectIds?.some(s => String(s._id || s) === String(obj.subjectId._id || obj.subjectId))
      ? [obj.subjectId] : []
    const mergedSubjects = [...(obj.subjectIds || []), ...legacySubject]
    return { ...obj, productIds: mergedProducts, subjectIds: mergedSubjects, sizeLabel: fmtSize(c.size) }
  })
  res.json({ content: data, total, page: +page, pages: Math.ceil(total / limit) })
}

// GET /api/admin/content/subjects  — subjects from Subject collection (grouped by level)
export async function listSubjects(req, res) {
  const { level } = req.query
  const filter = {}
  if (level) filter.level = level
  const subjects = await Subject.find(filter).sort({ level: 1, order: 1, name: 1 })
  res.json({ subjects })
}

// PUT /api/admin/content/:id
export async function updateContent(req, res) {
  const { title, description, subject, subjectIds: rawSIds, productIds: rawPIds, productId, order, isActive, bunnyVideoId, status } = req.body
  const update = {}
  if (title       !== undefined) update.title       = title.trim()
  if (description !== undefined) update.description = description.trim()

  // If subjectIds is being updated, resolve names and level from Subject
  if (rawSIds !== undefined) {
    const idList = parseSubjectIds(rawSIds)
    if (idList.length > 0) {
      const resolved = await resolveSubjects(idList)
      if (!resolved) return res.status(400).json({ error: 'One or more invalid subjectIds' })
      update.subjectIds = resolved.subjectIds
      update.subjectId  = resolved.subjectId
      update.subject    = resolved.subject
      update.level      = resolved.level
    } else {
      update.subjectIds = []
      update.subjectId  = null
    }
  } else if (subject !== undefined) {
    update.subject = subject.trim()
  }

  if (rawPIds !== undefined) {
    update.productIds = parseProductIds(rawPIds)
    update.productId  = null
  } else if (productId !== undefined) {
    update.productIds = productId ? [productId] : []
    update.productId  = null
  }
  if (order    !== undefined) update.order    = parseInt(order)
  if (isActive !== undefined) update.isActive = isActive
  if (bunnyVideoId !== undefined) {
    update.bunnyVideoId = bunnyVideoId || null
    if (bunnyVideoId) {
      update.storagePath = `stream/${bunnyVideoId}`
      update.url = `https://iframe.mediadelivery.net/embed/${BUNNY_STREAM_LIBRARY_ID}/${bunnyVideoId}`
    }
  }
  if (status !== undefined) update.status = status

  _contentCache.clear()

  const content = await Content.findByIdAndUpdate(req.params.id, update, { new: true })
    .populate('subjectIds', 'name level order')
    .populate('subjectId',  'name level order')
    .populate('productIds', 'name level')
  if (!content) return res.status(404).json({ error: 'Not found' })
  res.json({ content })
}

// GET /api/admin/content/:id/preview  — proxies PDF/video from Bunny Storage for admin viewing
export async function previewContent(req, res) {
  const content = await Content.findById(req.params.id).select('storagePath type isActive bunnyVideoId')
  if (!content) return res.status(404).json({ error: 'Not found' })

  // Bunny Stream video — serve HTML wrapper with iframe so Bunny sees a proper referer
  if (content.bunnyVideoId) {
    const expires = Math.floor(Date.now() / 1000) + 7200
    const token = BUNNY_STREAM_TOKEN_KEY
      ? crypto.createHash('sha256').update(BUNNY_STREAM_TOKEN_KEY + content.bunnyVideoId + expires).digest('hex')
      : null
    const params = new URLSearchParams({ autoplay: 'false', loop: 'false', muted: 'false', preload: 'false', api: 'true' })
    if (token) { params.set('token', token); params.set('expires', String(expires)) }
    const embedUrl = `https://iframe.mediadelivery.net/embed/${BUNNY_STREAM_LIBRARY_ID}/${content.bunnyVideoId}?${params}`
    return res.set('Content-Type', 'text/html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Video Preview</title>
<style>*{margin:0;padding:0}html,body{width:100%;height:100%;background:#000}iframe{width:100%;height:100%;border:none;display:block}</style>
</head><body>
<iframe src="${embedUrl}" allowfullscreen allow="autoplay"></iframe>
</body></html>`)
  }

  // PDF / legacy storage video — proxy from Bunny Storage
  const storageUrl = `${BUNNY_ENDPOINT}/${BUNNY_ZONE}/${content.storagePath}`
  try {
    const upstream = await axios({
      method: 'GET',
      url: storageUrl,
      headers: { AccessKey: BUNNY_API_KEY },
      responseType: 'stream',
      validateStatus: () => true,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    })
    res.status(upstream.status)
    const mime = content.type === 'pdf' ? 'application/pdf' : 'video/mp4'
    res.set('Content-Type', mime)
    res.set('Content-Disposition', 'inline')
    if (upstream.headers['content-length']) res.set('Content-Length', upstream.headers['content-length'])
    res.set('Cache-Control', 'private, max-age=300')
    upstream.data.pipe(res)
  } catch {
    res.status(502).json({ error: 'Failed to fetch from storage' })
  }
}

// DELETE /api/admin/content/:id
export async function deleteContent(req, res) {
  const content = await Content.findByIdAndDelete(req.params.id)
  if (!content) return res.status(404).json({ error: 'Not found' })

  // Delete from Bunny Stream or Bunny Storage
  if (content.bunnyVideoId) {
    try {
      await axios.delete(
        `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos/${content.bunnyVideoId}`,
        { headers: { AccessKey: BUNNY_STREAM_API_KEY } }
      )
    } catch (err) {
      console.warn('Bunny Stream delete warn:', err.message)
    }
  } else {
    try {
      await axios.delete(`${BUNNY_ENDPOINT}/${BUNNY_ZONE}/${content.storagePath}`, {
        headers: { AccessKey: BUNNY_API_KEY },
      })
    } catch (err) {
      console.warn('Bunny Storage delete warn:', err.message)
    }
  }

  res.json({ ok: true })
}

// GET /api/purchase/stream-url/:contentId  (auth required)
export async function getStreamUrl(req, res) {
  const content = await Content.findById(req.params.contentId).select('storagePath type isActive productId productIds hlsPath status bunnyVideoId')
  if (!content || !content.isActive) return res.status(404).json({ error: 'Content not found' })
  if (content.status === 'processing') return res.status(503).json({ error: 'Video is still being processed. Please try again in a few minutes.' })

  // If our DB says error but the video is on Bunny Stream, do a live check —
  // transcoding may have finished after our polling window expired.
  if (content.status === 'error' && content.bunnyVideoId) {
    try {
      const { data } = await axios.get(
        `https://video.bunnycdn.com/library/${BUNNY_STREAM_LIBRARY_ID}/videos/${content.bunnyVideoId}`,
        { headers: { AccessKey: BUNNY_STREAM_API_KEY } }
      )
      if (data.status === 4) {
        await Content.findByIdAndUpdate(content._id, { status: 'ready', size: data.storageSize || content.size })
        content.status = 'ready'
      }
    } catch { /* ignore — fall through to error below */ }
  }

  if (content.status === 'error') return res.status(500).json({ error: 'Video processing failed. Please contact support.' })

  // Access check: user must be enrolled via user.access OR have a paid purchase for any assigned product
  const allProductIds = [
    ...(content.productIds || []),
    ...(content.productId ? [content.productId] : []),
  ]
  if (allProductIds.length > 0) {
    const products = await Product.find({
      _id: { $in: allProductIds },
      'grants.courses.0': { $exists: true },
    }).select('grants').lean()

    if (products.length > 0) {
      const userCourses = enrolledCourses(req.user)
      let hasAccess = false
      for (const product of products) {
        if (product.grants.courses.some(c => userCourses.includes(c))) { hasAccess = true; break }
        const hasByPurchase = await Purchase.exists({
          userId: req.user._id, status: 'paid', 'items.productId': product._id,
        })
        if (hasByPurchase) { hasAccess = true; break }
      }
      if (!hasAccess) return res.status(403).json({ error: 'Access denied' })
    }
  }

  // Bunny Stream videos: signed embed URL — token expires in 2h, prevents URL sharing
  if (content.bunnyVideoId) {
    if (!BUNNY_STREAM_LIBRARY_ID) {
      return res.status(503).json({ error: 'Video streaming is not configured on this server.' })
    }
    const expires = Math.floor(Date.now() / 1000) + 7200 // 2 hours
    const token = BUNNY_STREAM_TOKEN_KEY
      ? crypto.createHash('sha256').update(BUNNY_STREAM_TOKEN_KEY + content.bunnyVideoId + expires).digest('hex')
      : null
    const params = new URLSearchParams({ autoplay: 'false', loop: 'false', muted: 'false', preload: 'false', api: 'true' })
    if (token) { params.set('token', token); params.set('expires', String(expires)) }
    return res.json({
      embedUrl: `https://iframe.mediadelivery.net/embed/${BUNNY_STREAM_LIBRARY_ID}/${content.bunnyVideoId}?${params}`,
    })
  }

  // Legacy: Bunny Storage proxy — pre-signed path token (no auth header needed in browser)
  const streamToken = _createStreamToken(req.user._id.toString(), content._id.toString())
  const baseUrl = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`
  res.json({ url: `${baseUrl}/api/purchase/stream/${content._id}/${streamToken}` })
}

// Pre-signed path tokens — access checked once in getStreamUrl (auth-gated), token stored
// server-side so the browser can use the URL directly as <video src> without custom headers.
// Token sits in the URL PATH (not query param) so reverse proxies never strip it.
const _streamTokens = new Map()
const _STREAM_TOKEN_TTL = 2 * 60 * 60 * 1000  // 2 hours

function _createStreamToken(userId, contentId) {
  if (_streamTokens.size > 5000) {
    const now = Date.now()
    for (const [k, v] of _streamTokens) if (v.expiresAt <= now) _streamTokens.delete(k)
  }
  const token = crypto.randomBytes(32).toString('hex')
  _streamTokens.set(token, { userId, contentId, expiresAt: Date.now() + _STREAM_TOKEN_TTL })
  return token
}

function _verifyStreamToken(token, contentId) {
  const e = _streamTokens.get(token)
  if (!e || e.expiresAt <= Date.now() || e.contentId !== contentId) {
    _streamTokens.delete(token)
    return false
  }
  return true
}

// 2-minute cache for public content list per productId — same for every student
const _contentCache = new Map()
const _CONTENT_CACHE_TTL = 2 * 60_000

// GET /api/purchase/stream/:contentId/:token  (no auth middleware — access checked at getStreamUrl)
// Token lives in the URL path so proxies cannot strip it. Browser uses this URL directly
// as <video src>, enabling native range-request streaming without downloading the full file.
export async function streamContent(req, res) {
  if (!_verifyStreamToken(req.params.token, req.params.contentId)) {
    return res.status(401).json({ error: 'Invalid or expired stream token' })
  }

  const content = await Content.findById(req.params.contentId).select('storagePath type isActive')
  if (!content || !content.isActive) return res.status(404).json({ error: 'Not found' })

  if (!BUNNY_API_KEY || !BUNNY_ZONE) {
    return res.status(503).json({ error: 'Content storage is not configured on this server.' })
  }

  // Fetch directly from Bunny Storage (server-to-server, no CDN token auth issues)
  const storageUrl = `${BUNNY_ENDPOINT}/${BUNNY_ZONE}/${content.storagePath}`
  const upstreamHeaders = { AccessKey: BUNNY_API_KEY }
  if (req.headers.range) upstreamHeaders.Range = req.headers.range

  try {
    const upstream = await axios({
      method: 'GET',
      url: storageUrl,
      headers: upstreamHeaders,
      responseType: 'stream',
      validateStatus: () => true,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    })

    res.status(upstream.status)
    const fwd = ['content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']
    fwd.forEach(h => { if (upstream.headers[h]) res.set(h, upstream.headers[h]) })
    // Force correct MIME type — Bunny stores all uploads as application/octet-stream
    res.set('Content-Type', content.type === 'video' ? 'video/mp4' : (upstream.headers['content-type'] || 'application/octet-stream'))
    res.set('Accept-Ranges', 'bytes')
    res.set('Cache-Control', 'private, max-age=3600')

    upstream.data.pipe(res)
  } catch (err) {
    res.status(502).json({ error: 'Failed to stream content' })
  }
}

// GET /api/purchase/hls/:contentId/playlist.m3u8?st=TOKEN
// GET /api/purchase/hls/:contentId/seg0000.ts?st=TOKEN
// Proxies HLS playlist (rewriting segment URLs) and .ts segments from Bunny Storage.
export async function hlsProxy(req, res) {
  const { st } = req.query
  if (!st) return res.status(401).json({ error: 'Stream token required' })

  let payload
  try { payload = jwt.verify(st, JWT_SECRET) }
  catch { return res.status(401).json({ error: 'Invalid or expired stream token' }) }

  if (payload.t !== 'stream' || payload.contentId !== req.params.contentId) {
    return res.status(403).json({ error: 'Token mismatch' })
  }

  const content = await Content.findById(req.params.contentId).select('hlsPath isActive')
  if (!content || !content.isActive || !content.hlsPath) {
    return res.status(404).json({ error: 'HLS not available for this content' })
  }

  const { filename } = req.params
  const bunnyUrl = `${BUNNY_ENDPOINT}/${BUNNY_ZONE}/${content.hlsPath}/${filename}`

  try {
    if (filename === 'playlist.m3u8') {
      const resp    = await axios.get(bunnyUrl, { headers: { AccessKey: BUNNY_API_KEY } })
      const baseUrl = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`
      // Rewrite relative .ts lines to absolute proxy URLs that include the auth token
      const rewritten = resp.data.split('\n').map(line => {
        const t = line.trim()
        return t.endsWith('.ts')
          ? `${baseUrl}/api/purchase/hls/${req.params.contentId}/${t}?st=${st}`
          : line
      }).join('\n')
      res.set('Content-Type', 'application/vnd.apple.mpegurl')
      res.set('Cache-Control', 'private, max-age=3600')
      return res.send(rewritten)
    }

    if (filename.endsWith('.ts')) {
      const upstream = await axios({
        method: 'GET', url: bunnyUrl,
        headers: { AccessKey: BUNNY_API_KEY },
        responseType: 'stream',
        validateStatus: () => true,
      })
      res.status(upstream.status)
      res.set('Content-Type', 'video/MP2T')
      res.set('Cache-Control', 'private, max-age=86400')
      return upstream.data.pipe(res)
    }

    res.status(404).json({ error: 'Unknown HLS file type' })
  } catch (err) {
    res.status(502).json({ error: 'HLS proxy error' })
  }
}

// GET /api/purchase/content?subject=&productId=  (student-facing, no auth)
export async function getPublicContent(req, res) {
  const { subject, productId } = req.query

  // Per-product cache — content list is identical for all students in the same course (2-min TTL)
  if (productId) {
    if (!mongoose.Types.ObjectId.isValid(productId)) return res.json({ content: [] })
    const cached = _contentCache.get(productId)
    if (cached && cached.expiresAt > Date.now()) {
      const items = subject ? cached.data.filter(c => c.subject === subject) : cached.data
      return res.json({ content: items })
    }

    // Build access $or: direct per-video assignment + product-level contentAccess grants
    const accessOr = [
      { productIds: productId },
      { productId: productId },
    ]
    const product = await Product.findById(productId).select('contentAccess').lean()
    if (product?.contentAccess?.subjectIds?.length) {
      accessOr.push({ subjectIds: { $in: product.contentAccess.subjectIds } })
      accessOr.push({ subjectId:  { $in: product.contentAccess.subjectIds } })
    }
    if (product?.contentAccess?.levels?.length) {
      const levelSubjectIds = await Subject.find({ level: { $in: product.contentAccess.levels } })
        .select('_id').lean().then(s => s.map(x => x._id))
      if (levelSubjectIds.length) {
        accessOr.push({ subjectIds: { $in: levelSubjectIds } })
        accessOr.push({ subjectId:  { $in: levelSubjectIds } })
      }
      accessOr.push({ level: { $in: product.contentAccess.levels } })
    }

    const dbItems = await Content.find({
      isActive: true,
      status: { $ne: 'processing' },
      $or: accessOr,
    }).sort({ order: 1, createdAt: 1 })
      .select('title description type subject url size order createdAt')
      .lean()
    _contentCache.set(productId, { data: dbItems, expiresAt: Date.now() + _CONTENT_CACHE_TTL })
    const items = subject ? dbItems.filter(c => c.subject === subject) : dbItems
    return res.json({ content: items })
  }

  // No productId — uncached (rare path)
  const filter = { isActive: true, status: { $ne: 'processing' } }
  if (subject) filter.subject = subject
  const items = await Content.find(filter)
    .sort({ order: 1, createdAt: 1 })
    .select('title description type subject url size order createdAt')
    .lean()
  res.json({ content: items })
}

export function clearProductCache(productId) {
  _contentCache.delete(String(productId))
}
