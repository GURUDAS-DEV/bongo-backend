const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const pool = require("../db");
const sendMail = require("../helpers/sendMail");
const { authenticateToken } = require("../helpers/middleware");

const router = express.Router();

// Helper function to generate OTP (used only for forgot password)
function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

//
// ✅ REGISTER
// POST /api/auth/register
//
router.post("/register", async (req, res) => {
  const { full_name, email, phone, password } = req.body;

  if (!full_name || !email || !password) {
    return res.status(400).json({ message: "Required fields missing" });
  }

  try {
    const userExists = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (userExists.rows.length > 0) {
      return res.status(400).json({ message: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users (full_name, email, phone, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, full_name, email, phone, role`,
      [full_name, email, phone || null, hashedPassword]
    );

    const user = result.rows[0];

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "10d" }
    );

    res.status(201).json({
      token,
      user,
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

//
// ✅ LOGIN
// POST /api/auth/login
//
router.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({
      message: "Email and password are required",
      code: "MISSING_FIELDS",
    });
  }

  try {
    const userRes = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (userRes.rows.length === 0) {
      return res.status(404).json({
        message: "User not registered",
        code: "USER_NOT_FOUND",
      });
    }

    const user = userRes.rows[0];

    const isMatch = await bcrypt.compare(password, user.password_hash);

    if (!isMatch) {
      return res.status(401).json({
        message: "Incorrect password",
        code: "INVALID_PASSWORD",
      });
    }

    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "10d" }
    );

    res.cookie("token", token, {
      httpOnly: true,
      secure: false, // 🔒 change to true in production
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        phone: user.phone,
        role: user.role,
      },
    });

  } catch (error) {
    console.error(error);
    res.status(500).json({
      message: "Server error",
      code: "SERVER_ERROR",
    });
  }
});

//
// ✅ GET CURRENT USER
// GET /api/auth/me
//
router.get("/me", authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, full_name, email, phone, role, created_at FROM users WHERE id = $1",
      [req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(result.rows[0]);

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

//
// ✅ UPDATE PROFILE
// PUT /api/auth/profile
//
router.put("/profile", authenticateToken, async (req, res) => {
  const { full_name, phone } = req.body;

  try {
    const result = await pool.query(
      `UPDATE users
       SET full_name = COALESCE($1, full_name),
           phone = COALESCE($2, phone)
       WHERE id = $3
       RETURNING id, full_name, email, phone, role`,
      [full_name || null, phone || null, req.user.id]
    );

    res.json(result.rows[0]);

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

//
// ✅ CHANGE PASSWORD
// PUT /api/auth/password
//
router.put("/password", authenticateToken, async (req, res) => {
  const { current_password, new_password } = req.body;

  if (!current_password || !new_password) {
    return res.status(400).json({ message: "Missing fields" });
  }

  try {
    const user = await pool.query(
      "SELECT password_hash FROM users WHERE id = $1",
      [req.user.id]
    );

    const isMatch = await bcrypt.compare(
      current_password,
      user.rows[0].password_hash
    );

    if (!isMatch) {
      return res.status(401).json({ message: "Wrong password" });
    }

    const hashedPassword = await bcrypt.hash(new_password, 10);

    await pool.query(
      "UPDATE users SET password_hash = $1 WHERE id = $2",
      [hashedPassword, req.user.id]
    );

    res.json({ message: "Password updated successfully" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

//
// ✅ FORGOT PASSWORD (OTP BASED)
// POST /api/auth/forgot-password
//
router.post("/forgot-password", async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ message: "Email is required" });
  }

  try {
    const user = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (user.rows.length === 0) {
      return res.status(400).json({ message: "User not found" });
    }

    const otp = generateOTP();

    await pool.query(
      "UPDATE users SET otp = $1 WHERE email = $2",
      [otp, email]
    );

    await sendMail({
      to: email,
      subject: "Password Reset OTP",
      text: `Your OTP is: ${otp}`,
    });

    res.json({ message: "OTP sent to email" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

//
// ✅ RESET PASSWORD
// POST /api/auth/reset-password
//
router.post("/reset-password", async (req, res) => {
  const { email, otp, newPassword } = req.body;

  if (!email || !otp || !newPassword) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    const user = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );

    if (user.rows.length === 0) {
      return res.status(400).json({ message: "User not found" });
    }

    if (user.rows[0].otp !== otp) {
      return res.status(400).json({ message: "Invalid OTP" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await pool.query(
      "UPDATE users SET password_hash = $1, otp = null WHERE email = $2",
      [hashedPassword, email]
    );

    res.json({ message: "Password reset successful" });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;