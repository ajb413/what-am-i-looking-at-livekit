# What am I looking at? A LiveKit vision real-time web app.

Web page app where you point the device camera at something; a LiveKit agent identifies it, shows the description as text on screen, and speaks the description out loud.

The client video stream is published to the LiveKit Agent and itentifies what is being shown by the camera.

- `server.js` — one process, two roles:
  - Express: basic auth, static page, `/token` (locked-down room token + agent dispatch).
  - LiveKit Agent: samples camera frames → vision LLM (`google/gemini-3-flash`) → text stream + Cartesia TTS, all via LiveKit Inference (LiveKit API key only).
- `public/index.html` — vanilla JS client (`livekit-client` UMD).

## Account

Create a project at [cloud.livekit.io](https://cloud.livekit.io) → Settings → API Keys.

## Run

Requires Node 24+. Serve over HTTPS (camera access), e.g. reverse proxy to `PORT`.

```sh
npm install
cp .env.example .env   # fill in values
npm start              # or: pm2 start npm --name livekit-vision -- start
```
