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

/* ======================================================
   STRIPE CONFIG
====================================================== */
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
  console.error("❌ Missing Stripe secret key");
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.error("❌ Missing Stripe webhook secret");
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
function tsFromStripe(sec) {
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

async function upsertSubscription({
  userId,
  stripeSubscriptionId,
  plan,
  status,
  currentPeriodEnd,
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
    VALUES ($1,$2,$3,$4,$5)
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

async function cancelSubscriptionNow(stripeSubscriptionId) {
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
   WEBHOOK (RAW BODY)
====================================================== */
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook signature error:", err.message);
      return res.status(400).send("Webhook signature error");
    }

    try {
      /* ===============================
         checkout.session.completed
      =============================== */
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        const email =
          session.customer_email ||
          session.customer_details?.email ||
          session.metadata?.email;

        const plan = session.metadata?.plan || "starter";
        const subscriptionId = session.subscription;

        if (!email || !subscriptionId) {
          console.warn("⚠️ Missing email or subscription id");
          return res.json({ received: true });
        }

        const sub = await stripe.subscriptions.retrieve(subscriptionId);
        const user = await upsertUserByEmail(email);

        await upsertSubscription({
          userId: user.id,
          stripeSubscriptionId: subscriptionId,
          plan,
          status: sub.status,
          currentPeriodEnd: tsFromStripe(sub.current_period_end),
        });

        // Email de bienvenida (no rompe webhook)
        try {
          await resend.emails.send({
            from: RESEND_FROM,
            to: email,
            subject: "Bienvenido a Construye tu futuro",
            html: `<h2>Bienvenido 👋</h2><p>Plan: <b>${plan}</b></p>`,
          });
        } catch (e) {
          console.error("❌ Email error:", e);
        }
      }

      /* ===============================
         subscription updated
      =============================== */
      if (event.type === "customer.subscription.updated") {
        const sub = event.data.object;
        await db.query(
          `
          UPDATE subscriptions
          SET status=$1, current_period_end=$2
          WHERE stripe_subscription_id=$3
          `,
          [
            sub.status,
            tsFromStripe(sub.current_period_end),
            sub.id,
          ]
        );
      }

      /* ===============================
         subscription deleted
      =============================== */
      if (event.type === "customer.subscription.deleted") {
        await cancelSubscriptionNow(event.data.object.id);
      }

      return res.json({ received: true });
    } catch (err) {
      console.error("❌ Webhook processing error:", err);
      return res.status(500).send("Webhook handler failed");
    }
  }
);

/* ======================================================
   NORMAL MIDDLEWARE
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

/* ======================================================
   ACCESS CHECK
====================================================== */
function isActive(row) {
  if (!row) return false;
  if (!["active", "trialing", "past_due"].includes(row.status)) return false;
  if (!row.current_period_end) return false;
  return new Date(row.current_period_end).getTime() > Date.now();
}

/* ======================================================
   AUTH
====================================================== */
app.post("/auth/login", async (req, res) => {
  const email = String(req.body?.email || "").toLowerCase().trim();
  if (!email) return res.status(400).json({ error: "Falta email" });

  const r = await db.query(
    `
    SELECT s.plan, s.status, s.current_period_end
    FROM users u
    JOIN subscriptions s ON s.user_id = u.id
    WHERE u.email = $1
    ORDER BY s.current_period_end DESC
    LIMIT 1
    `,
    [email]
  );

  const row = r.rows[0];
  if (!isActive(row)) {
    return res.status(401).json({ error: "Suscripción no activa" });
  }

  res.json({ ok: true, ...row });
});

/* ======================================================
   STRIPE PRICES
====================================================== */
const PRICE_LIVE = {
  starter: {
    eur: "price_1ShJvPGi85FmhwHAYtS2Nb3C",
    dkk: "price_1ShJvhGi85FmhwHAHRjSMLLy",
  },
  premium: {
    eur: "price_1ShJw3Gi85FmhwHA4IjFtDWR",
    dkk: "price_1ShJwPGi85FmhwHAnLEZAtVN",
  },
};

const PRICE_TEST = {
  starter: {
    eur: "price_1SiMv8Gi85FmhwHAxEXu7TTm",
    dkk: "price_1SiMvRGi85FmhwHAC1vxlUBF",
  },
  premium: {
    eur: "price_1SiMwFGi85FmhwHAa92oPtl5",
    dkk: "price_1SiMxBGi85FmhwHA8gnwb8uH",
  },
};

const PRICE = STRIPE_MODE === "test" ? PRICE_TEST : PRICE_LIVE;

/* ======================================================
   CREATE CHECKOUT SESSION (🔥 ARREGLADO)
====================================================== */
app.post("/create-checkout-session", async (req, res) => {
  try {
    let { plan, currency, email } = req.body;

    plan = String(plan || "").toLowerCase();
    currency = String(currency || "").toLowerCase();
    email = String(email || "").trim().toLowerCase();

    if (!PRICE[plan] || !PRICE[plan][currency]) {
      return res.status(400).json({ error: "Plan o moneda inválidos" });
    }
    if (!email) {
      return res.status(400).json({ error: "Falta email" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: PRICE[plan][currency], quantity: 1 }],

      // ✅ CORRECTO para subscriptions
      customer_email: email,

      metadata: { plan, email },
      subscription_data: {
        metadata: { plan, email },
      },

      success_url: `${FRONTEND}/?success=1&plan=${plan}`,
      cancel_url: `${FRONTEND}/?canceled=1`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("STRIPE ERROR:", err);
    res.status(500).json({
      error: err?.raw?.message || err?.message || "Stripe error",
    });
  }
});

/* ======================================================
   STATIC
====================================================== */
app.use(express.static("public"));

/* ======================================================
   START
====================================================== */
const PORT = process.env.PORT || 4242;
app.listen(PORT, () =>
  console.log(`🚀 Backend running on port ${PORT}`)
);
