// Microphone capture for one spoken turn.
//
// The mic stays open for the whole turn and every sample is buffered, so if the
// speaker pauses mid-sentence and starts again inside the silence window the new
// audio is simply appended to the same turn — the silence timer just resets.
// Only after a full `silenceMs` of uninterrupted quiet do we cut the turn, trim
// the dead air off both ends, and hand back a 16 kHz mono WAV file.
import mic from "mic"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

// Whisper wants 16 kHz mono signed 16-bit PCM, and so does everything below.
const RATE = 16000
const CHANNELS = 1
const BIT_WIDTH = 16
const BYTES_PER_SAMPLE = BIT_WIDTH / 8
const BYTES_PER_SECOND = RATE * CHANNELS * BYTES_PER_SAMPLE

// Level decisions are made on uniform 50 ms windows rather than on whatever
// sized chunks sox happens to emit, so the thresholds mean the same thing
// regardless of pipe buffering.
const WINDOW_MS = 50
const WINDOW_BYTES = (BYTES_PER_SECOND * WINDOW_MS) / 1000

// Nothing quieter than this counts as speech, however quiet the room is.
const MIN_RMS = Number(process.env.STT_MIN_RMS ?? 0.012)
// ...and nothing quieter than this multiple of the measured room tone does either.
const NOISE_MULTIPLIER = 3.5
// Room tone is sampled for this long before we start listening for speech.
const CALIBRATION_MS = 600
// Audio kept from just before the trigger so the first syllable isn't clipped.
const PRE_ROLL_MS = 300
// A little air after the last word so whisper doesn't cut off a trailing plosive.
const TRAIL_PAD_MS = 400
// A cough or door slam is shorter than this and is not treated as a turn.
const MIN_SPEECH_MS = 200
// Backstop against a room that never goes quiet enough to trip the silence timer.
const MAX_TURN_MS = 60000
// Default silence window: how long the speaker must pause before we cut the turn.
export const DEFAULT_SILENCE_MS = 5000

const bytesToMs = (bytes) => (bytes / BYTES_PER_SECOND) * 1000
const msToBytes = (ms) => Math.round((ms / 1000) * BYTES_PER_SECOND)
// Keep slice points on a sample boundary so we never split a 16-bit sample.
const alignSample = (bytes) => bytes - (bytes % BYTES_PER_SAMPLE)

const rmsOf = (buf) => {
  const samples = Math.floor(buf.length / BYTES_PER_SAMPLE)
  if (samples === 0) return 0
  let sum = 0
  for (let i = 0; i < samples; i++) {
    const sample = buf.readInt16LE(i * BYTES_PER_SAMPLE) / 32768
    sum += sample * sample
  }
  return Math.sqrt(sum / samples)
}

