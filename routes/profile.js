const express = require("express");
const { authenticateToken } = require("../helpers/middleware");
const pool = require("../db");

const router = express.Router();

// GET /profile - Get current user profile
router.get("/", authenticateToken, async (req, res) => {
  try {
    const user = await pool.query(
      "SELECT id, full_name, email, phone, role, created_at FROM users WHERE id = $1",
      [req.user.id],
    );

    if (user.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(user.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// PUT /profile - Edit profile
router.put("/", authenticateToken, async (req, res) => {
  const { full_name, phone } = req.body;

  if (!full_name || !phone) {
    return res
      .status(400)
      .json({ message: "Full name and phone are required" });
  }

  try {
    await pool.query(
      "UPDATE users SET full_name = $1, phone = $2 WHERE id = $3",
      [full_name, phone, req.user.id],
    );

    res.json({ message: "Profile updated successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// GET /profile/addresses - Get all addresses for the user
router.get("/addresses", authenticateToken, async (req, res) => {
  try {
    const addresses = await pool.query(
      "SELECT id, name, phone, address_line1, address_line2, city, state, country, pincode, is_default, created_at FROM addresses WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC",
      [req.user.id],
    );

    res.json(addresses.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /profile/addresses - Create a new address
router.post("/addresses", authenticateToken, async (req, res) => {
  const {
    name,
    phone,
    address,
    address_line2,
    city,
    state,
    country,
    pincode,
    is_default,
  } = req.body;

  if (!name || !phone || !address || !city || !state || !pincode) {
    return res.status(400).json({
      message: "Name, phone, address, city, state, and pincode are required",
    });
  }

  try {
    // If setting as default, unset other defaults
    if (is_default) {
      await pool.query(
        "UPDATE addresses SET is_default = FALSE WHERE user_id = $1",
        [req.user.id],
      );
    }

    const newAddress = await pool.query(
      "INSERT INTO addresses (user_id, name, phone, address_line1, address_line2, city, state, country, pincode, is_default) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, name, phone, address_line1, address_line2, city, state, country, pincode, is_default, created_at",
      [
        req.user.id,
        name,
        phone,
        address,
        address_line2 || null,
        city,
        state,
        country || "India",
        pincode,
        is_default || false,
      ],
    );

    res.status(201).json(newAddress.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// PUT /profile/addresses/:id - Edit an address
router.put("/addresses/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const existing = await pool.query(
      "SELECT * FROM addresses WHERE id = $1 AND user_id = $2",
      [id, req.user.id],
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ message: "Address not found" });
    }

    const address = existing.rows[0];

    const {
      name,
      phone,
      address_line1,
      address_line2,
      city,
      state,
      country,
      pincode,
      is_default,
    } = req.body;

    if (is_default) {
      await pool.query(
        "UPDATE addresses SET is_default = FALSE WHERE user_id = $1",
        [req.user.id],
      );
    }

    const updatedAddress = await pool.query(
      `UPDATE addresses 
       SET name=$1, phone=$2, address_line1=$3, address_line2=$4,
           city=$5, state=$6, country=$7, pincode=$8, is_default=$9
       WHERE id=$10 AND user_id=$11
       RETURNING *`,
      [
        name ?? address.name,
        phone ?? address.phone,
        address_line1 ?? address.address_line1,
        address_line2 ?? address.address_line2,
        city ?? address.city,
        state ?? address.state,
        country ?? address.country,
        pincode ?? address.pincode,
        is_default ?? address.is_default,
        id,
        req.user.id,
      ],
    );

    res.json(updatedAddress.rows[0]);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE /profile/addresses/:id - Delete an address
router.delete("/addresses/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      "DELETE FROM addresses WHERE id = $1 AND user_id = $2 RETURNING id",
      [id, req.user.id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Address not found" });
    }

    res.json({ message: "Address deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
