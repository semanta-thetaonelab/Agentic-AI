// Voice-driven agent loop.
//
// Each turn runs record -> transcribe -> answer -> speak, and the microphone is
// only open for the first step. Recording ends the moment the speaker has been
// quiet for SILENCE_MS, so the mic is already shut while the agent thinks and
// while the answer is spoken back — the assistant never hears itself, and the
// speaker can't interject mid-answer.
import Anthropic from "@anthropic-ai/sdk"
import say from "say"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { recordUtterance, DEFAULT_SILENCE_MS } from "./voice.js"

const HERE = path.dirname(fileURLToPath(import.meta.url))

const SILENCE_MS = Number(process.env.STT_SILENCE_MS ?? DEFAULT_SILENCE_MS)
const WHISPER_BIN = process.env.WHISPER_BIN || "whisper-cli"
// Resolved against the project dir so a relative path works from any cwd.
const WHISPER_MODEL = process.env.WHISPER_MODEL
  ? path.resolve(HERE, process.env.WHISPER_MODEL)
  : path.join(HERE, "models", "ggml-base.en.bin")
const SAY_VOICE = process.env.SAY_VOICE || null
const SAY_SPEED = Number(process.env.SAY_SPEED ?? 1.0)
const TEMPERATURE = Number(process.env.TEMPERATURE ?? 0.2)
// Spoken words that end the session, so the loop is escapable by voice alone.
const EXIT_WORDS = new Set(["exit", "quit", "goodbye", "good bye", "stop listening"])

const messages = []
const client = new Anthropic()

const assistantMessageStore = (message) => {
  messages.push({
    role: "assistant",
    content: message
  })
}

const userMessageStore = (message) => {
  messages.push({
    role: "user",
    content: message
  })
}

// Whisper emits bracketed markers for audio that isn't speech, and on near-silent
// input it is prone to hallucinating a few stock phrases. Both would be sent to
// the agent as a bogus question, so both are filtered out here.
const NOISE_PHRASES = new Set([
  "thank you",
  "thanks for watching",
  "thank you for watching",
  "thanks for watching!",
  "please subscribe",
  "you",
  "bye",
  "bye bye",
  "."
])

const cleanTranscript = (raw) =>
  raw
    .replace(/\[[^\]]*\]/g, " ") // [BLANK_AUDIO], [Music], [ Silence ]
    .replace(/\([^)]*\)/g, " ") // (silence), (inaudible)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\-–—\s]+$/, "") // whisper's favourite output for pure silence
    .replace(/\s+$/g, "")

/**
 * Dedicated audio-to-text turn. Deliberately separate from chat(): it runs the
 * local whisper model instead of the agent, and nothing it returns is stored in
 * the conversation history — the caller decides what counts as a question.
 */
const audioToText = (wavPath) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      WHISPER_BIN,
      [
        "-m", WHISPER_MODEL,
        "-f", wavPath,
        "-nt", // no timestamps
        "-np" // no banner/print noise on stdout
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    )

    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })

    child.on("error", (error) => {
      if (error.code === "ENOENT") {
        reject(new Error(`Could not run '${WHISPER_BIN}'. Install it with: brew install whisper-cpp`))
        return
      }
      reject(error)
    })

    child.on("close", (code) => {
      if (code !== 0) {
        const detail = stderr.trim().split("\n").pop() || "no output"
        reject(new Error(`${WHISPER_BIN} exited with code ${code}: ${detail}`))
        return
      }
      resolve(cleanTranscript(stdout))
    })
  })

const chat = async () => {
  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL,
    max_tokens: 5000,
    messages: messages,
    temperature: TEMPERATURE,
    system:`You are a assistant who can talk to user on general topics. Your name is "Argha". whenever someone asks
    you to introduce yourself, you should say "I am Argha, a virtual assistant here to help you with your questions and tasks."`
  })
  const text = response.content.find((block) => block.type === "text")?.text || response?.stop_reason || ""
  assistantMessageStore(text)
  return text
}

const speak = (text) =>
  new Promise((resolve, reject) => {
    say.speak(text, SAY_VOICE, SAY_SPEED, (error) => (error ? reject(error) : resolve()))
  })

const start = async () => {
  if (!fs.existsSync(WHISPER_MODEL)) {
    console.error(`Whisper model not found at ${WHISPER_MODEL}`)
    console.error("Download one with:")
    console.error("  curl -L -o models/ggml-base.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin")
    process.exit(1)
  }

  const controller = new AbortController()
  const onInterrupt = () => {
    controller.abort()
    say.stop()
  }
  process.on("SIGINT", onInterrupt)

  console.log("Voice chat started.")
  console.log(`  Speech-to-text : ${WHISPER_BIN} (${path.basename(WHISPER_MODEL)})`)
  console.log(`  Silence window : ${SILENCE_MS / 1000}s before a turn is sent`)
  console.log(`  Voice          : ${SAY_VOICE || "system default"} @ ${SAY_SPEED}x`)
  console.log("\nSpeak any time. Say \"exit\" or press Ctrl+C to quit.\n")

  while (!controller.signal.aborted) {
    const wavPath = await recordUtterance({
      silenceMs: SILENCE_MS,
      signal: controller.signal
    })
    // null means the turn was abandoned (Ctrl+C, or the mic died).
    if (!wavPath) break

    // Tracks whether this turn put a message in the history, so a failure in the
    // transcription step can't pop an earlier turn's message by mistake.
    let storedQuestion = false

    try {
      const question = await audioToText(wavPath)

      if (!question || NOISE_PHRASES.has(question.toLowerCase())) {
        console.log("  ⌀ No speech recognised — still listening.\n")
        continue
      }

      console.log(`\nYou: ${question}`)

      if (EXIT_WORDS.has(question.toLowerCase())) {
        console.log("\nBye.")
        break
      }

      userMessageStore(question)
      storedQuestion = true

      console.log("  … thinking")
      const answer = await chat()
      console.log(`\nAssistant: ${answer}\n`)
      await speak(answer)
    } catch (error) {
      // Drop the unanswered message so the history stays valid for the next turn
      if (storedQuestion && messages.at(-1)?.role === "user") messages.pop()
      console.error(`\nError: ${error.message}\n`)
    } finally {
      fs.rmSync(wavPath, { force: true })
    }
  }

  say.stop()
  process.off("SIGINT", onInterrupt)
  console.log("\nBye.")
}

start().catch((error) => {
  console.error(`\nFatal: ${error.message}`)
  say.stop()
  process.exit(1)
})
