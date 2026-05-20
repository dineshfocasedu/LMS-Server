// scripts/createAdmin.js
// Run: node scripts/createAdmin.js

import 'dotenv/config'
import mongoose from 'mongoose'
import User from '../models/User.js'

const phone = '6383514285'
const name  = 'FocasEdu'
const email = 'kvr@focasedu.com'

await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/focas')

const user = await User.findOneAndUpdate(
  { phoneNumber: phone },
  { $set: { phoneNumber: phone, name, isAdmin: true, ...(email ? { email } : {}) } },
  { upsert: true, new: true }
)

console.log(`✅ Admin user created/updated:`)
console.log(`   ID:    ${user._id}`)
console.log(`   Phone: ${user.phoneNumber}`)
console.log(`   Name:  ${user.name}`)
console.log(`   Email: ${user.email || '(none)'}`)
console.log(`   Admin: ${user.isAdmin}`)

await mongoose.disconnect()
