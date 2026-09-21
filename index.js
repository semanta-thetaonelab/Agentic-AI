// In this lecture, we learn LLM can't remember the previous conversation
// we need to store the conversation and send it with new converstion
import Anthropic from "@anthropic-ai/sdk"
const messages=[]

const assistantMessageStore = (message) =>{
  messages.push({
    role: "assistant",
    content: message
  })
}
const userMessageStore = (message) =>{
  messages.push({
    role: "user",
    content: message
  })
}
const chat = async () => {
  const client = new Anthropic()

  const response = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL,
    max_tokens: 1000,
    messages: messages
  })
  const text = response.content.find((block) => block.type === "text")?.text || ""
  assistantMessageStore(text)
  console.log(response,"response");
  return text
  // return response
}
const start=async () =>{
   userMessageStore("Tell me about naradra modi age")
   await chat()
   userMessageStore("Tell me his age")
   await chat()
   console.log(messages)
}
start()