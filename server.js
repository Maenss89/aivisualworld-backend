const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
const mongoose = require("mongoose");
const bcryptjs = require("bcryptjs");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const nodemailer = require("nodemailer");
const paypal = require("paypal-rest-sdk");
const { OpenAI } = require("openai");

dotenv.config();

const app = express();

// ===== MIDDLEWARE =====
app.use(cors({
  origin: [
    "https://www.aivisualworld.com",
    "https://aivisualworld.com",
    "https://aivisualworld-com-993102.hostingersite.com",
    "http://localhost:3000",
  ],
  credentials: true,
}));
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

// ===== SERVE REACT FRONTEND (static build) =====
// After running: npm run build inside aivisualworld-frontend,
// copy the build/ folder contents into aivisualworld-backend/public/
app.use(express.static(path.join(__dirname, "public")));

// ===== PAYPAL CONFIGURATION =====
paypal.configure({
  mode: process.env.PAYPAL_MODE || "sandbox",
  client_id: process.env.PAYPAL_CLIENT_ID,
  client_secret: process.env.PAYPAL_CLIENT_SECRET,
});

// ===== OPENAI CONFIGURATION =====
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// ===== MONGODB CONNECTION =====
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection failed:", err));

// ===== SCHEMAS =====

const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  tokens: { type: Number, default: 0 },
  subscriptionPlan: { type: String, enum: ["free", "starter", "pro", "enterprise"], default: "free" },
  subscriptionStatus: { type: String, enum: ["active", "inactive", "cancelled"], default: "inactive" },
  subscriptionEndDate: Date,
  paypalSubscriptionId: String,
  totalSpent: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

const generationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, enum: ["image", "text"], required: true },
  prompt: String,
  imageUrl: String,
  tokensUsed: Number,
  createdAt: { type: Date, default: Date.now },
});

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  type: { type: String, enum: ["subscription", "token_purchase", "generation"], required: true },
  amount: Number,
  tokensAdded: Number,
  paypalTransactionId: String,
  status: { type: String, enum: ["pending", "completed", "failed"], default: "pending" },
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model("User", userSchema);
const Generation = mongoose.model("Generation", generationSchema);
const Transaction = mongoose.model("Transaction", transactionSchema);

// ===== AUTH MIDDLEWARE =====

const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ error: "No token provided" });

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (error) {
    res.status(401).json({ error: "Invalid token" });
  }
};

// ===== AUTH ROUTES =====

