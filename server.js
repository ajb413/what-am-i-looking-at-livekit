import express from 'express';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { cli, defineAgent, ServerOptions, inference, llm } from '@livekit/agents';
import { AudioSource, LocalAudioTrack, RoomEvent, TrackKind, TrackPublishOptions, TrackSource as RtcSource, VideoStream } from '@livekit/rtc-node';
import { AccessToken, RoomConfiguration, RoomAgentDispatch, TrackSource } from 'livekit-server-sdk';

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, AUTH_USER, AUTH_PASS, PORT = 3000 } = process.env;
const PROMPT = 'What is the main item in this photo? Reply in under 15 words: its name, then a few identifying details. If nothing is clear, reply "Looking..."';
const VOICE = '9626c31c-bec5-4cca-baa8-f8ba9e84c8bc'; // Cartesia "Jacqueline"

// ---------- Agent: runs once per room, in a child process ----------
export default defineAgent({
  entry: async (ctx) => {
    // Models via LiveKit Inference (LiveKit API key only)
    const vision = new inference.LLM({ model: 'google/gemini-3-flash' });
    const tts = new inference.TTS({ model: 'cartesia/sonic-3', voice: VOICE });
    let frame;

    // Keep only the latest camera frame
    ctx.room.on(RoomEvent.TrackSubscribed, async (track) => {
      if (track.kind !== TrackKind.KIND_VIDEO) return;
      for await (const e of new VideoStream(track)) frame = e.frame;
    });
    await ctx.connect();

    // Session time limit from dispatch metadata (set by /token)
    const { maxSeconds } = JSON.parse(ctx.job.metadata || '{}');
    if (maxSeconds) setTimeout(() => ctx.room.disconnect(), maxSeconds * 1000);

    // Publish an audio track for speech
    const audio = new AudioSource(tts.sampleRate, tts.numChannels);
    await ctx.room.localParticipant.publishTrack(LocalAudioTrack.createAudioTrack('voice', audio), new TrackPublishOptions({ source: RtcSource.SOURCE_MICROPHONE }));
    const muted = () => [...ctx.room.remoteParticipants.values()].some((p) => p.attributes.muted === 'true');
    const speak = async (text) => {
      const stream = tts.stream();
      stream.pushText(text);
      stream.endInput();
      for await (const ev of stream) {
        if (typeof ev === 'symbol') break; // END_OF_STREAM
        await audio.captureFrame(ev.frame);
        if (ev.final) break;
      }
      stream.close();
      await audio.waitForPlayout();
    };

    // Describe the latest frame; send text and speak only when the item changes
    let last = '';
    while (ctx.room.isConnected) {
      if (frame) {
        const prompt = last ? `${PROMPT} Your previous answer was "${last}". If the main item is still the same, reply exactly SAME.` : PROMPT;
        const chatCtx = llm.ChatContext.empty();
        chatCtx.addMessage({ role: 'user', content: [prompt, llm.createImageContent({ image: frame, inferenceWidth: 768, inferenceHeight: 768 })] });
        try {
          const text = (await vision.chat({ chatCtx }).collect()).text.trim();
          if (text !== 'SAME' && text !== last) {
            last = text;
            await ctx.room.localParticipant.sendText(text, { topic: 'vision' });
            if (!muted()) await speak(text);
          }
        } catch (err) { console.error(err); }
      }
      await sleep(1000);
    }
  },
});

// ---------- Web server + agent worker: main process only ----------
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = express();

  // Basic auth on every route
  const expected = 'Basic ' + Buffer.from(`${AUTH_USER}:${AUTH_PASS}`).toString('base64');
  app.use((req, res, next) => {
    if (req.headers.authorization === expected) return next();
    res.set('WWW-Authenticate', 'Basic realm="lk"').sendStatus(401);
  });

  app.use(express.static('public'));

  // Token for a fresh, locked-down room; the "vision" agent is dispatched into it
  app.get('/token', async (req, res) => {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity: randomUUID(), ttl: '2m' });
    at.addGrant({
      roomJoin: true, room: `look-${randomUUID()}`,
      canPublishSources: [TrackSource.CAMERA], canPublishData: false, canSubscribe: true, canUpdateOwnMetadata: true,
    });
    at.roomConfig = new RoomConfiguration({
      maxParticipants: 2, emptyTimeout: 10, departureTimeout: 10,
      agents: [new RoomAgentDispatch({ agentName: 'vision', metadata: JSON.stringify({ maxSeconds: 300 }) })],
    });
    res.json({ url: LIVEKIT_URL, token: await at.toJwt() });
  });

  app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
  cli.runApp(new ServerOptions({ agent: fileURLToPath(import.meta.url), agentName: 'vision' }));
}
