import express from "express";
import cors from "cors";
// import { scanRouter } from "./routes/scan.route.js";

const app = express();
const port = process.env.PORT ? Number(process.env.PORT) : 4000;

app.use(cors());
app.use(express.json());

// app.use("/api/scan", scanRouter);

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`Backend listening on http://localhost:${port}`);
});
