import express from "express";
import Stripe from "stripe";
import "dotenv/config";

const app = express();
app.use((req, res, next) => {
  const origin = process.env.FRONTEND_ORIGIN;
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// 🔔 STRIPE WEBHOOK (para saber quién se suscribe y cancela)
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    return res.sendStatus(400);
  }

  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    console.log("✅ NUEVA SUSCRIPCIÓN:", s.customer_details?.email);
  }

  if (event.type === "customer.subscription.deleted") {
    console.log("🛑 SUSCRIPCIÓN CANCELADA");
  }

  res.sendStatus(200);
});
app.use(express.json());
app.use(express.static("public")); // sirve public/index.html

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ⬇️ Tus PRICE IDs de Stripe
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

const DOMAIN = process.env.DOMAIN || "http://localhost:4242";

import path from "path";

app.use(express.static("public"));

app.get("/", (req, res) => {
  res.sendFile(path.resolve("public/index.html"));
});

app.post("/create-checkout-session", async (req, res) => {
  try {
    // ✅ Normalizamos para evitar "EUR"/"DKK" o "Starter"/"Premium"
    let { plan, currency } = req.body;

    plan = String(plan || "").toLowerCase();
    currency = String(currency || "").toLowerCase();

    // (Opcional pero útil) ver qué llega:
    console.log("BODY:", req.body, "-> normalized:", { plan, currency });

    if (!PRICE[plan] || !PRICE[plan][currency]) {
      return res.status(400).json({ error: "Plan o moneda inválidos" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: PRICE[plan][currency], quantity: 1 }],
      success_url: `${DOMAIN}/?success=1&plan=${plan}`,
      cancel_url: `${DOMAIN}/?canceled=1`,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("STRIPE ERROR:", err);
    return res.status(500).json({
      error: err?.raw?.message || err?.message || "Stripe error",
    });
  }
});

const PORT = process.env.PORT || 4242;

import bodyParser from "body-parser";

// Stripe necesita el body RAW para verificar la firma
app.post(
  "/webhook",
  bodyParser.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook signature failed", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // 👉 AQUÍ SABES QUÉ PASA
    switch (event.type) {
      case "checkout.session.completed":
        console.log("✅ NUEVA SUSCRIPCIÓN");
        console.log(event.data.object.customer_email);
        break;

      case "customer.subscription.deleted":
        console.log("❌ SUSCRIPCIÓN CANCELADA");
        break;

      default:
        console.log(`ℹ️ Evento ${event.type}`);
    }

    res.json({ received: true });
  }
);
app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
