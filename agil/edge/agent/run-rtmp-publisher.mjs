#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runRtmpPublisher } from './rtmp-publisher.mjs';

const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());

try {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean' }, core: { type: 'string' }, ingress: { type: 'string' },
    room: { type: 'string' }, input: { type: 'string' },
  } });
  if (values.help) {
    console.log('Usage: node agil/edge/agent/run-rtmp-publisher.mjs --core CORE_ORIGIN --ingress RTMPS_ORIGIN --room ROOM_ID --input ABSOLUTE_MP4');
  } else {
    await runRtmpPublisher({ core: values.core, ingress: values.ingress, roomId: values.room, input: values.input,
      apiKey: process.env.AGIL_EDGE_CORE_API_KEY, ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH,
      signal: abort.signal, onState: (event) => console.log(JSON.stringify(event)) });
  }
} catch (error) {
  if (!abort.signal.aborted || error.message.startsWith('Core did not confirm revocation')) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
