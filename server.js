const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const archiver = require("archiver");
const express = require("express");
const multer = require("multer");

const app = express();
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST;
const dataRoot = process.env.DATA_DIR || path.join(__dirname, "tmp");
const uploadsDir = path.join(dataRoot, "uploads");
const outputsDir = path.join(dataRoot, "outputs");
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || 750);
const ttlMs = Number(process.env.FILE_TTL_MS || 1000 * 60 * 60 * 4);

// NOTE: this Map lives in process memory and file paths point at local disk.
// This app assumes exactly one running instance. If you ever configure Render
// to run more than one instance of this service, uploads/splits handled by one
// instance will 404 on requests routed to another. Keep numInstances at 1
// (see render.yaml) unless this is refactored to use shared storage.
const files = new Map();

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Optional basic auth. Set BASIC_AUTH_USER and BASIC_AUTH_PASS in the
// environment to require a login before the app (including its API routes)
// is reachable. If either is unset, the app is open to anyone with the URL -
// fine for a local test, not recommended once this is shared with the team.
function basicAuthMiddleware(req, res, next) {
  const expectedUser = process.env.BASIC_AUTH_USER;
  const expectedPass = process.env.BASIC_AUTH_PASS;
  if (!expectedUser || !expectedPass) {
    next();
    return;
  }

  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    const user = decoded.slice(0, separatorIndex);
    const pass = decoded.slice(separatorIndex + 1);
    if (timingSafeEqual(user, expectedUser) && timingSafeEqual(pass, expectedPass)) {
      next();
      return;
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="Story Splitter"');
  res.status(401).send("Authentication required.");
}

function safeBaseName(name) {
  const parsed = path.parse(name || "story.mp4");
  return (parsed.name || "story")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "story";
}

async function ensureDirs() {
  await fsp.mkdir(uploadsDir, { recursive: true });
  await fsp.mkdir(outputsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await ensureDirs();
      cb(null, uploadsDir);
    } catch (err) {
      cb(err);
    }
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || ".mp4") || ".mp4";
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: maxUploadMb * 1024 * 1024 }
});

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, options);
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const err = new Error(`${command} exited with code ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

async function getDuration(filePath) {
  const { stdout } = await runProcess("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    filePath
  ]);
  const duration = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("Could not determine video duration.");
  }
  return duration;
}

function parseSceneCandidates(ffmpegOutput) {
  const candidates = [];
  let pendingTime = null;

  for (const line of ffmpegOutput.split(/\r?\n/)) {
    const timeMatch = line.match(/pts_time:([0-9.]+)/);
    if (timeMatch) {
      pendingTime = Number.parseFloat(timeMatch[1]);
      continue;
    }

    const scoreMatch = line.match(/lavfi\.scene_score=([0-9.]+)/);
    if (scoreMatch && pendingTime !== null) {
      const score = Number.parseFloat(scoreMatch[1]);
      if (Number.isFinite(pendingTime) && Number.isFinite(score)) {
        candidates.push({ time: pendingTime, score });
      }
      pendingTime = null;
    }
  }
  return candidates;
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function chooseCuts(candidates, expectedCuts, duration) {
  const preferredMinScore = envNumber("SCENE_MIN_SCORE", 0.28);
  const fallbackMinScore = Math.min(
    preferredMinScore,
    envNumber("SCENE_FALLBACK_MIN_SCORE", 0.18)
  );
  const minSpacing = envNumber("MIN_CUT_SPACING_SECONDS", 1);
  const inRange = candidates
    .filter((candidate) => (
      candidate.time > 0.1 &&
      candidate.time < duration - 0.1
    ))
    .sort((a, b) => b.score - a.score);

  function pickAbove(minScore) {
    const picked = [];
    for (const candidate of inRange) {
      if (candidate.score < minScore) continue;
      const overlaps = picked.some((cut) => Math.abs(cut.time - candidate.time) < minSpacing);
      if (!overlaps) picked.push(candidate);
      if (picked.length === expectedCuts) break;
    }
    return picked;
  }

  let minScore = preferredMinScore;
  let picked = pickAbove(preferredMinScore);
  if (picked.length < expectedCuts && fallbackMinScore < preferredMinScore) {
    const fallbackPicked = pickAbove(fallbackMinScore);
    if (fallbackPicked.length > picked.length) {
      minScore = fallbackMinScore;
      picked = fallbackPicked;
    }
  }

  picked.sort((a, b) => a.time - b.time);
  return {
    cuts: picked.map((cut) => Number(cut.time.toFixed(3))),
    candidateCount: inRange.filter((candidate) => candidate.score >= minScore).length,
    minScore,
    preferredMinScore,
    fallbackMinScore,
    minSpacing
  };
}

async function detectCuts(filePath, frameCount, duration) {
  const expectedCuts = frameCount - 1;
  if (expectedCuts <= 0) return { cuts: [], candidateCount: 0 };

  const { stderr } = await runProcess("ffmpeg", [
    "-hide_banner",
    "-i", filePath,
    "-vf", "select='gt(scene,0.08)',metadata=print",
    "-an",
    "-f", "null",
    "-"
  ]);

  return chooseCuts(parseSceneCandidates(stderr), expectedCuts, duration);
}

function validateFrameCount(value) {
  const frameCount = Number.parseInt(value, 10);
  if (!Number.isInteger(frameCount) || frameCount < 2 || frameCount > 12) {
    throw new Error("Frame count must be a whole number between 2 and 12.");
  }
  return frameCount;
}

function validateCuts(cutTimestamps, frameCount, duration) {
  if (!Array.isArray(cutTimestamps) || cutTimestamps.length !== frameCount - 1) {
    throw new Error(`Expected ${frameCount - 1} cut timestamp(s).`);
  }
  const cuts = cutTimestamps
    .map((value) => Number(value))
    .sort((a, b) => a - b);

  for (let i = 0; i < cuts.length; i += 1) {
    if (!Number.isFinite(cuts[i]) || cuts[i] <= 0 || cuts[i] >= duration) {
      throw new Error("Cut timestamps must be inside the video duration.");
    }
    if (i > 0 && cuts[i] - cuts[i - 1] < 0.1) {
      throw new Error("Cut timestamps must be at least 0.1 seconds apart.");
    }
  }
  return cuts;
}

async function removeDir(target) {
  await fsp.rm(target, { recursive: true, force: true });
}

function cleanupFileRecord(fileId) {
  const record = files.get(fileId);
  if (!record) return;
  files.delete(fileId);
  removeDir(record.outputDir).catch(() => {});
  fsp.unlink(record.path).catch(() => {});
}

async function splitVideo(record, cutTimestamps) {
  await removeDir(record.outputDir);
  await fsp.mkdir(record.outputDir, { recursive: true });

  const points = [0, ...cutTimestamps, record.duration];
  const outputFiles = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const segmentDuration = points[index + 1] - start;
    const filename = `${record.baseName}_${index + 1}.mp4`;
    const outputPath = path.join(record.outputDir, filename);

    await runProcess("ffmpeg", [
      "-hide_banner",
      "-y",
      "-ss", String(start),
      "-i", record.path,
      "-t", String(segmentDuration),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "20",
      "-c:a", "aac",
      "-movflags", "+faststart",
      outputPath
    ]);

    outputFiles.push({ filename, path: outputPath });
  }

  record.outputs = outputFiles;
  return outputFiles;
}

app.use(basicAuthMiddleware);
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/upload", upload.single("video"), async (req, res, next) => {
  try {
    if (!req.file) throw new Error("A video file is required.");

    const frameCount = validateFrameCount(req.body.frameCount);
    const duration = await getDuration(req.file.path);
    const detection = await detectCuts(req.file.path, frameCount, duration);
    const fileId = crypto.randomUUID();
    const outputDir = path.join(outputsDir, fileId);

    files.set(fileId, {
      id: fileId,
      path: req.file.path,
      originalName: req.file.originalname,
      baseName: safeBaseName(req.file.originalname),
      frameCount,
      duration,
      outputDir,
      createdAt: Date.now(),
      outputs: []
    });

    setTimeout(() => cleanupFileRecord(fileId), ttlMs).unref();

    res.json({
      fileId,
      frameCount,
      duration,
      cutTimestamps: detection.cuts,
      expectedCuts: frameCount - 1,
      foundCuts: detection.cuts.length,
      candidateCount: detection.candidateCount,
      minScore: detection.minScore,
      minSpacing: detection.minSpacing
    });
  } catch (err) {
    if (req.file?.path) fsp.unlink(req.file.path).catch(() => {});
    next(err);
  }
});

app.post("/api/split", async (req, res, next) => {
  try {
    const { fileId } = req.body;
    const record = files.get(fileId);
    if (!record) {
      res.status(404).json({ error: "File not found or expired. Upload it again." });
      return;
    }

    const cutTimestamps = validateCuts(req.body.cutTimestamps, record.frameCount, record.duration);
    const outputFiles = await splitVideo(record, cutTimestamps);
    res.json({
      files: outputFiles.map((file) => ({
        name: file.filename,
        url: `/api/download/${record.id}/${encodeURIComponent(file.filename)}`
      })),
      zipUrl: `/api/download/${record.id}/all.zip`
    });
  } catch (err) {
    next(err);
  }
});

app.get("/api/download/:fileId/all.zip", async (req, res, next) => {
  try {
    const record = files.get(req.params.fileId);
    if (!record?.outputs?.length) {
      res.status(404).json({ error: "No split files are available for this upload." });
      return;
    }

    res.attachment(`${record.baseName}_split.zip`);
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", next);
    archive.pipe(res);
    for (const file of record.outputs) {
      archive.file(file.path, { name: file.filename });
    }
    await archive.finalize();
  } catch (err) {
    next(err);
  }
});

app.get("/api/download/:fileId/:filename", (req, res) => {
  const record = files.get(req.params.fileId);
  if (!record?.outputs?.length) {
    res.status(404).json({ error: "No split files are available for this upload." });
    return;
  }

  const filename = path.basename(req.params.filename);
  const file = record.outputs.find((candidate) => candidate.filename === filename);
  if (!file) {
    res.status(404).json({ error: "Split file not found." });
    return;
  }
  res.download(file.path, filename);
});

app.use((err, _req, res, _next) => {
  const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
  res.status(status).json({ error: err.message || "Request failed." });
});

ensureDirs().then(() => {
  const server = host ? app.listen(port, host) : app.listen(port);
  server.on("listening", () => {
    const address = host || "0.0.0.0";
    console.log(`Story Splitter listening on ${address}:${port}`);
  });
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
