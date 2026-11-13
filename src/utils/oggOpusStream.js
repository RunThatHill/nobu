const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const { DisTubeError } = require('distube');
const { createAudioResource, StreamType } = require('@discordjs/voice');

function pushArgsFromMap(target, obj) {
  if (!obj) return;
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item) target.push(`-${key}`, String(item));
      }
    } else if (value === true) {
      target.push(`-${key}`);
    } else if (value !== null && value !== undefined && value !== false) {
      target.push(`-${key}`, String(value));
    }
  }
}

/**
 * Low-memory audio stream that encodes directly to Ogg/Opus via FFmpeg libopus,
 * avoiding opusscript WASM allocation (~20-30 MB RSS savings) and JS PCM volume loops.
 */
class OggOpusStream extends EventEmitter {
  #ffmpegPath;
  #opts;
  #killed = false;
  #expectedFactor;
  #initialVolumeSynced = false;
  #onVolumeChange;

  constructor(url, options = {}) {
    super();
    const { ffmpeg = {}, seek = 0, volumePercent = 50, onVolumeChange } = options;
    const args = ffmpeg.args || {};

    this.seekTime = typeof seek === 'number' && seek > 0 ? seek : 0;
    this.#ffmpegPath = ffmpeg.path || 'ffmpeg';
    this.#onVolumeChange = onVolumeChange;
    this.#expectedFactor = (volumePercent / 100) ** (0.5 / Math.log10(2));

    let isFileUrl = false;
    let resolvedUrl = url;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'file:') {
        isFileUrl = true;
        resolvedUrl = parsed.hostname + parsed.pathname;
      }
    } catch (_) {}

    const ffArgs = [];
    if (!isFileUrl) {
      ffArgs.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
    }
    ffArgs.push(
      '-analyzeduration', '0',
      '-probesize', '65536',
      '-threads', '1',
      '-hide_banner'
    );

    const globalArgs = { ...(args.global || {}) };
    delete globalArgs.threads;
    delete globalArgs.probesize;
    pushArgsFromMap(ffArgs, globalArgs);

    const inputArgs = { ...(args.input || {}) };
    if (resolvedUrl && resolvedUrl.includes('googlevideo.com')) {
      delete inputArgs.user_agent;
    }
    pushArgsFromMap(ffArgs, inputArgs);

    if (this.seekTime > 0) {
      ffArgs.push('-ss', String(this.seekTime));
    }

    ffArgs.push('-i', resolvedUrl);

    const outputArgs = { ...(args.output || {}) };
    const filters = [];
    if (outputArgs.af) {
      filters.push(String(outputArgs.af));
      delete outputArgs.af;
    }
    if (Math.abs(this.#expectedFactor - 1) > 0.01) {
      filters.push(`volume=${this.#expectedFactor.toFixed(4)}`);
    }
    if (filters.length > 0) {
      ffArgs.push('-af', filters.join(','));
    }
    pushArgsFromMap(ffArgs, outputArgs);

    ffArgs.push(
      '-vn',
      '-acodec', 'libopus',
      '-b:a', '64k',
      '-vbr', 'on',
      '-frame_duration', '20',
      '-ar', '48000',
      '-ac', '2',
      '-f', 'opus',
      'pipe:1'
    );

    this.#opts = ffArgs;
    this.process = null;
    this.stream = new PassThrough({ highWaterMark: 16384 });
    this.stream
      .on('close', () => this.kill())
      .on('error', (err) => {
        this.debug(`[stream] error: ${err.message}`);
        this.emit('error', err);
      })
      .on('finish', () => this.debug('[stream] log: stream finished'));

    this.audioResource = createAudioResource(this.stream, {
      inputType: StreamType.OggOpus,
      inlineVolume: false,
    });
  }

  spawn() {
    this.debug(`[process] spawn: ${this.#ffmpegPath} ${this.#opts.join(' ')}`);
    this.process = spawn(this.#ffmpegPath, this.#opts, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    })
      .on('error', (err) => {
        this.debug(`[process] error: ${err.message}`);
        this.emit('error', err);
      })
      .on('exit', (code, signal) => {
        this.debug(`[process] exit: code=${code ?? 'unknown'} signal=${signal ?? 'unknown'}`);
        if (this.#killed) return;
        if (!code || [0, 255].includes(code)) return;
        this.debug(`[process] error: ffmpeg exited with code ${code}`);
        this.emit('error', new DisTubeError('FFMPEG_EXITED', code));
      });

    if (!this.process.stdout || !this.process.stderr) {
      this.kill();
      throw new Error('Failed to create ffmpeg process');
    }

    this.process.stdout.pipe(this.stream);
    this.process.stderr.setEncoding('utf8').on('data', (data) => {
      for (const line of data.split(/\r\n|\r|\n/u)) {
        if (!/^\s*$/.test(line)) {
          this.debug(`[ffmpeg] log: ${line}`);
        }
      }
    });
  }

  debug(msg) {
    this.emit('debug', msg);
  }

  setVolume(factor) {
    // Initial DisTubeVoice#play sync happens right after spawn() with the exact same factor
    if (!this.#initialVolumeSynced) {
      this.#initialVolumeSynced = true;
      return;
    }
    if (Math.abs(factor - this.#expectedFactor) > 0.01 && typeof this.#onVolumeChange === 'function') {
      this.#expectedFactor = factor;
      this.#onVolumeChange();
    }
  }

  kill() {
    this.#killed = true;
    if (!this.stream.destroyed) this.stream.destroy();
    if (this.process && !this.process.killed) {
      try {
        this.process.kill('SIGKILL');
      } catch (_) {}
    }
    if (typeof global.gc === 'function') {
      setImmediate(() => {
        try {
          global.gc();
        } catch (_) {}
      });
    }
  }
}

module.exports = {
  OggOpusStream,
};
