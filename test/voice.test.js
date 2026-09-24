// Turn-splitting tests for the voice capture logic.
//
// These feed synthetic PCM through recordUtterance() via its inputStream seam, so
// the real windowing, state machine, trimming and WAV writing all run — only sox
// itself is stubbed out.
//
//   node test/voice.test.js
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Readable } from "node:stream"
import { recordUtterance } from "../voice.js"

const RATE = 16000
const BYTES_PER_SECOND = RATE * 2

const silence = (ms) => Buffer.alloc(Math.round((ms / 1000) * BYTES_PER_SECOND))
const seconds = (buf) => buf.length / BYTES_PER_SECOND

// Reads back a WAV written by voice.js, so the assertions check the actual file
// the transcriber would be handed.
const readWav = (filePath) => {
  const buf = fs.readFileSync(filePath)
  const dataLength = buf.readUInt32LE(40)
  return {
    rate: buf.readUInt32LE(24),
    channels: buf.readUInt16LE(22),
    bitWidth: buf.readUInt16LE(34),
    pcm: buf.subarray(44, 44 + dataLength)
  }
}

// A speech-like signal: a tone burst at a realistic conversational level for a
// laptop mic (~0.08 RMS, well clear of the 0.012 floor).
const speech = (ms, freq = 220) => {
  const samples = Math.round((ms / 1000) * RATE)
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const envelope = Math.sin((Math.PI * i) / samples) // fade in/out, no clicks
    const value = Math.sin((2 * Math.PI * freq * i) / RATE) * 0.08 * envelope
    buf.writeInt16LE(Math.round(value * 32767), i * 2)
  }
  return buf
}

// Feeds audio in deliberately irregular chunks to prove the windowing logic
// survives chunk boundaries that don't line up with the 50ms analysis window.
const streamOf = (buf) => {
  let offset = 0
  return new Readable({
    read() {
      if (offset >= buf.length) return this.push(null)
      const size = 700 + ((offset * 37) % 5000)
      this.push(buf.subarray(offset, offset + size))
      offset += size
    }
  })
}

const cases = []
const test = (name, fn) => cases.push({ name, fn })

test("one utterance is captured and trimmed to speech", async () => {
  //              ambient        speech              silence past the window
  const audio = Buffer.concat([silence(800), speech(900), silence(6000)])
  const wavPath = await recordUtterance({ silenceMs: 1500, inputStream: streamOf(audio) })
  if (!wavPath) throw new Error("expected a turn, got null")

  const wav = readWav(wavPath)
  fs.rmSync(wavPath, { force: true })

  if (wav.rate !== 16000) throw new Error(`expected 16kHz, got ${wav.rate}`)
  if (wav.channels !== 1) throw new Error(`expected mono, got ${wav.channels} channels`)
  if (wav.bitWidth !== 16) throw new Error(`expected 16-bit, got ${wav.bitWidth}`)

  // 900ms of speech + 300ms pre-roll + 400ms trail pad ≈ 1.6s. The point is that
  // the leading 800ms of ambient is gone.
  const length = seconds(wav.pcm)
  if (length < 1.4 || length > 1.9) {
    throw new Error(`expected ~1.6s of trimmed audio, got ${length.toFixed(2)}s`)
  }
})

test("speech resuming inside the silence window merges into one turn", async () => {
  // A 2s pause sits inside the 5s window, so this must stay a single turn.
  const audio = Buffer.concat([
    silence(800),
    speech(700),
    silence(2000), // the pause — must NOT split the turn
    speech(700),
    silence(6000)
  ])

  const wavPath = await recordUtterance({ silenceMs: 5000, inputStream: streamOf(audio) })
  if (!wavPath) throw new Error("expected a turn, got null")

  const wav = readWav(wavPath)
  fs.rmSync(wavPath, { force: true })

  // 700 + 2000 + 700 of speech-and-gap, plus 300ms pre-roll and 400ms trail pad.
  // A split turn would be ~1.4s, so anything near 3.9s proves the merge.
  const length = seconds(wav.pcm)
  if (length < 3.6 || length > 4.3) {
    throw new Error(`expected the 2s gap to be merged into one ~3.9s turn, got ${length.toFixed(2)}s`)
  }

  // The gap between the two bursts must actually be present, not silently dropped.
  const pauseStart = Math.round(1.0 * BYTES_PER_SECOND) // 300ms preroll + 700ms speech
  const gap = wav.pcm.subarray(pauseStart, pauseStart + Math.round(1.5 * BYTES_PER_SECOND))
  let peak = 0
  for (let i = 0; i < Math.floor(gap.length / 2); i++) {
    peak = Math.max(peak, Math.abs(gap.readInt16LE(i * 2)))
  }
  if (peak > 300) throw new Error(`the merged pause should be quiet, but peaked at ${peak}`)
})

test("a pause longer than the window splits into separate turns", async () => {
  const audio = Buffer.concat([silence(800), speech(700), silence(6000)])
  const wavPath = await recordUtterance({ silenceMs: 1000, inputStream: streamOf(audio) })
  if (!wavPath) throw new Error("expected a turn, got null")

  const wav = readWav(wavPath)
  fs.rmSync(wavPath, { force: true })

  // With a 1s window the trailing 6s of silence cuts the turn ~1s in, so the
  // result is just the burst — not the 6s tail.
  const length = seconds(wav.pcm)
  if (length > 2.2) throw new Error(`expected a short turn, got ${length.toFixed(2)}s`)
})

test("pure ambient noise produces no turn", async () => {
  // A quiet room, never rising to speech. The turn must never be cut, so abort
  // it and expect null rather than a bogus recording.
  const audio = Buffer.concat([silence(8000)])
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 300)

  const wavPath = await recordUtterance({
    silenceMs: 1000,
    inputStream: streamOf(audio),
    signal: controller.signal
  })
  if (wavPath !== null) {
    fs.rmSync(wavPath, { force: true })
    throw new Error("ambient noise should not produce a turn")
  }
})

const run = async () => {
  let failed = 0
  for (const { name, fn } of cases) {
    try {
      await fn()
      console.log(`  ✓ ${name}`)
    } catch (error) {
      failed++
      console.log(`  ✗ ${name}\n      ${error.message}`)
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} passed`)
  if (failed > 0) process.exit(1)
}

run()
