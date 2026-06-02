// services/deviceService.js
import crypto from 'crypto'

function generateDeviceFingerprint(deviceData) {
  const { userAgent, acceptLanguage } = deviceData
  const combined = `${userAgent}-${acceptLanguage}`
  const hash = crypto.createHash('sha256').update(combined).digest('hex')
  console.log('[Device Fingerprint]', {
    userAgent: userAgent.substring(0, 50),
    hash: hash.substring(0, 16) + '...'
  })
  return hash
}

function getDeviceInfo(req) {
  const userAgent = req.headers['user-agent'] || ''
  const acceptLanguage = req.headers['accept-language'] || ''
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || ''
  const screenResolution = req.body?.screenResolution || 'unknown'
  const timezone = req.body?.timezone || 'unknown'

  const deviceData = {
    userAgent,
    acceptLanguage,
    screenResolution,
    timezone
  }

  const fingerprint = generateDeviceFingerprint(deviceData)

  let deviceType = 'desktop'
  if (/mobile|android|iphone|ipad/i.test(userAgent)) {
    deviceType = /ipad/i.test(userAgent) ? 'tablet' : 'mobile'
  }

  const deviceName = extractDeviceName(userAgent)

  return {
    deviceFingerprint: fingerprint,
    deviceType,
    deviceName,
    ip
  }
}

function extractDeviceName(userAgent) {
  if (/iPhone/i.test(userAgent)) return 'iPhone'
  if (/iPad/i.test(userAgent)) return 'iPad'
  if (/Android/i.test(userAgent)) return 'Android'
  if (/Windows/i.test(userAgent)) return 'Windows'
  if (/Mac/i.test(userAgent)) return 'Mac'
  if (/Linux/i.test(userAgent)) return 'Linux'
  return 'Unknown Device'
}

export { generateDeviceFingerprint, getDeviceInfo }
