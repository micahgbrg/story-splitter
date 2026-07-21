# Story Splitter

A small Render-ready web app that detects hard cuts in one conjoined story video and exports separate MP4 clips.

## Local Run

```sh
npm install
npm start
```

Open `http://localhost:3000`.

## Deployment

The app is designed for a Render Web Service using the included `Dockerfile`. The included `render.yaml` can be used as a Render Blueprint.

## Configuration

See `.env.example` for all environment variables (upload size limit, cleanup TTL, detection sensitivity, optional basic auth). Copy it to `.env` for local runs, or set the values directly in the Render dashboard.

### Restricting access

By default the app is open to anyone with the URL. Set `BASIC_AUTH_USER` and `BASIC_AUTH_PASS` (in the Render dashboard, not committed to the repo) before sharing this outside a trusted network - the app will then require a login on every route, including the API.

## Notes

- `ffmpeg` and `ffprobe` must be available on the server. The Docker image installs them with `apt-get`.
- Uploaded source files and generated clips are stored on local disk and cleaned up after a few hours.
- The UI lets users adjust every detected marker before splitting.
- This app assumes a single running instance - upload/split state lives in local disk and in-process memory, not a shared store. `render.yaml` pins `numInstances: 1`; don't scale past that without a rework.
- Render's proxy enforces a request timeout that this app hasn't been tested against with very large files. A long upload + re-encode + zip-download for a large video could get cut off mid-request. Test with your largest realistic file before rolling this out to the team, and check Render's current timeout docs if you hit it.
