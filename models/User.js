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
  }
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

export default User