// In this lecture, we learn LLM can't remember the previous conversation
// we need to store the conversation and send it with new converstion
import Anthropic from "@anthropic-ai/sdk"
import readline from "node:readline/promises"

const messages = []
const client = new Anthropic()

// Reasoning models need headroom for their thinking blocks before any visible
// text. 1000 was far too small and produced empty replies.
const MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS) || 8000

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
const chat = async () => {
  // .stream() returns a MessageStream we can iterate; .finalMessage() gives the
  // complete Message (with .content) once the stream is done.
  const stream = client.messages.stream({
    model: process.env.ANTHROPIC_MODEL,
    // Reasoning models (deepseek-v4-flash, Claude with extended thinking) emit
    // hidden "thinking" blocks first, and those tokens count against max_tokens.
    // A budget that's too small is spent entirely on thinking, leaving no room
    // for the answer -- the reply comes back with no text block at all.
    max_tokens: MAX_TOKENS,
    messages: messages
  })

  process.stdout.write("\nAssistant: ")

  // Fires for each text delta as it arrives
  stream.on("text", (delta) => {
    process.stdout.write(delta)
  })

  const finalMessage = await stream.finalMessage()
  process.stdout.write("\n\n")

  const text = finalMessage.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("")

  // No text block means the model only produced thinking. Surface the reason
  // instead of returning "" and printing a silently empty reply.
  if (!text) {
    throw new Error(
      `model returned no text (stop_reason=${finalMessage.stop_reason}, ` +
        `output_tokens=${finalMessage.usage?.output_tokens}) - ` +
        `raise ANTHROPIC_MAX_TOKENS if this is max_tokens`
    )
  }

  assistantMessageStore(text)
  return text
}

const start = async () => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  })

  console.log("Chat started. Type your message, or 'exit' to quit.\n")

  while (true) {
    let input
    try {
      input = await rl.question("You: ")
    } catch {
      break // Ctrl+C / Ctrl+D closed the terminal
    }

    const prompt = input.trim()
    if (!prompt) continue
    if (prompt === "exit" || prompt === "quit") break

    userMessageStore(prompt)

    try {
      // chat() already streams the reply to stdout, so don't print it again.
      await chat()
    } catch (error) {
      // Drop the unanswered message so the history stays valid for the next turn
      messages.pop()
      console.error(`\nError: ${error.message}\n`)
    }
  }

  rl.close()
  console.log("Bye.")
}

start()
