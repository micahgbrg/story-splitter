# Story Splitter — Spec (Render)

## Goal
A web tool, deployed on Render, where a user drops in a single video file (three Instagram story frames conjoined with two hard cuts) and gets back three separate video files split at the cut points, with a manual override before final export.

## User flow
1. User opens the app, drags/drops or selects a video file.
2. User selects the number of frames the video contains (a number input or a small set of preset buttons — 2, 3, 4 — since 3 is the common case but no reason to hardcode it).
3. App uploads the file to the server and runs cut detection, looking for `frameCount - 1` cuts.
4. App shows a timeline with the video's duration and `frameCount - 1` markers at the detected cut points.
5. User can nudge each marker if detection got it wrong.
6. User clicks "Split," and the app returns `frameCount` downloadable files (or a zip).

## Architecture
This is a standard long-running server, not serverless — a single Render **Web Service** running a Docker container. That removes the constraints that shaped the Vercel version of this spec:

- No function execution timeout to design around. A process just runs until it's done.
- No small request-body limit to route around with a separate blob-storage upload step. The file goes straight from the browser to the server's disk via a normal multipart form upload.
- ffmpeg is installed as a normal system package in the Dockerfile, not a bundled static binary fighting a function size cap.

**Stack:**
- Node/Express (or Python/Flask — either is fine; pick whichever your team is more comfortable maintaining) serving both the frontend and the API.
- ffmpeg installed via `apt-get install ffmpeg` in the Dockerfile.
- Files processed in a temp directory on the container's local disk, deleted after the response is sent (or after some TTL) so disk doesn't fill up over time.

**Dockerfile shape (rough):**
```
FROM node:20-slim
RUN apt-get update && apt-get install -y ffmpeg
WORKDIR /app
COPY . .
RUN npm install
EXPOSE 3000
CMD ["npm", "start"]
```

**Render setup:**
- New Web Service, connect the repo, Render auto-builds from the Dockerfile on push.
- No separate storage service needed for v1 — local disk is fine since files are processed and returned in the same request cycle, not persisted long-term.
- One thing to check before committing to this: Render's free/starter tiers have ephemeral disk and can spin down on inactivity (cold start delay on the next request). Fine for an internal tool used a few times a day; worth a paid instance if the team hits it constantly and cold starts get annoying. Confirm current tier behavior against Render's docs since this is from general knowledge of the platform, not verified against a specific plan.

## Cut detection
- Use ffmpeg's scene-detection filter (`select='gt(scene,X)',showinfo`) to get frame-to-frame difference scores across the clip.
- Take the top `frameCount - 1` highest-scoring timestamps above a minimum threshold, enforcing a minimum spacing (e.g. 1s) so two points from the same cut aren't double-counted.
- If fewer than `frameCount - 1` cuts clear the threshold, don't guess at the remainder — surface this to the user (e.g. "found 1 of 2 expected cuts") and let them place the missing marker(s) manually rather than auto-placing a guess.
- If more candidate cuts clear the threshold than expected (e.g. a frame has an internal jump cut), take the top `frameCount - 1` by score, but this is exactly the case the manual override exists for — worth a quick note in the UI when this happens so the user knows to double-check the markers.

## Splitting
- Re-encode at the cut points rather than stream-copy (`-c copy`). Stream copy only cuts cleanly at keyframes, and these clips are short enough that keyframe drift could bleed frames across segments. Re-encoding is slower but frame-accurate, and encode time for short clips is trivial — no timeout pressure here either way now that it's not serverless.
- Output `frameCount` files named clearly (`{original-name}_1.mp4`, `_2.mp4`, ... `_N.mp4`).

## API design (rough)
- `POST /api/upload` → multipart form upload with `frameCount` as a form field, saves file to temp dir, runs detection for `frameCount - 1` cuts, returns `{ fileId, frameCount, cutTimestamps: [t1, ..., tN-1], duration }`.
- `POST /api/split` → given `fileId` and the (possibly user-adjusted) array of cut timestamps, runs the split into `frameCount` segments, returns file URLs (served from the same app, or as a single zip download).

Single-server design means detection and splitting can share the same temp file on disk between requests — no need to re-upload or pass a blob URL between steps.

## UI spec
Kept intentionally minimal:
- Drop zone / file picker
- Frame count selector (number input or preset buttons for 2/3/4, defaulting to 3 since that's the common case)
- Single horizontal scrubber bar representing full video duration, with `frameCount - 1` draggable markers
- Numeric timecode display for each marker (frame-thumbnail preview on drag is a nice-to-have, not required for v1)
- "Split" button, disabled until all expected cut points are set
- Download links for each output file, or a single "Download all (.zip)" button

No accounts or history needed for v1.

## Dependencies (tentative)
- Node/Express or Python/Flask
- ffmpeg (system package, not a bundled binary — this is the main thing that gets simpler off Vercel)
- Multer (Node) or equivalent for handling multipart uploads
- No frontend framework needed beyond plain JS/HTML for this scope, unless the team wants React for maintainability

## Known risks / open questions
- Confirm Render's disk persistence and spin-down behavior on whatever tier you pick — affects whether cold starts are a real annoyance for daily use.
- Concurrent uploads: with local disk and no queue, two people uploading at once needs unique temp filenames (e.g. UUID-based) to avoid collisions — straightforward to build in from the start.
- No auth in this spec — if the tool needs to be restricted to your team rather than public, add basic auth or an allowlist before sharing the URL externally.

## Out of scope for v1
- Batch processing multiple files at once
- Auto-detecting the frame count itself (the user states it up front; the tool doesn't infer it)
- Transitions/fades between frames (this spec assumes hard cuts only)
- User accounts, upload history, or persistent storage of past splits
