// What the server is receiving from the encoder right now, for the channel
// page's Stream health box. Read from nginx-rtmp's own stats page
// (rtmp/nginx.conf.template, /stat on the internal port, never public).
// Only numbers go back to the browser, never the stream key.

const STAT_URL = `${process.env.HLS_INTERNAL_URL || 'http://rtmp:8080'}/stat`;

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m ? m[1] : null;
}

function block(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1] : '';
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function health(streamKey) {
  const res = await fetch(STAT_URL, { signal: AbortSignal.timeout(3000) });
  if (!res.ok) throw new Error(`The RTMP server's stats page answered ${res.status}`);
  const xml = await res.text();

  const streams = xml.split('<stream>').slice(1).map((s) => s.split('</stream>')[0]);
  const stream = streams.find((s) => tag(s, 'name') === streamKey && /<publishing\s*\/?>/.test(s));
  if (!stream) return { connected: false };

  const meta = block(stream, 'meta');
  const video = block(meta, 'video');
  const audio = block(meta, 'audio');
  const kbps = (v) => (num(v) == null ? null : Math.round(num(v) / 1000));
  return {
    connected: true,
    uptimeMs: num(tag(stream, 'time')),
    bitrateKbps: kbps(tag(stream, 'bw_in')),
    videoKbps: kbps(tag(stream, 'bw_video')),
    audioKbps: kbps(tag(stream, 'bw_audio')),
    width: num(tag(video, 'width')),
    height: num(tag(video, 'height')),
    fps: num(tag(video, 'frame_rate')),
    videoCodec: tag(video, 'codec'),
    videoProfile: tag(video, 'profile'),
    audioCodec: tag(audio, 'codec'),
    sampleRate: num(tag(audio, 'sample_rate')),
    audioChannels: num(tag(audio, 'channels')),
  };
}

module.exports = { health };