const wavFile = (pcm) => {
  const header = Buffer.alloc(44)
  header.write("RIFF", 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write("WAVE", 8)
  header.write("fmt ", 12)
  header.writeUInt32LE(16, 16) // PCM header size
  header.writeUInt16LE(1, 20) // format 1 = uncompressed PCM
  header.writeUInt16LE(CHANNELS, 22)
  header.writeUInt32LE(RATE, 24)
  header.writeUInt32LE(BYTES_PER_SECOND, 28)
  header.writeUInt16LE(CHANNELS * BYTES_PER_SAMPLE, 32)
  header.writeUInt16LE(BIT_WIDTH, 34)
  header.write("data", 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * Records until the speaker has been quiet for `silenceMs`, then resolves with
 * the path to a WAV file holding the trimmed utterance.
 *
 * Resolves `null` if the turn is abandoned, which happens when `signal` aborts
 * (Ctrl+C) or when the microphone dies before anyone speaks.
 *
 * `inputStream` overrides the microphone. It exists so the turn logic can be
 * exercised against known audio; callers should leave it unset.
 */
export const recordUtterance = ({ silenceMs = DEFAULT_SILENCE_MS, signal, inputStream } = {}) => {
  return new Promise((resolve, reject) => {
    let recorder = null
    let stream = inputStream

    if (!stream) {
      // exitOnSilence: 0 disables the library's own detector so data flows through
      // untouched and our 5s window is the only thing that ends a turn.
      recorder = mic({
        rate: String(RATE),
        channels: String(CHANNELS),
        bitwidth: String(BIT_WIDTH),
        encoding: "signed-integer",
        endian: "little",
        fileType: "raw",
        exitOnSilence: 0
      })
      stream = recorder.getAudioStream()
    }

    const chunks = [] // every byte received this turn, in order
    let pending = Buffer.alloc(0) // bytes not yet analysed as a full window
    let analyzedBytes = 0 // byte offset of the next window within the turn

    let calibrated = false
    let calibrationRmsSum = 0
    let calibrationWindows = 0
    let threshold = MIN_RMS

    // Turn state machine: idle until a real speech run arrives, then active.
    let state = "idle"
    let runStartMs = 0
    let runWindows = 0
    let speechStartMs = 0
    let lastSpeechEndMs = 0
    let lastCountdownSecond = null

    let settled = false
    const finish = (value, error) => {
      if (settled) return
      settled = true
      clearTimeout(maxTurnTimer)
      signal?.removeEventListener("abort", onAbort)
      recorder?.stop()
      if (error) reject(error)
      else resolve(value)
    }

    const onAbort = () => finish(null)

    const maxTurnTimer = setTimeout(() => {
      if (state === "active") cutTurn()
    }, MAX_TURN_MS)

    function cutTurn() {
      recorder?.stop()

      // Trim to the spoken portion, with a little padding either side.
      const pcm = Buffer.concat(chunks)
      const startByte = alignSample(Math.max(0, msToBytes(speechStartMs - PRE_ROLL_MS)))
      const endByte = alignSample(Math.min(pcm.length, msToBytes(lastSpeechEndMs + TRAIL_PAD_MS)))
      const utterance = pcm.subarray(startByte, endByte)

      if (utterance.length === 0) {
        finish(null)
        return
      }

      const filePath = path.join(os.tmpdir(), `agentic-ai-${process.pid}-${Date.now()}.wav`)
      fs.writeFileSync(filePath, wavFile(utterance))
      console.log(`\n  ⏹  Turn ended — ${(bytesToMs(utterance.length) / 1000).toFixed(1)}s captured`)
      finish(filePath)
    }

    function handleWindow(window, offsetBytes) {
      const windowStartMs = bytesToMs(offsetBytes)
      const windowEndMs = bytesToMs(offsetBytes + window.length)
      const level = rmsOf(window)

      if (!calibrated) {
        calibrationRmsSum += level
        calibrationWindows++
        if (windowEndMs >= CALIBRATION_MS && calibrationWindows > 0) {
          const noiseFloor = calibrationRmsSum / calibrationWindows
          // Adaptive floor so a noisy room doesn't hold the mic open, but never
          // so low that plain room tone reads as speech.
          threshold = Math.max(noiseFloor * NOISE_MULTIPLIER, MIN_RMS)
          calibrated = true
          process.stdout.write(`\n  🎤 Listening… (silence window ${silenceMs / 1000}s)\n`)
        }
        return
      }

      const isSpeech = level > threshold

      if (isSpeech) {
        if (runWindows === 0) runStartMs = windowStartMs
        runWindows++

        // Only commit to a turn once a run is long enough to be speech and not
        // a cough. The turn is backdated to where the run started.
        if (state === "idle" && runWindows * WINDOW_MS >= MIN_SPEECH_MS) {
          state = "active"
          speechStartMs = runStartMs
          process.stdout.write("  ● Speech detected\n")
        }

        if (state === "active") {
          lastSpeechEndMs = windowEndMs
          lastCountdownSecond = null
        }
        return
      }

      // Silence.
      runWindows = 0
      if (state !== "active") return

      const silenceElapsedMs = windowEndMs - lastSpeechEndMs
      if (silenceElapsedMs >= silenceMs) {
        cutTurn()
        return
      }

      // Surface the countdown so it's obvious the turn is still open and can be
      // continued just by speaking again.
      const remaining = Math.ceil((silenceMs - silenceElapsedMs) / 1000)
      if (remaining !== lastCountdownSecond) {
        lastCountdownSecond = remaining
        process.stdout.write(`\r  … quiet for ${Math.floor(silenceElapsedMs / 1000)}s — ends in ${remaining}s   `)
      }
    }

    stream.on("data", (chunk) => {
      if (settled) return
      chunks.push(chunk)

      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk
      // Walk complete analysis windows, carrying the remainder forward.
      while (pending.length >= WINDOW_BYTES) {
        const window = pending.subarray(0, WINDOW_BYTES)
        pending = pending.subarray(WINDOW_BYTES)
        handleWindow(window, analyzedBytes)
        analyzedBytes += WINDOW_BYTES
        if (settled) return
      }
    })

    stream.on("error", (error) => {
      finish(null, new Error(`Microphone stream failed: ${error.message}`))
    })

    stream.on("audioProcessExitComplete", () => {
      // sox exited on its own — almost always a denied mic permission.
      finish(
        null,
        new Error(
          "The recorder exited before the turn finished. Check that your terminal " +
            "has microphone access in System Settings → Privacy & Security → Microphone."
        )
      )
    })

    if (signal) {
      if (signal.aborted) return finish(null)
      signal.addEventListener("abort", onAbort, { once: true })
    }

    recorder?.start()
  })
}
