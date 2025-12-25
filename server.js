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
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const resend = new Resend(process.env.RESEND_API_KEY);

const FRONTEND =
  process.env.FRONTEND_ORIGIN || "https://construye-tu-futuro.netlify.app";

const RESEND_FROM =
  process.env.RESEND_FROM ||
  "Construye tu futuro <noreply@send.construye-tu-futuro.com>";

/* ======================================================
   1) STRIPE WEBHOOK (RAW BODY)
====================================================== */
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
      console.error("❌ Webhook signature error:", err.message);
      return res.status(400).send("Webhook Error");
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

        if (email) {
          // 1) Crear usuario (si no existe)
          const userRes = await db.query(
            `
            INSERT INTO users (email)
            VALUES ($1)
            ON CONFLICT (email)
            DO UPDATE SET email = EXCLUDED.email
            RETURNING id
            `,
            [email]
          );

          const userId = userRes.rows[0].id;

          // 2) Crear suscripción (30 días MVP)
          await db.query(
            `
            INSERT INTO subscriptions (
              user_id,
              stripe_subscription_id,
              plan,
              status,
              current_period_end
            )
            VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 days')
            `,
            [userId, session.subscription, plan, "active"]
          );

          // 3) Email bienvenida
          await resend.emails.send({
            from: RESEND_FROM,
            to: email,
            subject: "Bienvenido a Construye tu futuro",
            html: `
              <h2>Bienvenido 👋</h2>
              <p>Gracias por suscribirte a <b>Construye tu futuro</b>.</p>
              <p>Plan: <b>${plan}</b></p>
              <p>
                👉 <a href="${FRONTEND}/login.html">Entrar</a>
              </p>
            `,
          });

          console.log("✅ ALTA OK:", email);
        }
      }

      /* =========================================
         ❌ BAJA: customer.subscription.deleted
      ========================================= */
      if (event.type === "customer.subscription.deleted") {
        const sub = event.data.object;

        // Marcar suscripción como cancelada (acceso OFF inmediato)
        await db.query(
          `
          UPDATE subscriptions
          SET status = 'canceled',
              current_period_end = NOW()
          WHERE stripe_subscription_id = $1
          `,
          [sub.id]
        );

        // Recuperar email del cliente
        let email = null;
        if (sub.customer) {
          const customer = await stripe.customers.retrieve(sub.customer);
          email = customer?.email || null;
        }

        if (email) {
          await resend.emails.send({
            from: RESEND_FROM,
            to: email,
            subject: "Tu suscripción ha sido cancelada",
            html: `
              <h2>Suscripción cancelada</h2>
              <p>Tu acceso a <b>Construye tu futuro</b> ha sido desactivado.</p>
              <p>
                👉 <a href="${FRONTEND}">Volver a la web</a>
              </p>
            `,
          });

          console.log("❌ BAJA OK:", email);
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
   2) MIDDLEWARE NORMAL
====================================================== */
app.use(express.json());

app.use((req, res, next) => {
  if (process.env.FRONTEND_ORIGIN) {
    res.setHeader(
      "Access-Control-Allow-Origin",
      process.env.FRONTEND_ORIGIN
    );
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.static("public"));

app.get("/", (_, res) => res.send("Backend OK ✅"));

/* ======================================================
   3) CHECKOUT
====================================================== */
const PRICE = {
  starter: {
    eur: "price_1ShJvPGi85FmhwHAYtS2Nb3C",
    dkk: "price_1ShJvhGi85FmhwHAHRjSMLLy",
  },
  premium: {
    eur: "price_1ShJw3Gi85FmhwHA4IjFtDWR",
    dkk: "price_1ShJwPGi85FmhwHAnLEZAtVN",
  },
};

app.post("/create-checkout-session", async (req, res) => {
  try {
    let { plan, currency, email } = req.body;

    plan = String(plan).toLowerCase();
    currency = String(currency).toLowerCase();
    email = String(email).trim();

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
      success_url: `${FRONTEND}/?success=1`,
      cancel_url: `${FRONTEND}/?canceled=1`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("STRIPE ERROR:", err);
    res.status(500).json({ error: "Stripe error" });
  }
});

/* ======================================================
   START SERVER
====================================================== */
const PORT = process.env.PORT || 4242;
app.listen(PORT, () =>
  console.log(`🚀 Backend running on port ${PORT}`)
);
