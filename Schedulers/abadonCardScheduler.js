require("dotenv").config();

const { CronJob } = require("cron");
const pool = require("../db");
const sendMail = require("../helpers/sendMail");

const IS_DEVELOPMENT = process.env.NODE_ENV !== "production";
const BATCH_SIZE = Number.parseInt(process.env.CART_ABANDON_BATCH_SIZE || "50", 10) || 50;
const INACTIVITY_WINDOW_HOURS = IS_DEVELOPMENT
    ? 1
    : Number.parseInt(process.env.CART_ABANDON_INACTIVITY_HOURS || "24", 10) || 24;
const CRON_EXPRESSION = IS_DEVELOPMENT
    ? "* * * * *"
    : process.env.CART_ABANDON_CRON || "0 * * * *";
const FRONTEND_URL = (process.env.FRONTEND_URL || "http://localhost:5173").replace(/\/$/, "");
const CHECKOUT_URL = `${FRONTEND_URL}/cart`;

const currencyFormatter = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
});

function formatCurrency(value) {
    return currencyFormatter.format(Number(value) || 0);
}

function buildEmailText(userName, items, subtotal) {
    const itemLines = items
        .map((item) => `- ${item.name} x ${item.quantity} (${formatCurrency(item.price * item.quantity)})`)
        .join("\n");

    return [
        `Hi ${userName || "there"},`,
        "",
        "You still have items waiting in your cart.",
        "",
        "Items:",
        itemLines,
        "",
        `Subtotal: ${formatCurrency(subtotal)}`,
        `Resume checkout: ${CHECKOUT_URL}`,
        "",
        "If you already placed your order, you can ignore this message.",
    ].join("\n");
}

function buildEmailHtml(userName, items, subtotal) {
    const rows = items
        .map(
            (item) => `
                <tr>
                    <td style="padding:10px 0;border-bottom:1px solid #eee;">${item.name}</td>
                    <td style="padding:10px 0;border-bottom:1px solid #eee;text-align:center;">${item.quantity}</td>
                    <td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;">${formatCurrency(item.price * item.quantity)}</td>
                </tr>`,
        )
        .join("");

    return `
        <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111;max-width:640px;margin:0 auto;padding:24px;">
            <h2 style="margin:0 0 16px;">Hi ${userName || "there"}, your cart is still waiting</h2>
            <p style="margin:0 0 16px;">You have items in your cart and we wanted to remind you before they get forgotten.</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
                <thead>
                    <tr>
                        <th style="text-align:left;padding:8px 0;border-bottom:2px solid #ddd;">Item</th>
                        <th style="text-align:center;padding:8px 0;border-bottom:2px solid #ddd;">Qty</th>
                        <th style="text-align:right;padding:8px 0;border-bottom:2px solid #ddd;">Total</th>
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                </tbody>
            </table>
            <p style="font-weight:bold;margin:16px 0;">Subtotal: ${formatCurrency(subtotal)}</p>
            <p style="margin:24px 0;">
                <a href="${CHECKOUT_URL}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;">Go to cart</a>
            </p>
            <p style="color:#666;font-size:12px;">If you already ordered, ignore this email.</p>
        </div>
    `;
}

async function fetchEligibleUsers(limit) {
    console.log(
        `[AbandonedCartScheduler][DEBUG] Fetching eligible users. limit=${limit}, inactivityWindowHours=${INACTIVITY_WINDOW_HOURS}`,
    );

    const result = await pool.query(
        `
        WITH eligible_users AS (
            SELECT
                u.id AS user_id,
                u.full_name,
                u.email,
                MAX(ct.updated_at) AS last_cart_activity_at,
                COUNT(ct.id)::int AS cart_item_count,
                COALESCE(SUM(ct.quantity), 0)::int AS total_quantity
            FROM users u
            JOIN cart ct ON ct.user_id = u.id
            LEFT JOIN cart_abandon_reminders r ON r.user_id = u.id
            WHERE ct.updated_at <= NOW() - ($2::text || ' hours')::interval
                AND NOT EXISTS (
                    SELECT 1
                    FROM orders o
                    WHERE o.user_id = u.id
                        AND o.created_at >= NOW() - ($2::text || ' hours')::interval
                )
            GROUP BY u.id, u.full_name, u.email, r.last_cart_activity_at
            HAVING MAX(ct.updated_at) <= NOW() - ($2::text || ' hours')::interval
                AND COALESCE(r.last_cart_activity_at, TIMESTAMPTZ 'epoch') < MAX(ct.updated_at)
            ORDER BY MAX(ct.updated_at) ASC, u.id ASC
            LIMIT $1
        )
        SELECT
            eu.user_id,
            eu.full_name,
            eu.email,
            eu.last_cart_activity_at,
            eu.cart_item_count,
            eu.total_quantity,
            json_agg(
                json_build_object(
                    'product_id', p.id,
                    'name', p.name,
                    'slug', p.slug,
                    'quantity', ct.quantity,
                    'price', ct.price,
                    'original_price', ct.original_price,
                    'image', COALESCE(pi.image_url, '')
                )
                ORDER BY ct.created_at ASC
            ) AS items
        FROM eligible_users eu
        JOIN cart ct ON ct.user_id = eu.user_id
        JOIN products p ON p.id = ct.product_id
        LEFT JOIN LATERAL (
            SELECT image_url
            FROM product_images pi
            WHERE pi.product_id = p.id
            ORDER BY pi.sort_order ASC
            LIMIT 1
        ) pi ON true
        GROUP BY eu.user_id, eu.full_name, eu.email, eu.last_cart_activity_at, eu.cart_item_count, eu.total_quantity
        ORDER BY eu.last_cart_activity_at ASC, eu.user_id ASC
        `,
        [limit, INACTIVITY_WINDOW_HOURS],
    );

    console.log(`[AbandonedCartScheduler][DEBUG] Eligible users found: ${result.rows.length}`);

    return result.rows;
}

