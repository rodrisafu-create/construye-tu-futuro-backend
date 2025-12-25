import express from "express";
import Stripe from "stripe";
import { Resend } from "resend";
import "dotenv/config";
import pg from "pg";

const { Pool } = pg;

/* ======================================================
   DATABASE
====================================================== */
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/* ======================================================
   APP + SDKs
====================================================== */
const app = express();

// 🔁 Stripe mode selector: "test" o "live"
const STRIPE_MODE = (process.env.STRIPE_MODE || "live").toLowerCase();

const STRIPE_SECRET =
  STRIPE_MODE === "test"
    ? process.env.STRIPE_SECRET_KEY_TEST
    : process.env.STRIPE_SECRET_KEY;

const STRIPE_WEBHOOK_SECRET =
  STRIPE_MODE === "test"
    ? process.env.STRIPE_WEBHOOK_SECRET_TEST
    : process.env.STRIPE_WEBHOOK_SECRET;

if (!STRIPE_SECRET) {
  console.error("❌ Missing Stripe secret key for mode:", STRIPE_MODE);
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.error("❌ Missing Stripe webhook secret for mode:", STRIPE_MODE);
}

const stripe = new Stripe(STRIPE_SECRET);
const resend = new Resend(process.env.RESEND_API_KEY);


const FRONTEND =
  process.env.FRONTEND_ORIGIN || "https://construye-tu-futuro.netlify.app";

const RESEND_FROM =
  process.env.RESEND_FROM ||
  "Construye tu futuro <noreply@send.construye-tu-futuro.com>";

/* ======================================================
   HELPERS
====================================================== */
function tsFromStripeUnixSeconds(sec) {
  if (!sec) return null;
  return new Date(sec * 1000);
}

async function upsertUserByEmail(email) {
  const r = await db.query(
    `
    INSERT INTO users (email)
    VALUES ($1)
    ON CONFLICT (email)
    DO UPDATE SET email = EXCLUDED.email
    RETURNING id, email
    `,
    [email]
  );
  return r.rows[0];
}

// ✅ Requiere UNIQUE(stripe_subscription_id) en DB
async function upsertSubscription({
  userId,
  stripeSubscriptionId,
  plan,
  status,
  currentPeriodEnd, // Date o null
}) {
  await db.query(
    `
    INSERT INTO subscriptions (
      user_id,
      stripe_subscription_id,
      plan,
      status,
      current_period_end
    )
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (stripe_subscription_id)
    DO UPDATE SET
      user_id = EXCLUDED.user_id,
      plan = EXCLUDED.plan,
      status = EXCLUDED.status,
      current_period_end = EXCLUDED.current_period_end
    `,
    [userId, stripeSubscriptionId, plan, status, currentPeriodEnd]
  );
}

async function markSubscriptionCanceledNow(stripeSubscriptionId) {
  await db.query(
    `
    UPDATE subscriptions
    SET status = 'canceled',
        current_period_end = NOW()
    WHERE stripe_subscription_id = $1
    `,
    [stripeSubscriptionId]
  );
}

/* ======================================================
   1) STRIPE WEBHOOK (RAW BODY) — SIEMPRE ANTES DEL JSON
====================================================== */
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      if (!endpointSecret) throw new Error("Missing STRIPE_WEBHOOK_SECRET");
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error("❌ Webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      /* =========================================
         ✅ ALTA: checkout.session.completed
      ========================================= */
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        const email =
          session.customer_details?.email ||
          session.customer_email ||
          session.metadata?.email;

        const plan = session.metadata?.plan || "starter";
        const stripeSubscriptionId = session.subscription; // "sub_..."

        console.log("✅ checkout.session.completed:", {
          email,
          plan,
          stripeSubscriptionId,
        });

        if (email && stripeSubscriptionId) {
          const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId);
          const currentPeriodEnd = tsFromStripeUnixSeconds(sub.current_period_end);

          const user = await upsertUserByEmail(email);

          await upsertSubscription({
            userId: user.id,
            stripeSubscriptionId,
            plan,
            status: sub.status || "active",
            currentPeriodEnd,
          });

          const resp = await resend.emails.send({
            from: RESEND_FROM,
            to: email,
            subject: "Bienvenido a Construye tu futuro",
            html: `
              <h2>Bienvenido 👋</h2>
              <p>Gracias por suscribirte a <b>Construye tu futuro</b>.</p>
              <p>Plan: <b>${plan}</b></p>
              <p>👉 <a href="${FRONTEND}/login.html">Entrar</a></p>
              <p style="font-size:12px;color:#666;">
                Si no quieres recibir más emails, ignóralos. (MVP)
              </p>
            `,
          });

          console.log("📨 Resend welcome:", resp?.id || resp);
        } else {
          console.log("⚠️ checkout.session.completed sin email o sin subscription id");
        }
      }

      /* =========================================
         ✅ CAMBIOS: customer.subscription.updated
      ========================================= */
      if (event.type === "customer.subscription.updated") {
        const sub = event.data.object;

        const stripeSubscriptionId = sub.id;
        const currentPeriodEnd = tsFromStripeUnixSeconds(sub.current_period_end);
        const status = sub.status || "active";

        console.log("✅ customer.subscription.updated:", {
          stripeSubscriptionId,
          status,
          cancel_at_period_end: sub.cancel_at_period_end,
          currentPeriodEnd,
        });

        // Solo actualizamos lo que ya existe en DB (no inventamos user_id aquí).
        await db.query(
          `
          UPDATE subscriptions
          SET status = $1,
              current_period_end = $2
          WHERE stripe_subscription_id = $3
          `,
          [status, currentPeriodEnd, stripeSubscriptionId]
        );
      }

      /* =========================================
         ❌ FIN: customer.subscription.deleted
      ========================================= */
      if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;
        const stripeSubscriptionId = sub.id;

        console.log("✅ customer.subscription.deleted:", {
          stripeSubscriptionId,
          status: sub.status,
        });

        await markSubscriptionCanceledNow(stripeSubscriptionId);

        let email = null;
        try {
          if (sub.customer) {
            const customer = await stripe.customers.retrieve(sub.customer);
            email = customer?.email || null;
          }
        } catch (e) {
          console.log("⚠️ No pude recuperar customer email:", e?.message);
        }

        if (email) {
          const resp = await resend.emails.send({
            from: RESEND_FROM,
            to: email,
            subject: "Tu suscripción ha sido cancelada",
            html: `
              <h2>Suscripción cancelada</h2>
              <p>Tu suscripción a <b>Construye tu futuro</b> ha sido cancelada.</p>
              <p>Si fue un error, puedes volver cuando quieras.</p>
              <p>👉 Volver a la web: <a href="${FRONTEND}">${FRONTEND}</a></p>
              <p style="font-size:12px;color:#666;">
                Si tienes cualquier duda, responde a este email. (MVP)
              </p>
            `,
          });
          console.log("📨 Resend cancel:", resp?.id || resp);
        }
      }

      return res.json({ received: true });
    } catch (err) {
      console.error("❌ Webhook processing error:", err);
      return res.status(500).send("Webhook handler failed");
    }
  }
);

