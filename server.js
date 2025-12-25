import express from "express";
import Stripe from "stripe";
import { Resend } from "resend";
import "dotenv/config";

const app = express();

/* ======================================================
   1️⃣ STRIPE WEBHOOK — SIEMPRE PRIMERO (RAW BODY)
====================================================== */
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const resend = new Resend(process.env.RESEND_API_KEY);

    const sig = req.headers["stripe-signature"];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        endpointSecret
      );
    } catch (err) {
      console.error("❌ Webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        const email =
          session.customer_details?.email ||
          session.customer_email ||
          session.metadata?.email;

        const plan = session.metadata?.plan || "starter";

        if (email) {
          await resend.emails.send({
            from: "Construye tu futuro <onboarding@resend.dev>",
            to: email,
            subject: "Bienvenido a Construye tu futuro",
            html: `
              <h2>Bienvenido 👋</h2>
              <p>Gracias por suscribirte a <b>Construye tu futuro</b>.</p>
              <p>Plan: <b>${plan}</b></p>
              <p>👉 Accede aquí:
              <a href="https://construye-tu-futuro.netlify.app/login.html">
                Entrar
              </a></p>
            `,
          });

          console.log("✅ Email enviado a", email);
        }
      }

      res.json({ received: true });
    } catch (err) {
      console.error("❌ Error procesando webhook:", err);
      res.status(500).send("Webhook handler failed");
    }
  }
);

/* ======================================================
   2️⃣ RESTO DEL SERVER (JSON, CORS, STATIC)
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

app.use(express.static("public"));

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

/* ======================================================
   3️⃣ CHECKOUT
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

const FRONTEND = process.env.FRONTEND_ORIGIN;
const PORT = process.env.PORT || 4242;

app.post("/create-checkout-session", async (req, res) => {
  const { plan, currency, email } = req.body;

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: PRICE[plan][currency], quantity: 1 }],
    customer_email: email,
    metadata: { plan, email },
    success_url: `${FRONTEND}/?success=1`,
    cancel_url: `${FRONTEND}/?canceled=1`,
  });

  res.json({ url: session.url });
});

app.listen(PORT, () =>
  console.log(`Servidor activo en puerto ${PORT}`)
);
