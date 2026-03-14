const pool = require("../db");

async function getRole(userId) {
  try {
    const result = await pool.query("SELECT role FROM users WHERE id = $1", [
      userId,
    ]);
    return result.rows[0]?.role || null;
  } catch (error) {
    console.error("Error fetching role:", error);
    return null;
  }
}

module.exports = { getRole };