async function markRemindersSent(users) {
    if (users.length === 0) {
        console.log("[AbandonedCartScheduler][DEBUG] No delivered users to mark in cart_abandon_reminders.");
        return;
    }

    console.log(`[AbandonedCartScheduler][DEBUG] Marking reminders sent for ${users.length} users.`);

    const values = [];
    const placeholders = users.map((user, index) => {
        const base = index * 2;
        values.push(user.user_id, user.last_cart_activity_at);
        return `($${base + 1}, $${base + 2})`;
    });

    await pool.query(
        `
        INSERT INTO cart_abandon_reminders (user_id, last_cart_activity_at, last_sent_at)
        VALUES ${placeholders.map((entry) => `${entry.slice(0, -1)}, NOW())`).join(", ")}
        ON CONFLICT (user_id)
        DO UPDATE SET
            last_cart_activity_at = EXCLUDED.last_cart_activity_at,
            last_sent_at = EXCLUDED.last_sent_at,
            updated_at = NOW()
        `,
        values,
    );
}

async function sendReminderEmail(user) {
    const items = Array.isArray(user.items) ? user.items : [];
    const subtotal = items.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.quantity || 0), 0);

    console.log(
        `[AbandonedCartScheduler][DEBUG] Preparing email for user=${user.user_id}, email=${user.email}, items=${items.length}, subtotal=${subtotal}`,
    );

    await sendMail({
        to: user.email,
        subject: "Your cart is waiting",
        text: buildEmailText(user.full_name, items, subtotal),
        html: buildEmailHtml(user.full_name, items, subtotal),
    });
}

async function runAbandonedCartBatch() {
    let sentCount = 0;
    let failedCount = 0;
    let cycle = 0;

    console.log(
        `[AbandonedCartScheduler][DEBUG] Batch run started. batchSize=${BATCH_SIZE}, inactivityWindowHours=${INACTIVITY_WINDOW_HOURS}, cron='${CRON_EXPRESSION}', env=${process.env.NODE_ENV || "undefined"}`,
    );

    while (true) {
        cycle += 1;
        console.log(`[AbandonedCartScheduler][DEBUG] Processing cycle ${cycle}.`);

        const batch = await fetchEligibleUsers(BATCH_SIZE);

        if (batch.length === 0) {
            console.log("[AbandonedCartScheduler][DEBUG] No users in current batch. Stopping run.");
            break;
        }

        const delivered = [];

        for (const user of batch) {
            try {
                await sendReminderEmail(user);
                delivered.push(user);
                sentCount += 1;
                console.log(`Abandoned cart reminder sent to ${user.email}`);
            } catch (error) {
                failedCount += 1;
                console.error(`Failed to send abandoned cart reminder to ${user.email}:`, error);
            }
        }

        if (delivered.length > 0) {
            await markRemindersSent(delivered);
        }

        console.log(
            `[AbandonedCartScheduler][DEBUG] Cycle ${cycle} complete. batch=${batch.length}, delivered=${delivered.length}, failedInRun=${failedCount}`,
        );

        if (batch.length < BATCH_SIZE) {
            console.log("[AbandonedCartScheduler][DEBUG] Last batch smaller than batch size. Stopping run.");
            break;
        }
    }

    console.log(`Abandoned cart reminder run complete. sent=${sentCount}, failed=${failedCount}`);
}

const AbandonedCartScheduler = new CronJob(
    CRON_EXPRESSION,
    async () => {
        try {
            await runAbandonedCartBatch();
        } catch (error) {
            console.error("Abandoned cart scheduler failed:", error);
        }
    },
    null,
    false,
    process.env.CRON_TIMEZONE || "Asia/Kolkata",
);

AbandonedCartScheduler.start();
console.log(
    `Abandoned cart scheduler started with cron: ${CRON_EXPRESSION}, inactivityWindowHours=${INACTIVITY_WINDOW_HOURS}, mode=${IS_DEVELOPMENT ? "development" : "production"}`,
);

module.exports = AbandonedCartScheduler;