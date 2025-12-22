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
app.use(express.json());
app.use(express.static("public")); // sirve public/index.html

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ⬇️ Tus PRICE IDs de Stripe
const PRICE = {
  starter: {
    eur: "price_1ShHCAJKTO7x4rhK7jwwcDk6",
    dkk: "price_1ShEaNJKTO7x4rhKwhvsIsCo",
  },
  premium: {
    eur: "price_1ShGICJKTO7x4rhKw6HCavbL",
    dkk: "price_1ShGIQJKTO7x4rhKFbGvGRNp",
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

app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
