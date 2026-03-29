const express = require("express");
const pool = require("../db");
const { authenticateToken } = require("../helpers/middleware");

const router = express.Router();

// Middleware to check admin role
const requireAdmin = async (req, res, next) => {
  const role = await getRole(req.user.id);
  if (role !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
};

// ============================================================
// Categories
// ============================================================

// GET /categories - List all categories
router.get("/", async (req, res) => {
  try {
    const categories = await pool.query(
      "SELECT id, name, slug, created_at FROM categories ORDER BY name",
    );
    res.json(categories.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
});

// POST /categories - Create category (admin only)
router.post(
  "/",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const { name, slug } = req.body;

    if (!name || !slug) {
      return res.status(400).json({ message: "Name and slug are required" });
    }

    try {
      const newCategory = await pool.query(
        "INSERT INTO categories (name, slug) VALUES ($1, $2) RETURNING id, name, slug, created_at",
        [name, slug],
      );
      res.status(201).json(newCategory.rows[0]);
    } catch (error) {
      if (error.code === "23505") {
        // unique violation
        res.status(400).json({ message: "Category slug already exists" });
      } else {
        console.error(error);
        res.status(500).json({ message: "Server error" });
      }
    }
  },
);

// PUT /categories/:id - Update category (admin only)
router.put(
  "/:id",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const { id } = req.params;
    const { name, slug } = req.body;

    if (!name || !slug) {
      return res.status(400).json({ message: "Name and slug are required" });
    }

    try {
      const updatedCategory = await pool.query(
        "UPDATE categories SET name = $1, slug = $2 WHERE id = $3 RETURNING id, name, slug, created_at",
        [name, slug, id],
      );

      if (updatedCategory.rows.length === 0) {
        return res.status(404).json({ message: "Category not found" });
      }

      res.json(updatedCategory.rows[0]);
    } catch (error) {
      if (error.code === "23505") {
        res.status(400).json({ message: "Category slug already exists" });
      } else {
        console.error(error);
        res.status(500).json({ message: "Server error" });
      }
    }
  },
);

// DELETE /categories/:id - Delete category (admin only)
router.delete(
  "/:id",
  authenticateToken,
  requireAdmin,
  async (req, res) => {
    const { id } = req.params;

    try {
      const result = await pool.query(
        "DELETE FROM categories WHERE id = $1 RETURNING id",
        [id],
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ message: "Category not found" });
      }

      res.json({ message: "Category deleted successfully" });
    } catch (error) {
      console.error(error);
      res.status(500).json({ message: "Server error" });
    }
  },
);

module.exports = router;