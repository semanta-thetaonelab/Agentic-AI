// In this lecture, we learn LLM can't remember the previous conversation
// we need to store the conversation and send it with new converstion
import Anthropic from "@anthropic-ai/sdk"
import readline from "node:readline/promises"

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
const chat = async () => {
  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL,
    max_tokens: 1000,
    messages: messages
  })
  const text = response.content.find((block) => block.type === "text")?.text || response?.stop_reason || ""
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
      const answer = await chat()
      console.log(`\nAssistant: ${answer}\n`)
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