/* ======================================================
   2) MIDDLEWARE NORMAL (JSON, CORS, STATIC)
====================================================== */
app.use(express.json());

app.use((req, res, next) => {
  const origin = process.env.FRONTEND_ORIGIN;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/health", (_, res) => res.send("Backend OK ✅"));

function isAccessActiveRow(row) {
  if (!row) return false;

  const status = String(row.status || "").toLowerCase();
  const allowedStatus = ["active", "trialing", "past_due"]; // ajusta si quieres
  if (!allowedStatus.includes(status)) return false;

  const end = row.current_period_end ? new Date(row.current_period_end) : null;
  if (!end) return false;

  return end.getTime() > Date.now();
}

// POST /auth/login
app.post("/auth/login", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Falta email" });

    const r = await db.query(
      `
      SELECT s.plan, s.status, s.current_period_end
      FROM users u
      JOIN subscriptions s ON s.user_id = u.id
      WHERE u.email = $1
      ORDER BY s.current_period_end DESC NULLS LAST
      LIMIT 1
      `,
      [email]
    );

    const row = r.rows[0];
    if (!row) return res.status(401).json({ error: "No tienes suscripción activa." });

    if (!isAccessActiveRow(row)) {
      return res.status(401).json({ error: "Tu suscripción no está activa o ha expirado." });
    }

    return res.json({
      ok: true,
      plan: row.plan,
      status: row.status,
      current_period_end: row.current_period_end,
    });
  } catch (e) {
    console.error("AUTH LOGIN ERROR:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /auth/check?email=...
app.get("/auth/check", async (req, res) => {
  try {
    const email = String(req.query?.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ error: "Falta email" });

    const r = await db.query(
      `
      SELECT s.plan, s.status, s.current_period_end
      FROM users u
      JOIN subscriptions s ON s.user_id = u.id
      WHERE u.email = $1
      ORDER BY s.current_period_end DESC NULLS LAST
      LIMIT 1
      `,
      [email]
    );

    const row = r.rows[0];
    if (!row) return res.status(401).json({ ok: false, error: "No tienes suscripción activa." });

    if (!isAccessActiveRow(row)) {
      return res
        .status(401)
        .json({ ok: false, error: "Tu suscripción no está activa o ha expirado." });
    }

    return res.json({
      ok: true,
      plan: row.plan,
      status: row.status,
      current_period_end: row.current_period_end,
    });
  } catch (e) {
    console.error("AUTH CHECK ERROR:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Static
app.use(express.static("public"));

/* ======================================================
   3) CHECKOUT
====================================================== */
const PRICE_LIVE = {
  starter: {
    eur: "price_LIVE_EUR_STARTER",
    dkk: "price_LIVE_DKK_STARTER",
  },
  premium: {
    eur: "price_LIVE_EUR_PREMIUM",
    dkk: "price_LIVE_DKK_PREMIUM",
  },
};

const PRICE_TEST = {
  starter: {
    eur: "price_TEST_EUR_STARTER",
    dkk: "price_TEST_DKK_STARTER",
  },
  premium: {
    eur: "price_TEST_EUR_PREMIUM",
    dkk: "price_TEST_DKK_PREMIUM",
  },
};

const PRICE = STRIPE_MODE === "test" ? PRICE_TEST : PRICE_LIVE;

app.post("/create-checkout-session", async (req, res) => {
  try {
    let { plan, currency, email } = req.body;

    plan = String(plan || "").toLowerCase();
    currency = String(currency || "").toLowerCase();
    email = String(email || "").trim();

    if (!PRICE[plan] || !PRICE[plan][currency]) {
      return res.status(400).json({ error: "Plan o moneda inválidos" });
    }
    if (!email) {
      return res.status(400).json({ error: "Falta email" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: PRICE[plan][currency], quantity: 1 }],
      customer_email: email,
      metadata: { plan, email },
      success_url: `${FRONTEND}/?success=1&plan=${plan}`,
      cancel_url: `${FRONTEND}/?canceled=1`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("STRIPE ERROR:", err);
    return res.status(500).json({
      error: err?.raw?.message || err?.message || "Stripe error",
    });
  }
});

/* ======================================================
   START SERVER
====================================================== */
const PORT = process.env.PORT || 4242;
app.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));
