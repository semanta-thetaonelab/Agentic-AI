//what is temperature in agentic AI?
//In Agentic AI, temperature is a setting that controls how predictable vs. creative/random the AI's responses are.
import Anthropic from "@anthropic-ai/sdk"
import readline from "node:readline/promises"
import say from "say"

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
    messages: messages,
    temperature: 1.0
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
    if (prompt === "exit" || prompt === "quit"){
      say.stop()
      break;
    }

    userMessageStore(prompt)

    try {
      const answer = await chat();
      console.log(`\nAssistant: ${answer}\n`)
      say.speak(
        answer,
        null,
        1.0,//speed
        (error) => {
          if (error) {
            console.error(error);
            return;
          }
        }
      );
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
