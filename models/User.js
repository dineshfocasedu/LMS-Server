// models/User.js
import mongoose from "mongoose"

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, sparse: true, lowercase: true },
  phoneNumber: { type: String, required: true, unique: true },
  name: String,
  isAdmin: { type: Boolean, default: false },
  shopifyId: String,
  otp: String,
  otpExpires: Date,
  access: {
    shopify: { courses: [String], features: [String] },
    website: { courses: [String], features: [String] },
    combo:   { courses: [String], features: [String] },
  },
  activeSession: {
    deviceFingerprint: String,
    deviceName: String,
    deviceType: String,
    lastLoginTime: Date,
    ip: String,
  }
}, { timestamps: true });

userSchema.index({ shopifyId: 1 }, { sparse: true });
userSchema.index({ createdAt: -1 });
userSchema.index({ 'activeSession.deviceFingerprint': 1 }, { sparse: true });

const User = mongoose.model('User', userSchema);

export default User