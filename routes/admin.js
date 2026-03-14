const express = require("express");
const { authenticateAdmin } = require("../helpers/authenticateAdmin");
const pool = require("../db");

const router = express.Router();

// GET /dashboard
router.get("/dashboard", authenticateAdmin, async (req, res) => {
  try {
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM orders) AS total_orders,
        (SELECT COUNT(*) FROM orders WHERE DATE(created_at) = CURRENT_DATE) AS orders_today,
        (SELECT COUNT(*) FROM orders WHERE date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)) AS orders_this_month,

        (SELECT COUNT(*) FROM orders WHERE status = 'delivered') AS fulfilled_orders,
        (SELECT COUNT(*) FROM orders WHERE status = 'pending') AS pending_orders,
        (SELECT COUNT(*) FROM orders WHERE status = 'out_for_delivery') AS in_delivery,

        (SELECT COALESCE(SUM(total_amount),0) FROM orders WHERE payment_status = 'paid') AS total_revenue,
        (SELECT COALESCE(SUM(total_amount),0)
         FROM orders
         WHERE payment_status='paid'
         AND date_trunc('month', created_at)=date_trunc('month', CURRENT_DATE)
        ) AS revenue_this_month,

        (SELECT COUNT(*) FROM products) AS total_products,
        (SELECT COUNT(*) FROM products WHERE stock = 0) AS out_of_stock
    `);

    res.json(stats.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Dashboard error" });
  }
});

// GET /orders
router.get("/orders", authenticateAdmin, async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;

  try {
    const orders = await pool.query(
      `
      SELECT 
        o.id,
        'ORD-' || o.id AS order_number,
        o.status,
        o.total_amount AS total,
        o.created_at,
        u.full_name AS customer_name
      FROM orders o
      JOIN users u ON o.user_id = u.id
      ORDER BY o.created_at DESC
      LIMIT $1 OFFSET $2
      `,
      [limit, offset]
    );

    const count = await pool.query(`SELECT COUNT(*) FROM orders`);

    res.json({
      data: orders.rows,
      total: parseInt(count.rows[0].count),
      page,
      limit
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching orders" });
  }
});

// GET /orders/:id
router.get("/orders/:id", authenticateAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const order = await pool.query(
      `
      SELECT 
        o.*,
        u.full_name AS customer_name,
        u.email
      FROM orders o
      JOIN users u ON o.user_id = u.id
      WHERE o.id = $1
      `,
      [id]
    );

    const items = await pool.query(
      `
      SELECT 
        product_name_snapshot AS name,
        quantity,
        price_snapshot AS price
      FROM order_items
      WHERE order_id = $1
      `,
      [id]
    );

    res.json({
      ...order.rows[0],
      items: items.rows
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching order" });
  }
});

router.post("/orders/manual", authenticateAdmin, async (req, res) => {
  const { user_id, address_id, items } = req.body;

  try {
    let total = 0;

    for (const item of items) {
      const product = await pool.query(
        "SELECT name, price FROM products WHERE id=$1",
        [item.product_id]
      );

      total += product.rows[0].price * item.quantity;
    }

    const order = await pool.query(
      `
      INSERT INTO orders (user_id, address_id, total_amount)
      VALUES ($1,$2,$3)
      RETURNING *
      `,
      [user_id, address_id, total]
    );

    for (const item of items) {
      const product = await pool.query(
        "SELECT name, price FROM products WHERE id=$1",
        [item.product_id]
      );

      await pool.query(
        `
        INSERT INTO order_items
        (order_id, product_id, quantity, price_snapshot, product_name_snapshot)
        VALUES ($1,$2,$3,$4,$5)
        `,
        [
          order.rows[0].id,
          item.product_id,
          item.quantity,
          product.rows[0].price,
          product.rows[0].name
        ]
      );
    }

    res.json(order.rows[0]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Manual order failed" });
  }
});

router.put("/orders/:id", authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    const updated = await pool.query(
      `
      UPDATE orders
      SET status=$1
      WHERE id=$2
      RETURNING *
      `,
      [status, id]
    );

    res.json(updated.rows[0]);

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Status update failed" });
  }
});

module.exports = router;