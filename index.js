// index.js - FACULTECH backend

// Load environment variables from .env file
require("dotenv").config();

// ---------------- Imports ----------------
const express = require("express");
const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");
const cors = require("cors");

const app = express();
const port = process.env.PORT || 3000;

// ---------------- Middleware ----------------
app.use(express.json());
app.use(cors());

// Static Serving for Videos
const alertsClipsDir = path.join(__dirname, "alerts_clips");
const recordingsDir = path.join(__dirname, "recordings", "tapo");

// Ensure directories exist
[alertsClipsDir, recordingsDir].forEach((dir) => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁 Created directory: ${dir}`);
  }
});

app.use("/videos/alerts", express.static(alertsClipsDir));
app.use("/videos/raw", express.static(recordingsDir));

// ---------------- Firebase Initialization ----------------
let db;

try {
  // Initialize Firebase using environment variables instead of serviceAccountKey.json
  console.log(process.env.FIREBASE_PROJECT_ID);
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"), // Handle newlines in private key
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });

  db = admin.database();

  console.log("✅ Firebase initialized successfully");
} catch (err) {
  console.error(
    "❌ Firebase initialization error: Check environment variables",
    err,
  );
  process.exit(1);
}

// ==========================================================
// 🔒 GLOBAL CONTROL VARIABLES
// ==========================================================
let lastSavedTime = 0;

// ---------------- Test Route ----------------
app.get("/", (req, res) => {
  res.send("FACULTECH backend is running!");
});

// ==========================================================
// 🔔 SAVE FCM TOKEN
// ==========================================================
app.post("/save-token", async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ message: "No token provided" });
  }

  try {
    await db.ref("fcm_tokens").push(token);
    console.log("✅ FCM Token saved");
    res.status(200).json({ message: "Token saved successfully" });
  } catch (error) {
    console.error("❌ Error saving token:", error);
    res.status(500).json({ message: "Failed to save token" });
  }
});

// ==========================================================
// 📡 SENSOR DATA ENDPOINT
// ==========================================================
app.post("/api/sensor-data", async (req, res) => {
  const { co_ppm, pm25 } = req.body;

  if (co_ppm === undefined || pm25 === undefined) {
    console.warn("⚠️ Invalid data received:", req.body);
    return res.status(400).json({ message: "Invalid data format" });
  }

  const now = Date.now();

  const sensorData = {
    co_ppm,
    pm25,
    timestamp: new Date().toISOString(),
  };

  console.log("📡 Incoming Sensor Data:", sensorData);

  try {
    // ======================================================
    // 1️⃣ ALWAYS UPDATE LIVE VALUES
    // ======================================================
    await db.ref("current").set(sensorData);

    // ======================================================
    // 2️⃣ SAVE HISTORY EVERY 30 SECONDS
    // ======================================================
    if (now - lastSavedTime > 30000) {
      const historyRef = db.ref("sensor_readings");
      await historyRef.push(sensorData);
      lastSavedTime = now;

      console.log("💾 History saved (30s interval)");

      // 🔥 AUTO DELETE OLD RECORDS (KEEP LAST 100)
      const snapshot = await historyRef.once("value");
      const records = snapshot.val();

      if (records) {
        const keys = Object.keys(records);

        if (keys.length > 100) {
          const keysToDelete = keys.slice(0, keys.length - 100);

          for (const key of keysToDelete) {
            await historyRef.child(key).remove();
          }

          console.log("🗑️ Old history records deleted");
        }
      }
    }

    // ======================================================
    // 3️⃣ GET THRESHOLDS
    // ======================================================
    const thresholdSnapshot = await db.ref("thresholds").once("value");
    const thresholds = thresholdSnapshot.val();

    if (!thresholds) {
      console.log("⚠️ No thresholds found in Firebase.");
      return res.status(200).json({ message: "No thresholds set" });
    }

    const danger = co_ppm > thresholds.co_ppm || pm25 > thresholds.pm25;

    // ======================================================
    // 🔒 DEPLOYMENT-SAFE ALERT STATE
    // ======================================================
    const stateRef = db.ref("system_state");
    const stateSnapshot = await stateRef.once("value");

    let state = stateSnapshot.val() || {
      alertActive: false,
      dangerStartTime: null,
    };

    if (danger) {
      if (!state.dangerStartTime) {
        state.dangerStartTime = now;
      }

      const duration = now - state.dangerStartTime;

      if (duration >= 3000 && !state.alertActive) {
        console.log("🚨 5-second sustained danger confirmed!");

        const alerts = [];

        if (co_ppm > thresholds.co_ppm)
          alerts.push(`CO level high: ${co_ppm} ppm`);

        if (pm25 > thresholds.pm25) alerts.push(`PM2.5 level high: ${pm25}`);

        await db.ref("alerts").push({
          ...sensorData,
          alerts,
        });

        // ======================================================
        // 4️⃣ GET RECENT RECORDINGS
        // ======================================================
        const recordings = await getRecentRecordings(new Date().getTime());

        // ======================================================
        // 5️⃣ MOVE RECORDINGS TO ALERTS
        // ======================================================
        const alertClips = await moveRecordingsToAlerts(recordings);

        // ======================================================
        // 7️⃣ AUTO DELETE OLD ALERTS (KEEP LAST 100)
        // ======================================================
        const alertsSnapshot = await db.ref("alerts").once("value");
        const alertRecords = alertsSnapshot.val();

        if (alertRecords) {
          const alertKeys = Object.keys(alertRecords);

          if (alertKeys.length > 100) {
            const alertsToDelete = alertKeys.slice(0, alertKeys.length - 100);

            for (const key of alertsToDelete) {
              await db.ref("alerts").child(key).remove();
            }

            console.log("🗑️ Old alert records deleted (kept last 100)");
          }
        }

        // ======================================================
        // 8️⃣ SEND PUSH NOTIFICATIONS
        // ======================================================
        const tokensSnapshot = await db.ref("fcm_tokens").once("value");
        const tokensData = tokensSnapshot.val();

        if (tokensData) {
          const tokens = Object.values(tokensData);

          const message = {
            notification: {
              title: "🚨 Smoke / Vape Detected!",
              body: alerts.join(" | "),
            },
            tokens: tokens,
          };

          const response = await admin
            .messaging()
            .sendEachForMulticast(message);

          console.log(`🔔 Notifications sent: ${response.successCount}`);
        } else {
          console.log("⚠️ No FCM tokens found.");
        }

        state.alertActive = true;
      }
    } else {
      if (state.alertActive) {
        console.log("✅ Values back to normal. Alert reset.");
      }

      state.alertActive = false;
      state.dangerStartTime = null;
    }

    // Save updated system state
    await stateRef.set(state);

    res.status(200).json({ message: "Data processed successfully" });
  } catch (error) {
    console.error("❌ Error processing data:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

// ==========================================================
// 🌐 LATEST DATA ENDPOINT
// ==========================================================
app.get("/latest-data", async (req, res) => {
  try {
    const [dataSnapshot, thresholdSnapshot] = await Promise.all([
      db.ref("current").once("value"),
      db.ref("thresholds").once("value"),
    ]);
    const data = dataSnapshot.val();
    const thresholds = thresholdSnapshot.val() || null;

    if (!data) {
      return res.json({
        co_ppm: 0,
        pm25: 0,
        timestamp: new Date().toISOString(),
        thresholds,
      });
    }

    res.json({
      ...data,
      thresholds,
    });
  } catch (err) {
    console.error("❌ Error fetching latest data:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================================
// ==========================================================
// 📊 CONFIGURE THRESHOLDS ENDPOINT
// ==========================================================
app.post("/configure-thresholds", async (req, res) => {
  try {
    const { co_ppm, pm25 } = req.body;
    await db.ref("thresholds").set({ co_ppm, pm25 });
    res.status(200).json({ message: "Thresholds configured successfully" });
  } catch (err) {
    console.error("❌ Error configuring thresholds:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================================
// ---------------- Thumbnails ----------------
const thumbnailsDir = path.join(__dirname, "thumbnails");
if (!fs.existsSync(thumbnailsDir)) {
  fs.mkdirSync(thumbnailsDir, { recursive: true });
}
app.use("/thumbnails", express.static(thumbnailsDir));

const {
  getRecentRecordings,
  moveRecordingsToAlerts,
  listVideosInDir,
  getVideosWithThumbnails,
  listAnomalyFolders,
} = require("./utils.js");

// Helper to paginate
const paginate = (items, page = 1, limit = 10) => {
  const startIndex = (page - 1) * limit;
  const endIndex = page * limit;
  return {
    data: items.slice(startIndex, endIndex),
    meta: {
      total: items.length,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(items.length / limit),
    },
  };
};

// ==========================================================
// 📹 GET CLIPS ENDPOINT
// ==========================================================
app.get("/get-clips", async (req, res) => {
  try {
    const { page = 1, limit = 10, folder } = req.query;

    // If folder is specified, return clips inside that folder
    if (folder) {
      const clips = await getVideosWithThumbnails(alertsClipsDir, folder);
      const formattedClips = clips.map((clip) => ({
        name: clip.name,
        size: clip.size,
        date: clip.date,
        // Url needs to include the subfolder
        url: `/videos/alerts/${folder}/${path.basename(clip.path)}`,
        thumbnailUrl: clip.thumbnailUrl
          ? `/thumbnails/${path.basename(clip.thumbnailUrl)}`
          : null,
      }));
      return res.status(200).json(paginate(formattedClips, page, limit));
    }

    // Otherwise return list of anomaly folders
    const folders = listAnomalyFolders(alertsClipsDir);
    res.status(200).json(paginate(folders, page, limit));
  } catch (err) {
    console.error("❌ Error fetching clips:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/get-recordings", async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const recordings = await getVideosWithThumbnails(recordingsDir);

    const formattedRecordings = recordings.map((rec) => ({
      name: rec.name,
      size: rec.size,
      date: rec.date,
      url: `/videos/raw/${path.relative(recordingsDir, rec.path).replace(/\\/g, "/")}`,
      thumbnailUrl: rec.thumbnailUrl
        ? `/thumbnails/${path.basename(rec.thumbnailUrl)}`
        : null,
    }));

    res.status(200).json(paginate(formattedRecordings, page, limit));
  } catch (err) {
    console.error("❌ Error fetching recordings:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================================
// ==========================================================
// 📊 GET TABLE ANALYTICS ENDPOINT
// ==========================================================
app.get("/api/history", async (req, res) => {
  try {
    const snapshot = await db
      .ref("sensor_readings")
      .limitToLast(100)
      .once("value");
    const data = snapshot.val();
    const formattedData = data ? Object.values(data) : [];
    res.status(200).json(formattedData);
  } catch (err) {
    console.error("❌ Error fetching sensor history:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/alerts", async (req, res) => {
  try {
    const snapshot = await db.ref("alerts").limitToLast(100).once("value");
    const data = snapshot.val();
    const formattedData = data ? Object.values(data) : [];
    res.status(200).json(formattedData);
  } catch (err) {
    console.error("❌ Error fetching alerts history:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/get-table-analytics", async (req, res) => {
  try {
    const snapshot = await db
      .ref("sensor_readings")
      .limitToLast(500)
      .once("value");
    res.status(200).json(snapshot.val());
  } catch (err) {
    console.error("❌ Error fetching analytics:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================================
// 🧪 FIREBASE CONNECTION TEST
// ==========================================================
app.get("/test-firebase", async (req, res) => {
  try {
    const snapshot = await db.ref("/").once("value");
    res.status(200).json({
      message: "Firebase connection works",
      data: snapshot.val(),
    });
  } catch (err) {
    console.error("❌ Firebase connection test failed:", err);
    res.status(500).json({
      message: "Firebase connection failed",
      error: err.message,
    });
  }
});

// ---------------- START SERVER ----------------
app.listen(port, "0.0.0.0", () => {
  console.log(`🚀 FACULTECH backend running on port ${port}`);
  console.log("Waiting for ESP32 sensor data...");
});
