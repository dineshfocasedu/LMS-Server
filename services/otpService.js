import nodemailer from 'nodemailer';
import axios from "axios";
import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();

export function generateOTP() {
  return String(crypto.randomInt(100000, 999999));
}



export async function sendOTP(phoneNumber, otp) {
  try {
    console.log(`Sending OTP to ${phoneNumber}`);

    const cleanNumber = "+" + String(phoneNumber).replace(/\D/g, "");
    const encodedNumber = encodeURIComponent(cleanNumber);

    const url = `${process.env.WATI_BASE_URL}/api/v1/sendTemplateMessage?whatsappNumber=${encodedNumber}`;

    const payload = {
      template_name: "mobileotps",
      broadcast_name: "your_broadcast_name",
      channel_number: process.env.WATI_SECONDARY_NUMBER,
      parameters: [
        {
          name: "1",
          value: String(otp),
        },
      ],
    };

    const response = await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/json-patch+json",
        Authorization: `Bearer ${process.env.WATI_API_TOKEN}`,
        accept: "*/*",
      },
    });

    return response.data;
  } catch (error) {
    console.error("WATI ERROR:", error.response?.data || error.message);
    throw error;
  }
}
export async function sendEmailOTP(email, otp) {
  console.log(`Sending OTP to ${email}`);
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  await transporter.sendMail({
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Your OTP Code',
    text: `Your OTP is ${otp}. It expires in 5 minutes.`,
  });
   
}