app.post("/api/auth/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;

    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) return res.status(400).json({ error: "User already exists" });

    const hashedPassword = await bcryptjs.hash(password, 10);
    const user = await User.create({
      username,
      email,
      password: hashedPassword,
      tokens: 10, // Free tier gets 10 tokens
    });

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });

    res.json({ token, user: { id: user._id, username, email, tokens: user.tokens } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ error: "User not found" });

    const isPasswordValid = await bcryptjs.compare(password, user.password);
    if (!isPasswordValid) return res.status(400).json({ error: "Invalid password" });

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: "30d",
    });

    res.json({ token, user: { id: user._id, username: user.username, email: user.email, tokens: user.tokens } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== USER ROUTES =====

app.get("/api/user/profile", authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select("-password");
    res.json(user);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/user/tokens", authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    res.json({ tokens: user.tokens, subscriptionPlan: user.subscriptionPlan });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== IMAGE GENERATION ROUTES =====

app.post("/api/generate/image", authenticate, async (req, res) => {
  try {
    const { prompt } = req.body;
    const user = await User.findById(req.userId);

    const tokensRequired = 5;
    if (user.tokens < tokensRequired) {
      return res.status(400).json({ error: "Insufficient tokens" });
    }

    let imageUrl;
    if (process.env.STABILITY_API_KEY) {
      const response = await axios.post(
        "https://api.stability.ai/v1/generation/stable-diffusion-v1-6/text-to-image",
        {
          text_prompts: [{ text: prompt }],
          cfg_scale: 7,
          height: 512,
          width: 512,
          samples: 1,
          steps: 30,
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.STABILITY_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );
      imageUrl = `data:image/png;base64,${response.data.artifacts[0].base64}`;
    } else {
      imageUrl = "https://via.placeholder.com/512x512?text=" + encodeURIComponent(prompt);
    }

    user.tokens -= tokensRequired;
    await user.save();

    const generation = await Generation.create({
      userId: req.userId,
      type: "image",
      prompt,
      imageUrl,
      tokensUsed: tokensRequired,
    });

    res.json({ imageUrl, tokensRemaining: user.tokens, generationId: generation._id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== LLM ROUTES =====

app.post("/api/generate/text", authenticate, async (req, res) => {
  try {
    const { prompt, model = "gpt-3.5-turbo" } = req.body;
    const user = await User.findById(req.userId);

    const tokensRequired = 2;
    if (user.tokens < tokensRequired) {
      return res.status(400).json({ error: "Insufficient tokens" });
    }

    if (!openai) {
      return res.status(503).json({ error: "OpenAI API key not configured" });
    }

    const response = await openai.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 500,
    });

    const text = response.choices[0].message.content;

    user.tokens -= tokensRequired;
    await user.save();

    await Generation.create({
      userId: req.userId,
      type: "text",
      prompt,
      tokensUsed: tokensRequired,
    });

    res.json({ text, tokensRemaining: user.tokens });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== SUBSCRIPTION PLANS =====

const SUBSCRIPTION_PLANS = {
  free: { name: "Free", price: 0, tokens: 10, monthly: false },
  starter: { name: "Starter", price: 9.99, tokens: 100, monthly: true },
  pro: { name: "Pro", price: 29.99, tokens: 500, monthly: true },
  enterprise: { name: "Enterprise", price: 99.99, tokens: 2000, monthly: true },
};

app.get("/api/subscriptions/plans", (req, res) => {
  res.json(SUBSCRIPTION_PLANS);
});

// ===== PAYPAL INTEGRATION =====

app.post("/api/payment/create-subscription", authenticate, async (req, res) => {
  try {
    const { planId } = req.body;
    const user = await User.findById(req.userId);
    const plan = SUBSCRIPTION_PLANS[planId];

    if (!plan) return res.status(400).json({ error: "Invalid plan" });

    const billingPlanAttrs = {
      type: "REGULAR",
      payment_definitions: [
        {
          name: plan.name,
          type: "REGULAR",
          frequency: "MONTH",
          frequency_interval: "1",
          cycles: "0",
          amount: { value: plan.price, currency: "USD" },
        },
      ],
      merchant_preferences: {
        setup_fee: { value: "0", currency: "USD" },
        return_url: process.env.PAYPAL_RETURN_URL,
        cancel_url: process.env.PAYPAL_CANCEL_URL,
        notify_url: process.env.PAYPAL_NOTIFY_URL,
        max_fail_attempts: "3",
        initial_fail_amount_action: "CONTINUE",
        day_of_month: "1",
      },
    };

    paypal.billingPlan.create(billingPlanAttrs, (error, billingPlan) => {
      if (error) {
        console.error(error);
        return res.status(500).json({ error: "Failed to create billing plan" });
      }

      paypal.billingPlan.update(billingPlan.id, [{ op: "replace", path: "/", value: { state: "ACTIVE" } }], () => {
        const billingAgreementAttrs = {
          name: `${plan.name} Subscription`,
          description: `${plan.tokens} tokens/month`,
          start_date: new Date(Date.now() + 10000).toISOString(),
          plan: { id: billingPlan.id },
          payer: {
            payment_method: "paypal",
            payer_info: { email: user.email },
          },
        };

        paypal.billingAgreement.create(billingAgreementAttrs, (error, billingAgreement) => {
          if (error) {
            console.error(error);
            return res.status(500).json({ error: "Failed to create billing agreement" });
          }

          const approvalUrl = billingAgreement.links.find((link) => link.rel === "approval_url").href;
          res.json({ approvalUrl, agreementId: billingAgreement.id });
        });
      });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/payment/execute-subscription", authenticate, async (req, res) => {
  try {
    const { agreementId, planId } = req.body;
    const user = await User.findById(req.userId);
    const plan = SUBSCRIPTION_PLANS[planId];

    paypal.billingAgreement.execute(agreementId, {}, async (error, billingAgreement) => {
      if (error) {
        console.error(error);
        return res.status(500).json({ error: "Failed to execute subscription" });
      }

      user.subscriptionPlan = planId;
      user.subscriptionStatus = "active";
      user.subscriptionEndDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      user.paypalSubscriptionId = billingAgreement.id;
      user.tokens += plan.tokens;
      await user.save();

      await Transaction.create({
        userId: req.userId,
        type: "subscription",
        amount: plan.price,
        tokensAdded: plan.tokens,
        paypalTransactionId: billingAgreement.id,
        status: "completed",
      });

      res.json({ success: true, user });
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/payment/webhook", async (req, res) => {
  try {
    const { event_type, resource } = req.body;

    if (event_type === "BILLING.SUBSCRIPTION.CANCELLED") {
      const subscription = await User.findOne({ paypalSubscriptionId: resource.id });
      if (subscription) {
        subscription.subscriptionStatus = "cancelled";
        await subscription.save();
      }
    }

    res.json({ received: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// ===== TRANSACTION ROUTES =====

app.get("/api/transactions", authenticate, async (req, res) => {
  try {
    const transactions = await Transaction.find({ userId: req.userId }).sort({ createdAt: -1 });
    res.json(transactions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/generations", authenticate, async (req, res) => {
  try {
    const generations = await Generation.find({ userId: req.userId }).sort({ createdAt: -1 });
    res.json(generations);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== CONTACT FORM =====
// Sends an email to contact@aivisualworld.com from the contact form

app.post("/api/contact", async (req, res) => {
  try {
    const { name, email, message } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ error: "Name, email, and message are required." });
    }

    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 465,
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });

    await transporter.sendMail({
      from: `"AIVisualWorld Contact" <${process.env.SMTP_USER}>`,
      to: process.env.CONTACT_EMAIL,
      replyTo: email,
      subject: `Contact: ${name} - aivisualworld.com`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #6b21a8;">New Contact Form Submission</h2>
          <p><strong>Name:</strong> ${name}</p>
          <p><strong>Email:</strong> <a href="mailto:${email}">${email}</a></p>
          <hr />
          <p><strong>Message:</strong></p>
          <p style="background: #f3f4f6; padding: 15px; border-radius: 8px;">${message.replace(/\n/g, "<br>")}</p>
          <hr />
          <small style="color: #6b7280;">Sent from www.aivisualworld.com contact form</small>
        </div>
      `,
    });

    res.json({ success: true, message: "Your message has been sent! We will get back to you soon." });
  } catch (error) {
    console.error("Contact form error:", error);
    res.status(500).json({ error: "Failed to send message. Please try again later." });
  }
});

// ===== HEALTH CHECK =====

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "aivisualworld-backend", domain: "www.aivisualworld.com" });
});

// ===== SPA CATCH-ALL (MUST be last route) =====
// Returns React's index.html for all non-API routes so React Router works

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ===== START SERVER =====

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`AIVisualWorld running on port ${PORT}`);
  console.log(`Domain: https://www.aivisualworld.com`);
});
